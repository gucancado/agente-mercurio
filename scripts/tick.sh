#!/bin/bash
# tick.sh — v0.7 trigger-based
# Lê inbox via REST do worker, invoca claude --print pra compor resposta (sem MCP),
# envia via Evolution REST, marca lida via worker REST.
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

log "start"

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

# ── 3. Configs (model, persona, etc) ────────────────────────────────────
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-haiku-4-5}"
CLAUDE_TIMEOUT=$(yq -r '.guardrails.claude_timeout_seconds // 60' "$WORKSPACE/scripts/cadencia.yml")

# ── 4. Loop FIFO (mais antigos primeiro) ────────────────────────────────
# /inbox-debug retorna DESC por created_at, então invertemos pra processar do mais antigo
ITEMS=$(jq -c '[.messages[]] | reverse | .[]' <<<"$INBOX_JSON")

TOTAL_COST=0
PROCESSED=0
FAILED=0

while IFS= read -r ITEM; do
  ID=$(jq -r '.id' <<<"$ITEM")
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

  # Monta prompt enxuto pro Claude
  PROJECT_BRIEF=$(cat "$PROJECT_DIR/PROJECT.md" 2>/dev/null || echo "(briefing ausente)")

  PROMPT=$(cat <<EOF
Você é a persona descrita abaixo (PROJECT.md). Responda a mensagem recebida no WhatsApp.

== PROJECT.md ==
$PROJECT_BRIEF
== fim ==

Mensagem recebida de **$IDENTIFIER** (nome WhatsApp: "$PUSH_NAME"):
"$TEXT"

Compose APENAS o texto da resposta WhatsApp, em PT-BR, curta (1-3 frases). Se é primeira mensagem em thread nova, inclua disclosure ("Sou [persona], agente automatizada da BeeAds, operada por humanos"). Sem aspas externas, sem prefixo "Resposta:". Apenas o texto.
EOF
)

  # Invoca Claude SEM tools, só geração de texto
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

  # Parse: pega `result` (texto gerado) e custo
  RESPONSE=$(jq -r '.result // empty' "$CLAUDE_STDOUT")
  COST=$(jq -r '.total_cost_usd // 0' "$CLAUDE_STDOUT")
  TURNS=$(jq -r '.num_turns // 0' "$CLAUDE_STDOUT")

  rm -f "$CLAUDE_STDOUT" "$CLAUDE_STDERR"

  if [[ -z "$RESPONSE" ]]; then
    log "  claude retornou response vazia — pulando"
    FAILED=$((FAILED+1))
    continue
  fi

  log "  resposta (turns=$TURNS cost=\$$COST): ${RESPONSE:0:120}"

  # ── Envia via Evolution REST ──
  EVO_NUMBER="${IDENTIFIER#+}"   # remove leading +
  EVO_PAYLOAD=$(jq -nc \
    --arg number "$EVO_NUMBER" \
    --arg text "$RESPONSE" \
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

  # ── Marca lida via worker REST ──
  curl -fsS --max-time 10 -X POST \
    -H "X-Agent-Token: ${WORKER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg s "tick-mark-read" --arg t "marked id=$ID by $TICK_ID" '{source: $s, text: $t}')" \
    "${WORKER_URL}/debug" >/dev/null 2>&1

  # Mark via worker MCP /mark-read — usar SQL direto via /debug post + UPDATE? Não tem rota.
  # Como /inbox-debug retorna processed_at e MCP inbox_mark_read existe mas requer transport MCP,
  # vou adicionar rota REST POST /inbox-debug/mark/<id> no worker em paralelo.
  # Por enquanto, faço POST que marca via worker
  curl -fsS --max-time 10 -X POST \
    -H "X-Agent-Token: ${WORKER_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg id "$ID" '{id: ($id|tonumber), processed_by: "tick"}')" \
    "${WORKER_URL}/inbox-debug/mark-read" >/dev/null 2>&1

  TOTAL_COST=$(awk -v t="$TOTAL_COST" -v c="$COST" 'BEGIN { print t + c }')
  PROCESSED=$((PROCESSED+1))

  # Cap por tick? Se já passou cost_cap_usd_per_tick, para.
  TICK_CAP=$(yq -r '.guardrails.cost_cap_usd_per_tick // 0.10' "$WORKSPACE/scripts/cadencia.yml")
  OVER_T=$(awk -v t="$TOTAL_COST" -v cap="$TICK_CAP" 'BEGIN { print (t >= cap) ? 1 : 0 }')
  if [[ "$OVER_T" == "1" ]]; then
    log "cap por tick (\$$TICK_CAP) atingido; restantes ficam pro próximo trigger"
    break
  fi
done <<< "$ITEMS"

# Log final
echo "{\"tick_id\":\"$TICK_ID\",\"cost_usd\":$TOTAL_COST,\"processed\":$PROCESSED,\"failed\":$FAILED,\"at\":\"$(date -u +%FT%TZ)\"}" >> "$COST_FILE"

log "end processed=$PROCESSED failed=$FAILED total_cost=\$$TOTAL_COST"
