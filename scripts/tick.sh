#!/bin/bash
# tick.sh <profile>
# Tick simplificado do mercurio (v0.6 — inbox-driven).
# Sempre invoca Claude com a skill `processar-inbox`; sem cheap-tick.
# Custo controlado por max-turns + cost cap diário em cadencia.yml.

set -uo pipefail
# NÃO usar set -e — `var=$(cmd)` com cmd falhando mata o script antes de
# checarmos o exit code. Pegamos exits explicitamente.

PROFILE="${1:?usage: tick.sh <profile>}"
WORKSPACE=/workspace
TICK_ID="$(date -u +%Y%m%dT%H%M%SZ)-${PROFILE}-$$"
LOCK_FILE="${WORKSPACE}/.locks/tick.${PROFILE}.lock"
LOG_DIR="${WORKSPACE}/.logs"
COST_DIR="${WORKSPACE}/.cost"
COST_FILE="${COST_DIR}/$(date -u +%F).jsonl"
CADENCIA="${WORKSPACE}/scripts/cadencia.yml"

mkdir -p "$(dirname "$LOCK_FILE")" "$LOG_DIR" "$COST_DIR"

# log local + POST /debug do worker pra owner ver via REST
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

# ── 0. Lock por perfil ──────────────────────────────────────────────────
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "skip: tick anterior do perfil $PROFILE ainda rodando"
  exit 0
fi

log "start"

# ── 1. Guarda de custo (soft cap diário) ────────────────────────────────
COST_CAP_DAY=$(yq -r '.guardrails.cost_cap_usd_per_day // 5.0' "$CADENCIA")
COST_TODAY=0
if [[ -f "$COST_FILE" ]]; then
  COST_TODAY=$(jq -s '[.[].cost_usd] | add // 0' "$COST_FILE")
fi
OVER=$(awk -v c="$COST_TODAY" -v cap="$COST_CAP_DAY" 'BEGIN { print (c >= cap) ? 1 : 0 }')
if [[ "$OVER" == "1" ]]; then
  log "GUARDA INTERNA: cost cap diario (\$$COST_CAP_DAY) excedido (\$$COST_TODAY)"
  exit 0
fi

# ── 2. Git pull com retry ──────────────────────────────────────────────
for i in 1 2 3; do
  if git -C "$WORKSPACE" pull --rebase --autostash >/dev/null 2>>"$LOG_DIR/git.log"; then
    break
  fi
  log "git pull falhou (tentativa $i/3)"
  [[ $i -lt 3 ]] && sleep $((i*2))
done

# ── 3. Carrega perfil ───────────────────────────────────────────────────
PROFILE_JSON=$(yq -o=json ".profiles.$PROFILE" "$CADENCIA")
ENABLED=$(jq -r '.enabled // true' <<<"$PROFILE_JSON")
if [[ "$ENABLED" != "true" ]]; then
  log "perfil $PROFILE desabilitado em cadencia.yml; encerrando"
  exit 0
fi
MAX_TURNS=$(jq -r '.max_turns_per_workspace // 50' <<<"$PROFILE_JSON")

# ── 4. Invoca Claude direto na raiz do agente ───────────────────────────
# Claude carrega CLAUDE.md raiz, descobre projetos via skill processar-inbox.
log "invocando claude (max-turns=$MAX_TURNS) cwd=$WORKSPACE"
log "  ANTHROPIC_API_KEY len=${#ANTHROPIC_API_KEY}"
log "  claude version: $(claude --version 2>&1 | head -1)"

CLAUDE_LOG="${LOG_DIR}/claude.${TICK_ID}.log"
CLAUDE_STDOUT=$(mktemp)
CLAUDE_STDERR=$(mktemp)

# Subshell + cd; sem set -e; captura exit explicitamente
(
  cd "$WORKSPACE"
  claude --print \
    --model claude-sonnet-4-6 \
    --max-turns "$MAX_TURNS" \
    --output-format json \
    --append-system-prompt "$(cat "$WORKSPACE/scripts/tick-prompt.md")" \
    <<<"TICK_ID=$TICK_ID PROFILE=$PROFILE" \
    > "$CLAUDE_STDOUT" 2> "$CLAUDE_STDERR"
)
CLAUDE_EXIT=$?
log "claude exit=$CLAUDE_EXIT"
log "claude stdout size=$(wc -c < "$CLAUDE_STDOUT") bytes; stderr size=$(wc -c < "$CLAUDE_STDERR") bytes"

# Salva os outputs no log dir
cp "$CLAUDE_STDOUT" "$CLAUDE_LOG.stdout" 2>/dev/null
cp "$CLAUDE_STDERR" "$CLAUDE_LOG.stderr" 2>/dev/null

# Mostra primeiras linhas de stderr no /debug (se houver)
if [[ -s "$CLAUDE_STDERR" ]]; then
  head -20 "$CLAUDE_STDERR" 2>/dev/null | while IFS= read -r l; do log "  claude-err> $l"; done
fi
# Mostra um trecho do stdout
if [[ -s "$CLAUDE_STDOUT" ]]; then
  head -c 1500 "$CLAUDE_STDOUT" 2>/dev/null | tr '\n' ' ' | (read -r line; log "  claude-out> ${line:0:1500}")
fi

if [[ $CLAUDE_EXIT -ne 0 ]]; then
  log "claude failed; abortando tick"
  rm -f "$CLAUDE_STDOUT" "$CLAUDE_STDERR"
  exit 0
fi

CLAUDE_OUT=$(cat "$CLAUDE_STDOUT")
rm -f "$CLAUDE_STDOUT" "$CLAUDE_STDERR"

# ── 5. Parse custo do output ────────────────────────────────────────────
TICK_COST=$(jq -r '.total_cost_usd // .cost_usd // 0' <<<"$CLAUDE_OUT" 2>/dev/null || echo 0)
TICK_TURNS=$(jq -r '.num_turns // 0' <<<"$CLAUDE_OUT" 2>/dev/null || echo 0)
echo "{\"tick_id\":\"$TICK_ID\",\"cost_usd\":$TICK_COST,\"turns\":$TICK_TURNS,\"at\":\"$(date -u +%FT%TZ)\"}" >> "$COST_FILE"
log "tick OK cost=\$$TICK_COST turns=$TICK_TURNS"

# ── 6. Commit + push se houve mudancas ──────────────────────────────────
cd "$WORKSPACE"
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git -c user.name="agente-${AGENT_NAME:-mercurio}" \
      -c user.email="${AGENT_EMAIL:-agent@beeads.com.br}" \
      commit -m "tick $TICK_ID cost=\$$TICK_COST turns=$TICK_TURNS" \
      >>"$LOG_DIR/git.log" 2>&1 || true
  for i in 1 2 3; do
    if git push >>"$LOG_DIR/git.log" 2>&1; then break; fi
    [[ $i -lt 3 ]] && sleep $((i*2))
  done
fi

date -u +%FT%TZ > "$WORKSPACE/.last-tick"
log "end"
