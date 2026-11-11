'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { runHook, blocked, setting, stateDir } = require('./hook')
const { readSessionFiles } = require('./sessions')
const { realPath, pathKey } = require('./paths')

// Advisory overlap detection without a server. After every edit, PostToolUse appends
// { session, file, time } to a small file per repository in the state directory. Before an edit,
// PreToolUse reads that file and, when another session that is still running edited the same
// file recently (in this tree or in another worktree of the same repository), tells the agent.
// Everything here is plain file reads: no process scan, no git, no network.

const MAX_ENTRIES = 300
const KEEP_MS = 2 * 60 * 60 * 1000
const MODES = ['warn', 'ask', 'block']

// The .git folder or file at or above `file`, read without running git. A linked worktree has a
// .git file that points at <common>/worktrees/<name>, whose commondir file names <common>.
function repoOf(file, read = fs) {
  let dir = path.dirname(file)
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(dir, '.git')
    let st = null
    try { st = read.statSync(dotGit) } catch {}
    if (st && st.isDirectory()) return { top: dir, gitdir: dotGit, common: dotGit }
    if (st && st.isFile()) {
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(read.readFileSync(dotGit, 'utf8'))
        if (!m) return null
        const gitdir = path.resolve(dir, m[1].trim())
        let common = gitdir
        try { common = path.resolve(gitdir, read.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim()) } catch {}
        return { top: dir, gitdir, common }
      } catch { return null }
    }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

function branchOf(top, read = fs) {
  const repo = repoOf(path.join(top, 'x'), read)
  if (!repo) return null
  try {
    const head = read.readFileSync(path.join(repo.gitdir, 'HEAD'), 'utf8').trim()
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return m ? m[1] : head.slice(0, 8)
  } catch { return null }
}

function filePathOf(input) {
  const t = (input && input.tool_input) || {}
  const p = t.file_path || t.notebook_path
  return typeof p === 'string' && p ? p : null
}

// Where the file lives: the state file for its repository, and its name inside that repository.
function locate(file, dir, platform = process.platform) {
  const real = realPath(file)
  const repo = repoOf(real)
  if (!repo) return { real, key: pathKey(real, platform), top: null, stateFile: path.join(dir, 'edits', 'nogit.json') }
  const top = realPath(repo.top)
  const rel = pathKey(real, platform).slice(pathKey(top, platform).length + 1)
  const id = crypto.createHash('sha1').update(pathKey(repo.common, platform)).digest('hex').slice(0, 16)
  return { real, key: rel, top, stateFile: path.join(dir, 'edits', `${id}.json`) }
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (s && Array.isArray(s.entries)) {
      return {
        entries: s.entries.filter(e => e && typeof e.t === 'number' && e.s && e.k),
        seen: s.seen && typeof s.seen === 'object' && !Array.isArray(s.seen) ? s.seen : {},
      }
    }
  } catch {}
  return { entries: [], seen: {} }
}

// Temp file and rename, so a reader never sees half a file. Two sessions writing at once can
// lose one entry; this is advisory, so that is accepted.
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, file)
}

function prune(state, now, keepMs) {
  const entries = state.entries.filter(e => now - e.t <= keepMs).slice(-MAX_ENTRIES)
  const seen = Object.entries(state.seen).filter(([, t]) => typeof t === 'number' && now - t <= keepMs).slice(-MAX_ENTRIES)
  return { entries, seen: Object.fromEntries(seen) }
}

// PostToolUse: remember that this session edited the file.
function record(input, { dir = stateDir(), now = Date.now(), platform = process.platform, keepMs = KEEP_MS } = {}) {
  const file = filePathOf(input)
  if (!file || !input.session_id) return false
  const loc = locate(file, dir, platform)
  const state = readState(loc.stateFile)
  state.entries = state.entries.filter(e => !(e.s === input.session_id && e.k === loc.key))
  state.entries.push({ s: input.session_id, k: loc.key, top: loc.top, t: now })
  writeState(loc.stateFile, prune(state, now, keepMs))
  return true
}

