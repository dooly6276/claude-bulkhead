'use strict'
// What the user sees at SessionStart: what orphan-reaper stopped since the last notice, and one
// line the first time bulkhead runs. Both live as small files in the state dir. Every function
// fails open and returns nothing on any error.
const fs = require('fs')
const path = require('path')
const { shortPath } = require('./cli-util')

const PENDING = 'reaped-pending.jsonl'
const FIRST_RUN = 'first-run'
const MAX_SHOWN = 3
const MAX_PENDING_BYTES = 64 * 1024

const FIRST_RUN_TEXT = 'bulkhead is on: it blocks commands that would hit other Claude Code sessions. See what it did: bulkhead log. Check your setup: bulkhead doctor.'

// "vite", "node srv.js", "python3 app.py": the program and the script it runs, not the whole line.
function label(cmd, name) {
  const words = String(cmd || name || '').trim().match(/"[^"]*"|'[^']*'|\S+/g) || []
  const base = w => String(w).replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.exe$/i, '')
  const prog = base(words[0]) || base(name) || 'process'
  const arg = words.slice(1).find(w => !w.startsWith('-'))
  if (!arg) return prog
  const bin = /node_modules[\\/](?:\.bin|[^\\/]+[\\/]bin)[\\/]/.test(arg) ? base(arg).replace(/\.m?js$/, '') : null
  if (bin) return bin
  return `${prog} ${base(arg)}`
}

// done: the { orphan, pids } list run() stops; ports: [{ port, pid }] from the same process table.
function items(done, ports = [], projectOf = () => null) {
  return done.map(({ orphan: o, pids }) => {
    const hit = ports.find(l => pids.includes(l.pid))
    return { label: label(o.cmd, o.name), port: hit ? hit.port : null, project: projectOf(o) }
  })
}

function append(dir, list, now = Date.now()) {
  if (!list.length) return false
  try {
    const file = path.join(dir, PENDING)
    let size = 0
    try { size = fs.statSync(file).size } catch {}
    if (size > MAX_PENDING_BYTES) return false
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(file, list.map(i => JSON.stringify({ time: now, ...i })).join('\n') + '\n')
    return true
  } catch {
    return false
  }
}

// Takes the pending list: renaming first means two sessions starting together never both print it.
function claim(dir) {
  const file = path.join(dir, PENDING)
  const mine = `${file}.${process.pid}`
  try {
    fs.renameSync(file, mine)
  } catch {
    return []
  }
  try {
    return fs.readFileSync(mine, 'utf8').split('\n').flatMap(l => {
      try { return [JSON.parse(l)] } catch { return [] }
    })
  } catch {
    return []
  } finally {
    try { fs.unlinkSync(mine) } catch {}
  }
}

function format(list, home) {
  if (!list.length) return null
  const shown = list.slice(0, MAX_SHOWN).map(i => {
    const where = i.project ? ` (${shortPath(i.project, home)})` : ''
    return `${i.label}${i.port ? ` :${i.port}` : ''}${where}`
  })
  const more = list.length > MAX_SHOWN ? `, and ${list.length - MAX_SHOWN} more` : ''
  const n = list.length
  return `bulkhead stopped ${n} leftover${n === 1 ? '' : 's'} from ended sessions: ${shown.join(', ')}${more}. Keep one next time with BULKHEAD_KEEP=1. Details: bulkhead log --guard orphan-reaper`
}

// The first-run line once, and only once: the marker is created before anything is printed. A state
// dir that already has a log belongs to an install from before this notice, and gets no line.
function firstRun(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const used = ['guards.log', 'events.jsonl'].some(n => fs.existsSync(path.join(dir, n)))
    fs.writeFileSync(path.join(dir, FIRST_RUN), `${new Date().toISOString()}\n`, { flag: 'wx' })
    return used ? null : FIRST_RUN_TEXT
  } catch {
    return null
  }
}

module.exports = { label, items, append, claim, format, firstRun, FIRST_RUN_TEXT, PENDING, FIRST_RUN }
