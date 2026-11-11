'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { fitPath, describeSession, lookupCwds, enrich, stateLabel, needsUserFirst, branchLabel, homeShort } = require('../src/session-info')
const { collect, render, toJson, size } = require('../src/status')
const { frame } = require('../src/top')
const { findSessions } = require('../src/sessions')

const MB = 2 ** 20
const now = new Date(2026, 10, 11, 14, 30).getTime()
const visible = s => s.replace(/\x1b\[[0-9;]*m/g, '')

test('long paths are cut from the start and keep the tail', () => {
  assert.strictEqual(fitPath('~/dev/api', 20), '~/dev/api')
  assert.strictEqual(fitPath('/private/tmp/claude-501/work/dev/api', 10), '…/dev/api')
  assert.strictEqual(fitPath('/private/tmp/claude-501/work/dev/api', 12), '…/dev/api')
  assert.strictEqual(fitPath('averyveryverylongfoldername', 8), '…dername')
  assert.strictEqual(fitPath('abcdef', 1), '…')
  assert.strictEqual(fitPath('abcdef', 0), '')
  assert.ok(fitPath('/a/b/c/d/e/f/g/h', 7).length <= 7)
})

test('a session is described for another session: pid, folder, branch, worktree', () => {
  const git = dir => (dir === '/Users/me/dev/api-wt' ? { branch: 'feat-x', worktree: true } : dir === '/Users/me/dev/api' ? { branch: 'main', worktree: false } : null)
  const o = { home: '/Users/me', git }
  assert.strictEqual(describeSession({ pid: 83183, cwd: '/Users/me/dev/api' }, o), 'session 83183 in ~/dev/api on branch main')
  assert.strictEqual(describeSession({ pid: 83183, cwd: '/Users/me/dev/api-wt' }, o), 'session 83183 in ~/dev/api-wt on branch feat-x (worktree)')
  assert.strictEqual(describeSession({ pid: 5, cwd: '/tmp/x' }, o), 'session 5 in /tmp/x')
  assert.strictEqual(describeSession({ pid: 5, cwd: null }, o), 'session 5')
  assert.strictEqual(describeSession({ pid: 5, cwd: '/x', branch: 'dev', worktree: false }, { git: () => { throw new Error('unused') } }), 'session 5 in /x on branch dev')
  assert.strictEqual(describeSession({ pid: 5, cwd: '/x' }, { git: () => { throw new Error('boom') } }), 'session 5 in /x')
  assert.strictEqual(homeShort('C:\\Users\\Me\\dev\\api', 'c:\\users\\me'), '~/dev/api')
})

test('missing cwds: one lsof on macOS, nothing elsewhere', () => {
  const calls = []
  const lsof = (cmd, args) => { calls.push([cmd, args]); return 'p812\nn/Users/me/dev/api\np990\nn/Users/me/dev/web\n' }
  const m = lookupCwds([812, 990], { platform: 'darwin', run: lsof })
  assert.deepStrictEqual([...m], [[812, '/Users/me/dev/api'], [990, '/Users/me/dev/web']])
  assert.deepStrictEqual(calls, [['lsof', ['-a', '-d', 'cwd', '-Fn', '-p', '812,990']]])
  assert.strictEqual(lookupCwds([812], { platform: 'win32', run: lsof }).size, 0)
  assert.strictEqual(lookupCwds([812], { platform: 'linux', run: lsof }).size, 0)
  assert.strictEqual(lookupCwds([], { platform: 'darwin', run: lsof }).size, 0)
  assert.strictEqual(lookupCwds([812], { platform: 'darwin', run: () => { throw new Error('no lsof') } }).size, 0)
  // lsof exits 1 when one pid is gone but still prints the rest
  const partial = lookupCwds([812, 1], { platform: 'darwin', run: () => { throw Object.assign(new Error('x'), { stdout: 'p812\nn/a\n' }) } })
  assert.strictEqual(partial.get(812), '/a')
})

const proc = (pid, ppid, name, cmd, rssMb, start) => ({ pid, ppid, name, cmd, start, rss: rssMb * MB, claudePid: null })
const rec = (session, state, since, reason = null, ppid = 0) => ({ session, state, since, at: since, reason, ppid })

function fixture() {
  const t = now - 3600e3
  const procs = [
    proc(100, 1, 'claude', 'claude', 300, t), proc(110, 100, 'npm', 'npm exec @playwright/mcp@latest', 50, t + 1000), proc(111, 110, 'node', 'node /n/node_modules/.bin/playwright-mcp', 400, t + 2000),
    proc(200, 1, 'claude', 'claude', 300, t + 10), proc(210, 200, 'npm', 'npm exec @playwright/mcp@latest', 50, t + 1000), proc(211, 210, 'node', 'node /n/node_modules/.bin/playwright-mcp', 400, t + 2000),
    proc(300, 1, 'claude', 'claude', 300, t + 20),
  ]
  const files = new Map([
    [100, { cwd: '/Users/me/dev/api', startedAt: 0, sessionId: 's100' }],
    [200, { cwd: '/Users/me/dev/api-wt', startedAt: 0, sessionId: 's200' }],
  ])
  return { snapshot: { procs, ports: [] }, files }
}

const git = dir => (dir === '/Users/me/dev/api' ? { branch: 'main', worktree: false } : dir === '/Users/me/dev/api-wt' ? { branch: 'feat/x', worktree: true } : null)

test('collect adds branch, worktree, state, a cwd for sessions with no file, and the MCP report', () => {
  const { snapshot, files } = fixture()
  const states = new Map([
    ['s100', rec('s100', 'waiting', now - 180e3, 'reply')],
    ['s200', rec('s200', 'permission', now - 60e3, 'permission')],
    ['sDEAD', rec('sDEAD', 'waiting', now - 999e3)],
  ])
  const st = collect({ snapshot, files, slots: [], queue: [], mem: { freeGb: 9, totalGb: 32, commitPct: null }, now, enrichOpts: { states, git, cwds: pids => new Map(pids.map(p => [p, '/Users/me/dev/blog'])) } })
  const [a, b, c] = st.sessions
  assert.deepStrictEqual([a.branch, a.worktree, a.state, a.stateReason], ['main', false, 'waiting', 'reply'])
  assert.deepStrictEqual([b.branch, b.worktree, b.state], ['feat/x', true, 'permission'])
  assert.deepStrictEqual([c.cwd, c.branch, c.state], ['/Users/me/dev/blog', null, null])
  assert.strictEqual(a.mcp.length, 1)
  assert.strictEqual(st.mcp[0].copies, 2)
  assert.strictEqual(st.mcp[0].duplicate, true)
  const j = toJson(st)
  assert.deepStrictEqual([j.sessions[0].branch, j.sessions[1].worktree, j.sessions[0].state, j.sessions[0].stateSince], ['main', true, 'waiting', new Date(now - 180e3).toISOString()])
  assert.strictEqual(j.sessions[2].stateSince, null)
  assert.deepStrictEqual([j.mcp[0].name, j.mcp[0].copies, j.mcp[0].rss], ['@playwright/mcp', 2, 900 * MB])
})

test('a state file left by a session that no longer runs shows nowhere', () => {
  const { snapshot, files } = fixture()
  const states = new Map([['sGONE', rec('sGONE', 'permission', now - 5e3, 'permission')]])
  const st = collect({ snapshot, files, slots: [], queue: [], mem: { freeGb: 9, totalGb: 32, commitPct: null }, now, enrichOpts: { states, git, cwds: () => new Map() } })
  assert.ok(st.sessions.every(s => s.state === null))
  assert.ok(!render(st, { home: '/Users/me' }).includes('permission'))
})

test('state text and ordering: needs-permission first, then waiting longest first, then the rest', () => {
  assert.strictEqual(stateLabel({ state: 'working', stateSince: now - 5e3 }, now), 'working')
  assert.strictEqual(stateLabel({ state: 'waiting', stateSince: now - 3 * 60e3 }, now), 'waiting 3m')
  assert.strictEqual(stateLabel({ state: 'waiting', stateSince: now - 20e3 }, now), 'waiting')
  assert.strictEqual(stateLabel({ state: 'waiting', stateSince: now - 125 * 60e3 }, now), 'waiting 2h')
  assert.strictEqual(stateLabel({ state: 'permission', stateReason: 'permission', stateSince: now - 60e3 }, now), 'needs permission 1m')
  assert.strictEqual(stateLabel({ state: 'permission', stateReason: 'input', stateSince: now }, now), 'needs input')
  assert.strictEqual(stateLabel({ state: null }, now), '-')
  const list = [
    { pid: 1, state: 'working', stateSince: 1 }, { pid: 2, state: 'waiting', stateSince: 50 }, { pid: 3, state: null },
    { pid: 4, state: 'permission', stateSince: 90 }, { pid: 5, state: 'waiting', stateSince: 10 }, { pid: 6, state: 'working', stateSince: 2 },
  ]
  assert.deepStrictEqual(needsUserFirst(list).map(s => s.pid), [4, 5, 2, 1, 3, 6])
  assert.strictEqual(branchLabel({ branch: 'feat/x', worktree: true }), 'feat/x (wt)')
  assert.strictEqual(branchLabel({ branch: null, worktree: false }), '-')
})

function many(n) {
  const sessions = Array.from({ length: n }, (_, i) => ({
    pid: 1000 + i, start: now - (n - i) * 60e3, cwd: `/Users/me/dev/some-quite-long-project-name-${i}/packages/service`, rss: (200 + i) * MB, children: 3, ports: i % 4 === 0 ? [{ port: 3000 + i, pid: 1, name: 'node' }] : [],
    branch: i % 3 === 0 ? 'feat/a-long-branch-name-' + i : 'main', worktree: i % 3 === 0,
    state: ['working', 'waiting', 'permission', null][i % 4], stateReason: null, stateSince: now - i * 30e3, mcp: [],
  }))
  return { at: now, sessions, mcp: [{ name: '@playwright/mcp', copies: 3, sessions: [1000, 1001, 1002], rss: 1200 * MB, duplicate: true }], slots: [], queue: [], memory: { freeGb: 9, totalGb: 32, commitPct: null } }
}

test('top with 25 sessions: waiting sessions first, duplicate MCP section, no line too wide', () => {
  const st = many(25)
  for (const width of [200, 120, 80, 50, 30, 24]) {
    const lines = frame({ st, now, interval: 2000, events: [] }, { width, height: 200, home: '/Users/me', color: true })
    for (const l of lines) assert.ok(visible(l).length <= Math.max(24, width), `width ${width}: ${visible(l)}`)
  }
  const lines = frame({ st, now, interval: 2000, events: [] }, { width: 140, height: 200, home: '/Users/me' })
  const text = lines.join('\n')
  const rows = lines.filter(l => /^10\d\d /.test(l))
  assert.strictEqual(rows.length, 25)
  assert.match(rows[0], /needs permission/)
  assert.match(text, /SESSIONS 25 {2}12 waiting for you/)
  assert.match(text, /DUPLICATE MCP SERVERS\n3 copies of @playwright\/mcp, 1\.2 GB {2}sessions 1000, 1001, 1002/)
  const firstWorking = rows.findIndex(r => / working/.test(r))
  const lastWaiting = rows.map(r => /needs permission|waiting/.test(r)).lastIndexOf(true)
  assert.ok(lastWaiting < firstWorking)
  assert.ok(text.includes('…/packages/service') || text.includes('packages/service'))
  const short = frame({ st, now, interval: 2000, events: [] }, { width: 100, height: 20, home: '/Users/me' })
  assert.ok(short.length <= 20)
  assert.ok(short.some(l => /more$/.test(l)))
})

test('NO_COLOR and plain output carry no escape codes; color only when asked', () => {
  const st = many(6)
  assert.ok(!frame({ st, now, interval: 2000, events: [] }, { width: 120, home: '/Users/me' }).join('\n').includes('\x1b['))
  assert.ok(!render(st, { home: '/Users/me' }).includes('\x1b['))
  assert.ok(render(st, { home: '/Users/me', color: true }).includes('\x1b[31m')) // permission in red
})

test('status text with 25 sessions and a narrow terminal keeps rows on one line', () => {
  const st = many(25)
  const wide = render(st, { home: '/Users/me' }).split('\n')
  assert.ok(wide.some(l => /^1002 .*needs permission/.test(l)))
  const narrow = render(st, { home: '/Users/me', width: 70 }).split('\n')
  for (const l of narrow.filter(x => /^10\d\d /.test(x))) assert.ok(l.length <= 90, l) // the other columns are fixed, the project shrinks
  assert.ok(narrow.some(l => l.includes('…/packages/service') || l.includes('…')))
  assert.ok(narrow.some(l => /^duplicate MCP: 3 copies of @playwright\/mcp, 1\.2 GB/.test(l)))
  assert.ok(size(MB) === '1 MB')
})

test('without the hooks installed the STATE column says -', () => {
  const { snapshot, files } = fixture()
  const st = collect({ snapshot, files, slots: [], queue: [], mem: { freeGb: 9, totalGb: 32, commitPct: null }, now, enrichOpts: { states: new Map(), git, cwds: () => new Map() } })
  assert.match(render(st, { home: '/Users/me' }), /^100 +- +/m)
})

test('enrich leaves everything alone when git throws', () => {
  const { snapshot, files } = fixture()
  const out = enrich(findSessions(snapshot, files), snapshot, files, { states: new Map(), git: () => { throw new Error('x') }, cwds: () => new Map() })
  assert.ok(out.sessions.every(s => s.branch === null && s.worktree === false))
})
