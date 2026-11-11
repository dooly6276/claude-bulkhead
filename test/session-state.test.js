'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { classify, apply, readStates, stateOf, runNotify, prune, safeId, dirFor } = require('../src/session-state')
const { tempDir } = require('./helpers')

// payloads shaped like the ones in https://code.claude.com/docs/en/hooks
const base = { session_id: 'abc123', transcript_path: '/Users/me/.claude/projects/p/abc.jsonl', cwd: '/Users/me/dev/api' }
const payload = (hook_event_name, extra = {}) => ({ ...base, hook_event_name, ...extra })
const prompt = payload('UserPromptSubmit', { permission_mode: 'default', prompt: 'Write a function to calculate the factorial' })
const stop = payload('Stop', { stop_hook_active: false, last_assistant_message: 'Done.', background_tasks: [], session_crons: [] })
const perm = payload('Notification', { message: 'Claude needs your permission to use Bash', title: 'Permission needed', notification_type: 'permission_prompt' })
const idle = payload('Notification', { message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
const post = payload('PostToolUse', { tool_name: 'Write', tool_input: { file_path: '/x', content: 'y' }, tool_response: { filePath: '/x', type: 'create' }, tool_use_id: 'toolu_01ABC', duration_ms: 12 })

test('payloads map to states', () => {
  assert.deepStrictEqual(classify(prompt), { state: 'working', reason: null })
  assert.strictEqual(classify(stop).state, 'waiting')
  assert.strictEqual(classify(stop).notify, true)
  assert.deepStrictEqual([classify(perm).state, classify(perm).reason, classify(perm).notify], ['permission', 'permission', true])
  assert.strictEqual(classify(payload('Notification', { notification_type: 'elicitation_dialog' })).reason, 'input')
  assert.strictEqual(classify(idle).keep, true)
  assert.strictEqual(classify(post).soft, true)
  assert.strictEqual(classify(payload('PostToolUseFailure', { tool_name: 'Bash' })).state, 'working')
  assert.deepStrictEqual(classify(payload('SessionStart', { source: 'startup', model: 'claude-opus-5' })), { state: 'waiting', reason: 'idle' })
  assert.strictEqual(classify(payload('SessionStart', { source: 'compact' })), null)
  assert.deepStrictEqual(classify(payload('SessionEnd', { reason: 'other' })), { remove: true })
})

test('events that mean nothing are ignored', () => {
  assert.strictEqual(classify(payload('Notification', { notification_type: 'auth_success' })), null)
  assert.strictEqual(classify(payload('PreToolUse')), null)
  assert.strictEqual(classify({}), null)
  assert.strictEqual(classify(null), null)
})

test('session ids that are not plain file names are refused', () => {
  assert.strictEqual(safeId('abc-123_x.y'), 'abc-123_x.y')
  for (const bad of ['../x', 'a/b', '', '..', 'a\\b', null, 5, 'x'.repeat(200)]) assert.strictEqual(safeId(bad), null, String(bad))
  const dir = tempDir()
  assert.strictEqual(apply(dir, { ...prompt, session_id: '../evil' }).wrote, false)
  assert.ok(!fs.existsSync(path.join(dir, 'evil.json')))
})

test('a turn: working, waiting after the reply, working again; since only moves on a change', () => {
  const dir = tempDir()
  const t0 = 1_000_000
  assert.strictEqual(apply(dir, prompt, { now: t0 }).wrote, true)
  assert.strictEqual(apply(dir, post, { now: t0 + 1000 }).wrote, false) // already working: no write
  let s = readStates(dir).get('abc123')
  assert.deepStrictEqual([s.state, s.since, s.cwd], ['working', t0, '/Users/me/dev/api'])
  const r = apply(dir, stop, { now: t0 + 60000 })
  assert.deepStrictEqual([r.wrote, r.notify], [true, true])
  s = readStates(dir).get('abc123')
  assert.deepStrictEqual([s.state, s.reason, s.since], ['waiting', 'reply', t0 + 60000])
  apply(dir, prompt, { now: t0 + 120000 })
  assert.strictEqual(readStates(dir).get('abc123').state, 'working')
})

test('a permission prompt waits until the tool ends; a late async PostToolUse does not undo Stop', () => {
  const dir = tempDir()
  apply(dir, prompt, { now: 1e9 })
  assert.strictEqual(apply(dir, perm, { now: 1e9 + 20000 }).notify, true)
  assert.strictEqual(readStates(dir).get('abc123').state, 'permission')
  apply(dir, post, { now: 1e9 + 25000 })
  assert.strictEqual(readStates(dir).get('abc123').state, 'working')
  apply(dir, stop, { now: 1e9 + 30000 })
  apply(dir, post, { now: 1e9 + 31000 }) // the last async hook of the turn arriving after Stop
  assert.strictEqual(readStates(dir).get('abc123').state, 'waiting')
  apply(dir, post, { now: 1e9 + 40000 }) // a turn that resumes by itself (background task)
  assert.strictEqual(readStates(dir).get('abc123').state, 'working')
})

test('idle_prompt keeps an existing waiting state and its time', () => {
  const dir = tempDir()
  apply(dir, stop, { now: 5000 })
  assert.strictEqual(apply(dir, idle, { now: 65000 }).wrote, false)
  assert.strictEqual(readStates(dir).get('abc123').since, 5000)
  const d2 = tempDir()
  apply(d2, idle, { now: 9000 })
  assert.strictEqual(readStates(d2).get('abc123').state, 'waiting')
})

test('notifications are rate limited per session, and only on entering a state', () => {
  const dir = tempDir()
  const opts = now => ({ now, minIntervalMs: 30000 })
  assert.strictEqual(apply(dir, stop, opts(100000)).notify, true)
  apply(dir, prompt, opts(105000))
  assert.strictEqual(apply(dir, stop, opts(110000)).notify, false) // 10 s after the last one
  apply(dir, prompt, opts(111000))
  assert.strictEqual(apply(dir, stop, opts(140000)).notify, true)
  assert.strictEqual(apply(dir, stop, opts(141000)).notify, false) // same state again
  assert.strictEqual(apply(tempDir(), { ...stop, session_id: 'other' }, opts(110000)).notify, true) // other session unaffected
})

test('SessionEnd removes the file; SessionStart waits; compact keeps the state', () => {
  const dir = tempDir()
  apply(dir, payload('SessionStart', { source: 'startup' }), { now: 1 })
  assert.strictEqual(readStates(dir).get('abc123').state, 'waiting')
  apply(dir, prompt, { now: 2 })
  apply(dir, payload('SessionStart', { source: 'compact' }), { now: 3 })
  assert.strictEqual(readStates(dir).get('abc123').state, 'working')
  apply(dir, payload('SessionEnd', { reason: 'prompt_input_exit' }))
  assert.strictEqual(readStates(dir).size, 0)
})

test('files of dead sessions are never shown: they only join a live session by id', () => {
  const dir = tempDir()
  apply(dir, stop, { now: 100000 })
  apply(dir, { ...stop, session_id: 'dead' }, { now: 100000 })
  const states = readStates(dir)
  const live = { pid: 812, start: 90000 }
  assert.strictEqual(stateOf(states, live, { sessionId: 'abc123' }).state, 'waiting')
  assert.strictEqual(stateOf(states, live, { sessionId: 'unknown' }), null) // dead session's id belongs to no live process
  assert.strictEqual(stateOf(states, live, undefined), null)
  // the same id resumed in a newer process: a record older than the process is ignored
  assert.strictEqual(stateOf(states, { pid: 900, start: 500000 }, { sessionId: 'abc123' }), null)
})

test('the parent pid joins when the session file has no session id', () => {
  const dir = tempDir()
  apply(dir, stop, { now: 100000 })
  const rec = readStates(dir).get('abc123')
  assert.strictEqual(stateOf(new Map([['abc123', { ...rec, ppid: 812 }]]), { pid: 812, start: 90000 }, { sessionId: null }).state, 'waiting')
})

test('unreadable and malformed state files are skipped', () => {
  const dir = tempDir()
  apply(dir, stop, { now: 1000 })
  fs.writeFileSync(path.join(dirFor(dir), 'junk.json'), '{nope')
  fs.writeFileSync(path.join(dirFor(dir), 'odd.json'), JSON.stringify({ session: 'odd', state: 'sleeping', since: 5 }))
  assert.deepStrictEqual([...readStates(dir).keys()], ['abc123'])
  assert.strictEqual(readStates(path.join(dir, 'missing')).size, 0)
})

test('prune removes files two days old', () => {
  const dir = tempDir()
  apply(dir, stop, { now: 1000 })
  const f = path.join(dirFor(dir), 'abc123.json')
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  fs.utimesSync(f, old, old)
  prune(dir)
  assert.ok(!fs.existsSync(f))
})

test('runNotify spawns the command detached with the given environment and never throws', () => {
  const calls = []
  const fake = (command, opts) => { calls.push([command, opts]); return { unref() {}, on() {} } }
  assert.strictEqual(runNotify('notify-send "Claude waiting"', { BULKHEAD_SESSION_STATE: 'waiting' }, fake), true)
  assert.strictEqual(calls[0][0], 'notify-send "Claude waiting"')
  assert.deepStrictEqual([calls[0][1].shell, calls[0][1].detached, calls[0][1].stdio, calls[0][1].env.BULKHEAD_SESSION_STATE], [true, true, 'ignore', 'waiting'])
  assert.strictEqual(runNotify('', {}, fake), false)
  assert.strictEqual(runNotify(null, {}, fake), false)
  assert.strictEqual(runNotify('x', {}, () => { throw new Error('EACCES') }), false)
})

// the real script, the way Claude Code runs it: JSON on stdin
function hook(stateDir, input, env = {}) {
  const t = Date.now()
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'session-state.js')], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, BULKHEAD_DISABLE: '', BULKHEAD_STATE_DIR: stateDir, CLAUDE_CONFIG_DIR: stateDir, ...env },
  })
  return { ...r, ms: Date.now() - t }
}

