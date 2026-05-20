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

# ── 0. /workspace = checkout git do repo do agente
# - Primeira vez (volume vazio): clone do repo público
# - Próximas: git pull pra pegar atualizações sem rebuild
REPO_URL="https://github.com/gucancado/agente-mercurio.git"
if [[ ! -d /workspace/.git ]]; then
  log "/workspace sem .git — clonando $REPO_URL"
  cd /workspace
  # Limpa qualquer cópia parcial antiga (do seed)
  rm -rf /workspace/.[!.]* /workspace/* 2>/dev/null
  git clone "$REPO_URL" /workspace 2>&1 | while IFS= read -r l; do log_local "clone> $l"; done
  log "clone OK: $(ls /workspace | tr '\n' ' ')"
else
  log "/workspace é git checkout — git pull"
  cd /workspace
  git pull --rebase --autostash 2>&1 | while IFS= read -r l; do log_local "pull> $l"; done
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

# ── 4. Volumes runtime
mkdir -p "$WORKSPACE/.logs" "$WORKSPACE/.cost" "$WORKSPACE/.locks" 2>&1
log "diretórios runtime criados"

# ── 5. Git identity
git config --global user.name "agente-${AGENT_NAME:-mercurio}" 2>&1
git config --global user.email "${AGENT_EMAIL:-agent@beeads.com.br}" 2>&1
git config --global pull.rebase true 2>&1
log "git config OK"

# ── 6. Trigger HTTP server (substitui supercronic — modelo trigger-based v0.7)
# Worker faz POST /trigger quando webhook chega; aí roda tick.sh em background.
# Container fica idle (sem custo Claude) até receber trigger.
log "starting trigger-server na porta ${PORT:-3000}..."
exec node /workspace/docker/trigger-server.js
