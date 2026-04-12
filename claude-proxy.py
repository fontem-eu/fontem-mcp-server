#!/usr/bin/env python3
"""
Claude CLI proxy with MCP + SSE streaming.

Uses --output-format stream-json --verbose to get structured events
from Claude CLI, including tool use notifications. These are forwarded
as rich SSE status events so the frontend can show real activity.

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

# Human-friendly tool descriptions for the UI
TOOL_LABELS = {
    "mcp__gmr__search_entities": "Searching entities",
    "mcp__gmr__get_company": "Looking up company",
    "mcp__gmr__get_contracts": "Fetching contracts",
    "mcp__gmr__get_authority": "Looking up authority",
    "mcp__gmr__explore_graph": "Exploring graph",
    "mcp__gmr__find_paths": "Finding connections",
    "mcp__gmr__get_fundamentals": "Loading financials",
    "mcp__gmr__validate_widget": "Validating widget",
    "mcp__gmr__web_search": "Searching the web",
    "mcp__gmr__propose_edit": "Proposing report edit",
    "ToolSearch": "Discovering tools",
}


def _build_args_text(message, system):
    """Build args for blocking text output."""
    return [
        CLAUDE_CLI, "-p", message,
        "--append-system-prompt", system,
        "--mcp-config", MCP_CONFIG,
        "--allowedTools", MCP_TOOLS,
    ]


def _build_args_stream(message, system):
    """Build args for streaming JSON output with tool visibility."""
    return [
        CLAUDE_CLI, "-p", message,
        "--append-system-prompt", system,
        "--mcp-config", MCP_CONFIG,
        "--allowedTools", MCP_TOOLS,
        "--output-format", "stream-json",
        "--verbose",
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
        """SSE streaming with real tool-use visibility from Claude CLI."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True

        self._send_sse("status", json.dumps({
            "phase": "connecting", "detail": "Starting assistant...", "elapsed": 0,
        }))

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
            *_build_args_text(message, system),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300)
        if proc.returncode != 0:
            return {"error": stderr.decode()[:500]}
        return {"content": stdout.decode().strip()}

    async def _stream_claude(self, message, system):
        start = time.time()
        proc = await asyncio.create_subprocess_exec(
            *_build_args_stream(message, system),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        self._send_sse("status", json.dumps({
            "phase": "thinking", "detail": "Processing your request...",
            "elapsed": round(time.time() - start, 1),
        }))

        buffer = ""
        tool_calls = 0
        streaming_started = False

        while True:
            chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=300)
            if not chunk:
                break
            buffer += chunk.decode("utf-8", errors="replace")

            # Process complete JSON lines
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue

                try:
                    event = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue

                etype = event.get("type", "")
                elapsed = round(time.time() - start, 1)

                if etype == "assistant":
                    msg = event.get("message", {})
                    for block in msg.get("content", []):
                        btype = block.get("type", "")

                        if btype == "tool_use":
                            tool_calls += 1
                            tool_name = block.get("name", "")
                            tool_input = block.get("input", {})
                            label = TOOL_LABELS.get(tool_name, tool_name)

                            # Build a human-friendly detail string
                            query = (tool_input.get("query") or
                                     tool_input.get("gmr_id") or
                                     tool_input.get("entity_id") or "")
                            detail = f"{label}"
                            if query:
                                detail += f': "{query}"'

                            self._send_sse("status", json.dumps({
                                "phase": "tool_use",
                                "tool": tool_name,
                                "detail": detail,
                                "elapsed": elapsed,
                            }))

                        elif btype == "text":
                            text = block.get("text", "")
                            if text:
                                if not streaming_started:
                                    streaming_started = True
                                    self._send_sse("status", json.dumps({
                                        "phase": "streaming",
                                        "detail": "Writing response...",
                                        "elapsed": elapsed,
                                    }))
                                # Send text in chunks (split by newlines for granularity)
                                for text_line in text.split("\n"):
                                    self._send_sse("chunk", json.dumps({
                                        "text": text_line + "\n",
                                    }))

                elif etype == "result":
                    # Final result — if we haven't streamed text yet, extract it
                    result_text = event.get("result", "")
                    if not streaming_started and result_text:
                        self._send_sse("status", json.dumps({
                            "phase": "streaming",
                            "detail": "Writing response...",
                            "elapsed": elapsed,
                        }))
                        self._send_sse("chunk", json.dumps({
                            "text": result_text,
                        }))
                    # Forward real token usage so callers can bill accurately.
                    # Claude CLI's stream-json result event carries a
                    # {"usage": {"input_tokens": N, "output_tokens": N}} block.
                    usage = event.get("usage") or {}
                    inp = usage.get("input_tokens")
                    out = usage.get("output_tokens")
                    if isinstance(inp, int) and isinstance(out, int):
                        self._send_sse("usage", json.dumps({
                            "input_tokens": inp,
                            "output_tokens": out,
                        }))

        # Process any remaining buffer
        if buffer.strip():
            try:
                event = json.loads(buffer.strip())
                if event.get("type") == "result":
                    result_text = event.get("result", "")
                    if not streaming_started and result_text:
                        self._send_sse("chunk", json.dumps({"text": result_text}))
            except (json.JSONDecodeError, ValueError):
                pass

        await proc.wait()

    def log_message(self, *a):
        pass


class ThreadedServer(ThreadingMixIn, HTTPServer):
    pass


# ── OAuth keepalive ───────────────────────────────────────────
#
# Claude CLI's OAuth token expires after ~7 days of inactivity.
# This background thread makes a cheap CLI call every 4 hours to
# trigger token refresh, preventing silent auth expiry.

import threading

KEEPALIVE_INTERVAL = 4 * 3600  # seconds between pings


def _keepalive_loop():
    """Periodically invoke Claude CLI to trigger OAuth token refresh."""
    while True:
        time.sleep(KEEPALIVE_INTERVAL)
        try:
            proc = asyncio.run(
                asyncio.create_subprocess_exec(
                    CLAUDE_CLI, "-p", "ping", "--max-turns", "1",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
            )
            asyncio.run(asyncio.wait_for(proc.wait(), timeout=60))
            print(f"[keepalive] token refreshed (rc={proc.returncode})", flush=True)
        except Exception as exc:
            print(f"[keepalive] failed: {exc}", flush=True)


if __name__ == "__main__":
    # Start the keepalive daemon thread
    t = threading.Thread(target=_keepalive_loop, daemon=True, name="oauth-keepalive")
    t.start()
    print(f"[keepalive] started (every {KEEPALIVE_INTERVAL // 3600}h)", flush=True)

    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8090
    srv = ThreadedServer(("0.0.0.0", port), Handler)
    print(f"Claude MCP proxy (streaming) on :{port}", flush=True)
    srv.serve_forever()
