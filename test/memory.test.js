'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { readMemory, parseMeminfo, parseVmStat, parseDarwinLevel, parseWindowsCommit } = require('../src/memory')

const MEMINFO = `MemTotal:       32768000 kB
MemFree:         1024000 kB
MemAvailable:    8388608 kB
Buffers:          204800 kB
Cached:          6000000 kB
CommitLimit:    20000000 kB
Committed_AS:   45000000 kB
`

const VM_STAT_SONOMA = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3000.
Pages active:                            300000.
Pages inactive:                          290000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                        150000.
Pages purgeable:                          20000.
"Translation faults":                 900000000.
Pages copy-on-write:                   20000000.
Pages zero filled:                    400000000.
Pages reactivated:                      1000000.
Pages purged:                           2000000.
File-backed pages:                       250000.
Anonymous pages:                         345000.
Pages stored in compressor:              200000.
Pages occupied by compressor:             60000.
`

const VM_STAT_OLD = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              100000.
Pages active:                            900000.
Pages inactive:                          400000.
Pages speculative:                        50000.
Pages wired down:                        300000.
Pages purgeable:                          10000.
`

test('linux uses MemAvailable and ignores overcommitted commit charge', () => {
  const m = parseMeminfo(MEMINFO)
  assert.strictEqual(m.freeGb, 8)
  assert.ok(Math.abs(m.totalGb - 31.25) < 0.01)
  assert.strictEqual(m.commitPct, null)
})

test('linux without MemAvailable falls back to free + buffers + cache', () => {
  const m = parseMeminfo('MemTotal: 1048576 kB\nMemFree: 262144 kB\nBuffers: 0 kB\nCached: 262144 kB\n')
  assert.strictEqual(m.freeGb, 0.5)
})

test('macOS estimates available memory like Activity Monitor', () => {
  const total = 16 * 2 ** 30
  const m = parseVmStat(VM_STAT_SONOMA, total)
  // used = (345000 - 20000 + 150000 + 60000) pages * 16 KiB = 8.16 GiB
  assert.ok(Math.abs(m.freeGb - (16 - (535000 * 16384) / 2 ** 30)) < 1e-9)
  assert.ok(m.freeGb > 7.8 && m.freeGb < 7.9)
})

test('macOS without anonymous page counts uses free + inactive + speculative + purgeable', () => {
  const m = parseVmStat(VM_STAT_OLD, 8 * 2 ** 30)
  assert.ok(Math.abs(m.freeGb - (560000 * 4096) / 2 ** 30) < 1e-9)
})

test('windows commit charge from Win32_OperatingSystem', () => {
  assert.strictEqual(parseWindowsCommit('67108864 16777216\r\n'), 75)
  assert.strictEqual(parseWindowsCommit(''), null)
})

test('readMemory picks the adapter by platform', () => {
  const linux = readMemory({ platform: 'linux', readFile: () => MEMINFO })
  assert.strictEqual(linux.freeGb, 8)
  const mac = readMemory({ platform: 'darwin', run: () => VM_STAT_SONOMA })
  assert.ok(mac.freeGb >= 0)
  const win = readMemory({ platform: 'win32', withCommit: true, run: () => '100 40' })
  assert.strictEqual(win.commitPct, 60)
  const noCommit = readMemory({ platform: 'win32', run: () => { throw new Error('not called') } })
  assert.strictEqual(noCommit.commitPct, null)
})

// Captured on a 48 GB Mac that `memory_pressure` called 69% free: the vm_stat estimate read about
// 10 GB because it ignores reclaimable cache, kern.memorystatus_level said 69.
const VM_STAT_48G = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  446804.
Pages active:                                856726.
Pages inactive:                              848403.
Pages speculative:                             1217.
Pages wired down:                            441930.
Pages purgeable:                               3997.
File-backed pages:                           212568.
Anonymous pages:                            1493778.
Pages occupied by compressor:                490143.
`
const GIB = 2 ** 30

test('macOS free RAM comes from kern.memorystatus_level, which counts reclaimable cache', () => {
  const m = parseDarwinLevel('69\n1\n', 48 * GIB)
  assert.ok(Math.abs(m.freeGb - 33.12) < 0.01)
  assert.strictEqual(m.pressure, 1)
  assert.strictEqual(parseDarwinLevel('12\n4\n', 16 * GIB).pressure, 4)
  assert.strictEqual(parseDarwinLevel('garbage', 16 * GIB), null)
  assert.strictEqual(parseDarwinLevel('150\n1', 16 * GIB), null)
  // the old estimate on the same machine was far lower
  assert.ok(parseVmStat(VM_STAT_48G, 48 * GIB).freeGb < 12)
})

test('readMemory on macOS asks sysctl first, then vm_stat, then reports unknown as plenty', () => {
  const calls = []
  const sysctl = file => { calls.push(file); return '62\n1\n' }
  const m = readMemory({ platform: 'darwin', run: sysctl })
  assert.deepStrictEqual(calls, ['sysctl'])
  assert.strictEqual(m.pressure, 1)
  assert.ok(m.freeGb > 0.6 * m.totalGb - 0.01)
  const onlyVm = readMemory({ platform: 'darwin', run: file => { if (file === 'sysctl') throw new Error('no'); return VM_STAT_SONOMA } })
  assert.ok(onlyVm.freeGb >= 0 && !onlyVm.unknown)
  // both fail: never os.freemem(), which is near zero on a healthy Mac; the guard must not block
  const none = readMemory({ platform: 'darwin', run: () => { throw new Error('hung') } })
  assert.strictEqual(none.unknown, true)
  assert.strictEqual(none.freeGb, none.totalGb)
})
