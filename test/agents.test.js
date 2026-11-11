'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { agentOf, agentLabel, installedAgents } = require('../src/agents')
const { findSessions, ownSession, readCwds, readLiveSessionFiles, sessionRoots } = require('../src/sessions')
const { check: checkPort } = require('../src/port-guard')
const { classify } = require('../src/checkout-guard')
const { collect, render } = require('../src/status')

const t0 = Date.UTC(2026, 10, 11, 8)
const MB = 2 ** 20
const proc = (pid, ppid, name, cmd, start = t0, rss = 0) => ({ pid, ppid, name, cmd, start, rss, claudePid: null })

// Command lines as each OS shows them for the agent's published launcher (npm bin entries and
// install scripts; see docs/other-agents.md).
const SHAPES = {
  codex: [
    proc(1, 0, 'codex', '/opt/homebrew/bin/codex --full-auto'),
    proc(1, 0, 'codex', '/home/dev/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex'),
    proc(1, 0, 'node', 'node /home/dev/.npm-global/lib/node_modules/@openai/codex/bin/codex.js'),
    proc(1, 0, 'codex.exe', '"C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe"'),
  ],
  gemini: [
    proc(1, 0, 'node', 'node /usr/local/lib/node_modules/@google/gemini-cli/bundle/gemini.js'),
    proc(1, 0, 'node', 'node /opt/homebrew/bin/gemini'),
    proc(1, 0, 'node', 'node --max-old-space-size=8192 /opt/homebrew/bin/gemini'),
    proc(1, 0, 'node.exe', '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js'),
  ],
  copilot: [
    proc(1, 0, 'node', 'node /usr/lib/node_modules/@github/copilot/npm-loader.js'),
    proc(1, 0, 'copilot', '/home/dev/.local/bin/copilot --banner'),
  ],
  cursor: [
    proc(1, 0, 'cursor-agent', '/Users/dev/.local/share/cursor-agent/versions/2026.11.11-043ef28/cursor-agent'),
    proc(1, 0, 'node', '/Users/dev/.local/share/cursor-agent/versions/2026.11.11-043ef28/node /Users/dev/.local/share/cursor-agent/versions/2026.11.11-043ef28/index.js'),
    proc(1, 0, 'agent', '/Users/dev/.local/share/cursor-agent/versions/2026.11.11-043ef28/cursor-agent chat'),
  ],
  opencode: [
    proc(1, 0, 'opencode', '/usr/local/lib/node_modules/opencode-ai/bin/opencode'),
    proc(1, 0, 'opencode.exe', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe'),
  ],
  amp: [
    proc(1, 0, 'amp', '/usr/local/lib/node_modules/@sourcegraph/amp/node_modules/@ampcode/cli/bin/amp.exe'),
    proc(1, 0, 'amp', 'amp'),
  ],
  cline: [
    proc(1, 0, 'cline', '/usr/local/lib/node_modules/cline/bin/cline'),
    proc(1, 0, 'node', 'node /usr/local/lib/node_modules/cline/bin/cline --yolo'),
  ],
  droid: [
    proc(1, 0, 'droid', '/home/dev/.local/bin/droid'),
    proc(1, 0, 'node', 'node /usr/lib/node_modules/@factory/cli/bin/droid'),
  ],
}

test('recognizes each agent CLI as the process the platform shows', () => {
  for (const [agent, shapes] of Object.entries(SHAPES)) {
    for (const p of shapes) assert.strictEqual(agentOf(p), agent, `${agent}: ${p.cmd}`)
  }
})

test('leaves look-alikes alone', () => {
  for (const p of [
    proc(1, 0, 'node', 'node server.js'),
    proc(1, 0, 'node', 'node /home/dev/gemini/server.js'),
    proc(1, 0, 'node', 'node /home/dev/app/gemini-utils.js'),
    proc(1, 0, 'vim', 'vim codex.md'),
    proc(1, 0, 'codex-helper', 'codex-helper --serve'),
    proc(1, 0, 'bash', 'bash -c "codex exec fix the bug"'),
    proc(1, 0, 'Cursor', '/Applications/Cursor.app/Contents/MacOS/Cursor'),
    proc(1, 0, 'Cursor Helper', '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper --type=renderer'),
    proc(1, 0, 'ampd', 'ampd'),
    proc(1, 0, 'python3', 'python3 -m droid_tools'),
  ]) assert.strictEqual(agentOf(p), null, p.cmd)
  assert.strictEqual(agentOf(null), null)
})

test('labels', () => {
  assert.strictEqual(agentLabel('codex'), 'Codex')
  assert.strictEqual(agentLabel('claude'), 'Claude')
  assert.strictEqual(agentLabel(undefined), 'Claude')
  assert.strictEqual(agentLabel('newagent'), 'newagent')
})

test('an agent is installed when its folder exists, also under XDG_CONFIG_HOME', () => {
  const home = '/home/dev'
  const has = set => p => set.includes(p.replace(/\\/g, '/'))
  assert.deepStrictEqual(installedAgents(home, has([]), {}), [])
  assert.deepStrictEqual(installedAgents(home, has(['/home/dev/.codex', '/home/dev/.gemini']), {}), ['codex', 'gemini'])
  assert.deepStrictEqual(installedAgents(home, has(['/home/dev/.config/opencode']), {}), ['opencode'])
  assert.deepStrictEqual(installedAgents(home, has(['/xdg/amp']), { XDG_CONFIG_HOME: '/xdg' }), ['amp'])
})

test('a launcher and the program it starts are one session, at the outer process', () => {
  // npm codex: node wrapper -> native codex -> a shell -> a dev server
  const procs = [
    proc(10, 1, 'node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js', t0, 40 * MB),
    proc(11, 10, 'codex', '/usr/lib/node_modules/@openai/codex/vendor/x/codex/codex', t0 + 1e3, 90 * MB),
    proc(12, 11, 'bash', 'bash -c "npm run dev"', t0 + 60e3, 4 * MB),
    proc(13, 12, 'node', 'node vite', t0 + 61e3, 200 * MB),
    // gemini relaunches itself with more heap
    proc(20, 1, 'node', 'node /opt/homebrew/bin/gemini', t0, 60 * MB),
    proc(21, 20, 'node', 'node --max-old-space-size=8192 /opt/homebrew/bin/gemini', t0 + 1e3, 100 * MB),
  ]
  const roots = sessionRoots(procs).map(r => [r.proc.pid, r.agent])
  assert.deepStrictEqual(roots, [[10, 'codex'], [20, 'gemini']])
  const s = findSessions({ procs, ports: [{ port: 5173, pid: 13 }] }, new Map(), () => null)
  assert.deepStrictEqual(s.map(x => [x.pid, x.agent]), [[10, 'codex'], [20, 'gemini']])
  assert.deepStrictEqual(s[0].ports, [{ port: 5173, pid: 13, name: 'node' }])
  assert.strictEqual(s[0].rss, 334 * MB)
  assert.strictEqual(s[0].children, 3)
})

test('Claude sessions are found as before, and one running inside another agent stays its own', () => {
  const procs = [
    proc(10, 1, 'codex', '/usr/local/bin/codex', t0),
    proc(11, 10, 'claude', 'claude -p fix', t0 + 5e3),
    proc(12, 11, 'node', 'node next dev', t0 + 9e3),
  ]
  const s = findSessions({ procs, ports: [{ port: 3000, pid: 12 }] }, new Map(), () => null)
  assert.deepStrictEqual(s.map(x => [x.pid, x.agent, x.ports.length]), [[10, 'codex', 0], [11, 'claude', 1]])
})

test('cwd: the Claude session file wins, other agents are asked once', () => {
  const procs = [proc(10, 1, 'claude', 'claude', t0), proc(20, 1, 'codex', '/usr/local/bin/codex', t0 + 1e3), proc(30, 1, 'opencode', 'opencode', t0 + 2e3)]
  const calls = []
  const run = (cmd, args) => {
    calls.push([cmd, ...args])
    return 'p20\nfcwd\nn/Users/dev/api\np30\nfcwd\nn/Users/dev/web\n'
  }
  const s = findSessions({ procs, ports: [] }, new Map([[10, { cwd: '/Users/dev/app', startedAt: 0 }]]), null, 'darwin', run)
  assert.deepStrictEqual(s.map(x => x.cwd), ['/Users/dev/app', '/Users/dev/api', '/Users/dev/web'])
  assert.deepStrictEqual(calls, [['lsof', '-a', '-p', '20,30', '-d', 'cwd', '-Fn']])
  // nothing to ask when there is no other agent
  calls.length = 0
  findSessions({ procs: [procs[0]], ports: [] }, new Map(), null, 'darwin', run)
  assert.strictEqual(calls.length, 0)
})

test('readCwds: macOS parses lsof and tolerates its exit 1, Linux reads /proc, Windows has none', () => {
  const partial = () => { throw Object.assign(new Error('exit 1'), { stdout: 'p20\nfcwd\nn/work/api\n' }) }
  assert.deepStrictEqual([...readCwds([20, 99], 'darwin', partial)], [[20, '/work/api']])
  assert.deepStrictEqual([...readCwds([20], 'darwin', () => { throw new Error('no lsof') })], [])
  assert.deepStrictEqual([...readCwds([process.pid], 'linux')].length, 1)
  assert.deepStrictEqual([...readCwds([20, 30], 'win32', () => assert.fail('must not run'))], [])
  assert.deepStrictEqual([...readCwds([], 'darwin', () => assert.fail('must not run'))], [])
})

test('ownSession: the hook belongs to the agent that started it, at its outermost process', () => {
  const procs = [
    proc(10, 1, 'node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js', t0),
    proc(11, 10, 'codex', '/usr/lib/node_modules/@openai/codex/vendor/x/codex/codex', t0 + 1e3),
    proc(12, 11, 'node', 'node /opt/bulkhead/bin/bulkhead hook --agent codex', t0 + 9e3),
    proc(20, 1, 'claude', 'claude', t0),
    proc(21, 20, 'node', 'node /opt/bulkhead/src/port-guard.js', t0 + 9e3),
    proc(30, 20, 'codex', '/usr/local/bin/codex exec', t0 + 5e3),
    proc(31, 30, 'node', 'node /opt/bulkhead/bin/bulkhead hook --agent codex', t0 + 9e3),
  ]
  assert.strictEqual(ownSession(procs, 12, {}), 10)
  assert.strictEqual(ownSession(procs, 21, {}), 20)
  assert.strictEqual(ownSession(procs, 31, {}), 30)
  assert.strictEqual(ownSession([proc(5, 1, 'node', 'node x')], 5, { CLAUDE_PID: '77' }), 77)
})

test('port-guard blocks a server on a port another agent owns, and not one the agent owns itself', async () => {
  const procs = [
    proc(10, 1, 'codex', '/usr/local/bin/codex', t0),
    proc(11, 10, 'node', 'node next dev', t0 + 9e3),
    proc(20, 1, 'gemini', '/usr/local/bin/gemini', t0 + 30e3),
    proc(21, 20, 'node', 'node /opt/bulkhead/bin/bulkhead hook --agent gemini', t0 + 40e3),
  ]
  const snap = { procs, ports: [{ port: 3000, pid: 11 }] }
  const opts = { cwd: '/w', probe: async () => true, snapshot: () => snap, files: () => new Map() }
  const msg = await checkPort('npx next dev', { ...opts, self: () => ownSession(procs, 21, {}) })
  assert.match(msg, /port 3000 is already used by another Codex session \(session 10\): node pid 11/)
  assert.strictEqual(await checkPort('npx next dev', { ...opts, self: () => ownSession(procs, 11, {}) }), null)
})

test('checkout-guard sees another agent working in the same tree', () => {
  const repo = path.resolve('/work/shop')
  const files = new Map([[10, { cwd: repo, startedAt: t0, sessionId: null, agent: 'codex' }]])
  const run = args => {
    if (args[0] === 'rev-parse') return repo
    throw new Error('unexpected git ' + args.join(' '))
  }
  const hit = classify('git checkout main', { cwd: repo, sessionId: 'mine', files: () => files, isAlive: () => true, run })
  assert.ok(hit)
  assert.match(hit.why, /another Codex session works in the same tree \(session 10 in \/work\/shop\)/)
  const rm = classify(`rm -rf ${repo}`, { cwd: '/tmp', sessionId: 'mine', files: () => files, isAlive: () => true, run, home: '/home/dev' })
  assert.match(rm.why, /another Codex session works in it \(session 10 in \/work\/shop\)/)
})

test('readLiveSessionFiles adds other agents with their folder, skips the caller, and stays cheap without them', () => {
  const procs = [
    proc(10, 1, 'codex', '/usr/local/bin/codex', t0),
    proc(11, 10, 'node', 'node /opt/bulkhead/bin/bulkhead hook --agent codex', t0 + 9e3),
    proc(20, 1, 'opencode', 'opencode', t0 + 1e3),
    proc(30, 1, 'claude', 'claude', t0),
  ]
  const claudeFiles = new Map([[30, { cwd: '/w/a', startedAt: t0, sessionId: 'c', status: null }]])
  const base = { files: claudeFiles, installed: () => ['codex'], read: () => ({ procs, ports: [] }), platform: 'darwin', run: () => 'p20\nfcwd\nn/w/b\n' }
  // called from codex's own hook: codex itself is not "another session"
  const mine = readLiveSessionFiles({ ...base, self: 11 })
  assert.deepStrictEqual([...mine.keys()].sort(), [20, 30])
  assert.strictEqual(mine.get(20).cwd, '/w/b')
  assert.strictEqual(mine.get(20).agent, 'opencode')
  assert.strictEqual(mine.get(20).sessionId, null)
  // called from a Claude hook: codex counts, with no folder where the OS cannot say (the run answers only pid 20)
  const fromClaude = readLiveSessionFiles({ ...base, self: 999 })
  assert.deepStrictEqual([...fromClaude.keys()].sort((a, b) => a - b), [10, 20, 30])
  assert.strictEqual(fromClaude.get(10).cwd, null)
  // no other agent installed: the process table is never read
  const none = readLiveSessionFiles({ ...base, installed: () => [], read: () => assert.fail('must not read') })
  assert.deepStrictEqual([...none.keys()], [30])
  // a failing reader leaves the Claude files alone
  const broken = readLiveSessionFiles({ ...base, read: () => { throw new Error('ps failed') } })
  assert.deepStrictEqual([...broken.keys()], [30])
  // Windows: sessions are found but have no folder
  const win = readLiveSessionFiles({ ...base, platform: 'win32', run: () => assert.fail('must not run'), self: 999 })
  assert.strictEqual(win.get(20).cwd, null)
})

test('status shows an AGENT column once a session is not Claude Code', () => {
  const procs = [proc(30, 1, 'claude', 'claude', Date.UTC(2026, 10, 11, 8)), proc(10, 1, 'codex', '/usr/local/bin/codex', Date.UTC(2026, 10, 11, 9), 80 * MB)]
  const mem = { freeGb: 9, totalGb: 32, commitPct: null }
  const st = collect({ snapshot: { procs, ports: [] }, files: new Map([[30, { cwd: '/w/a', startedAt: 0 }]]), slots: [], queue: [], mem, now: Date.UTC(2026, 10, 11, 10) })
  const lines = render(st, { home: '/w' }).split('\n')
  assert.match(lines[0], /^SESSION\s+AGENT\s+STATE\s+STARTED\s+RSS\s+BRANCH\s+PROJECT$/)
  assert.match(lines[1], /^30\s+claude\s/)
  assert.match(lines[2], /^10\s+codex\s/)
  const claudeOnly = collect({ snapshot: { procs: [procs[0]], ports: [] }, files: new Map(), slots: [], queue: [], mem, now: Date.UTC(2026, 10, 11, 10) })
  assert.match(render(claudeOnly).split('\n')[0], /^SESSION\s+STATE\s+STARTED\s+RSS\s+BRANCH\s+PROJECT$/)
})
