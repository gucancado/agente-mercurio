#!/bin/bash
# Entrypoint do container do agente.
# Versão debug: NÃO sai em erro; loga absolutamente tudo + sleep infinity ao fim.

set +e   # nada de exit em erro
exec 2>&1

log_local() { echo "[entrypoint $(date -u +%FT%TZ)] $*"; }

# log() — local + POST /debug do worker
log() {
  log_local "$*"
  if [[ -n "${WORKER_URL:-}" && -n "${WORKER_TOKEN:-}" ]]; then
    curl -fsS --max-time 5 -X POST \
      -H "X-Agent-Token: ${WORKER_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$(jq -nc --arg s "entrypoint" --arg t "$*" '{source: $s, text: $t}' 2>/dev/null)" \
      "${WORKER_URL}/debug" >/dev/null 2>&1
  fi
}

log "ENTRYPOINT START pid=$$"
log "user=$(whoami) uid=$(id -u) home=$HOME pwd=$(pwd)"
log "WORKER_URL set: $([[ -n "${WORKER_URL:-}" ]] && echo yes || echo no)"
log "WORKER_TOKEN len: ${#WORKER_TOKEN:-0}"
log "AGENT_NAME=${AGENT_NAME:-UNSET}  EVOLUTION_INSTANCE=${EVOLUTION_INSTANCE:-UNSET}"
log "ANTHROPIC_API_KEY len: ${#ANTHROPIC_API_KEY}"

log "tools check:"
log "  bash: $(command -v bash)"
log "  jq: $(command -v jq) -- $(jq --version 2>&1)"
log "  yq: $(command -v yq) -- $(yq --version 2>&1)"
log "  curl: $(command -v curl)"
log "  supercronic: $(command -v supercronic) -- $(supercronic --version 2>&1 | head -1 || echo missing)"
log "  claude: $(command -v claude) -- $(claude --version 2>&1 | head -1 || echo missing)"
log "  git: $(command -v git)"

log "/workspace existe? $([[ -d /workspace ]] && echo sim || echo NÃO)"
if [[ -d /workspace ]]; then
  log "/workspace entries (top 15):"
  ls -la /workspace 2>&1 | head -16 | while IFS= read -r line; do log_local "  $line"; done
fi

# ── 0. Popula /workspace se está vazio (volume Coolify recém-criado)
if [[ ! -f /workspace/CLAUDE.md ]]; then
  log "/workspace vazio (sem CLAUDE.md) — copiando seed de /opt/agent/seed"
  if [[ -d /opt/agent/seed ]]; then
    cp -a /opt/agent/seed/. /workspace/ 2>&1 | while IFS= read -r l; do log_local "seed> $l"; done
    log "seed copiado: top files: $(ls /workspace 2>&1 | tr '\n' ' ')"
  else
    log "ERRO: /opt/agent/seed não existe — não posso popular /workspace; sleep infinity"
    sleep infinity
  fi
else
  log "/workspace já tem CLAUDE.md — pulando seed"
fi

log "/workspace/_platform/user-claude.md existe? $([[ -f /workspace/_platform/user-claude.md ]] && echo sim || echo NÃO)"
log "/workspace/scripts/cadencia.yml existe? $([[ -f /workspace/scripts/cadencia.yml ]] && echo sim || echo NÃO)"

WORKSPACE=/workspace
HOME_DIR="${HOME:-/home/agent}"
CLAUDE_HOME="${HOME_DIR}/.claude"

# ── 1. ~/.claude
mkdir -p "$CLAUDE_HOME/skills"
if [[ -f "$WORKSPACE/_platform/user-claude.md" ]]; then
  cp "$WORKSPACE/_platform/user-claude.md" "$CLAUDE_HOME/CLAUDE.md"
  log "copied user-claude.md"
else
  log "WARN: $WORKSPACE/_platform/user-claude.md NÃO existe"
fi

if [[ -f "$WORKSPACE/_platform/user-settings.json" ]]; then
  cp "$WORKSPACE/_platform/user-settings.json" "$CLAUDE_HOME/settings.json"
  log "copied user-settings.json"
fi

