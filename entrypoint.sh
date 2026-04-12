#!/bin/sh
# Entrypoint for the gmr-mcp-server container.
#
# Responsibilities (in order):
#   1. Ensure $HOME/.claude exists and is writable (PVC mount).
#   2. Seed $HOME/.claude/.credentials.json from the read-only Secret mount
#      the FIRST time the container boots against an empty PVC. On any
#      subsequent restart the PVC already holds the most recently refreshed
#      OAuth tokens, so we leave them alone.
#   3. Write /tmp/gmr-mcp.json pointing Claude CLI at the bundled MCP server.
#   4. Exec the proxy.
#
# Why a PVC instead of emptyDir:
#   Claude's OAuth refresh ROTATES the refresh token — using it gives a new
#   access+refresh pair and invalidates the old one. An emptyDir is wiped on
#   pod restart, so we'd re-seed from the Secret (which holds the original
#   now-rotated-and-invalid RT). A PVC persists the refreshed tokens across
#   pod lifecycles. The Secret is just a one-time bootstrap.
#
# Why the leading dot in .credentials.json:
#   That's where the Claude CLI stores its OAuth state. The k8s Secret uses
#   the non-dotted key "credentials.json" for readability (dotted keys are
#   awkward in yaml and kubectl output), and we rename on seed.

set -eu

CLAUDE_DIR="${HOME}/.claude"
CLAUDE_CREDS="${CLAUDE_DIR}/.credentials.json"
SECRET_CREDS="/run/secrets/claude/credentials.json"
MCP_CONFIG="/tmp/gmr-mcp.json"

# 1+2: make sure we have a writable ~/.claude with credentials in it
mkdir -p "${CLAUDE_DIR}"

# Always re-seed from the Secret if it's newer than what's on the PVC.
# This ensures that updating the K8s Secret + restarting the pod picks up
# fresh credentials even when the PVC already has (possibly stale) tokens.
if [ -s "${SECRET_CREDS}" ]; then
    if [ ! -s "${CLAUDE_CREDS}" ] || [ "${SECRET_CREDS}" -nt "${CLAUDE_CREDS}" ]; then
        echo "[entrypoint] Seeding credentials from Secret mount → PVC"
        cp "${SECRET_CREDS}" "${CLAUDE_CREDS}"
        chmod 600 "${CLAUDE_CREDS}"
    else
        echo "[entrypoint] Using existing credentials from PVC (token refresh persists here)"
    fi
elif [ ! -s "${CLAUDE_CREDS}" ]; then
    echo "[entrypoint] FATAL: no credentials in PVC and no Secret mounted at ${SECRET_CREDS}" >&2
    echo "[entrypoint] Mount the claude-credentials Secret or seed the PVC manually." >&2
    exit 1
fi

# 3: write the MCP config that the proxy references via --mcp-config
cat > "${MCP_CONFIG}" <<EOF
{
  "mcpServers": {
    "gmr": {
      "command": "node",
      "args": ["${MCP_SERVER_PATH:-/app/src/index.js}"],
      "env": {
        "GMR_API_URL": "${GMR_API_URL:-http://gmr-api.gmr.svc.cluster.local}"
      }
    }
  }
}
EOF
echo "[entrypoint] Wrote MCP config to ${MCP_CONFIG}"

# 4: hand off to the proxy
exec python3 /app/claude-proxy.py --port "${PORT:-8090}"
