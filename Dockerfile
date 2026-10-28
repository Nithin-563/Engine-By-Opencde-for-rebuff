FROM node:22-bookworm-slim

# Tools the agent is allowed to use inside its workspace.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates git curl bash python3 procps ripgrep \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    WORKSPACE_ROOT=/data/workspaces

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /data/workspaces && chown -R node:node /data /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "src/server.js"]
