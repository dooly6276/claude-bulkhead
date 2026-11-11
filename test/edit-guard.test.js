'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { check, record, output, repoOf, branchOf } = require('../src/edit-guard')
const { tempDir } = require('./helpers')

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0)
const MIN = 60000

function repo(name, branch = 'main') {
  const root = fs.realpathSync(tempDir())
  const dir = path.join(root, name)
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'x\n')
  return dir
}

// A linked worktree the way git lays it out: a .git file, and <common>/worktrees/<name>/commondir.
function worktree(main, name, branch) {
  const dir = path.join(path.dirname(main), name)
  const admin = path.join(main, '.git', 'worktrees', name)
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(admin, { recursive: true })
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${admin}\n`)
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
  fs.writeFileSync(path.join(admin, 'HEAD'), `ref: refs/heads/${branch}\n`)
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'x\n')
  return dir
}

const edit = (sessionId, file, extra = {}) => ({ session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file }, ...extra })
const sessions = (...rows) => () => new Map(rows.map(([pid, sessionId, cwd]) => [pid, { cwd, sessionId, startedAt: 0 }]))
const world = () => ({ dir: tempDir(), now: NOW })

test('a live session that edited the file minutes ago is announced, with its folder and branch', () => {
  const main = repo('api', 'feat-x')
  const file = path.join(main, 'src', 'app.js')
  const w = world()
  record(edit('other', file), { ...w, now: NOW - 6 * MIN })
  const hit = check(edit('me', file), { ...w, sessions: sessions([4821, 'other', main]), isAlive: () => true })
  assert.strictEqual(hit.rule, 'same-tree')
  assert.match(hit.message, /^Note: session 4821 \(.*api, branch feat-x\) edited this file 6 min ago; re-read it before assuming its contents, and don't revert their change\.$/)
  assert.ok(!hit.message.includes('\n'))
})

test('the same session, a dead session and an unknown session are ignored', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const w = world()
  record(edit('other', file), { ...w, now: NOW - MIN })
  const live = { sessions: sessions([1, 'other', main]), isAlive: () => true }
  assert.strictEqual(check(edit('other', file), { ...w, ...live }), null)
  assert.strictEqual(check(edit('me', file), { ...w, sessions: sessions([1, 'other', main]), isAlive: () => false }), null)
  assert.strictEqual(check(edit('me', file), { ...w, sessions: sessions([2, 'someone-else', main]), isAlive: () => true }), null)
  assert.strictEqual(check(edit('me', file), { ...w, sessions: sessions(), isAlive: () => true }), null)
  assert.ok(check(edit('me', file), { ...w, ...live }))
})

test('an edit older than the window is not announced', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const w = world()
  record(edit('other', file), { ...w, now: NOW - 31 * MIN })
  const ctx = { ...w, sessions: sessions([1, 'other', main]), isAlive: () => true }
  assert.strictEqual(check(edit('me', file), ctx), null)
  assert.ok(check(edit('me', file), { ...ctx, windowMs: 45 * MIN }))
  assert.strictEqual(check(edit('me', file), { ...ctx, windowMs: 10 * MIN }), null)
})

test('another file is not announced', () => {
  const main = repo('api')
  const w = world()
  record(edit('other', path.join(main, 'src', 'app.js')), { ...w, now: NOW - MIN })
  const ctx = { ...w, sessions: sessions([1, 'other', main]), isAlive: () => true }
  assert.strictEqual(check(edit('me', path.join(main, 'src', 'other.js')), ctx), null)
})

test('an edit in another worktree of the same repository is announced as such', () => {
  const main = repo('api', 'main')
  const wt = worktree(main, 'api-wt', 'feat-y')
  const w = world()
  record(edit('other', path.join(wt, 'src', 'app.js')), { ...w, now: NOW - 3 * MIN })
  const hit = check(edit('me', path.join(main, 'src', 'app.js')), { ...w, sessions: sessions([77, 'other', wt]), isAlive: () => true })
  assert.strictEqual(hit.rule, 'other-worktree')
  assert.match(hit.message, /session 77 edited the same file in another worktree \(.*api-wt, branch feat-y\) 3 min ago/)
  assert.match(hit.message, /conflict on merge/)
})

test('two different repositories never see each other', () => {
  const a = repo('a')
  const b = repo('b')
  const w = world()
  record(edit('other', path.join(a, 'src', 'app.js')), { ...w, now: NOW - MIN })
  assert.strictEqual(check(edit('me', path.join(b, 'src', 'app.js')), { ...w, sessions: sessions([1, 'other', a]), isAlive: () => true }), null)
})

test('each edit of the other session is announced once in warn mode, every time in block mode', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const w = world()
  record(edit('other', file), { ...w, now: NOW - 5 * MIN })
  const ctx = { ...w, sessions: sessions([1, 'other', main]), isAlive: () => true }
  assert.ok(check(edit('me', file), ctx))
  assert.strictEqual(check(edit('me', file), ctx), null)
  record(edit('other', file), { ...w, now: NOW - MIN })
  assert.ok(check(edit('me', file), ctx))
  assert.ok(check(edit('me', file), { ...ctx, mode: 'block' }))
  assert.ok(check(edit('me', file), { ...ctx, mode: 'block' }))
})

test('a corrupt or foreign state file is ignored, and the next edit repairs it', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const w = world()
  record(edit('other', file), w)
  const edits = path.join(w.dir, 'edits')
  const [name] = fs.readdirSync(edits)
  for (const junk of ['{not json', '[]', '{"entries":"x"}', '{"entries":[null,1,{"t":"x"}],"seen":[]}', '']) {
    fs.writeFileSync(path.join(edits, name), junk)
    assert.strictEqual(check(edit('me', file), { ...w, sessions: sessions([1, 'other', main]), isAlive: () => true }), null)
  }
  assert.strictEqual(record(edit('other', file), w), true)
  assert.ok(check(edit('me', file), { ...w, sessions: sessions([1, 'other', main]), isAlive: () => true }))
})

test('payloads without a file or a session, and unreadable state, pass without an error', () => {
  const w = { ...world(), sessions: () => { throw new Error('should not be read') } }
  assert.strictEqual(check({ session_id: 'me', tool_input: {} }, w), null)
  assert.strictEqual(check({ tool_input: { file_path: '/x/y' } }, w), null)
  assert.strictEqual(check(null, w), null)
  assert.strictEqual(record({ session_id: 'me', tool_input: {} }, w), false)
  assert.strictEqual(check(edit('me', '/nonexistent/dir/file.js'), w), null)
})

test('the fast path never reads the session files', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const w = { ...world(), sessions: () => { throw new Error('read') } }
  assert.strictEqual(check(edit('me', file), w), null)
  record(edit('me', file), w)
  assert.strictEqual(check(edit('me', file), w), null)
})

test('Windows paths compare without case', () => {
  const w = world()
  const win = { ...w, platform: 'win32', sessions: sessions([1, 'other', '/Work/Shop']), isAlive: () => true }
  record(edit('other', '/Work/Shop/Src/App.js'), { ...w, platform: 'win32', now: NOW - MIN })
  assert.ok(check(edit('me', '/work/shop/src/app.JS'), win))
  assert.strictEqual(check(edit('me', '/work/shop/src/app.JS'), { ...win, platform: 'linux' }), null)
})

test('NotebookEdit and MultiEdit paths count', () => {
  const main = repo('ds')
  const nb = path.join(main, 'src', 'a.ipynb')
  const w = world()
  record({ session_id: 'other', tool_name: 'NotebookEdit', tool_input: { notebook_path: nb } }, { ...w, now: NOW - MIN })
  assert.ok(check({ session_id: 'me', tool_name: 'NotebookEdit', tool_input: { notebook_path: nb } }, { ...w, sessions: sessions([1, 'other', main]), isAlive: () => true }))
})

test('old entries are pruned and the file stays bounded', () => {
  const main = repo('api')
  const w = world()
  record(edit('old', path.join(main, 'src', 'app.js')), { ...w, now: NOW - 3 * 60 * MIN })
  for (let i = 0; i < 350; i++) record(edit(`s${i}`, path.join(main, 'src', `f${i}.js`)), w)
  const [name] = fs.readdirSync(path.join(w.dir, 'edits'))
  const state = JSON.parse(fs.readFileSync(path.join(w.dir, 'edits', name), 'utf8'))
  assert.strictEqual(state.entries.length, 300)
  assert.ok(!state.entries.some(e => e.s === 'old'))
  assert.ok(fs.statSync(path.join(w.dir, 'edits', name)).size < 60000)
  assert.deepStrictEqual(fs.readdirSync(path.join(w.dir, 'edits')).filter(n => n.endsWith('.tmp')), [])
})

test('repoOf and branchOf read plain, linked and missing repositories without git', () => {
  const main = repo('api', 'dev')
  const wt = worktree(main, 'wt', 'topic')
  assert.strictEqual(repoOf(path.join(main, 'src', 'app.js')).top, main)
  assert.strictEqual(repoOf(path.join(wt, 'src', 'app.js')).common, path.join(main, '.git'))
  assert.strictEqual(branchOf(main), 'dev')
  assert.strictEqual(branchOf(wt), 'topic')
  assert.strictEqual(repoOf(path.join(tempDir(), 'x', 'y.js')), null)
})

test('output shapes: warn informs only, ask also asks the user', () => {
  const hit = { message: 'Note: x', mode: 'warn' }
  assert.deepStrictEqual(output(hit), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Note: x' } })
  assert.deepStrictEqual(output({ ...hit, mode: 'ask' }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Note: x', permissionDecision: 'ask', permissionDecisionReason: 'Note: x' },
  })
  assert.ok(!('permissionDecision' in output(hit).hookSpecificOutput))
})

// The whole thing through the script, the way Claude Code runs it.
function run(payload, env) {
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'edit-guard.js')], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, BULKHEAD_DISABLE: '', ...env },
  })
}

test('script: PostToolUse records, PreToolUse of another live session answers with the documented JSON', () => {
  const main = repo('api', 'feat-z')
  const file = path.join(main, 'src', 'app.js')
  const state = tempDir()
  const claude = tempDir()
  fs.mkdirSync(path.join(claude, 'sessions'))
  // this test process stands in for the other session's claude process
  fs.writeFileSync(path.join(claude, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'other', cwd: main, startedAt: Date.now() }))
  const env = { BULKHEAD_STATE_DIR: state, CLAUDE_CONFIG_DIR: claude }
  const post = run({ ...edit('other', file), hook_event_name: 'PostToolUse', tool_response: {} }, env)
  assert.strictEqual(post.status, 0)
  assert.strictEqual(post.stdout, '')

  const quiet = run(edit('other', file), env)
  assert.strictEqual(quiet.status, 0)
  assert.strictEqual(quiet.stdout, '')

  const warn = run(edit('me', file), env)
  assert.strictEqual(warn.status, 0)
  const out = JSON.parse(warn.stdout)
  assert.deepStrictEqual(Object.keys(out), ['hookSpecificOutput'])
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`session ${process.pid} \\(.*api, branch feat-z\\) edited this file`))
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, undefined)

  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ editGuard: { mode: 'ask' } }))
  const ask = JSON.parse(run(edit('me2', file), env).stdout).hookSpecificOutput
  assert.strictEqual(ask.permissionDecision, 'ask')
  assert.match(ask.permissionDecisionReason, /^Note: session/)

  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ editGuard: { mode: 'block' } }))
  const block = run(edit('me3', file), env)
  assert.strictEqual(block.status, 2)
  assert.match(block.stderr, /\[bulkhead\] edit-guard: Note: session/)

  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ editGuard: { enabled: false } }))
  assert.strictEqual(run(edit('me4', file), env).stdout, '')
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ editGuard: { windowMinutes: 0 } }))
  assert.strictEqual(run(edit('me5', file), env).stdout, '')
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ editGuard: { mode: 'nonsense' } }))
  assert.strictEqual(JSON.parse(run(edit('me6', file), env).stdout).hookSpecificOutput.permissionDecision, undefined)
})

test('script: garbage input and a dead session add nothing and do not fail', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const state = tempDir()
  const claude = tempDir()
  fs.mkdirSync(path.join(claude, 'sessions'))
  const env = { BULKHEAD_STATE_DIR: state, CLAUDE_CONFIG_DIR: claude }
  for (const bad of ['', 'not json', '{"tool_input":5}', '[]']) {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'edit-guard.js')], { input: bad, encoding: 'utf8', env: { ...process.env, ...env } })
    assert.strictEqual(r.status, 0)
    assert.strictEqual(r.stdout, '')
  }
  run({ ...edit('other', file), hook_event_name: 'PostToolUse' }, env)
  assert.strictEqual(run(edit('me', file), env).stdout, '')
})

test('speed: a check that finds another live session stays well under 30 ms', () => {
  const main = repo('api')
  const file = path.join(main, 'src', 'app.js')
  const w = world()
  record(edit('other', file), { ...w, now: NOW - MIN })
  const ctx = { ...w, mode: 'block', sessions: sessions([1, 'other', main]), isAlive: () => true }
  check(edit('me', file), ctx)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 50; i++) check(edit('me', file), ctx)
  const each = Number(process.hrtime.bigint() - t0) / 1e6 / 50
  assert.ok(each < 5, `${each} ms per check`)
})