test('the script writes the state file, exits 0 and prints nothing', () => {
  const dir = tempDir()
  let r = hook(dir, prompt)
  assert.deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', ''])
  assert.strictEqual(readStates(dir).get('abc123').state, 'working')
  r = hook(dir, stop)
  assert.strictEqual(readStates(dir).get('abc123').state, 'waiting')
  assert.ok(r.ms < 1500, `took ${r.ms} ms`)
})

test('the script fails open on bad input and when switched off', () => {
  const dir = tempDir()
  for (const input of ['', 'not json', '[]', '{"hook_event_name":"Stop"}', '{"session_id":"x","hook_event_name":"Bogus"}']) {
    assert.strictEqual(hook(dir, input).status, 0, input)
  }
  assert.strictEqual(readStates(dir).size, 0)
  hook(dir, prompt, { BULKHEAD_DISABLE: 'session-state' })
  assert.strictEqual(readStates(dir).size, 0)
  // a state dir that cannot be created
  fs.writeFileSync(path.join(dir, 'blocker'), 'x')
  assert.strictEqual(hook(path.join(dir, 'blocker', 'sub'), prompt).status, 0)
})

test('notify.command runs when a session starts waiting, with the three variables', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ notify: { command: `node -e "require('fs').writeFileSync(process.env.OUT, [process.env.BULKHEAD_SESSION_PROJECT, process.env.BULKHEAD_SESSION_STATE, process.env.BULKHEAD_SESSION_PID].join('|'))"` } }))
  const out = path.join(dir, 'notified.txt')
  fs.mkdirSync(path.join(dir, 'sessions'))
  fs.writeFileSync(path.join(dir, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'abc123', cwd: '/Users/me/dev/api', startedAt: 1 }))
  hook(dir, prompt, { OUT: out })
  assert.ok(!fs.existsSync(out))
  hook(dir, stop, { OUT: out })
  const until = Date.now() + 5000
  while (!fs.existsSync(out) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '/Users/me/dev/api|waiting|4242')
})

test('notify.command is ignored in a project config file', () => {
  const dir = tempDir()
  const proj = tempDir()
  fs.mkdirSync(path.join(proj, '.claude'))
  fs.writeFileSync(path.join(proj, '.claude', 'bulkhead.json'), JSON.stringify({ notify: { command: 'touch pwned' } }))
  const out = path.join(dir, 'pwned')
  hook(dir, { ...stop, cwd: proj }, { CLAUDE_PROJECT_DIR: proj, OUT: out })
  const r = hook(dir, { ...prompt, cwd: proj }, { CLAUDE_PROJECT_DIR: proj })
  assert.strictEqual(r.status, 0)
  assert.ok(!fs.existsSync(path.join(proj, 'pwned')) && !fs.existsSync(path.join(process.cwd(), 'pwned')))
})
