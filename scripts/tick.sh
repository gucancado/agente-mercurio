#!/bin/bash
# tick.sh — v0.8 SDR
# Lê inbox via REST do worker, lê lead_state, sugere slots (se aplicável),
# invoca claude --print pra compor resposta estruturada (<reply>/<state_patch>/<actions>),
# parseia output, envia WhatsApp, aplica state_patch + actions, marca lida.
# Disparado por trigger-server.js quando webhook chega.

set -uo pipefail

PROFILE="${1:-responsive}"
WORKSPACE=/workspace
TICK_ID="$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}-$$"
LOCK_FILE="${WORKSPACE}/.locks/tick.${PROFILE}.lock"
LOG_DIR="${WORKSPACE}/.logs"
COST_DIR="${WORKSPACE}/.cost"
COST_FILE="${COST_DIR}/$(date -u +%F).jsonl"

mkdir -p "$(dirname "$LOCK_FILE")" "$LOG_DIR" "$COST_DIR"

# log local + POST /debug worker
log() {
  echo "[$(date -u +%FT%TZ)] [$TICK_ID] $*" >> "$LOG_DIR/tick.log"
  if [[ -n "${WORKER_URL:-}" && -n "${WORKER_TOKEN:-}" ]]; then
    curl -fsS --max-time 5 -X POST \
      -H "X-Agent-Token: ${WORKER_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg s "tick" --arg t "[$TICK_ID] $*" '{source: $s, text: $t}')" \
      "${WORKER_URL}/debug" >/dev/null 2>&1 || true
  fi
}

# ── 0. Lock ─────────────────────────────────────────────────────────────
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "skip: tick anterior em execução"
  exit 0
fi

log "start v0.8 SDR"

# ── 1. Cost cap diário ──────────────────────────────────────────────────
COST_CAP_DAY=$(yq -r '.guardrails.cost_cap_usd_per_day // 3.0' "$WORKSPACE/scripts/cadencia.yml")
COST_TODAY=0
if [[ -f "$COST_FILE" ]]; then
  COST_TODAY=$(jq -s '[.[].cost_usd] | add // 0' "$COST_FILE")
fi
OVER=$(awk -v c="$COST_TODAY" -v cap="$COST_CAP_DAY" 'BEGIN { print (c >= cap) ? 1 : 0 }')
if [[ "$OVER" == "1" ]]; then
  log "GUARDA: cost cap diário (\$$COST_CAP_DAY) excedido (\$$COST_TODAY)"
  exit 0
fi

# ── 2. Lê inbox via REST do worker ──────────────────────────────────────
: "${WORKER_URL:?WORKER_URL não definida}"
: "${WORKER_TOKEN:?WORKER_TOKEN não definida}"

INBOX_JSON=$(curl -fsS --max-time 10 \
  -H "X-Agent-Token: ${WORKER_TOKEN}" \
  "${WORKER_URL}/inbox-debug?unread_only=true&limit=10" 2>/dev/null)

if [[ -z "$INBOX_JSON" ]]; then
  log "erro buscando inbox"
  exit 0
fi

COUNT=$(jq '.messages | length' <<<"$INBOX_JSON")
log "inbox unread: $COUNT items"

if [[ "$COUNT" == "0" ]]; then
  log "inbox vazia; encerrando sem invocar claude"
  exit 0
fi

# ── 3. Configs ─────────────────────────────────────────────────────────
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-haiku-4-5}"
CLAUDE_TIMEOUT=$(yq -r '.guardrails.claude_timeout_seconds // 90' "$WORKSPACE/scripts/cadencia.yml")
PLAYBOOK_PATH="$WORKSPACE/_base/playbook-sdr.md"

# ── 4. Loop FIFO ────────────────────────────────────────────────────────
ITEMS=$(jq -c '[.messages[]] | reverse | .[]' <<<"$INBOX_JSON")

TOTAL_COST=0
PROCESSED=0
FAILED=0

