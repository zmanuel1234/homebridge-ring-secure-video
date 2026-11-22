import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import test from 'node:test'
import zlib from 'node:zlib'

// ring-client-api 14.3.0 sends its requests through Node's fetch with an undici Agent and asks
// for undici ^7.19.2. On Node 26, undici before 7.27.1 doesn't decompress Ring's (gzip) answers,
// so signing in and token renewal fail (dgreif/ring#1876, #1884). The plugin asks for 7.27.1+.

// resolves packages as ring-client-api's own files do
const requireFromRingClientApi = createRequire(import.meta.resolve('ring-client-api'))

const atLeast7271 = (version) => {
  const [major, minor, patch] = version.split('.').map(Number)
  return major === 7 && (minor > 27 || (minor === 27 && patch >= 1))
}

test('the plugin asks for undici 7.27.1 or newer within 7.x', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const range = pkg.dependencies.undici
  assert.match(range, /^\^7\.\d+\.\d+$/, range)
  assert.ok(atLeast7271(range.slice(1)), range)
})

test('ring-client-api gets an undici that decompresses Ring\'s answers on Node 26', () => {
  const { version } = requireFromRingClientApi('undici/package.json')
  assert.ok(atLeast7271(version), `ring-client-api loads undici ${version}`)
})

test("a gzip-compressed answer reads back through ring-client-api's undici Agent", async (t) => {
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
  const { Agent } = requireFromRingClientApi('undici'),
    dispatcher = new Agent()
  t.after(() => dispatcher.close())
  const response = await fetch(`http://127.0.0.1:${server.address().port}/oauth/token`, {
    dispatcher,
  })
  assert.deepEqual(await response.json(), answer)
})
