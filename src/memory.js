'use strict'
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const GB = 2 ** 30

function field(text, name) {
  const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))
  return m ? Number(m[1]) : null
}

// Linux: MemAvailable already counts reclaimable cache. Commit is not used because
// the default overcommit mode makes Committed_AS routinely exceed CommitLimit.
function parseMeminfo(text) {
  const total = field(text, 'MemTotal')
  let avail = field(text, 'MemAvailable')
  if (avail === null) avail = (field(text, 'MemFree') || 0) + (field(text, 'Buffers') || 0) + (field(text, 'Cached') || 0)
  const swapTotal = field(text, 'SwapTotal')
  const swap = swapTotal ? { swapTotalGb: (swapTotal * 1024) / GB, swapUsedGb: ((swapTotal - (field(text, 'SwapFree') || 0)) * 1024) / GB } : {}
  return { totalGb: (total * 1024) / GB, freeGb: (avail * 1024) / GB, commitPct: null, ...swap }
}

// macOS: os.freemem() only counts pages that are completely unused, which is near zero
// on a healthy Mac. We approximate Activity Monitor instead:
// available = total - (app memory + wired + compressed), app memory = anonymous - purgeable.
// Older vm_stat output has no "Anonymous pages"; then free + inactive + speculative + purgeable.
function parseVmStat(text, totalBytes) {
  const page = Number((text.match(/page size of (\d+) bytes/) || [])[1]) || 4096
  const n = name => {
    const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'))
    return m ? Number(m[1]) : 0
  }
  let freeBytes
  if (/^Anonymous pages:/m.test(text)) {
    const used = n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')
    freeBytes = totalBytes - used * page
  } else {
    freeBytes = (n('Pages free') + n('Pages inactive') + n('Pages speculative') + n('Pages purgeable')) * page
  }
  return { totalGb: totalBytes / GB, freeGb: Math.max(0, freeBytes) / GB, commitPct: null }
}

// macOS: kern.memorystatus_level is the percentage of memory the system counts as free,
// reclaimable file cache and compressed pages included (what `memory_pressure` prints as
// "System-wide memory free percentage"). The vm_stat estimate above misses the reclaimable
// cache and read 7.7 GB free on a 48 GB Mac that `memory_pressure` called 62% free.
// pressure is kern.memorystatus_vm_pressure_level: 1 normal, 2 warning, 4 critical.
function parseDarwinLevel(text, totalBytes) {
  const [level, pressure] = String(text).trim().split(/\s+/).map(Number)
  if (!(level >= 0 && level <= 100)) return null
  return { totalGb: totalBytes / GB, freeGb: (totalBytes / GB) * (level / 100), commitPct: null, pressure: [1, 2, 4].includes(pressure) ? pressure : null }
}

// Windows: commit charge can run out while RAM still looks "free", and the machine stalls when it does.
function parseWindowsCommit(text) {
  const [total, free] = String(text).trim().split(/\s+/).map(Number)
  if (!(total > 0) || !Number.isFinite(free)) return null
  return Math.round((100 * (total - free)) / total)
}

function windowsCommitPct(run) {
  try {
    return parseWindowsCommit(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)"']))
  } catch {
    return null
  }
}

// vm_stat and sysctl answer in milliseconds; only PowerShell is slow, so only it gets the long wait.
const defaultRun = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: /powershell/i.test(file) ? 8000 : 1500, windowsHide: true })

// { totalGb, freeGb, commitPct } where commitPct is measured only on Windows and only on request.
function readMemory({ platform = process.platform, withCommit = false, run = defaultRun, readFile = fs.readFileSync } = {}) {
  if (process.env.BULKHEAD_TEST_MEMORY) return JSON.parse(process.env.BULKHEAD_TEST_MEMORY)
  if (platform === 'linux') {
    try { return parseMeminfo(readFile('/proc/meminfo', 'utf8')) } catch {}
  }
  if (platform === 'darwin') {
    try {
      const m = parseDarwinLevel(run('sysctl', ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level']), os.totalmem())
      if (m) return m
    } catch {}
    try { return parseVmStat(run('vm_stat', []), os.totalmem()) } catch {}
    // os.freemem() counts only never-used pages, near zero on a healthy Mac: with no usable
    // reading, say everything is free so a guard allows the command instead of blocking it.
    return { totalGb: os.totalmem() / GB, freeGb: os.totalmem() / GB, commitPct: null, pressure: null, unknown: true }
  }
  const mem = { totalGb: os.totalmem() / GB, freeGb: os.freemem() / GB, commitPct: null }
  if (platform === 'win32' && withCommit) mem.commitPct = windowsCommitPct(run)
  return mem
}

module.exports = { readMemory, parseMeminfo, parseVmStat, parseDarwinLevel, parseWindowsCommit }
