#!/usr/bin/env python3
"""Claude CLI proxy with MCP server for GMR Knowledge Graph."""
import asyncio
import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

CLAUDE_CLI = os.environ.get("CLAUDE_CLI_PATH", "/config/.local/bin/claude")

SYSTEM_PROMPT = """You are a research assistant for the GMR EU Knowledge Graph platform.
You have MCP tools to search entities, explore the graph, look up contracts, and more.
When asked about data, USE YOUR TOOLS — don't guess. Be concise and cite specific values."""


class ProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/chat":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        message = body.get("message", "")
        system = body.get("system", SYSTEM_PROMPT)
        if not message:
            self.send_error(400, "Missing message")
            return
        try:
            result = asyncio.run(self._call_claude(message, system))
            self._respond(200, result)
        except Exception as exc:
            self._respond(500, {"error": str(exc)[:500]})

    def _respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    async def _call_claude(self, message, system):
        mcp_tools = ",".join(
            f"mcp__gmr__{t}" for t in [
                "search_entities", "get_company", "get_contracts",
                "get_authority", "explore_graph", "find_paths",
                "get_fundamentals", "validate_widget", "web_search",
            ]
        )
        args = [CLAUDE_CLI, "-p", message,
                "--append-system-prompt", system,
                "--mcp-config", "/tmp/gmr-mcp.json",
                "--allowedTools", mcp_tools]
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        if proc.returncode != 0:
            raise RuntimeError(stderr.decode()[:500])
        return {"content": stdout.decode().strip()}

    def log_message(self, fmt, *args):
        pass

if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8090
    server = HTTPServer(("0.0.0.0", port), ProxyHandler)
    print(f"Claude proxy listening on :{port}", flush=True)
    server.serve_forever()
