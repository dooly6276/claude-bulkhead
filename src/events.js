'use strict'
const fs = require('fs')
const path = require('path')

// One JSON line per block in <state dir>/events.jsonl. Writing happens only on the block
// path, costs one stat and one append, and never throws.
const MAX_BYTES = 1024 * 1024
const MAX_COMMAND = 200

function eventsFile(dir) {
  return path.join(dir, 'events.jsonl')
}

function loggingOff(env = process.env) {
  return /^(?:1|true|yes)$/i.test(String(env.BULKHEAD_NO_LOG || '').trim())
}

function truncate(s, max = MAX_COMMAND) {
  if (s == null) return null
  const one = String(s).replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

// event: { guard, rule, session, project, command, ...extra }. Returns true when written.
// Moves file to file.1 once it is over `limit` bytes. Two hooks may try at once: a lock folder
// lets one rotate, and it checks the size again under the lock, so a hook that saw the old big
// file never moves the fresh small one over the history in file.1. A lock left by a crashed hook
// is cleared after 10 seconds. Never throws.
function rotate(file, limit, now = Date.now()) {
  const lock = file + '.lock'
  try {
    try {
      fs.mkdirSync(lock)
    } catch {
      if (now - fs.statSync(lock).mtimeMs < 10000) return false
      fs.rmdirSync(lock)
      fs.mkdirSync(lock)
    }
  } catch {
    return false
  }
  try {
    if (fs.statSync(file).size <= limit) return false
    fs.renameSync(file, file + '.1')
    return true
  } catch {
    return false
  } finally {
    try { fs.rmdirSync(lock) } catch {}
  }
}

function record(dir, event, { env = process.env, now = Date.now(), maxBytes = MAX_BYTES } = {}) {
  if (loggingOff(env)) return false
  try {
    const { guard, rule, session, project, command, ...extra } = event
    const line = JSON.stringify({
      time: new Date(now).toISOString(),
      guard,
      rule: rule || null,
      session: session || null,
      project: project || null,
      command: truncate(command),
      ...extra,
    }) + '\n'
    const file = eventsFile(dir)
    let size = -1
    try { size = fs.statSync(file).size } catch {}
    if (size < 0) fs.mkdirSync(dir, { recursive: true })
    else if (size + line.length > maxBytes) rotate(file, maxBytes - line.length)
    fs.appendFileSync(file, line)
    return true
  } catch {
    return false
  }
}

function parseLines(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (e && e.time && e.guard) out.push(e)
    } catch {}
  }
  return out
}

// All events from the rotated file and the current one, oldest first.
function readEvents(dir) {
  const file = eventsFile(dir)
  const out = []
  for (const f of [file + '.1', file]) {
    try { for (const e of parseLines(fs.readFileSync(f, 'utf8'))) out.push(e) } catch {}
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

// The last `n` events without reading the whole file, for `bulkhead top`.
function tailEvents(dir, n = 5, bytes = 64 * 1024) {
  const file = eventsFile(dir)
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const events = parseLines(lines.join('\n'))
    if (events.length >= n || start > 0) return events.slice(-n)
  } catch {
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
  return readEvents(dir).slice(-n)
}

function logSize(dir) {
  let bytes = 0
  let files = 0
  for (const f of [eventsFile(dir), eventsFile(dir) + '.1']) {
    try {
      bytes += fs.statSync(f).size
      files++
    } catch {}
  }
  return { bytes, files }
}

module.exports = { rotate, record, readEvents, tailEvents, logSize, eventsFile, loggingOff, truncate, MAX_BYTES }
