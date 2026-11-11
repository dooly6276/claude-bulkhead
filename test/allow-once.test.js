'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const allow = require('../src/allow-once')
const allowCli = require('../src/allow-cli')
const { withWayOut, ASK_USER } = require('../src/hook')
const { tempDir } = require('./helpers')

const KILL = 'pk' + 'ill -f node'
const T0 = Date.UTC(2026, 10, 11, 10)
const min = n => n * 60000
const block = (base, over = {}) => allow.issue({ guard: 'kill-guard', rule: 'pkill', command: KILL, cwd: '/work/a', session: 's1', ...over }, { base, now: T0 })

test('a code is 5 characters from the base32 alphabet and differs between blocks', () => {
  const base = tempDir()
  const a = block(base)
  const b = block(base, { command: 'other command' })
  assert.match(a, /^[A-HJ-NP-Z2-9]{5}$/)
  assert.notStrictEqual(a, b)
})

test('happy path: issue, approve, the guard consumes it once', () => {
  const base = tempDir()
  const code = block(base)
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/a', { base, now: T0 + 1 }), false, 'not approved yet')
  const res = allow.approve(code.toLowerCase(), { base, now: T0 + min(1) })
  assert.ok(res.ok)
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/a', { base, now: T0 + min(2) }), true)
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/a', { base, now: T0 + min(2) }), false, 'one use only')
})

test('whitespace around the command does not matter, a different command or folder does', () => {
  const base = tempDir()
  const code = block(base)
  allow.approve(code, { base, now: T0 })
  assert.strictEqual(allow.consume('kill-guard', 'pkill', `${KILL}x`, '/work/a', { base, now: T0 }), false)
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/b', { base, now: T0 }), false, 'wrong cwd')
  assert.strictEqual(allow.consume('port-guard', 'pkill', KILL, '/work/a', { base, now: T0 }), false, 'wrong guard')
  assert.strictEqual(allow.consume('kill-guard', 'other-rule', KILL, '/work/a', { base, now: T0 }), false, 'wrong rule')
  assert.strictEqual(allow.consume('kill-guard', 'pkill', `  ${KILL}\n`, '/work/a/', { base, now: T0 }), true)
})

test('a code expires after the ttl, and so does an approval', () => {
  const base = tempDir()
  const code = block(base)
  assert.deepStrictEqual(allow.approve(code, { base, now: T0 + min(11) }), { ok: false, reason: 'unknown' })
  const again = block(base)
  assert.ok(allow.approve(again, { base, now: T0 + min(9) }).ok)
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/a', { base, now: T0 + min(9) + min(10) + 1 }), false)
  assert.deepStrictEqual(allow.list({ base, now: T0 + min(30) }), [], 'pruned on read')
  assert.deepStrictEqual(fs.readdirSync(allow.dirOf(base)), [])
})

test('allowOnce.ttlMinutes changes the lifetime', () => {
  const base = tempDir()
  const code = allow.issue({ guard: 'kill-guard', rule: 'pkill', command: KILL, cwd: '/w' }, { base, now: T0, ttl: 2 })
  assert.deepStrictEqual(allow.approve(code, { base, now: T0 + min(3) }), { ok: false, reason: 'unknown' })
  assert.strictEqual(allow.ttlMs(undefined), min(10))
  assert.strictEqual(allow.ttlMs(0), min(10))
  assert.strictEqual(allow.ttlMs(3), min(3))
})

test('two guards blocking one command share a code, and approving it allows both once', () => {
  const base = tempDir()
  const a = block(base)
  const b = block(base, { guard: 'port-guard', rule: 'kill-by-port' })
  assert.strictEqual(a, b)
  const res = allow.approve(a, { base, now: T0 })
  assert.strictEqual(res.entries.length, 2)
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/a', { base, now: T0 }), true)
  assert.strictEqual(allow.consume('port-guard', 'kill-by-port', KILL, '/work/a', { base, now: T0 }), true)
})

test('approving twice, or an unknown code, reports why', () => {
  const base = tempDir()
  const code = block(base)
  assert.ok(allow.approve(code, { base, now: T0 }).ok)
  assert.strictEqual(allow.approve(code, { base, now: T0 }).reason, 'used')
  assert.strictEqual(allow.approve('ZZZZZ', { base, now: T0 }).reason, 'unknown')
  assert.strictEqual(allow.approve('', { base, now: T0 }).reason, 'no-code')
})

