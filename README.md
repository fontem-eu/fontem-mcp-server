# fontem-mcp-server

Claude proxy: a Model Context Protocol server that surfaces Fontem entities + queries to Claude via standard MCP tools. Deployed as the claude-proxy Deployment; one replica with a PVC-backed Claude home dir for OAuth + session state.

## Deploy

CI auto-deploys to the testing env on every merge to main. Promotion to staging / prod is **manual** — bump the version in `gitops/<env>/<service>.yaml` to land it in a given environment.

## Convention

See [/config/repos/CLAUDE.md](https://contribute.void42.internal/fontem/gitops) for workspace-wide rules (feature branches + CI gate, no direct push to main, full gate before declaring done, conventional commits).
