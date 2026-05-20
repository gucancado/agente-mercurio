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

# Repo do agente em DOIS lugares:
# - /opt/agent/seed/   imagem-side, NUNCA sobrescrita por volume Coolify
# - /workspace/        volume Coolify (montado em runtime; se vazio, entrypoint copia do seed)
# Entrypoint vive em /opt/agent/ porque ENTRYPOINT precisa de path estável
# (volume Coolify monta /workspace vazio se ainda não existia).
COPY --chown=agent:agent . /opt/agent/seed

# Normaliza line endings e permissões em /opt/agent/seed
RUN find /opt/agent/seed -name '*.sh' -type f -exec sed -i 's/\r$//' {} \; \
    && chmod +x /opt/agent/seed/scripts/tick.sh \
                /opt/agent/seed/_platform/mcp-bootstrap.sh \
                /opt/agent/seed/docker/entrypoint.sh \
    && find /opt/agent/seed/scripts/lib -name '*.sh' -exec chmod +x {} \; 2>/dev/null || true \
    && mkdir -p /workspace \
    && chown -R agent:agent /opt/agent /workspace /home/agent

WORKDIR /workspace
USER agent

# Entrypoint fora do volume; vai popular /workspace se necessário.
ENTRYPOINT ["bash", "/opt/agent/seed/docker/entrypoint.sh"]
