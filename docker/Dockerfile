# Dockerfile do agente mercurio — self-contained (inline do agente-base).
# Quando 2º agente surgir, refatorar pra usar imagem base compartilhada
# (ghcr.io/gucancado/agente-base — repo público, package precisa virar
# público via UI GitHub).

FROM node:24-slim

# Utilitários do tick
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      jq \
      tzdata \
    && rm -rf /var/lib/apt/lists/*
# flock e coreutils via util-linux (default no node:24-slim Debian)

# yq (mikefarah, Go binary). Pinado pra evitar flakiness em latest/download.
RUN curl -fsSL -o /usr/local/bin/yq \
      "https://github.com/mikefarah/yq/releases/download/v4.53.2/yq_linux_amd64" \
    && chmod +x /usr/local/bin/yq

# supercronic
RUN curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64" \
    && chmod +x /usr/local/bin/supercronic

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Skills universais — Obsidian
RUN mkdir -p /opt/skills \
    && git clone --depth 1 https://github.com/kepano/obsidian-skills.git \
        /opt/skills/obsidian-skills

# Usuário não-root
RUN groupadd -g 1001 agent && useradd -m -u 1001 -g 1001 -s /bin/bash agent

# Metadados do agente (build args)
ARG AGENT_NAME=mercurio
ENV AGENT_NAME=${AGENT_NAME}

# Copia repo do agente. Em produção, /workspace é volume Coolify
# (sobrescreve esta cópia) — esta é fallback de primeira inicialização.
COPY --chown=agent:agent . /workspace
WORKDIR /workspace

# Permissões dos scripts
RUN chmod +x /workspace/scripts/tick.sh \
             /workspace/_platform/mcp-bootstrap.sh \
             /workspace/docker/entrypoint.sh \
    && find /workspace/scripts/lib -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true \
    && chown -R agent:agent /workspace /home/agent

USER agent

ENTRYPOINT ["/workspace/docker/entrypoint.sh"]
