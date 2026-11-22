import assert from 'node:assert/strict'
import http from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import zlib from 'node:zlib'

// Ring sends its sign-in and token answers gzip-compressed. ring-client-api 14.3.0 read them
// with Node's fetch and an undici 7 Agent, which before undici 7.27.1 couldn't decompress them on
// Node 26 (dgreif/ring#1876, #1884). ring-client-api 15 reads them with undici's own fetch and
// Agent; CI runs this on Node 22, 24 and 26.

// resolves packages as ring-client-api's own files do
const requireFromRingClientApi = createRequire(import.meta.resolve('ring-client-api'))

test("a gzip-compressed answer reads back through ring-client-api's undici fetch and Agent", async (t) => {
  const answer = { access_token: 'access', refresh_token: 'refresh' },
    body = zlib.gzipSync(JSON.stringify(answer)),
    server = http
      .createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
        res.end(body)
      })
      .listen(0, '127.0.0.1')
  t.after(() => server.close())
  await new Promise((resolve) => server.once('listening', resolve))

  // as ring-client-api's rest client sends its requests
  const { Agent, fetch } = requireFromRingClientApi('undici'),
    dispatcher = new Agent()
  t.after(() => dispatcher.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/oauth/token`, {
    dispatcher,
  })
  assert.deepEqual(await response.json(), answer)
})
