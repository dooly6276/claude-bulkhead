'use strict'
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { runHook, setting, stateDir } = require('./hook')

// What each session is doing: working, waiting for you, or waiting on a permission prompt.
// The hooks in hooks/hooks.json call this script; it writes one small JSON file per session in
// <state dir>/session-state/ and reads nothing else (no process table, no git). `bulkhead status`
// and `top` join those files to live sessions by session id, so a file left by a dead session
// is never shown.
//
// Events (https://code.claude.com/docs/en/hooks):
//   UserPromptSubmit, PostToolUse, PostToolUseFailure  the turn is running: working
//   Stop                                               Claude finished its reply: waiting
//   Notification permission_prompt                     a tool needs your approval: permission
//   Notification elicitation_dialog, elicitation_url_dialog   Claude asks you a question: permission (reason input)
//   Notification idle_prompt                           still waiting; keeps the state it has
//   SessionStart (not source compact)                  a new prompt is open: waiting
//   SessionEnd                                         the file is removed

const WORKING = 'working'
const WAITING = 'waiting'
const PERMISSION = 'permission'
// A PostToolUse hook runs async, so the last one of a turn can finish after Stop wrote "waiting".
// It only takes a session out of "waiting" when that state is older than this.
const WAITING_GRACE_MS = 3000
const STALE_FILE_MS = 2 * 24 * 3600 * 1000

function dirFor(base = stateDir()) {
  return path.join(base, 'session-state')
}

// The session id becomes a file name, so only plain characters pass.
function safeId(id) {
  return typeof id === 'string' && /^[\w.-]{1,128}$/.test(id) && !/^\.+$/.test(id) ? id : null
}

// What a hook payload means: { remove: true }, { state, reason, notify, soft } or null to ignore.
// `soft` means the event only confirms the state and must not replace a waiting one younger than the grace.
function classify(input) {
  switch (input && input.hook_event_name) {
    case 'UserPromptSubmit': return { state: WORKING, reason: null }
    case 'PostToolUse':
    case 'PostToolUseFailure': return { state: WORKING, reason: null, soft: true }
    case 'Stop': return { state: WAITING, reason: 'reply', notify: true }
    case 'SessionStart': return input.source === 'compact' ? null : { state: WAITING, reason: 'idle' }
    case 'SessionEnd': return { remove: true }
    case 'Notification':
      switch (input.notification_type) {
        case 'permission_prompt': return { state: PERMISSION, reason: 'permission', notify: true }
        case 'elicitation_dialog':
        case 'elicitation_url_dialog': return { state: PERMISSION, reason: 'input', notify: true }
        case 'idle_prompt': return { state: WAITING, reason: 'idle', keep: true }
      }
  }
  return null
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeRecord(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(rec))
  fs.renameSync(tmp, file)
}

// Applies one event. Returns { wrote, notify } where notify says a notification should go out now.
function apply(base, input, { now = Date.now(), minIntervalMs = 30000 } = {}) {
  const id = safeId(input && input.session_id)
  const c = classify(input)
  if (!id || !c) return { wrote: false, notify: false }
  const dir = dirFor(base)
  const file = path.join(dir, `${id}.json`)
  if (c.remove) {
    try { fs.unlinkSync(file) } catch {}
    return { wrote: false, notify: false }
  }
  const prev = readRecord(file)
  const same = prev && prev.state === c.state
  if (c.keep && prev && (prev.state === WAITING || prev.state === PERMISSION)) return { wrote: false, notify: false }
  if (same && !c.notify && (prev.reason || null) === (c.reason || null)) return { wrote: false, notify: false }
  if (c.soft && prev && prev.state === WAITING && now - prev.since < WAITING_GRACE_MS) return { wrote: false, notify: false }
  if (same && c.notify && prev.reason === c.reason) return { wrote: false, notify: false }
  const rec = {
    v: 1,
    session: id,
    state: c.state,
    reason: c.reason,
    since: same ? prev.since : now,
    at: now,
    cwd: input.cwd || (prev && prev.cwd) || null,
    ppid: process.ppid,
    notifiedAt: (prev && prev.notifiedAt) || 0,
  }
  const notify = Boolean(c.notify) && now - rec.notifiedAt >= minIntervalMs
  if (notify) rec.notifiedAt = now
  writeRecord(file, rec)
  return { wrote: true, notify, record: rec }
}

// Files of sessions that ended without a SessionEnd (crash, kill) are removed after two days.
function prune(base, now = Date.now()) {
  const dir = dirFor(base)
  let names = []
  try { names = fs.readdirSync(dir) } catch { return }
  for (const n of names) {
    try {
      const f = path.join(dir, n)
      if (now - fs.statSync(f).mtimeMs > STALE_FILE_MS) fs.unlinkSync(f)
    } catch {}
  }
}

// Map of session id -> record, for the join in status. Unreadable files are skipped.
function readStates(base = stateDir()) {
  const dir = dirFor(base)
  const out = new Map()
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const n of names.filter(x => x.endsWith('.json'))) {
    const rec = readRecord(path.join(dir, n))
    if (rec && rec.session && [WORKING, WAITING, PERMISSION].includes(rec.state) && Number(rec.since) > 0) out.set(rec.session, rec)
  }
  return out
}

// The record of a live session: by session id, else by the parent pid the hook saw. A record
// older than the process (the same id resumed in a new process) is ignored.
function stateOf(states, session, file, slackMs = 5000) {
  let rec = file && file.sessionId ? states.get(file.sessionId) : null
  if (!rec) rec = [...states.values()].find(r => r.ppid === session.pid && r.at >= session.start) || null
  if (!rec || (session.start && rec.at < session.start - slackMs)) return null
  return rec
}

// Spawns the user's notify command detached; it never blocks or throws into the hook.
function runNotify(command, env, spawnFn = spawn) {
  if (typeof command !== 'string' || !command.trim()) return false
  try {
    const child = spawnFn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } })
    if (child && child.unref) child.unref()
    if (child && child.on) child.on('error', () => {})
    return true
  } catch {
    return false
  }
}

function sessionPid(sessionId) {
  try {
    for (const [pid, f] of require('./sessions').readSessionFiles()) if (f.sessionId === sessionId) return pid
  } catch {}
  return process.ppid
}

function handle(input) {
  const minIntervalMs = Math.max(0, Number(setting('notify.minIntervalSeconds', 30))) * 1000
  const r = apply(stateDir(), input, { minIntervalMs })
  if (input.hook_event_name === 'SessionStart') prune(stateDir())
  const command = setting('notify.command', null)
  if (r.notify && command) {
    runNotify(command, {
      BULKHEAD_SESSION_PROJECT: input.cwd || '',
      BULKHEAD_SESSION_STATE: r.record.state,
      BULKHEAD_SESSION_PID: String(sessionPid(input.session_id)),
    })
  }
}

if (require.main === module) runHook('session-state', handle)

module.exports = { classify, apply, readStates, stateOf, runNotify, prune, safeId, dirFor, WORKING, WAITING, PERMISSION, WAITING_GRACE_MS }
