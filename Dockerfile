# Guffy engine — Node 22 on Debian slim.
# Render uses this file when the service environment is "Docker" and it sits at
# the repo root next to package.json.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates jq \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Workspace scratch space. Attach a Render disk here for persistence across
# deploys; without one, files re-materialise from Supabase on first use.
ENV PORT=8080
ENV DATA_DIR=/data/workspaces
RUN mkdir -p /data/workspaces
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "src/index.js"]
