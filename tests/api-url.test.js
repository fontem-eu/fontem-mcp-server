/**
 * Pre-rename the MCP server defaulted GMR_API_URL to
 *   http://gmr-api.gmr.svc.cluster.local
 * That DNS name is NXDOMAIN in every fontem-* namespace post-rename,
 * so every MCP tool call (search_entities, get_company, get_contracts,
 * ...) silently failed at the network layer. The chart now sets
 * GMR_API_URL explicitly via gmrApiUrl in values.yaml, but a dev
 * running `node src/index.js` locally still hits the default. Pin
 * that the default targets the post-rename Service so the same
 * mistake can't recur silently.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Source-read rather than import: `src/index.js` calls
// `await server.connect(transport)` at top-level, which starts the
// MCP stdio server and never returns. Importing the module would hang
// the test process. Parsing the URL default out of the source string
// pins the same contract without needing to execute the server.
const SRC = readFileSync(
  new URL('../src/index.js', import.meta.url),
  'utf-8',
)

describe('GMR_API default URL', () => {
  it('points at fontem-api, not the stale gmr-api name', () => {
    const match = SRC.match(
      /process\.env\.GMR_API_URL\s*\|\|\s*['"]([^'"]+)['"]/,
    )
    assert.ok(match, 'expected a fall-back default for GMR_API_URL')
    const defaultUrl = match[1]
    assert.ok(
      !defaultUrl.includes('gmr-api'),
      `Default GMR_API_URL must not reference the stale gmr-api name; got ${defaultUrl}`,
    )
    assert.strictEqual(defaultUrl, 'http://fontem-api')
  })

  it('reads GMR_API_URL from the process env at startup', () => {
    // Sanity: env override is a plain `process.env.GMR_API_URL` read so
    // the chart can override per-env (`gmrApiUrl` in values.yaml).
    assert.match(SRC, /process\.env\.GMR_API_URL/)
  })
})
