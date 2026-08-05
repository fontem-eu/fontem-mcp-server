/**
 * The remote MCP endpoint.
 *
 * The property that matters is the negative one: an unauthenticated
 * request must never reach a tool. A tool server that quietly degrades to
 * anonymous access is a data leak, not a convenience.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startHttp } from '../src/http-transport.js'

/** Minimal stand-in — startHttp only ever calls connect(). */
function fakeServer() {
  const connected = []
  return { connected, connect: async (t) => connected.push(t) }
}

async function withServer(fn) {
  process.env.MCP_HTTP_PORT = '0'
  const srv = await startHttp(fakeServer())
  const { port } = srv.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}

test('healthz is open, and says which transport is running', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, transport: 'streamable-http' })
  })
})

test('no token is refused, not served anonymously', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST' })
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.equal(body.error, 'unauthorized')
    // Point the client at how to fix it rather than leaving it guessing.
    assert.match(body.detail, /Account settings/)
  })
})

test('the 401 advertises how to authenticate', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, { method: 'POST' })
    assert.match(res.headers.get('www-authenticate') || '', /^Bearer /)
  })
})

test('a bad token is refused too', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: 'Bearer not-a-real-token' },
    })
    // resolveUser cannot reach the community API in a unit test, and the
    // failure direction must be "deny" rather than "allow".
    assert.equal(res.status, 401)
  })
})

test('unknown paths 404 rather than falling through to the tool endpoint', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/anything-else`)
    assert.equal(res.status, 404)
  })
})
