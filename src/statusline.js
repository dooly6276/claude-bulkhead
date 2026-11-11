'use strict'
const fs = require('fs')
const path = require('path')
const { stateDir } = require('./hook')
const { readMemory } = require('./memory')
const { execFileSync } = require('child_process')
const { readSessionFiles, isClaudeCli } = require('./sessions')
const { readStates } = require('./session-state')
const { readSlots, slotDir, staleReason } = require('./slots')

const CACHE_MS = 5000

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

const PS_LINE = /^\s*(\d+)\s+(\w+ +\w+ +\d+ +[\d:]+ +\d+)\s+(.*)$/
const START_SLACK_MS = 120 * 1000

// Sessions running now: the session files, narrowed by one `ps` for just those pids (a few
// milliseconds, not a listing of every process). A file outlives its process and the OS reuses
// pids, so a pid counts only when it is a Claude Code CLI that started when the file says.
// null when there is no cheap check (Windows), and the caller counts live pids instead.
function claudeCount({ platform = process.platform, run = execFileSync, files = new Map(), isAlive = alive } = {}) {
  if (platform === 'win32') return null
  const pids = [...files.keys()].filter(isAlive)
  if (!pids.length) return 0
  let out
  try {
    out = run('ps', ['-ww', '-o', 'pid=,lstart=,args=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    out = e && e.stdout ? String(e.stdout) : null // ps exits 1 when one of the pids is gone
    if (out == null) return null
  }
  let n = 0
  for (const l of out.split('\n')) {
    const m = PS_LINE.exec(l)
    if (!m) continue
    const cmd = m[3]
    if (!isClaudeCli({ name: (cmd.split(' ')[0] || '').split(/[\\/]/).pop(), cmd })) continue
    const f = files.get(Number(m[1]))
    const started = new Date(m[2].replace(/ +/g, ' ')).getTime()
    if (f && f.startedAt && started && Math.abs(f.startedAt - started) >= START_SLACK_MS) continue
    n++
  }
  return n
}

// Live sessions that are waiting for you, from the state files the session-state hook writes.
function waitingCount(files, states = readStates(), isAlive = alive) {
  let n = 0
  for (const rec of states.values()) {
    if (rec.state === 'working') continue
    const hit = [...files].find(([pid, f]) => (f.sessionId && f.sessionId === rec.session) || pid === rec.ppid)
    if (hit && isAlive(hit[0])) n++
  }
  return n
}

// Only cheap reads: session files, slot files, state files and free RAM. One small `ps`, so
// it stays well under the 100 ms the status line debounce allows.
function line({ files = readSessionFiles(), slots = readSlots(slotDir(stateDir())), mem = readMemory(), isAlive = alive, count = null, waiting = null } = {}) {
  const sessions = count != null ? count : (claudeCount({ files, isAlive }) ?? [...files.keys()].filter(isAlive).length)
  const heavy = slots.filter(s => !staleReason(s, Date.now(), isAlive)).length
  const wait = waiting != null ? waiting : waitingCount(files, undefined, isAlive)
  return `${sessions} session${sessions === 1 ? '' : 's'}${wait ? `  ${wait} waiting` : ''}  ${heavy} heavy  ${mem.freeGb.toFixed(1)} GB free`
}

function cached(file, now = Date.now(), compute = line) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (now - c.at < CACHE_MS && now >= c.at) return c.text
  } catch {}
  const text = compute()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // tmp and rename: sessions share this file and must never read half of it
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ at: now, text }))
    fs.renameSync(tmp, file)
  } catch {}
  return text
}

function main() {
  let text = ''
  try {
    text = cached(path.join(stateDir(), 'statusline.json'))
  } catch {}
  process.stdout.write(text + '\n')
}

module.exports = { line, cached, main, claudeCount, waitingCount }
