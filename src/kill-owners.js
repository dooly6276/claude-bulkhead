'use strict'
// Who owns what on this machine, for the kill checks that need to know. The process table is read
// at most once per hook and only when a command asks for it: kill with literal PIDs, pkill -f with
// a specific pattern, and the mass kills that matter only while another session is alive.
const os = require('os')
const path = require('path')
const processes = require('./processes')
const sessions = require('./sessions')

function shortPath(p) {
  const home = os.homedir()
  const s = String(p || '')
  return home && (s === home || s.startsWith(home + path.sep)) ? '~' + s.slice(home.length) : s
}

// A lazy view of the machine. Nothing is read until table() is called; a failed read gives null
// and every check then lets the command through.
function makeContext({ snapshot, files, self, cwd = process.cwd(), off = [] } = {}) {
  let cached
  return {
    cwd,
    off: new Set(off),
    table() {
      if (cached === undefined) {
        try {
          cached = loadTable({
            snapshot: snapshot || (() => processes.readProcesses(process.platform, { withPorts: false })),
            files: files || (() => sessions.readSessionFiles()),
            self: self || (procs => sessions.ownSession(procs)),
          })
        } catch {
          cached = null
        }
      }
      return cached
    },
  }
}

function loadTable({ snapshot, files, self }) {
  const snap = snapshot()
  if (!snap || !Array.isArray(snap.procs)) return null
  const list = sessions.findSessions(snap, files())
  const roots = new Set(list.map(s => s.pid))
  const me = self(snap.procs)
  return {
    procs: snap.procs,
    byPid: new Map(snap.procs.map(p => [p.pid, p])),
    owner: sessions.assignOwners(snap.procs, roots),
    info: new Map(list.map(s => [s.pid, s])),
    me,
    // without knowing which session this is, no session can be called another one
    others: me ? list.filter(s => s.pid !== me) : [],
  }
}

function label(t, pid) {
  const s = t.info.get(pid)
  return s && s.cwd ? `${shortPath(s.cwd)} (pid ${pid})` : `pid ${pid}`
}

// The other session a process belongs to, or null.
function otherOwner(t, pid) {
  const o = t.owner.get(pid)
  return o && o !== t.me && t.info.has(o) ? o : null
}

// Another live session exists: a sentence naming one, or null.
function othersCheck(t) {
  return t && t.others.length ? `Another Claude session is running here: ${label(t, t.others[0].pid)}.` : null
}

// A literal PID that is another session's process, or any Claude session's own process.
function pidsCheck(t, pids) {
  if (!t || !t.me) return null
  for (const raw of pids) {
    const pid = Math.abs(raw)
    const p = t.byPid.get(pid)
    if (!p) continue
    if (pid === t.me) return `PID ${pid} is your own Claude session.`
    const o = otherOwner(t, pid)
    if (o) return `PID ${pid} (${p.name}) belongs to the Claude session ${label(t, o)}.`
  }
  return null
}

// A pkill or killall pattern that would reach another session's processes.
function patternCheck(t, pattern, { full = false, exact = false } = {}) {
  if (!t || !t.me || !pattern || String(pattern).length > 500) return null
  let re
  try {
    re = new RegExp(exact ? `^(?:${pattern})$` : pattern, 'i')
  } catch {
    return null
  }
  for (const p of t.procs) {
    const o = otherOwner(t, p.pid)
    if (!o) continue
    if (re.test(full ? p.cmd : p.name)) return `That pattern matches PID ${p.pid} (${p.name}) of the Claude session ${label(t, o)}.`
  }
  return null
}

// docker compose down in a folder another live session works in.
function sameProjectCheck(t, dir) {
  if (!t || !t.others.length) return null
  const here = path.resolve(dir)
  const hit = t.others.find(s => {
    if (!s.cwd) return false
    const there = path.resolve(s.cwd)
    return there === here || there.startsWith(here + path.sep) || here.startsWith(there + path.sep)
  })
  return hit ? `Claude session ${label(t, hit.pid)} works in the same project.` : null
}

module.exports = { makeContext, loadTable, label, otherOwner, othersCheck, pidsCheck, patternCheck, sameProjectCheck, shortPath }
