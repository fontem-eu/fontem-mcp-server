/**
 * Streamable HTTP transport, so users can point their own LLM client at
 * Fontem instead of Fontem hosting a model for them.
 *
 * Why this exists rather than an in-app assistant on the user's
 * subscription: no provider sells that. Anthropic prohibited subscription
 * OAuth tokens in third-party tools (2026-02-20) and blocked them
 * (2026-04-04); OpenAI's ChatGPT plans have never included API access;
 * Mistral bills Le Chat and la Plateforme separately. A third party
 * cannot spend a user's subscription.
 *
 * What a third party *can* do is be the thing the user's own first-party
 * client talks to. Their client, their subscription, their quota — and no
 * inference cost to us at all.
 *
 * Auth here is Fontem's own bearer token, authorising access to Fontem
 * data. That is entirely ours to grant, and is a different thing from the
 * provider credential we deliberately do not want to hold.
 */
import { randomUUID } from 'node:crypto'
import http from 'node:http'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

const PORT = Number(process.env.MCP_HTTP_PORT || 8091)
const PATH = process.env.MCP_HTTP_PATH || '/mcp'

/**
 * Verify a Fontem token and resolve it to a user.
 *
 * Delegated to the community API rather than re-implemented: it already
 * owns sessions, and a second token verifier is a second place for the
 * rules to drift. Returns null when the token is not usable, and the
 * caller turns that into a 401 — never into anonymous access, because a
 * tool server that silently degrades to anonymous is a data leak.
 */
async function resolveUser(token, apiBase) {
  if (!token) return null
  try {
    const res = await fetch(`${apiBase}/assist/mcp-tokens/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) return null
    const body = await res.json()
    return body.user_id ? body : null
  } catch {
    // Network failure resolves to "deny". A tool server that serves
    // anonymously when its auth backend is unreachable is worse than one
    // that is briefly unavailable.
    return null
  }
}

function unauthorized(res, detail) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    // Tells a compliant MCP client where to get a token instead of
    // leaving it to guess.
    'WWW-Authenticate': 'Bearer realm="fontem"',
  })
  res.end(JSON.stringify({ error: 'unauthorized', detail }))
}

export async function startHttp(server) {
  const apiBase = (process.env.COMMUNITY_API_URL || 'http://fontem-community-api').replace(/\/$/, '')

  // Sessions are per-connection. The transport keeps its own id; we hold
  // the map so a reconnecting client resumes rather than re-initialising.
  const transports = new Map()

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, transport: 'streamable-http' }))
      return
    }

    if (url.pathname !== PATH) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not_found' }))
      return
    }

    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const user = await resolveUser(token, apiBase)
    if (!user) {
      unauthorized(res, 'A Dargle access token is required. Create one in Account settings.')
      return
    }

    const sessionId = req.headers['mcp-session-id']
    let transport = sessionId ? transports.get(sessionId) : undefined

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      await server.connect(transport)
    }

    await transport.handleRequest(req, res)
  })

  await new Promise((resolve) => httpServer.listen(PORT, '0.0.0.0', resolve))
  // stderr on purpose: stdout is the stdio transport's channel, and
  // writing to it corrupts the protocol for the other mode.
  process.stderr.write(`fontem mcp: streamable-http on :${PORT}${PATH}\n`)
  return httpServer
}