# ── 2. Symlinks skills
ln -sfn "$WORKSPACE/_base/skills" "$CLAUDE_HOME/skills/_base" 2>&1
log "symlink _base: $?"
if [[ -d /opt/skills/obsidian-skills ]]; then
  ln -sfn /opt/skills/obsidian-skills "$CLAUDE_HOME/skills/obsidian" 2>&1
  log "symlink obsidian: $?"
fi

# ── 3. MCPs user-scope (opcional)
if [[ -x "$WORKSPACE/_platform/mcp-bootstrap.sh" ]]; then
  log "running mcp-bootstrap..."
  "$WORKSPACE/_platform/mcp-bootstrap.sh" 2>&1 | while IFS= read -r l; do log_local "mcp> $l"; done
fi

# ── 4. Crontab
CRONTAB="${HOME_DIR}/agent-crontab"
: > "$CRONTAB"

if [[ -f "$WORKSPACE/scripts/cadencia.yml" ]]; then
  PROFILES=$(yq -r '.profiles | keys | .[]' "$WORKSPACE/scripts/cadencia.yml" 2>&1)
  log "perfis em cadencia.yml: $(echo "$PROFILES" | tr '\n' ',')"
  for PROFILE in $PROFILES; do
    # yq retorna "true", "false" ou "null" se ausente.
    # Política: só `false` literal pula; null/true/missing habilita.
    ENABLED=$(yq -r ".profiles.\"$PROFILE\".enabled" "$WORKSPACE/scripts/cadencia.yml")
    log "  $PROFILE enabled=$ENABLED"
    if [[ "$ENABLED" == "false" ]]; then continue; fi
    TZ=$(yq -r ".profiles.$PROFILE.timezone // \"UTC\"" "$WORKSPACE/scripts/cadencia.yml")
    CRONS=$(yq -r ".profiles.$PROFILE.crons[]" "$WORKSPACE/scripts/cadencia.yml" 2>&1)
    log "    TZ=$TZ"
    log "    crons raw: $(echo "$CRONS" | tr '\n' '|')"
    while IFS= read -r CRON_EXPR; do
      [[ -z "$CRON_EXPR" ]] && continue
      echo "CRON_TZ=$TZ $CRON_EXPR /workspace/scripts/tick.sh $PROFILE >> /workspace/.logs/supercronic.log 2>&1" >> "$CRONTAB"
      log "    + $CRON_EXPR"
    done <<< "$CRONS"
  done
  CRONTAB_LINES=$(wc -l < "$CRONTAB" 2>&1)
  log "crontab gerado: $CRONTAB_LINES linhas em $CRONTAB"
  cat "$CRONTAB" 2>&1 | while IFS= read -r l; do log "  cron> $l"; done
else
  log "WARN: cadencia.yml ausente"
fi

# ── 5. Volumes
mkdir -p "$WORKSPACE/.logs" "$WORKSPACE/.cost" "$WORKSPACE/.locks" 2>&1
log "diretórios runtime criados"

# ── 6. Git identity
git config --global user.name "agente-${AGENT_NAME:-mercurio}" 2>&1
git config --global user.email "${AGENT_EMAIL:-agent@beeads.com.br}" 2>&1
git config --global pull.rebase true 2>&1
log "git config OK"

# ── 7. Supercronic
if [[ ! -s "$CRONTAB" ]]; then
  log "WARN: crontab vazio — não há perfis habilitados; sleep infinity"
  sleep infinity
fi

log "starting supercronic..."
SUPER_OUT=/tmp/supercronic.log
( supercronic "$CRONTAB" > "$SUPER_OUT" 2>&1; echo $? > /tmp/supercronic.exit ) &
SUPER_PID=$!
log "supercronic pid=$SUPER_PID"

# Espera supercronic. Se exitar, captura logs e sleep infinity pra debug.
wait $SUPER_PID 2>/dev/null
EXIT=$(cat /tmp/supercronic.exit 2>/dev/null || echo "?")
log "supercronic terminou com exit=$EXIT — output:"
if [[ -f "$SUPER_OUT" ]]; then
  tail -30 "$SUPER_OUT" 2>&1 | while IFS= read -r l; do log "  super> $l"; done
else
  log "  (sem output capturado)"
fi
log "sleep infinity"
sleep infinity