while IFS= read -r ITEM; do
  ID=$(jq -r '.id' <<<"$ITEM")
  CHANNEL=$(jq -r '.channel' <<<"$ITEM")
  INSTANCE=$(jq -r '.instance' <<<"$ITEM")
  IDENTIFIER=$(jq -r '.identifier' <<<"$ITEM")
  TEXT=$(jq -r '.message_text // "(sem texto)"' <<<"$ITEM")
  PUSH_NAME=$(jq -r '.push_name // "?"' <<<"$ITEM")
  PROJECT_SLUG=$(jq -r '.instance | split("-")[1:] | join("-")' <<<"$ITEM")

  log "processando id=$ID from=$IDENTIFIER project=$PROJECT_SLUG: ${TEXT:0:60}"

  PROJECT_DIR="$WORKSPACE/projetos/$PROJECT_SLUG"
  if [[ ! -d "$PROJECT_DIR" ]]; then
    log "  ERRO: $PROJECT_DIR não existe; pulando (não marca lido)"
    FAILED=$((FAILED+1))
    continue
  fi

  PROJECT_BRIEF=$(cat "$PROJECT_DIR/PROJECT.md" 2>/dev/null || echo "(briefing ausente)")
  PLAYBOOK=$(cat "$PLAYBOOK_PATH" 2>/dev/null || echo "(playbook ausente)")

  # ── 4a. Lê lead_state ──
  STATE_RESP=$(curl -fsS --max-time 10 \
    -H "X-Agent-Token: ${WORKER_TOKEN}" \
    "${WORKER_URL}/lead-state?channel=${CHANNEL}&identifier=$(jq -rn --arg v "$IDENTIFIER" '$v|@uri')" \
    2>/dev/null || echo '{"state":null,"exists":false}')
  LEAD_STATE=$(jq -c '.state // {}' <<<"$STATE_RESP")
  log "  lead_state: $(jq -c '. | tostring | .[0:120]' <<<"$LEAD_STATE")"

  # ── 4b. Sugere slots SE estado indicar próxima ação de marcar reunião ──
  # Heurística: se proxima_acao.tipo == "marcar_reuniao" OU temperatura == "quente",
  # já busca slots pra Mel ter contexto disponível.
  PROXIMA_TIPO=$(jq -r '.proxima_acao.tipo // ""' <<<"$LEAD_STATE")
  TEMPERATURA=$(jq -r '.temperatura // ""' <<<"$LEAD_STATE")
  CONTEXT_SLOTS="[]"
  if [[ "$PROXIMA_TIPO" == "marcar_reuniao" || "$TEMPERATURA" == "quente" ]]; then
    SLOTS_RESP=$(curl -fsS --max-time 10 \
      -H "X-Agent-Token: ${WORKER_TOKEN}" \
      "${WORKER_URL}/meetings/suggest-slots" 2>/dev/null || echo '{"slots":[]}')
    CONTEXT_SLOTS=$(jq -c '.slots' <<<"$SLOTS_RESP")
    log "  pre-fetched slots: $(jq 'length' <<<"$CONTEXT_SLOTS")"
  fi

  # ── 4c. Monta prompt ──
  PROMPT=$(cat <<EOF
Você é a persona descrita em PROJECT.md, operando como SDR seguindo o PLAYBOOK abaixo. Receba a mensagem nova do lead, considere o estado salvo, e responda no formato XML estruturado.

== PLAYBOOK ==
$PLAYBOOK
== fim PLAYBOOK ==

== PROJECT.md ==
$PROJECT_BRIEF
== fim PROJECT.md ==

<lead_state>
$LEAD_STATE
</lead_state>

<context_slots>
$CONTEXT_SLOTS
</context_slots>

<lead_info>
identifier: $IDENTIFIER
push_name: $PUSH_NAME
channel: $CHANNEL
</lead_info>

<lead_message>
$TEXT
</lead_message>

INSTRUÇÕES FINAIS:
- Use APENAS o playbook + project + lead_state pra decidir.
- Saída EXATA no formato <reply>...</reply><state_patch>{...}</state_patch><actions>[...]</actions>.
- O <reply> vai literal pro WhatsApp — sem prefixo, sem aspas externas.
- Se estado é {} (lead novo), inclua disclosure ("Sou agente automatizada da BeeAds, operada por humanos") na primeira frase do reply.
- state_patch faz merge top-level com estado salvo — envie só campos que mudaram.
- actions vazio [] quando não há ação além de responder.
EOF
)

  # ── 4d. Invoca Claude ──
  CLAUDE_STDOUT=$(mktemp)
  CLAUDE_STDERR=$(mktemp)
  (
    cd "$WORKSPACE"
    timeout "${CLAUDE_TIMEOUT}s" claude --print \
      --model "$CLAUDE_MODEL" \
      --max-turns 3 \
      --output-format json \
      --setting-sources project \
      <<<"$PROMPT" \
      > "$CLAUDE_STDOUT" 2> "$CLAUDE_STDERR"
  )
  CEXIT=$?

  if [[ $CEXIT -ne 0 ]]; then
    log "  claude exit=$CEXIT — não envia, não marca"
    head -c 800 "$CLAUDE_STDERR" 2>/dev/null | tr '\n' ' ' | (read -r l; log "    err: ${l:0:500}")
    rm -f "$CLAUDE_STDOUT" "$CLAUDE_STDERR"
    FAILED=$((FAILED+1))
    continue
  fi

  RESPONSE=$(jq -r '.result // empty' "$CLAUDE_STDOUT")
  COST=$(jq -r '.total_cost_usd // 0' "$CLAUDE_STDOUT")
  TURNS=$(jq -r '.num_turns // 0' "$CLAUDE_STDOUT")

  rm -f "$CLAUDE_STDOUT" "$CLAUDE_STDERR"

  if [[ -z "$RESPONSE" ]]; then
    log "  claude retornou response vazia — pulando"
    FAILED=$((FAILED+1))
    continue
  fi

  # ── 4e. Parse <reply>/<state_patch>/<actions> ──
  REPLY=$(printf '%s' "$RESPONSE" | sed -n '/<reply>/,/<\/reply>/p' | sed '1d;$d' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  STATE_PATCH=$(printf '%s' "$RESPONSE" | sed -n '/<state_patch>/,/<\/state_patch>/p' | sed '1d;$d')
  ACTIONS_RAW=$(printf '%s' "$RESPONSE" | sed -n '/<actions>/,/<\/actions>/p' | sed '1d;$d')

  # Fallback: se não tem tag <reply>, usa output inteiro como fallback (graceful)
  if [[ -z "$REPLY" ]]; then
    log "  WARN: sem tag <reply>; usando output inteiro como fallback"
    REPLY="$RESPONSE"
  fi

  # Valida JSONs (se inválidos, ignora apenas eles)
  STATE_PATCH_VALID="{}"
  if [[ -n "$STATE_PATCH" ]] && echo "$STATE_PATCH" | jq empty >/dev/null 2>&1; then
    STATE_PATCH_VALID=$(echo "$STATE_PATCH" | jq -c '.')
  elif [[ -n "$STATE_PATCH" ]]; then
    log "  WARN: state_patch JSON inválido — ignorando"
  fi

  ACTIONS_VALID="[]"
  if [[ -n "$ACTIONS_RAW" ]] && echo "$ACTIONS_RAW" | jq -e 'type == "array"' >/dev/null 2>&1; then
    ACTIONS_VALID=$(echo "$ACTIONS_RAW" | jq -c '.')
  elif [[ -n "$ACTIONS_RAW" ]]; then
    log "  WARN: actions JSON inválido — ignorando"
  fi

  log "  reply (turns=$TURNS cost=\$$COST): ${REPLY:0:120}"

  # ── 4f. Envia via Evolution REST ──
  EVO_NUMBER="${IDENTIFIER#+}"
  EVO_PAYLOAD=$(jq -nc \
    --arg number "$EVO_NUMBER" \
    --arg text "$REPLY" \
    '{number: $number, text: $text}')

  SEND_RESP=$(curl -fsS --max-time 20 -X POST \
    -H "apikey: ${EVOLUTION_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$EVO_PAYLOAD" \
    "${EVOLUTION_API_URL}/message/sendText/${INSTANCE}" 2>&1)
  SEND_CODE=$?

  if [[ $SEND_CODE -ne 0 ]]; then
    log "  Evolution sendText falhou: ${SEND_RESP:0:300}"
    FAILED=$((FAILED+1))
    continue
  fi

  log "  enviado OK"

  # ── 4g. Aplica state_patch ──
  if [[ "$STATE_PATCH_VALID" != "{}" ]]; then
    SP_RESP=$(curl -fsS --max-time 10 -X POST \
      -H "X-Agent-Token: ${WORKER_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg ch "$CHANNEL" --arg id "$IDENTIFIER" --argjson p "$STATE_PATCH_VALID" '{channel:$ch, identifier:$id, patch:$p}')" \
      "${WORKER_URL}/lead-state" 2>&1)
    if [[ $? -eq 0 ]]; then
      log "  state_patch aplicado: $(echo "$STATE_PATCH_VALID" | jq -c '. | tostring | .[0:100]')"
    else
      log "  WARN: state_patch falhou: ${SP_RESP:0:200}"
    fi
  fi

  # ── 4h. Aplica actions ──
  if [[ "$ACTIONS_VALID" != "[]" ]]; then
    echo "$ACTIONS_VALID" | jq -c '.[]' | while IFS= read -r ACTION; do
      TYPE=$(jq -r '.type // ""' <<<"$ACTION")
      case "$TYPE" in
        handoff)
          MOTIVO=$(jq -r '.motivo // "outro"' <<<"$ACTION")
          URGENCIA=$(jq -r '.urgencia // "media"' <<<"$ACTION")
          CONTEXTO=$(jq -r '.contexto_resumido // ""' <<<"$ACTION")
          HO_RESP=$(curl -fsS --max-time 10 -X POST \
            -H "X-Agent-Token: ${WORKER_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg ch "$CHANNEL" --arg id "$IDENTIFIER" --arg m "$MOTIVO" --arg u "$URGENCIA" --arg c "$CONTEXTO" \
                  '{channel:$ch, identifier:$id, motivo:$m, urgencia:$u, contexto_resumido:$c}')" \
            "${WORKER_URL}/handoff" 2>&1)
          log "  action handoff: motivo=$MOTIVO urgencia=$URGENCIA → ${HO_RESP:0:150}"
          ;;
        schedule_meeting)
          SLOT_ISO=$(jq -r '.slot_iso // ""' <<<"$ACTION")
          SLOT_HUMAN=$(jq -r '.slot_human // ""' <<<"$ACTION")
          LEAD_EMAIL=$(jq -r '.lead_email // ""' <<<"$ACTION")
          LEAD_NAME=$(jq -r '.lead_name // ""' <<<"$ACTION")
          COMPANY=$(jq -r '.company // ""' <<<"$ACTION")
          CTX_M=$(jq -r '.contexto // ""' <<<"$ACTION")
          SM_RESP=$(curl -fsS --max-time 10 -X POST \
            -H "X-Agent-Token: ${WORKER_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg ch "$CHANNEL" --arg id "$IDENTIFIER" --arg si "$SLOT_ISO" --arg sh "$SLOT_HUMAN" \
                  --arg e "$LEAD_EMAIL" --arg n "$LEAD_NAME" --arg co "$COMPANY" --arg ctx "$CTX_M" \
                  '{channel:$ch, identifier:$id, slot_iso:$si, slot_human:$sh,
                    lead_email:(if $e=="" then null else $e end),
                    lead_name:(if $n=="" then null else $n end),
                    company:(if $co=="" then null else $co end),
                    contexto:(if $ctx=="" then null else $ctx end)}')" \
            "${WORKER_URL}/meetings/schedule" 2>&1)
          log "  action schedule_meeting: $SLOT_HUMAN → ${SM_RESP:0:150}"
          ;;
        suggest_slots)
          # Sinal pra próximo turno; não tem efeito imediato porque slots já foram pré-fetchados.
          log "  action suggest_slots (próximo turno usará)"
          ;;
        archive_lead)
          MOTIVO_A=$(jq -r '.motivo // "arquivado"' <<<"$ACTION")
          # Marcar via state patch direto
          curl -fsS --max-time 10 -X POST \
            -H "X-Agent-Token: ${WORKER_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "$(jq -nc --arg ch "$CHANNEL" --arg id "$IDENTIFIER" --arg m "$MOTIVO_A" \
                  '{channel:$ch, identifier:$id, patch:{temperatura:"congelado", proxima_acao:{tipo:"arquivar",motivo:$m}}}')" \
            "${WORKER_URL}/lead-state" >/dev/null 2>&1
          log "  action archive_lead: $MOTIVO_A"
          ;;
        *)
          log "  WARN: action type desconhecido: $TYPE"
          ;;
      esac
    done
  fi

  # ── 4i. Marca lida ──
  curl -fsS --max-time 10 -X POST \
    -H "X-Agent-Token: ${WORKER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg id "$ID" '{id: ($id|tonumber), processed_by: "tick"}')" \
    "${WORKER_URL}/inbox-debug/mark-read" >/dev/null 2>&1

  TOTAL_COST=$(awk -v t="$TOTAL_COST" -v c="$COST" 'BEGIN { print t + c }')
  PROCESSED=$((PROCESSED+1))

  TICK_CAP=$(yq -r '.guardrails.cost_cap_usd_per_tick // 0.10' "$WORKSPACE/scripts/cadencia.yml")
  OVER_T=$(awk -v t="$TOTAL_COST" -v cap="$TICK_CAP" 'BEGIN { print (t >= cap) ? 1 : 0 }')
  if [[ "$OVER_T" == "1" ]]; then
    log "cap por tick (\$$TICK_CAP) atingido; restantes ficam pro próximo trigger"
    break
  fi
done <<< "$ITEMS"

echo "{\"tick_id\":\"$TICK_ID\",\"cost_usd\":$TOTAL_COST,\"processed\":$PROCESSED,\"failed\":$FAILED,\"at\":\"$(date -u +%FT%TZ)\"}" >> "$COST_FILE"

log "end processed=$PROCESSED failed=$FAILED total_cost=\$$TOTAL_COST"
