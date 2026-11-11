'use strict'
const fs = require('fs')
const path = require('path')
const { stateDir } = require('./hook')
const { readMemory } = require('./memory')
const { execFileSync } = require('child_process')
const { readSessionFiles, isClaudeCli } = require('./sessions')
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

// Claude Code CLI processes running now, from one `ps` listing (about 20 ms), the same test
// `bulkhead status` uses. A session file outlives its process and the OS reuses pids, so counting
// files whose pid is merely alive overcounts. null when there is no cheap listing (Windows).
function claudeCount({ platform = process.platform, run = execFileSync } = {}) {
  if (platform === 'win32') return null
  let out
  try {
    out = run('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { return null }
  let n = 0
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(l)
    if (!m) continue
    const cmd = m[2]
    if (isClaudeCli({ name: (cmd.split(' ')[0] || '').split(/[\\/]/).pop(), cmd })) n++
  }
  return n
}

// Only cheap reads: session files, slot files and free RAM. No process scan, so it stays
// well under the 300 ms the status line debounce allows.
function line({ files = readSessionFiles(), slots = readSlots(slotDir(stateDir())), mem = readMemory(), isAlive = alive, count = null } = {}) {
  const sessions = count != null ? count : (claudeCount() ?? [...files.keys()].filter(isAlive).length)
  const heavy = slots.filter(s => !staleReason(s, Date.now(), isAlive)).length
  return `${sessions} session${sessions === 1 ? '' : 's'}  ${heavy} heavy  ${mem.freeGb.toFixed(1)} GB free`
}

function cached(file, now = Date.now(), compute = line) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (now - c.at < CACHE_MS && now >= c.at) return c.text
  } catch {}
  const text = compute()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ at: now, text }))
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

module.exports = { line, cached, main, claudeCount }
