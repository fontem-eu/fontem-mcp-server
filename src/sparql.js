/**
 * SPARQL query proxy for the AI helper.
 *
 * The MCP `sparql_query` tool runs against the platform's Virtuoso
 * triple store. The Virtuoso role bound to the MCP user *should* be
 * SPARQL_SELECT-only, but we also enforce read-only at this layer —
 * a misconfigured role can't be exploited from an injected prompt.
 *
 * The write-keyword check is a regex scan over the query text rather
 * than a real SPARQL parser. That's deliberate:
 *   - SPARQL 1.1 has a small, fixed set of update keywords (INSERT,
 *     DELETE, LOAD, CLEAR, CREATE, DROP, COPY, MOVE, ADD); a parser
 *     would be overkill
 *   - We anchor on whitespace boundaries so identifiers like
 *     "DELETETIONDATE" don't false-positive
 *   - SPARQL is case-insensitive on keywords, so the regex is too
 */
const SPARQL_WRITE_KEYWORDS = [
  'INSERT', 'DELETE', 'LOAD', 'CLEAR', 'CREATE', 'DROP',
  'COPY', 'MOVE', 'ADD',
]
const SPARQL_WRITE_RE = new RegExp(
  String.raw`(^|[\s;])(` + SPARQL_WRITE_KEYWORDS.join('|') + String.raw`)([\s{(<])`,
  'i',
)

export const MAX_QUERY_CHARS = 8000

/** Returns null when the query is read-only; an error message otherwise. */
export function checkReadOnly(query) {
  if (typeof query !== 'string') {
    return 'Query must be a string.'
  }
  if (query.length > MAX_QUERY_CHARS) {
    return `Query too long (max ${MAX_QUERY_CHARS} chars).`
  }
  if (SPARQL_WRITE_RE.test(query)) {
    return 'SPARQL UPDATE/INSERT/DELETE/CLEAR/LOAD/etc are blocked. '
      + 'This tool is read-only — use SELECT, CONSTRUCT, ASK, or DESCRIBE.'
  }
  return null
}

/** POST the query to the configured SPARQL endpoint and return the
 * response body. Caller is responsible for the read-only check. */
export async function postSparql(endpoint, query, opts = {}) {
  const form = new URLSearchParams({
    query,
    format: 'application/sparql-results+json',
    timeout: String(opts.timeout_ms || 30000),
  })
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'Fontem-MCP/1.0 (+https://fontem.eu; team@fontem.eu)',
      },
      body: form.toString(),
    })
    if (!res.ok) {
      const body = await res.text()
      return JSON.stringify({
        error: `SPARQL ${res.status}: ${res.statusText}`,
        detail: body.slice(0, 500),
      })
    }
    return await res.text()
  } catch (err) {
    return JSON.stringify({ error: `SPARQL unreachable: ${err.message}` })
  }
}

/** Convenience wrapper: validates + posts. */
export async function sparqlQuery(endpoint, query, opts = {}) {
  const refusal = checkReadOnly(query)
  if (refusal) return JSON.stringify({ error: refusal })
  return postSparql(endpoint, query, opts)
}
