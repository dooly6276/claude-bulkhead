'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { explain, render, commandFrom, main } = require('../src/explain')
const { tempDir } = require('./helpers')

const t0 = Date.UTC(2026, 9, 13, 8)
const proc = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd, start, rss: 0, claudePid: null })
const KILL = 'pk' + 'ill -f node'

// Session 100 (acme-web) runs next dev on 3000. Session 200 (blog) is another one.
const snap = {
  procs: [
    proc(100, 1, 'claude', 'claude', t0),
    proc(111, 100, 'node', 'node next dev', t0 + 11e3),
    proc(200, 1, 'claude', 'claude', t0 + 60e3),
    proc(211, 200, 'node', 'node vite', t0 + 70e3),
  ],
  ports: [{ port: 3000, pid: 111 }],
}
const files = () => new Map([
  [100, { cwd: '/home/dev/acme-web', startedAt: 0, sessionId: 'sess-a' }],
  [200, { cwd: '/home/dev/blog', startedAt: 0, sessionId: 'sess-b' }],
])
const ctx = (over = {}) => ({
  files, snapshot: () => snap, probe: async () => true, memory: () => ({ freeGb: 16, totalGb: 32 }),
  isAlive: () => true, run: () => { throw new Error('no git') }, cwd: '/home/dev/blog', ...over,
})
const verdict = (r, guard) => r.guards.find(g => g.guard === guard)

test('a harmless command passes every guard and reads no process data', async () => {
  const r = await explain('ls -la', ctx({ snapshot: () => assert.fail('no process scan') , memory: () => assert.fail('no memory read') }))
  assert.strictEqual(r.blocked, false)
  assert.deepStrictEqual(r.guards.map(g => g.status), Array(7).fill('pass'))
  assert.match(render(r), /passes every guard/)
})

test('kill by name: block with the rule, the sessions that run that program, and how to allow it', async () => {
  const r = await explain(KILL, ctx())
  const g = verdict(r, 'kill-guard')
  assert.strictEqual(g.status, 'block')
  assert.strictEqual(g.rule, 'pkill')
  assert.ok(g.evidence.some(e => /node pid 111 .*session with pid 100 \(\/home\/dev\/acme-web\)/.test(e)), g.evidence.join('|'))
  assert.ok(g.evidence.some(e => /node pid 211 .*session with pid 200/.test(e)))
  assert.match(g.message, /^\[bulkhead\] kill-guard: pkill\/killall matches every process with that name/)
  assert.match(g.message, /`bulkhead allow <code>`/)
  assert.strictEqual(g.config, '{"killGuard":{"allowNames":["node"]}}')
  assert.strictEqual(g.disable, 'kill-guard')
  assert.strictEqual(g.allowOnce, true)
  assert.strictEqual(r.blocked, true)
  const text = render(r)
  assert.match(text, /BLOCKED by kill-guard pkill/)
  assert.match(text, /allow always \{"killGuard":\{"allowNames":\["node"\]\}\} in \.claude\/bulkhead\.json/)
  assert.match(text, /BULKHEAD_DISABLE=kill-guard/)
})

test('a port held by another session names its owner; the same session passes', async () => {
  const other = await explain('npx next dev', ctx({ sessionId: 'sess-b' }))
  const g = verdict(other, 'port-guard')
  assert.strictEqual(g.status, 'block')
  assert.strictEqual(g.rule, 'port-in-use')
  assert.match(g.evidence[0], /node pid 111 on port 3000 belongs to the session with pid 100 \(\/home\/dev\/acme-web\)/)
  assert.strictEqual(g.config, '{"portGuard":{"ignorePorts":[3000]}}')
  assert.strictEqual(other.session.pid, 200)
  const own = await explain('npx next dev', ctx({ sessionId: '100' }))
  assert.strictEqual(verdict(own, 'port-guard').status, 'pass')
  const fresh = await explain('npx next dev', ctx())
  assert.strictEqual(verdict(fresh, 'port-guard').status, 'block', 'a new session is not the owner')
})

test('kill by port is the port-guard kill-by-port rule', async () => {
  const r = await explain('lsof -ti :3000 | xargs kill -9', ctx({ sessionId: 'sess-b' }))
  const g = verdict(r, 'port-guard')
  assert.strictEqual(g.rule, 'kill-by-port')
  assert.match(g.evidence[0], /port 3000/)
})

