#!/usr/bin/env python3
"""
Claude CLI proxy with MCP + SSE streaming.

Endpoints:
  POST /chat         — blocking JSON response (legacy)
  POST /chat/stream  — SSE stream (text/event-stream)
"""
import asyncio
import json
import os
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

CLAUDE_CLI = os.environ.get("CLAUDE_CLI_PATH", "/config/.local/bin/claude")
MCP_CONFIG = "/tmp/gmr-mcp.json"
MCP_TOOLS = ",".join(f"mcp__gmr__{t}" for t in [
    "search_entities", "get_company", "get_contracts", "get_authority",
    "explore_graph", "find_paths", "get_fundamentals", "validate_widget",
    "web_search", "propose_edit",
])

SYSTEM = """You are a research assistant for the GMR EU Knowledge Graph.
Use your MCP tools to search entities, explore the graph, and look up data.
When asked about data, ALWAYS use your tools — don't guess.
Be concise, cite specific numbers, and suggest widget embeds when relevant."""


def _build_args(message, system):
    return [
        CLAUDE_CLI, "-p", message,
        "--append-system-prompt", system,
        "--mcp-config", MCP_CONFIG,
        "--allowedTools", MCP_TOOLS,
    ]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        message = body.get("message", "")
        system = body.get("system", SYSTEM)

        if not message:
            self.send_error(400, "Missing message")
            return

        if self.path == "/chat/stream":
            self._handle_stream(message, system)
        elif self.path == "/chat":
            self._handle_blocking(message, system)
        else:
            self.send_error(404)

    def _handle_blocking(self, message, system):
        """Legacy blocking response."""
        try:
            loop = asyncio.new_event_loop()
            result = loop.run_until_complete(self._call_blocking(message, system))
            loop.close()
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)[:500]}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def _handle_stream(self, message, system):
        """SSE streaming response — sends chunks as Claude generates them."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")  # close after streaming
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        # Send initial status so the frontend knows the connection is open
        self._send_sse("status", json.dumps({"phase": "connecting", "elapsed": 0}))

        try:
            loop = asyncio.new_event_loop()
            loop.run_until_complete(self._stream_claude(message, system))
            loop.close()
        except Exception as exc:
            self._send_sse("error", json.dumps({"error": str(exc)[:500]}))

        self._send_sse("done", json.dumps({"done": True}))

    def _send_sse(self, event, data):
        try:
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    async def _call_blocking(self, message, system):
        proc = await asyncio.create_subprocess_exec(
            *_build_args(message, system),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        if proc.returncode != 0:
            return {"error": stderr.decode()[:500]}
        return {"content": stdout.decode().strip()}

    async def _stream_claude(self, message, system):
        proc = await asyncio.create_subprocess_exec(
            *_build_args(message, system),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        start = time.time()
        got_output = False
        buffer = ""

        # Send heartbeat events every 2s while waiting for Claude to finish
        # tool calls. This keeps the connection alive and gives the user feedback.
        async def heartbeat():
            nonlocal got_output
            phases = [
                (0, "thinking"),
                (3, "searching"),
                (8, "analyzing"),
                (20, "synthesizing"),
            ]
            while not got_output:
                elapsed = time.time() - start
                phase = "thinking"
                for threshold, name in phases:
                    if elapsed >= threshold:
                        phase = name
                self._send_sse("status", json.dumps({
                    "phase": phase,
                    "elapsed": round(elapsed, 1),
                }))
                await asyncio.sleep(2)

        heartbeat_task = asyncio.create_task(heartbeat())

        try:
            while True:
                chunk = await asyncio.wait_for(proc.stdout.read(256), timeout=300)
                if not chunk:
                    break
                if not got_output:
                    got_output = True
                    heartbeat_task.cancel()
                    self._send_sse("status", json.dumps({
                        "phase": "streaming",
                        "elapsed": round(time.time() - start, 1),
                    }))
                text = chunk.decode("utf-8", errors="replace")
                buffer += text
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    self._send_sse("chunk", json.dumps({"text": line + "\n"}))

            if buffer.strip():
                self._send_sse("chunk", json.dumps({"text": buffer}))
        finally:
            heartbeat_task.cancel()

        await proc.wait()

    def log_message(self, *a):
        pass


class ThreadedServer(ThreadingMixIn, HTTPServer):
    pass


if __name__ == "__main__":
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8090
    srv = ThreadedServer(("0.0.0.0", port), Handler)
    print(f"Claude MCP proxy (streaming) on :{port}", flush=True)
    srv.serve_forever()
