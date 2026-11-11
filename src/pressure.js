'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// Is the machine under critical memory pressure right now? Cheap, and cached for a few seconds
// because every subagent spawn asks.
//   macOS    kern.memorystatus_vm_pressure_level 4 (1 normal, 2 warning, 4 critical)
//   Linux    /proc/pressure/memory: processes stalled on memory (full avg10 >= 10, or some avg10 >= 50);
//            without PSI, MemAvailable under 5% of RAM
//   Windows  available physical memory under 8%
const CACHE_MS = 5000
const LINUX_FULL = 10
const LINUX_SOME = 50
const WINDOWS_FREE_PCT = 8
const LOW_FREE_PCT = 5

const sysctl = () => execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 1500 })

function parsePsi(text) {
  const avg = kind => {
    const m = String(text).match(new RegExp(`^${kind} .*?avg10=([\\d.]+)`, 'm'))
    return m ? Number(m[1]) : null
  }
  return { some: avg('some'), full: avg('full') }
}

function freePct(mem) {
  return mem.totalGb > 0 ? (100 * mem.freeGb) / mem.totalGb : 100
}

// { critical, detail } from one reading, or null when nothing could be read (then nothing is blocked).
function measure({ platform = process.platform, run = sysctl, readFile = fs.readFileSync, readMem = () => require('./memory').readMemory() } = {}) {
  try {
    if (process.env.BULKHEAD_TEST_PRESSURE) return JSON.parse(process.env.BULKHEAD_TEST_PRESSURE)
    if (platform === 'darwin') {
      const level = Number(String(run()).trim())
      if (!Number.isFinite(level)) return null
      return { critical: level >= 4, detail: `macOS memory pressure level ${level}` }
    }
    if (platform === 'linux') {
      let psi = null
      try { psi = parsePsi(readFile('/proc/pressure/memory', 'utf8')) } catch {}
      if (psi && psi.some !== null) {
        const critical = (psi.full || 0) >= LINUX_FULL || psi.some >= LINUX_SOME
        return { critical, detail: `memory stall avg10 some ${psi.some}% full ${psi.full || 0}%` }
      }
      const mem = readMem()
      return { critical: freePct(mem) < LOW_FREE_PCT, detail: `${mem.freeGb.toFixed(1)} GB free` }
    }
    const mem = readMem()
    return { critical: freePct(mem) < (platform === 'win32' ? WINDOWS_FREE_PCT : LOW_FREE_PCT), detail: `${mem.freeGb.toFixed(1)} GB of ${mem.totalGb.toFixed(1)} GB free` }
  } catch {
    return null
  }
}

// measure() with the answer kept in <state dir>/pressure.json for CACHE_MS.
function current({ stateDir, now = Date.now(), ...readers } = {}) {
  const file = stateDir && path.join(stateDir, 'pressure.json')
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (now - c.at >= 0 && now - c.at < CACHE_MS) return c.value
  } catch {}
  const value = measure(readers)
  if (file && value) {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ at: now, value }))
    } catch {}
  }
  return value
}

module.exports = { measure, current, parsePsi, CACHE_MS }
