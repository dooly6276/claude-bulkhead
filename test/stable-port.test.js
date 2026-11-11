'use strict'
const test = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const path = require('path')
const { stablePort, pickFree, sequence, startPort, keyFor, parseRange, DEFAULT_RANGE, BROWSER_BLOCKED } = require('../src/stable-port')
const { findStable, stableKey, main } = require('../src/port-cli')

const sink = () => ({ text: '', write(s) { this.text += s } })

test('the start port is the sha1 of the resolved root, as a uint32, inside the range', () => {
  const root = path.resolve('/work/shop')
  const want = 3000 + (crypto.createHash('sha1').update(root).digest().readUInt32BE(0) % 1000)
  assert.strictEqual(startPort(keyFor('/work/shop')), want)
  assert.strictEqual(startPort(keyFor('/work/shop')), startPort(keyFor('/work/shop/')))
  assert.ok(startPort(keyFor('/work/blog')) >= 3000)
})

test('Windows paths are hashed in lower case', () => {
  assert.strictEqual(keyFor('/Work/Shop', 'win32'), keyFor('/work/shop', 'win32'))
  assert.notStrictEqual(keyFor('/Work/Shop', 'linux'), keyFor('/work/shop', 'linux'))
})

test('the sequence stays in the range, wraps, and skips browser-blocked ports', () => {
  const seq = sequence('anything', { min: 3600, max: 3700 })
  assert.strictEqual(seq.length, 100) // 3659 is blocked
  assert.ok(!seq.includes(3659))
  assert.ok(seq.every(p => p >= 3600 && p <= 3700))
  assert.strictEqual(new Set(seq).size, seq.length)
  const all = sequence('x', { min: 4040, max: 4050 })
  assert.ok(!all.includes(4045) && all.length === 10)
  assert.ok(BROWSER_BLOCKED.has(4045))
})

test('the same worktree always gets the same port; busy ports move it on in a fixed order', async () => {
  const free = () => Promise.resolve(true)
  const a = await stablePort('/work/shop', DEFAULT_RANGE, { bind: free })
  assert.strictEqual(a, await stablePort('/work/shop', DEFAULT_RANGE, { bind: free }))
  assert.strictEqual(a, startPort(keyFor('/work/shop')) === 3659 ? 3660 : startPort(keyFor('/work/shop')))
  const busy = new Set([a])
  const next = await stablePort('/work/shop', DEFAULT_RANGE, { bind: (h, p) => Promise.resolve(!busy.has(p)) })
  assert.strictEqual(next, sequence(keyFor('/work/shop'))[1])
  assert.strictEqual(await stablePort('/work/shop', { min: 3000, max: 3001 }, { bind: () => Promise.resolve(false) }), null)
})

test('pickFree is the same order with the busy ports known', () => {
  const key = keyFor('/work/shop')
  const first = sequence(key)[0]
  assert.strictEqual(pickFree(key, new Set()), first)
  assert.strictEqual(pickFree(key, new Set([first])), sequence(key)[1])
  assert.strictEqual(pickFree(key, new Set(sequence(key))), null)
})

test('range parsing', () => {
  assert.deepStrictEqual(parseRange('4000-4099'), { min: 4000, max: 4099 })
  for (const bad of ['4000', '4099-4000', '80-90', '1-99999', 'a-b', '', undefined]) assert.strictEqual(parseRange(bad), null, String(bad))
})

test('port --stable: the first free port, with who held the skipped ones', async () => {
  const key = keyFor('/work/shop')
  const seq = sequence(key)
  const owners = ports => Object.fromEntries(ports.map(p => [p, { pid: 111, name: 'node', session: 'session 812 in ~/dev/api on branch main' }]))
  const r = await findStable(key, DEFAULT_RANGE, { bind: (h, p) => Promise.resolve(p !== seq[0]), owners })
  assert.deepStrictEqual([r.port, r.preferred], [seq[1], seq[0]])
  assert.deepStrictEqual(r.skipped.map(s => [s.port, s.session]), [[seq[0], 'session 812 in ~/dev/api on branch main']])
  const none = await findStable(key, { min: 5000, max: 5001 }, { bind: () => Promise.resolve(false), owners: () => ({}) })
  assert.strictEqual(none.port, null)
  assert.strictEqual(none.skipped.length, 2)
})

test('--name hashes the name, not the folder; default is the git worktree root', () => {
  assert.strictEqual(stableKey('storybook').key, 'name:storybook')
  assert.strictEqual(stableKey('storybook').root, null)
  const k = stableKey(null, __dirname)
  assert.ok(k.root && path.resolve(__dirname).startsWith(k.root))
  assert.strictEqual(k.key, keyFor(k.root))
})

test('port --stable prints the port, and --json the details; a bad range is an error', async () => {
  const out = sink()
  const err = sink()
  await main(['--stable', '--name', 'cli-test-name', '--range', '48000-48999'], { stdout: out, stderr: err })
  const port = Number(out.text)
  assert.ok(port >= 48000 && port <= 48999, out.text)
  const j = sink()
  await main(['--stable', '--name=cli-test-name', '--range=48000-48999', '--json'], { stdout: j, stderr: sink() })
  const parsed = JSON.parse(j.text)
  assert.strictEqual(parsed.port, port)
  assert.deepStrictEqual([parsed.name, parsed.range, parsed.root], ['cli-test-name', { min: 48000, max: 48999 }, null])
  const bad = sink()
  const saved = process.exitCode
  await main(['--stable', '--range', '5-1'], { stdout: sink(), stderr: bad })
  assert.match(bad.text, /--range needs LOW-HIGH/)
  assert.strictEqual(process.exitCode, 1)
  process.exitCode = saved
})
