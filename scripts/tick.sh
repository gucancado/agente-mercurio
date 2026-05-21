#!/bin/bash
# tick.sh — v0.9 (Fase 2 do plano de ação)
#
# Loop fininho: lock + cost cap + fetch inbox + delega cada mensagem pro
# orquestrador Node (process-tick-message.js).
#
# Toda lógica de classify/respond/persist/send está em process-tick-message.js.

set -uo pipefail

PROFILE="${1:-responsive}"
WORKSPACE=/workspace
TICK_ID="$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}-$$"
LOCK_FILE="${WORKSPACE}/.locks/tick.${PROFILE}.lock"
LOG_DIR="${WORKSPACE}/.logs"
COST_DIR="${WORKSPACE}/.cost"
COST_FILE="${COST_DIR}/$(date -u +%F).jsonl"

mkdir -p "$(dirname "$LOCK_FILE")" "$LOG_DIR" "$COST_DIR"

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

log "start v0.9 Fase 2"

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

# ── 2. Lê inbox via REST ────────────────────────────────────────────────
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
  log "inbox vazia; encerrando"
  exit 0
fi

# ── 3. Loop FIFO ────────────────────────────────────────────────────────
ITEMS=$(jq -c '[.messages[]] | reverse | .[]' <<<"$INBOX_JSON")

TOTAL_COST=0
PROCESSED=0
FAILED=0
TICK_CAP=$(yq -r '.guardrails.cost_cap_usd_per_tick // 0.10' "$WORKSPACE/scripts/cadencia.yml")
ORCHESTRATOR="$WORKSPACE/scripts/process-tick-message.js"

while IFS= read -r ITEM; do
  ID=$(jq -r '.id' <<<"$ITEM")
  TEXT=$(jq -r '.message_text // "(sem texto)"' <<<"$ITEM")
  IDENTIFIER=$(jq -r '.identifier // ""' <<<"$ITEM")

  # ── Comando mágico zerar-conversa (curto-circuita orquestrador) ──
  LOWER_TEXT=$(echo "$TEXT" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  CHANNEL=$(jq -r '.channel' <<<"$ITEM")
  INSTANCE=$(jq -r '.instance' <<<"$ITEM")
  if [[ "$LOWER_TEXT" == "zerar-conversa" || "$LOWER_TEXT" == "zerar conversa" || "$LOWER_TEXT" == "/reset" ]]; then
    log "id=$ID comando zerar-conversa from=$IDENTIFIER"
    curl -fsS --max-time 10 -X POST \
      -H "X-Agent-Token: ${WORKER_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg ch "$CHANNEL" --arg id "$IDENTIFIER" '{channel:$ch, identifier:$id}')" \
      "${WORKER_URL}/sdr/reset" >/dev/null 2>&1
    curl -fsS --max-time 20 -X POST \
      -H "apikey: ${EVOLUTION_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg n "${IDENTIFIER#+}" --arg t "Conversa zerada. Pode mandar *oi* que começo do zero 👍" '{number:$n, text:$t}')" \
      "${EVOLUTION_API_URL}/message/sendText/${INSTANCE}" >/dev/null 2>&1
    PROCESSED=$((PROCESSED+1))
    continue
  fi

  # ── Delega para orquestrador Node ──
  RESULT_FILE=$(mktemp)
  ERR_FILE=$(mktemp)
  CLAUDE_TIMEOUT=$(yq -r '.guardrails.claude_timeout_seconds // 90' "$WORKSPACE/scripts/cadencia.yml")
  if timeout "${CLAUDE_TIMEOUT}s" node "$ORCHESTRATOR" <<<"$ITEM" > "$RESULT_FILE" 2> "$ERR_FILE"; then
    RESULT_JSON=$(cat "$RESULT_FILE")
    COST=$(jq -r '.cost_usd_total // 0' <<<"$RESULT_JSON")
    INTENT=$(jq -r '.classifier_intent // "?"' <<<"$RESULT_JSON")
    PREVIEW=$(jq -r '.reply_preview // ""' <<<"$RESULT_JSON")
    log "id=$ID OK intent=$INTENT cost=\$$COST"
    TOTAL_COST=$(awk -v t="$TOTAL_COST" -v c="$COST" 'BEGIN { print t + c }')
    PROCESSED=$((PROCESSED+1))
  else
    EXIT=$?
    log "id=$ID FALHOU exit=$EXIT"
    head -c 600 "$ERR_FILE" 2>/dev/null | tr '\n' ' ' | (read -r l; log "  err: ${l:0:500}")
    FAILED=$((FAILED+1))
  fi
  rm -f "$RESULT_FILE" "$ERR_FILE"

  # Cap por tick
  OVER_T=$(awk -v t="$TOTAL_COST" -v cap="$TICK_CAP" 'BEGIN { print (t >= cap) ? 1 : 0 }')
  if [[ "$OVER_T" == "1" ]]; then
    log "cap por tick (\$$TICK_CAP) atingido; restantes ficam pro próximo trigger"
    break
  fi
done <<< "$ITEMS"

echo "{\"tick_id\":\"$TICK_ID\",\"cost_usd\":$TOTAL_COST,\"processed\":$PROCESSED,\"failed\":$FAILED,\"at\":\"$(date -u +%FT%TZ)\"}" >> "$COST_FILE"

log "end processed=$PROCESSED failed=$FAILED total_cost=\$$TOTAL_COST"
