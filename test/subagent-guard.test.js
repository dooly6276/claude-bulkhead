'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { measure, current, parsePsi } = require('../src/pressure')
const { check } = require('../src/subagent-guard')
const { runScript, tempDir } = require('./helpers')

const PSI_CALM = 'some avg10=0.50 avg60=0.20 avg300=0.10 total=1000\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'
const PSI_STALLED = 'some avg10=30.00 avg60=20.00 avg300=5.00 total=99999\nfull avg10=12.50 avg60=8.00 avg300=1.00 total=5555\n'
const PSI_SOME_ONLY = 'some avg10=60.00 avg60=20.00 avg300=5.00 total=99999\nfull avg10=1.00 avg60=0.00 avg300=0.00 total=1\n'

test('macOS: only pressure level 4 is critical', () => {
  assert.strictEqual(measure({ platform: 'darwin', run: () => '1\n' }).critical, false)
  assert.strictEqual(measure({ platform: 'darwin', run: () => '2\n' }).critical, false)
  const crit = measure({ platform: 'darwin', run: () => '4\n' })
  assert.strictEqual(crit.critical, true)
  assert.match(crit.detail, /level 4/)
})

test('Linux: stalls in /proc/pressure/memory, with a MemAvailable fallback', () => {
  const read = text => () => text
  assert.strictEqual(measure({ platform: 'linux', readFile: read(PSI_CALM) }).critical, false)
  assert.strictEqual(measure({ platform: 'linux', readFile: read(PSI_STALLED) }).critical, true)
  assert.strictEqual(measure({ platform: 'linux', readFile: read(PSI_SOME_ONLY) }).critical, true)
  const noPsi = () => { throw new Error('ENOENT') }
  assert.strictEqual(measure({ platform: 'linux', readFile: noPsi, readMem: () => ({ freeGb: 0.3, totalGb: 16 }) }).critical, true)
  assert.strictEqual(measure({ platform: 'linux', readFile: noPsi, readMem: () => ({ freeGb: 4, totalGb: 16 }) }).critical, false)
  assert.deepStrictEqual(parsePsi(PSI_STALLED), { some: 30, full: 12.5 })
})

test('Windows: free physical memory under 8 percent is critical', () => {
  assert.strictEqual(measure({ platform: 'win32', readMem: () => ({ freeGb: 1, totalGb: 16 }) }).critical, true)
  assert.strictEqual(measure({ platform: 'win32', readMem: () => ({ freeGb: 2, totalGb: 16 }) }).critical, false)
})

test('a reader that fails means no verdict, not a block', () => {
  assert.strictEqual(measure({ platform: 'darwin', run: () => { throw new Error('boom') } }), null)
  assert.strictEqual(measure({ platform: 'darwin', run: () => 'nonsense' }), null)
  assert.strictEqual(check({}, () => null), null)
})

test('the verdict is cached for a few seconds', () => {
  const stateDir = tempDir()
  let reads = 0
  const run = () => { reads++; return '4\n' }
  const a = current({ stateDir, now: 1000, platform: 'darwin', run })
  const b = current({ stateDir, now: 3000, platform: 'darwin', run })
  assert.strictEqual(a.critical, true)
  assert.deepStrictEqual(b, a)
  assert.strictEqual(reads, 1)
  current({ stateDir, now: 7000, platform: 'darwin', run })
  assert.strictEqual(reads, 2)
  // a failed read is not cached
  const other = tempDir()
  current({ stateDir: other, now: 1, platform: 'darwin', run: () => { throw new Error('x') } })
  assert.ok(!fs.existsSync(path.join(other, 'pressure.json')))
})

test('the block message tells the agent what to do', () => {
  const why = check({}, () => ({ critical: true, detail: 'macOS memory pressure level 4' }))
  assert.match(why, /subagent-guard: memory pressure is critical \(macOS memory pressure level 4\)/)
  assert.match(why, /wait for the running subagents/)
  assert.strictEqual(check({}, () => ({ critical: false, detail: '' })), null)
})

function hook(config, env) {
  const state = tempDir()
  if (config) fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config))
  return runScript('subagent-guard', { tool_name: 'Agent', tool_input: { description: 'review', prompt: 'x' } }, { BULKHEAD_STATE_DIR: state, ...env })
}

test('hook is off unless memoryGuard.subagents is set, and fails open', () => {
  assert.strictEqual(hook(null).status, 0)
  assert.strictEqual(hook({ memoryGuard: { subagents: false } }).status, 0)
  assert.strictEqual(hook({ memoryGuard: { subagents: true } }, { BULKHEAD_DISABLE: 'memory-guard' }).status, 0)
  assert.strictEqual(runScript('subagent-guard', 'not json').status, 0)
})

test('hook blocks a spawn under critical pressure only when enabled', () => {
  const critical = { BULKHEAD_TEST_PRESSURE: JSON.stringify({ critical: true, detail: 'test' }) }
  const r = hook({ memoryGuard: { subagents: true } }, critical)
  assert.strictEqual(r.status, 2)
  assert.match(r.stderr, /Do not start another subagent/)
  assert.strictEqual(hook(null, critical).status, 0)
  assert.strictEqual(hook({ memoryGuard: { subagents: true } }, { BULKHEAD_TEST_PRESSURE: JSON.stringify({ critical: false, detail: 'ok' }) }).status, 0)
})