test('a corrupt state file is skipped and removed; nothing throws and nothing is allowed', () => {
  const base = tempDir()
  const dir = allow.dirOf(base)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'AAAAA-kill-guard-pkill.json'), '{not json')
  fs.writeFileSync(path.join(dir, 'BBBBB-kill-guard-pkill.json'), JSON.stringify({ code: 'BBBBB', approved: 1 }))
  assert.strictEqual(allow.consume('kill-guard', 'pkill', KILL, '/work/a', { base, now: T0 }), false)
  assert.deepStrictEqual(allow.list({ base, now: T0 }), [])
  assert.deepStrictEqual(fs.readdirSync(dir), [])
  // a state dir that is a file, not a folder: issue gives no code instead of throwing
  const broken = tempDir()
  fs.writeFileSync(path.join(broken, 'allow'), 'x')
  assert.strictEqual(allow.issue({ guard: 'g', rule: 'r', command: 'c', cwd: '/' }, { base: broken, now: T0 }), null)
  assert.strictEqual(allow.consume('g', 'r', 'c', '/', { base: broken, now: T0 }), false)
})

test('withWayOut: one line with the code and the config snippet', () => {
  const msg = withWayOut(`body\n${ASK_USER}`, { code: '7F3K', json: '{"killGuard":{"allowNames":["node"]}}' })
  assert.strictEqual(msg, 'body\nIf the user wants this on purpose, ask them to run `bulkhead allow 7F3K` in their own terminal (allows it once), or set {"killGuard":{"allowNames":["node"]}} in .claude/bulkhead.json.')
  assert.strictEqual(withWayOut('body', { code: 'ABCDE', json: null }), 'body\nIf the user wants this on purpose, ask them to run `bulkhead allow ABCDE` in their own terminal (allows it once).')
  assert.strictEqual(withWayOut(`body\n${ASK_USER}`, {}), 'body')
})

const root = path.join(__dirname, '..')
function hook(file, command, state, cwd = '/work/a') {
  return spawnSync(process.execPath, [path.join(root, 'src', file)], {
    input: JSON.stringify({ session_id: 's1', cwd, tool_input: { command } }), encoding: 'utf8',
    env: { ...process.env, BULKHEAD_DISABLE: '', BULKHEAD_STATE_DIR: state },
  })
}
const cli = (state, ...args) => spawnSync(process.execPath, [path.join(root, 'bin', 'bulkhead'), ...args], { encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: state } })

test('through the real hook and CLI: block, allow, pass once, block again', () => {
  const state = tempDir()
  const first = hook('kill-guard.js', KILL, state)
  assert.strictEqual(first.status, 2)
  const code = /`bulkhead allow ([A-Z2-9]{5})`/.exec(first.stderr)[1]
  assert.match(first.stderr, /\{"killGuard":\{"allowNames":\["node"\]\}\} in \.claude\/bulkhead\.json/)
  assert.strictEqual(hook('kill-guard.js', KILL, state).status, 2, 'still blocked before the user approves')
  const out = cli(state, 'allow', code)
  assert.strictEqual(out.status, 0)
  assert.match(out.stdout, /Allowed once: pkill -f node/)
  assert.strictEqual(hook('kill-guard.js', KILL, state, '/elsewhere').status, 2, 'other folder')
  assert.strictEqual(hook('kill-guard.js', KILL, state).status, 0, 'the approved call goes through')
  assert.strictEqual(hook('kill-guard.js', KILL, state).status, 2, 'and only once')
})

test('a corrupt allow file does not stop the hook from blocking, and does not crash it', () => {
  const state = tempDir()
  fs.mkdirSync(path.join(state, 'allow'))
  fs.writeFileSync(path.join(state, 'allow', 'AAAAA-kill-guard-pkill.json'), '\u0000\u0001garbage')
  const r = hook('kill-guard.js', KILL, state)
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /bulkhead allow [A-Z2-9]{5}/)
})

test('bulkhead allow: list, unknown code, bad usage', () => {
  const state = tempDir()
  assert.match(cli(state, 'allow', '--list').stdout, /no codes waiting/)
  hook('kill-guard.js', KILL, state)
  const list = cli(state, 'allow', '--list')
  assert.match(list.stdout, /CODE\s+STATE\s+GUARD/)
  assert.match(list.stdout, /waiting\s+kill-guard\s+pkill\s+\/work\/a/)
  assert.strictEqual(JSON.parse(cli(state, 'allow', '--list', '--json').stdout).length, 1)
  const bad = cli(state, 'allow', 'ZZZZZ')
  assert.strictEqual(bad.status, 1)
  assert.match(bad.stderr, /no waiting code ZZZZZ/)
  assert.strictEqual(cli(state, 'allow').status, 1)
  assert.match(allowCli.renderList([]), /no codes waiting/)
})