test('port probe says nothing listens: no process scan', async () => {
  const r = await explain('npx next dev', ctx({ probe: async () => false, snapshot: () => assert.fail('no scan') }))
  assert.strictEqual(verdict(r, 'port-guard').status, 'pass')
})

test('checkout-guard names the session that works in the same tree', async () => {
  const run = (args) => {
    if (args[0] === 'rev-parse') return '/home/dev/blog'
    if (args[0] === 'status') return ' M a.js\n M b.js'
    throw new Error('no')
  }
  const same = () => new Map([[200, { cwd: '/home/dev/blog', startedAt: 0, sessionId: 'sess-b' }], [300, { cwd: '/home/dev/blog', startedAt: 0, sessionId: 'sess-c' }]])
  const r = await explain('git add -A', ctx({ files: same, run, sessionId: 'sess-b', cwd: '/home/dev/blog' }))
  const g = verdict(r, 'checkout-guard')
  assert.strictEqual(g.status, 'block')
  assert.strictEqual(g.rule, 'stage-all')
  assert.match(g.evidence[0], /session with pid 300 \(\/home\/dev\/blog\)/)
  assert.strictEqual(g.config, '{"checkoutGuard":{"stageAll":false}}')
  assert.match(g.message, /bulkhead allow <code>/)
})

test('memory-guard shows free RAM; basics shows the rule and its config key', async () => {
  const low = await explain('npm test', ctx({ memory: () => ({ freeGb: 0.5, totalGb: 32 }) }))
  const m = verdict(low, 'memory-guard')
  assert.strictEqual(m.rule, 'low-memory')
  assert.deepStrictEqual(m.evidence, ['0.5 GB of 32.0 GB RAM is free'])
  assert.strictEqual(m.config, '{"memory":{"minFreeGb":1}}')
  const rm = await explain('rm -rf /', ctx())
  const b = verdict(rm, 'basics')
  assert.strictEqual(b.rule, 'rm-root')
  assert.strictEqual(b.config, '{"basics":{"rmRoot":false}}')
  assert.strictEqual(b.disable, 'rm-root')
  const wait = await explain('sleep 600', ctx({ timeout: 900000 }))
  assert.strictEqual(verdict(wait, 'wait-guard').rule, 'long-sleep')
})

test('self-allow cannot be allowed once or in the config', async () => {
  const r = await explain('bulkhead allow 7F3K', ctx())
  const b = verdict(r, 'basics')
  assert.strictEqual(b.rule, 'self-allow')
  assert.strictEqual(b.allowOnce, false)
  assert.strictEqual(b.config, null)
  assert.ok(!/bulkhead allow <code>`, or/.test(b.message))
  assert.match(render(r), /not allowable/)
})

test('a guard that is turned off is reported as off', async () => {
  const old = process.env.BULKHEAD_DISABLE
  process.env.BULKHEAD_DISABLE = 'kill-guard'
  try {
    assert.strictEqual(verdict(await explain(KILL, ctx()), 'kill-guard').status, 'off')
  } finally {
    if (old === undefined) delete process.env.BULKHEAD_DISABLE
    else process.env.BULKHEAD_DISABLE = old
  }
})

test('explain never executes the command and never logs an event', () => {
  const state = tempDir()
  const marker = path.join(state, 'ran')
  const root = path.join(__dirname, '..')
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'bulkhead'), 'explain', '--json', '--', `touch ${marker}; ${KILL}`], {
    encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: state, BULKHEAD_DISABLE: '' },
  })
  assert.strictEqual(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.strictEqual(out.blocked, true)
  assert.ok(!fs.existsSync(marker), 'the command was not run')
  assert.deepStrictEqual(fs.readdirSync(state), [], 'no events.jsonl, no guards.log, no allow codes')
})

test('the command can be several words or one quoted string; usage when it is missing', async () => {
  assert.strictEqual(commandFrom(['--', 'git', 'commit', '-m', 'a b']), "git commit -m 'a b'")
  assert.strictEqual(commandFrom(['--cwd', '/x', '--', 'ls -la | wc']), 'ls -la | wc')
  assert.strictEqual(commandFrom(['--cwd', '/x']), null)
  let err = ''
  const old = process.exitCode
  await main(['--json'], { stderr: { write: s => (err += s) }, stdout: { write() {} } })
  assert.match(err, /usage: bulkhead explain/)
  assert.strictEqual(process.exitCode, 1)
  process.exitCode = old
})