const short = (p, home = os.homedir()) => (p && (p === home || p.startsWith(home + path.sep)) ? '~' + p.slice(home.length) : p)

function ago(ms) {
  const min = Math.floor(ms / 60000)
  return min < 1 ? 'less than a minute ago' : `${min} min ago`
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// PreToolUse: { message, mode, rule } when another live session edited this file lately, else null.
// The session files are read only after a recent edit by someone else is found, so the usual
// case costs one failed file read.
function check(input, {
  dir = stateDir(), now = Date.now(), platform = process.platform, windowMs = 30 * 60 * 1000, mode = 'warn',
  sessions = () => readSessionFiles(), isAlive = alive,
} = {}) {
  const file = filePathOf(input)
  const me = input && input.session_id
  if (!file || !me) return null
  const loc = locate(file, dir, platform)
  const state = readState(loc.stateFile)
  const recent = state.entries
    .filter(e => e.s !== me && e.k === loc.key && now - e.t <= windowMs && e.t <= now + 60000)
    .sort((a, b) => b.t - a.t)
  if (!recent.length) return null
  const files = sessions()
  for (const e of recent) {
    const live = [...files].find(([pid, f]) => f.sessionId === e.s && isAlive(pid))
    if (!live) continue
    const seenKey = `${me}|${e.s}|${e.k}`
    // told once per edit of theirs; block mode keeps stopping until they stop editing
    if (mode !== 'block' && state.seen[seenKey] >= e.t) continue
    const [pid, f] = live
    const sameTree = loc.top && e.top && pathKey(e.top, platform) === pathKey(loc.top, platform)
    const branch = e.top ? branchOf(e.top) : null
    const where = [short(sameTree ? f.cwd || e.top : e.top || f.cwd), branch && `branch ${branch}`].filter(Boolean).join(', ')
    const message = sameTree || !e.top
      ? `Note: session ${pid} (${where}) edited this file ${ago(now - e.t)}; re-read it before assuming its contents, and don't revert their change.`
      : `Note: session ${pid} edited the same file in another worktree (${where}) ${ago(now - e.t)}; the two versions will conflict on merge, so look at its change before overwriting this one.`
    if (mode !== 'block') {
      try { writeState(loc.stateFile, prune({ entries: state.entries, seen: { ...state.seen, [seenKey]: e.t } }, now, KEEP_MS)) } catch {}
    }
    return { message, mode, rule: sameTree || !e.top ? 'same-tree' : 'other-worktree' }
  }
  return null
}

// The JSON Claude Code reads. additionalContext alone informs the model without approving the
// call; "ask" puts the same text in front of the user.
function output(hit) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', additionalContext: hit.message }
  if (hit.mode === 'ask') {
    hookSpecificOutput.permissionDecision = 'ask'
    hookSpecificOutput.permissionDecisionReason = hit.message
  }
  return { hookSpecificOutput }
}

if (require.main === module) {
  runHook('edit-guard', input => {
    if (input.hook_event_name === 'PostToolUse') {
      record(input)
      return
    }
    const configured = setting('editGuard.mode', 'warn')
    const mode = MODES.includes(configured) ? configured : 'warn'
    const minutes = Number(setting('editGuard.windowMinutes', 30))
    const hit = check(input, { mode, windowMs: (Number.isFinite(minutes) ? minutes : 30) * 60000 })
    if (!hit) return
    if (hit.mode === 'block') {
      return blocked('edit-guard', hit.rule, input, `[bulkhead] edit-guard: ${hit.message}\nIf the user wants this on purpose, ask them: they can set editGuard.mode to "warn" in .claude/bulkhead.json.`, filePathOf(input))
    }
    return { output: output(hit) }
  })
}

module.exports = { check, record, output, repoOf, branchOf, locate }
