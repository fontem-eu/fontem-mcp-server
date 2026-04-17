# gmr-mcp-server — bundles the Claude proxy and the MCP server into one image.
#
# Runtime:
#   * /app/claude-proxy.py  Python HTTP server on :8090
#   * /app/src/index.js     stdio MCP server, spawned by Claude CLI per request
#   * /usr/local/bin/claude Claude Code CLI, authenticated via OAuth credentials
#                           mounted at $HOME/.claude/credentials.json
#
# The entrypoint seeds $HOME/.claude from a read-only Kubernetes Secret into a
# writable PVC-backed location on first boot, then execs the proxy. Subsequent
# token refreshes persist in the PVC and survive pod restarts.

FROM node:22-slim

COPY void42-ca.crt /usr/local/share/ca-certificates/void42-ca.crt

# System deps: Python for the proxy, git for CLI MCP resolution, ca-certs
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        ca-certificates \
        git \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm config set registry https://nexus.void42.internal/repository/npm-proxy/ --global

# Install the Claude Code CLI globally (provides /usr/local/bin/claude)
RUN npm install -g --omit=dev @anthropic-ai/claude-code@2.1.101 \
    && npm cache clean --force

WORKDIR /app

# MCP server deps — installed first for layer cacheability
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source
COPY src/ ./src/
COPY claude-proxy.py ./claude-proxy.py
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV HOME=/claude-home \
    CLAUDE_CLI_PATH=/usr/local/bin/claude \
    MCP_SERVER_PATH=/app/src/index.js \
    GMR_API_URL=http://gmr-api.gmr.svc.cluster.local

EXPOSE 8090

ENTRYPOINT ["/app/entrypoint.sh"]
