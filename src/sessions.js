'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { agentOf, installedAgents } = require('./agents')

// On Windows the desktop app and the CLI are both claude.exe. The app's processes run from
// ...\app\Claude.exe (or Claude.app on macOS) and its helpers carry --type=. On macOS the
// app's own Claude Code sessions run from .../claude-code/<x.y.z>/<hash>/claude.app/Contents/
// MacOS/claude, so the macOS match is case-sensitive: Claude.app/.../Claude is the app,
// claude.app/.../claude is the CLI. The app starts each one through Contents/Helpers/disclaimer,
// whose command line names the CLI too; that wrapper is not a session.
const DESKTOP_APP = /[\\/]app[\\/]Claude\.exe/i
const DESKTOP_APP_MAC = /Claude\.app\/Contents\/(?:MacOS\/Claude(?:["\s]|$)|Helpers\/)/
const BUNDLED_CLI_MAC = /\/claude\.app\/Contents\/MacOS\/claude(?:["\s]|$)/
const PID_REUSE_SLACK_MS = 120 * 1000

// The native installer runs versions/<x.y.z> through a `claude` link, so the process name can be
// the version; the command line still starts with claude or names that folder.
function isClaudeCli(p) {
  if (!p) return false
  if (/--type=/.test(p.cmd) || DESKTOP_APP.test(p.cmd) || DESKTOP_APP_MAC.test(p.cmd)) return false
  if (/^claude(?:\.exe)?$/i.test(p.name) || BUNDLED_CLI_MAC.test(p.cmd)) return true
  if (/^["']?(?:\S*[\\/])?claude(?:\.exe)?["']?(?:\s|$)|[\\/]claude[\\/]versions[\\/]/i.test(p.cmd)) return true
  return /^(?:node|bun)(?:\.exe)?$/i.test(p.name) && /claude-code[\\/]cli\.js|@anthropic-ai[\\/]claude-code/i.test(p.cmd)
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

// Claude Code writes ~/.claude/sessions/<pid>.json with the session's cwd and start time.
function readSessionFiles(dir = path.join(claudeDir(), 'sessions')) {
  const files = new Map()
  let names = []
  try { names = fs.readdirSync(dir) } catch {}
  for (const name of names.filter(n => /^\d+\.json$/.test(n))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (s.pid) files.set(Number(s.pid), { cwd: s.cwd || null, startedAt: Number(s.startedAt) || 0, status: s.status || null, sessionId: s.sessionId || null })
    } catch {}
  }
  return files
}

// Maps every process to the session whose tree it is in. A child must be younger than its
// parent, which skips Windows children whose parent PID was reused. On Linux a server that
// outlived its shell is still matched through CLAUDE_PID.
function assignOwners(procs, sessionPids) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const kids = new Map()
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(p)
  }
  const owner = new Map()
  for (const root of sessionPids) {
    const queue = [byPid.get(root)]
    owner.set(root, root)
    for (let i = 0; i < queue.length; i++) {
      for (const c of kids.get(queue[i].pid) || []) {
        if (owner.has(c.pid) || sessionPids.has(c.pid) || c.start < queue[i].start) continue
        owner.set(c.pid, root)
        queue.push(c)
      }
    }
  }
  // the shell snapshots each live session is seen using through its own tree
  const known = new Map()
  for (const [pid, root] of owner) {
    const ms = snapshotMs(byPid.get(pid).cmd)
    if (!ms) continue
    if (!known.has(root)) known.set(root, new Set())
    known.get(root).add(ms)
  }
  for (const p of procs) {
    if (owner.has(p.pid)) continue
    const s = byPid.get(p.claudePid)
    if (sessionPids.has(p.claudePid) && p.start >= s.start) owner.set(p.pid, p.claudePid)
    else {
      const bySnapshot = snapshotOwner(p, byPid, sessionPids, known)
      if (bySnapshot) owner.set(p.pid, bySnapshot)
    }
  }
  return owner
}

function snapshotMs(cmd) {
  const m = /shell-snapshots[\\/]snapshot-\w+-(\d{13})-/.exec(cmd)
  return m ? Number(m[1]) : 0
}

// Windows: a server started with `&` loses its parent when the tool shell's wrapper exits.
// The Claude shell above it still names the session's shell snapshot. Claude Code writes it at
// the session's first Bash call, which can be minutes after the start, so any session started
// before it may own it. A session uses one snapshot, so one seen using another is ruled out.
// We only use it when exactly one session is left.
function snapshotOwner(p, byPid, sessionPids, known = new Map()) {
  let cur = p
  let ms = 0
  for (let i = 0; cur && i < 30 && !ms; i++) {
    ms = snapshotMs(cur.cmd)
    const par = byPid.get(cur.ppid)
    cur = par && par.start <= cur.start ? par : null
  }
  if (!ms) return null
  for (const [pid, set] of known) if (set.has(ms)) return pid
  const fits = [...sessionPids].filter(pid => byPid.get(pid).start <= ms + 5000 && !known.has(pid))
  return fits.length === 1 ? fits[0] : null
}

function linuxCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`) } catch { return null }
}

// The working directories of several processes at once. macOS has no /proc: one lsof call
// answers for all of them. Windows has no cheap way, so those sessions have no cwd and the
// checks that need a folder skip them.
function readCwds(pids, platform = process.platform, run = execFileSync) {
  const out = new Map()
  if (!pids.length) return out
  if (platform === 'linux') {
    for (const pid of pids) out.set(pid, linuxCwd(pid))
  } else if (platform === 'darwin') {
    let text = ''
    try {
      text = run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' } })
    } catch (e) { text = String(e.stdout || '') } // lsof exits 1 when one of the processes is gone
    let pid = 0
    for (const line of text.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1))
      else if (line[0] === 'n' && pid) out.set(pid, line.slice(1))
    }
  }
  return out
}

// Claude Code sessions first, as before. Another agent's tree is one session at its outermost
// process: the npm launchers of Codex and Gemini start the real program as a child.
function sessionRoots(procs) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const roots = []
  for (const p of procs) {
    if (isClaudeCli(p)) {
      roots.push({ proc: p, agent: 'claude' })
      continue
    }
    const agent = agentOf(p)
    if (!agent) continue
    let cur = byPid.get(p.ppid)
    let nested = false
    for (let i = 0; cur && i < 40 && !nested; i++) {
      nested = cur.start <= p.start && !isClaudeCli(cur) && agentOf(cur) === agent
      cur = byPid.get(cur.ppid)
    }
    if (!nested) roots.push({ proc: p, agent })
  }
  return roots
}

// [{ pid, agent, start, cwd, rss, ports: [{ port, pid, name }] }], oldest first.
function findSessions({ procs, ports = [] }, files = new Map(), cwdOf = null, platform = process.platform, run = execFileSync) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const roots = sessionRoots(procs)
  const owner = assignOwners(procs, new Set(roots.map(r => r.proc.pid)))
  const fileCwd = r => {
    const f = files.get(r.proc.pid)
    const fileMatches = f && (!f.startedAt || !r.proc.start || Math.abs(f.startedAt - r.proc.start) < PID_REUSE_SLACK_MS)
    return (fileMatches && f.cwd) || null
  }
  // Claude Code names its folder in a session file; the others are asked once, together
  const others = roots.filter(r => r.agent !== 'claude').map(r => r.proc.pid)
  const asked = cwdOf ? new Map() : readCwds(others, platform, run)
  return roots.sort((a, b) => a.proc.start - b.proc.start).map(r => {
    const p = r.proc
    let rss = 0
    let children = 0
    for (const [pid, root] of owner) {
      if (root !== p.pid) continue
      rss += byPid.get(pid).rss || 0
      if (pid !== p.pid) children++
    }
    const fallback = cwdOf ? cwdOf(p.pid) : r.agent === 'claude' ? (platform === 'linux' ? linuxCwd(p.pid) : null) : asked.get(p.pid)
    return {
      pid: p.pid,
      agent: r.agent,
      start: p.start,
      cwd: fileCwd(r) || fallback || null,
      rss,
      children,
      ports: ports.filter(l => owner.get(l.pid) === p.pid).map(l => ({ ...l, name: byPid.get(l.pid).name })),
    }
  })
}

// The session a process runs under: its nearest Claude ancestor, else the outermost process of
// the nearest other agent, else CLAUDE_PID.
function ownSession(procs, pid = process.pid, env = process.env) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  let cur = byPid.get(pid)
  let found = null
  for (let i = 0; cur && i < 40; i++) {
    if (isClaudeCli(cur)) return found ? found.pid : cur.pid
    const agent = agentOf(cur)
    if (agent && (!found || found.agent === agent)) found = { pid: cur.pid, agent }
    const par = byPid.get(cur.ppid)
    cur = par && par.start <= cur.start ? par : null
  }
  return found ? found.pid : Number(env.CLAUDE_PID) || null
}

// Session files for the checks that need each live session's folder (checkout-guard): Claude
// Code's own files plus a cwd for every other agent's process. The process table is only read
// when one of the other agents has left a folder in the home directory, and never for the agent
// the caller runs under.
function readLiveSessionFiles({
  files = readSessionFiles(), installed = installedAgents, read = () => require('./processes').readProcesses(process.platform, { ports: false }),
  platform = process.platform, run = execFileSync, self = process.pid,
} = {}) {
  const merged = new Map(files)
  try {
    if (!installed().length) return merged
    const snap = read()
    if (!snap) return merged
    const mine = new Set()
    const byPid = new Map(snap.procs.map(p => [p.pid, p]))
    for (let cur = byPid.get(self), i = 0; cur && i < 40; cur = byPid.get(cur.ppid), i++) mine.add(cur.pid)
    const roots = sessionRoots(snap.procs).filter(r => r.agent !== 'claude' && !mine.has(r.proc.pid))
    const cwds = readCwds(roots.map(r => r.proc.pid), platform, run)
    for (const r of roots) merged.set(r.proc.pid, { cwd: cwds.get(r.proc.pid) || null, startedAt: r.proc.start, status: null, sessionId: null, agent: r.agent })
  } catch {}
  return merged
}

module.exports = { PID_REUSE_SLACK_MS, isClaudeCli, readSessionFiles, readLiveSessionFiles, readCwds, sessionRoots, findSessions, assignOwners, ownSession, claudeDir }
