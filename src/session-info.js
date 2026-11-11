'use strict'
const os = require('os')
const { execFileSync } = require('child_process')
const { gitInfo } = require('./git-info')
const { assignOwners } = require('./sessions')
const { findMcp } = require('./mcp')
const { readStates, stateOf } = require('./session-state')

function homeShort(p, home = os.homedir()) {
  if (!p) return null
  const s = String(p)
  return home && s.toLowerCase().startsWith(home.toLowerCase()) ? '~' + s.slice(home.length).replace(/\\/g, '/') : s.replace(/\\/g, '/')
}

// Cut from the start so the useful tail stays: "…/dev/api". Starts at a folder boundary when it can.
function fitPath(s, width) {
  s = String(s == null ? '' : s)
  if (width <= 0) return ''
  if (s.length <= width) return s
  if (width === 1) return '…'
  const tail = s.slice(s.length - (width - 1))
  const cut = tail.indexOf('/')
  return '…' + (cut > 0 && cut < tail.length - 1 ? tail.slice(cut) : tail)
}

// "session 83183 in ~/dev/api on branch feat-x": how guards name another session in their messages.
// `s` needs pid and cwd; the branch is read from the folder unless the session already has one.
function describeSession(s, { home = os.homedir(), git = gitInfo } = {}) {
  let branch = s.branch
  let worktree = s.worktree
  if (branch === undefined && s.cwd) {
    try {
      const g = git(s.cwd)
      branch = g ? g.branch : null
      worktree = g ? g.worktree : false
    } catch { branch = null }
  }
  return `session ${s.pid}` + (s.cwd ? ` in ${homeShort(s.cwd, home)}` : '') +
    (branch ? ` on branch ${branch}${worktree ? ' (worktree)' : ''}` : '')
}

// pid -> cwd for sessions with no session file. macOS: one lsof for all of them; Linux reads
// /proc in findSessions already; Windows has no cheap way, so those stay unknown.
function lookupCwds(pids, { platform = process.platform, run = execFileSync } = {}) {
  const out = new Map()
  if (platform !== 'darwin' || !pids.length) return out
  let text = ''
  try {
    text = run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } })
  } catch (e) { text = String((e && e.stdout) || '') }
  let pid = 0
  for (const line of text.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1))
    else if (line[0] === 'n' && pid) out.set(pid, line.slice(1))
  }
  return out
}

// Adds branch, worktree and the working/waiting state to each session, and the MCP report.
// Everything here reads small files; the only subprocess is the optional cwd lookup.
function enrich(sessions, snapshot, files, {
  states = readStates(), git = gitInfo, cwds = lookupCwds,
} = {}) {
  const missing = sessions.filter(s => !s.cwd).map(s => s.pid)
  const found = missing.length ? cwds(missing) : new Map()
  const cache = new Map()
  const gitOf = dir => {
    if (!cache.has(dir)) {
      let g = null
      try { g = git(dir) } catch {}
      cache.set(dir, g)
    }
    return cache.get(dir)
  }
  const out = sessions.map(s => {
    const cwd = s.cwd || found.get(s.pid) || null
    const g = cwd ? gitOf(cwd) : null
    const rec = stateOf(states, s, files.get(s.pid))
    return {
      ...s,
      cwd,
      branch: g ? g.branch : null,
      worktree: g ? g.worktree : false,
      state: rec ? rec.state : null,
      stateReason: rec ? rec.reason : null,
      stateSince: rec ? rec.since : null,
    }
  })
  const owner = assignOwners(snapshot.procs, new Set(out.map(s => s.pid)))
  const mcp = findMcp(snapshot.procs, owner, out)
  for (const s of out) s.mcp = mcp.instances.filter(i => i.session === s.pid).map(i => ({ name: i.name, pid: i.pid, rss: i.rss }))
  return { sessions: out, mcp: mcp.groups }
}

// Human text for the STATE column.
function stateLabel(s, now) {
  if (!s.state) return '-'
  const mins = Math.max(0, Math.floor((now - s.stateSince) / 60000))
  const age = mins >= 1 ? ` ${mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`}` : ''
  if (s.state === 'working') return 'working'
  if (s.state === 'permission') return (s.stateReason === 'input' ? 'needs input' : 'needs permission') + age
  return 'waiting' + age
}

// Sessions that need you first (permission, then waiting the longest), then the rest in their order.
function needsUserFirst(sessions) {
  const rank = s => (s.state === 'permission' ? 0 : s.state === 'waiting' ? 1 : 2)
  return sessions.map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) ||
    (rank(a[0]) < 2 ? a[0].stateSince - b[0].stateSince : 0) || a[1] - b[1]).map(x => x[0])
}

function branchLabel(s) {
  return s.branch ? s.branch + (s.worktree ? ' (wt)' : '') : s.worktree ? '(wt)' : '-'
}

// "3 copies of @playwright/mcp, 1.2 GB"
function mcpLine(g, size) {
  return `${g.copies} copies of ${g.name}, ${size(g.rss)}`
}

module.exports = { homeShort, fitPath, describeSession, lookupCwds, enrich, stateLabel, needsUserFirst, branchLabel, mcpLine }
