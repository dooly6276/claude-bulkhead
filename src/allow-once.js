'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { stateDir } = require('./hook')

// Allow once: a block gets a short code; the user runs `bulkhead allow <code>` in their own
// terminal, and the next identical tool call (same command text, same folder) passes the guard
// that blocked it. One JSON file per (code, guard, rule) in <state dir>/allow, so two guards
// blocking the same command in parallel never overwrite each other's write.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // base32 without I, O, 0, 1
const CODE_LENGTH = 5
const DEFAULT_TTL_MINUTES = 10

const dirOf = (base = stateDir()) => path.join(base, 'allow')

function ttlMs(minutes) {
  let m = minutes
  if (m === undefined) {
    try { m = require('./config').get('allowOnce.ttlMinutes') } catch {}
  }
  return (Number.isFinite(m) && m > 0 ? m : DEFAULT_TTL_MINUTES) * 60000
}

const normalizeCommand = command => String(command || '').replace(/\r\n/g, '\n').trim()
const normalizeCwd = cwd => {
  const s = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

// The identity of a tool call as far as allowing it goes: the command text and the folder.
function commandKey(command, cwd) {
  return crypto.createHash('sha256').update(`${normalizeCommand(command)}\0${normalizeCwd(cwd)}`).digest('hex')
}

function newCode(taken = new Set()) {
  for (;;) {
    const bytes = crypto.randomBytes(CODE_LENGTH)
    let code = ''
    for (const b of bytes) code += ALPHABET[b % 32]
    if (!taken.has(code)) return code
  }
}

const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data))
  try {
    fs.renameSync(tmp, file)
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

const valid = e => e && typeof e === 'object' && typeof e.code === 'string' && typeof e.guard === 'string' &&
  typeof e.rule === 'string' && typeof e.key === 'string' && Number.isFinite(e.expires) && Number.isFinite(e.created)

// Every readable entry as { file, entry }. Expired and unreadable files are deleted on the way.
function readAll(base, now) {
  const dir = dirOf(base)
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    const file = path.join(dir, name)
    if (!name.endsWith('.json')) {
      // a temp file left by a crash
      try { if (now - fs.statSync(file).mtimeMs > 60000) fs.unlinkSync(file) } catch {}
      continue
    }
    let entry = null
    try { entry = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    if (!valid(entry) || entry.expires <= now) {
      try { fs.unlinkSync(file) } catch {}
      continue
    }
    out.push({ file, entry })
  }
  return out
}

const safe = s => String(s).replace(/[^\w.-]/g, '_')

// The code a block shows. A second guard blocking the same command in the same minute reuses
// the code of the first, so the person types one code. Returns null when nothing can be stored.
function issue({ guard, rule, command, cwd, session }, { base, now = Date.now(), ttl } = {}) {
  try {
    const key = commandKey(command, cwd)
    const all = readAll(base, now)
    const same = all.find(x => x.entry.key === key && !x.entry.approved)
    const code = same ? same.entry.code : newCode(new Set(all.map(x => x.entry.code)))
    const dir = dirOf(base)
    fs.mkdirSync(dir, { recursive: true })
    const entry = {
      code, guard, rule, key, cmd: normalizeCommand(command).replace(/\s+/g, ' ').slice(0, 160),
      cwd: cwd || '', session: session || null, created: now, expires: now + ttlMs(ttl), approved: null,
    }
    writeAtomic(path.join(dir, `${code}-${safe(guard)}-${safe(rule)}.json`), entry)
    return code
  } catch {
    return null
  }
}

// Marks every pending entry of that command as allowed once. { ok, entries } or { ok: false, reason }.
function approve(input, { base, now = Date.now(), ttl } = {}) {
  const code = cleanCode(input)
  if (!code) return { ok: false, reason: 'no-code' }
  let all
  try { all = readAll(base, now) } catch { return { ok: false, reason: 'unreadable' } }
  const hit = all.find(x => x.entry.code === code)
  if (!hit) return { ok: false, reason: 'unknown' }
  if (hit.entry.approved) return { ok: false, reason: 'used', entries: [hit.entry] }
  const approved = []
  for (const x of all) {
    if (x.entry.key !== hit.entry.key || x.entry.approved) continue
    const e = { ...x.entry, approved: now, expires: now + ttlMs(ttl) }
    try { writeAtomic(x.file, e) } catch { return { ok: false, reason: 'unwritable' } }
    approved.push(e)
  }
  return { ok: true, entries: approved }
}

// Called by a guard that is about to block. True when the user approved this exact command for
// this guard and rule; the approval is deleted, so it works once. Any trouble means false.
function consume(guard, rule, command, cwd, { base, now = Date.now() } = {}) {
  try {
    const key = commandKey(command, cwd)
    for (const x of readAll(base, now)) {
      const e = x.entry
      if (!e.approved || e.key !== key || e.guard !== guard || e.rule !== rule) continue
      try { fs.unlinkSync(x.file) } catch { continue } // somebody else used it first
      return true
    }
  } catch {}
  return false
}

// Pending and approved entries, newest first, for `bulkhead allow --list`.
function list({ base, now = Date.now() } = {}) {
  try {
    return readAll(base, now).map(x => x.entry).sort((a, b) => b.created - a.created)
  } catch {
    return []
  }
}

module.exports = { issue, approve, consume, list, commandKey, normalizeCommand, newCode, dirOf, ttlMs, ALPHABET, DEFAULT_TTL_MINUTES }
