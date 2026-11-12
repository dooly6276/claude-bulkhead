'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { admit, take, release, readSlots, limits } = require('../src/slots')
const { shellCommand, findGitBash } = require('../src/slot-cli')
const { tempDir, posixShell } = require('./helpers')

const limit = { minFreeGb: 3, floorGb: 5, maxCommitPct: 75 }
const now = 1_000_000_000

test('first job only needs the minimum free RAM', () => {
  assert.strictEqual(admit({ held: [], mem: { freeGb: 3.5, totalGb: 8 }, gb: 4, now, limit }), '')
  assert.match(admit({ held: [], mem: { freeGb: 2, totalGb: 32 }, gb: 1, now, limit }), /below 3 GB/)
})

test('later jobs must leave the floor free after counting jobs still warming up', () => {
  const settled = [{ gb: 4, at: now - 10 * 60e3 }]
  const warming = [{ gb: 4, at: now - 30e3 }]
  const mem = { freeGb: 12, totalGb: 32, commitPct: 40 }
  assert.strictEqual(admit({ held: settled, mem, gb: 4, now, limit }), '')
  assert.match(admit({ held: warming, mem, gb: 4, now, limit }), /starting jobs 4 GB/)
})

test('default limits scale with total RAM unless set', () => {
  const saved = { ...process.env }
  delete process.env.BULKHEAD_MIN_FREE_GB
  delete process.env.BULKHEAD_SLOT_FLOOR_GB
  try {
    assert.deepStrictEqual(limits(8), { minFreeGb: 1.2, floorGb: 2, maxCommitPct: 75 })
    assert.deepStrictEqual(limits(16), { minFreeGb: 2.4, floorGb: 4, maxCommitPct: 75 })
    assert.deepStrictEqual(limits(64), { minFreeGb: 3, floorGb: 5, maxCommitPct: 75 })
    process.env.BULKHEAD_MIN_FREE_GB = '4'
    assert.strictEqual(limits(8).minFreeGb, 4)
  } finally {
    process.env = saved
  }
})

test('small machines run one heavy job at a time', () => {
  assert.match(admit({ held: [{ gb: 1, at: 0 }], mem: { freeGb: 12, totalGb: 16 }, gb: 1, now, limit }), /one heavy job/)
})

test('high commit charge blocks a second job; unknown commit does not', () => {
  const held = [{ gb: 2, at: 0 }]
  assert.match(admit({ held, mem: { freeGb: 20, totalGb: 32, commitPct: 90 }, gb: 2, now, limit }), /commit charge 90%/)
  assert.strictEqual(admit({ held, mem: { freeGb: 20, totalGb: 32, commitPct: null }, gb: 2, now, limit }), '')
})

test('take writes a slot, release frees it, dead owners are reclaimed', () => {
  const dir = path.join(tempDir(), 'slots')
  const roomy = () => ({ freeGb: 30, totalGb: 64, commitPct: null })
  const a = take(dir, { label: 'build', gb: 3, pid: process.pid }, roomy)
  assert.ok(a.file)
  assert.strictEqual(readSlots(dir).length, 1)

  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(dir, 'slot-5.json'), JSON.stringify({ label: 'orphan', gb: 4, pid: Number(dead.stdout), at: Date.now() }))
  const reclaimed = []
  const b = take(dir, { label: 'test', gb: 3, pid: process.pid }, roomy, s => reclaimed.push(s.label))
  assert.ok(b.file)
  assert.deepStrictEqual(reclaimed, ['orphan'])
  assert.strictEqual(readSlots(dir).length, 2)

  release(a.file)
  release(b.file)
  assert.strictEqual(readSlots(dir).length, 0)
})

test('take reports why it has to wait', () => {
  const dir = path.join(tempDir(), 'slots')
  const r = take(dir, { label: 'x', gb: 3, pid: process.pid }, () => ({ freeGb: 1, totalGb: 8 }))
  assert.match(r.reason, /below/)
})

test('shellCommand keeps quoting when argv is split', () => {
  const posix = shellCommand(['bash', '-c', 'npm ci && npm test'], 'linux')
  assert.deepStrictEqual(posix, { file: '/bin/sh', args: ['-c', "bash -c 'npm ci && npm test'"] })
  assert.deepStrictEqual(shellCommand(['npm test && echo ok'], 'darwin').args, ['-c', 'npm test && echo ok'])
  assert.strictEqual(shellCommand(['npm', 'test'], 'win32', 'C:\\Git\\bin\\bash.exe').file, 'C:\\Git\\bin\\bash.exe')
  assert.deepStrictEqual(shellCommand(['echo', 'a b'], 'win32', null).args.slice(-1), ['echo "a b"'])
})

test('findGitBash prefers the path Claude Code was told about', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\bash.exe', ProgramFiles: 'C:\\Program Files' }
  assert.strictEqual(findGitBash(env, () => true), 'D:\\tools\\bash.exe')
  assert.strictEqual(findGitBash({}, () => true), null)
})

test('bulkhead-slot run returns the command exit code and releases its slot', () => {
  const state = tempDir()
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead-slot')
  const env = {
    ...process.env,
    BULKHEAD_STATE_DIR: state,
    BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 30, totalGb: 64, commitPct: null }),
  }
  const r = spawnSync(process.execPath, [bin, 'run', '--gb=2', '--', 'node', '-e', 'process.exit(7)'], { env, encoding: 'utf8' })
  assert.strictEqual(r.status, 7, r.stderr)
  assert.strictEqual(readSlots(path.join(state, 'slots')).length, 0)

  const s = spawnSync(process.execPath, [bin, 'status'], { env, encoding: 'utf8' })
  assert.match(s.stdout, /no slots held/)
  assert.match(s.stdout, /would start now/)
})

test('waiting jobs are listed until their process is gone', () => {
  const { enqueue, readQueue } = require('../src/slots')
  const dir = path.join(tempDir(), 'queue')
  enqueue(dir, { label: 'npm run build', gb: 3, pid: process.pid, at: 2, reason: 'one heavy job at a time' })
  enqueue(dir, { label: 'gone', gb: 2, pid: 999999, at: 1, reason: 'x' })
  assert.deepStrictEqual(readQueue(dir, pid => pid === process.pid).map(q => q.label), ['npm run build'])
  assert.deepStrictEqual(readQueue(path.join(dir, 'missing')), [])
})

test('a job that has to wait shows up in the queue and leaves it when it gives up', () => {
  const { readQueue, queueDir } = require('../src/slots')
  const state = tempDir()
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead-slot')
  // 0.5 GB free is below the minimum, so the job waits; --wait=0 gives up at the first retry
  const env = { ...process.env, BULKHEAD_STATE_DIR: state, BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 0.5, totalGb: 32, commitPct: null }) }
  const r = spawnSync(process.execPath, [bin, 'run', '--wait=0', '--gb=2', '--', 'echo hi'], { env, encoding: 'utf8', timeout: 30000 })
  assert.strictEqual(r.status, 3)
  assert.match(r.stderr, /gave up waiting/)
  assert.deepStrictEqual(readQueue(queueDir(state)), [])
})

test('a stale lock is broken by exactly one waiter', () => {
  const { breakStale, withLock } = require('../src/slots')
  const dir = tempDir()
  const lock = path.join(dir, '.lock')
  fs.mkdirSync(lock)
  const old = new Date(Date.now() - 120e3)
  fs.utimesSync(lock, old, old)
  assert.strictEqual(breakStale(lock), true)
  assert.strictEqual(breakStale(lock), false)
  assert.ok(!fs.existsSync(lock))
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'the moved lock is removed too')
  // a fresh lock is left alone
  fs.mkdirSync(lock)
  assert.strictEqual(breakStale(lock), false)
  assert.ok(fs.existsSync(lock))
  fs.rmdirSync(lock)
  // withLock gets in after a stale lock
  fs.mkdirSync(lock)
  fs.utimesSync(lock, old, old)
  assert.strictEqual(withLock(dir, () => 'in', 3000), 'in')
})

test('a stale lock that was replaced by a fresh one meanwhile is put back, not removed', () => {
  const { breakStale } = require('../src/slots')
  const dir = tempDir()
  const lock = path.join(dir, '.lock')
  fs.mkdirSync(lock)
  // "now" 25 s ahead: the lock is not stale yet, so it stays
  assert.strictEqual(breakStale(lock, Date.now() + 25e3), false)
  assert.ok(fs.existsSync(lock))
  assert.strictEqual(breakStale(lock, Date.now() + 60e3), true)
})

test('the oldest waiter that fits goes first; one that does not fit does not hold others up', () => {
  const dir = path.join(tempDir(), 'slots')
  const roomy = () => ({ freeGb: 30, totalGb: 64, commitPct: null })
  const older = { label: 'old job', gb: 3, pid: 1, at: 1 }
  const r = take(dir, { label: 'late', gb: 3, pid: process.pid }, roomy, undefined, [older])
  assert.match(r.reason, /old job has been waiting longer and goes first/)
  assert.strictEqual(readSlots(dir).length, 0)
  const tooBig = { label: 'huge', gb: 200, pid: 1, at: 1 }
  const first = take(dir, { label: 'running', gb: 3, pid: process.pid }, roomy)
  const ok = take(dir, { label: 'small', gb: 3, pid: process.pid }, roomy, undefined, [tooBig])
  assert.ok(ok.file)
  release(ok.file)
  release(first.file)
})

test('waitersBefore orders by time then PID and skips the caller', () => {
  const { waitersBefore, enqueue } = require('../src/slots')
  const q = path.join(tempDir(), 'queue')
  enqueue(q, { label: 'b', gb: 1, pid: process.pid, at: 200 })
  assert.deepStrictEqual(waitersBefore(q, { pid: 999999, at: 300 }).map(w => w.label), ['b'])
  assert.deepStrictEqual(waitersBefore(q, { pid: process.pid, at: 200 }), [])
  assert.deepStrictEqual(waitersBefore(q, { pid: 1, at: 100 }), [])
})

test('twelve short jobs on eight slots finish in a few seconds, not in 15 second steps', () => {
  const state = tempDir()
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead-slot')
  const env = { ...process.env, BULKHEAD_STATE_DIR: state, BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 60, totalGb: 64, commitPct: null }) }
  const started = Date.now()
  const script = Array.from({ length: 12 }, (_, i) => `"${process.execPath}" "${bin}" run --gb=1 --label=j${i} -- node -e "setTimeout(()=>{},1200)" >/dev/null 2>&1 &`).join('\n') + '\nwait'
  const r = spawnSync(posixShell(), ['-c', script], { env, encoding: 'utf8' })
  assert.strictEqual(r.status, 0, r.stderr)
  const took = Date.now() - started
  assert.ok(took < 8000, `took ${took} ms`)
  assert.deepStrictEqual(fs.readdirSync(path.join(state, 'queue')), [])
})

test('a waiting job prints its position, what is held and what is free, then gives up with exit 3', () => {
  const state = tempDir()
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead-slot')
  const env = { ...process.env, BULKHEAD_STATE_DIR: state, BULKHEAD_SLOT_PROGRESS_MS: '400', BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 2, totalGb: 64, commitPct: null }) }
  const r = spawnSync(process.execPath, [bin, 'run', '--gb=2', '--wait=0.03', '--', 'echo', 'never'], { env, encoding: 'utf8' })
  assert.strictEqual(r.status, 3)
  assert.match(r.stderr, /waiting \(#1 in line, 0 GB held by 0 jobs, 2\.0 GB free\)/)
  assert.match(r.stderr, /still waiting \(#1 in line/)
  assert.match(r.stderr, /gave up waiting/)
  assert.ok(!r.stdout.includes('never'))
})

test('slot status names the session and project of each job and shows who waits', () => {
  const { enqueue } = require('../src/slots')
  const state = tempDir()
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead-slot')
  fs.mkdirSync(path.join(state, 'slots'))
  fs.writeFileSync(path.join(state, 'slots', 'slot-1.json'), JSON.stringify({ label: 'npm test', gb: 3, pid: process.pid, at: Date.now() - 5000 }))
  enqueue(path.join(state, 'queue'), { label: 'cargo build', gb: 4, pid: process.pid, at: Date.now() - 45e3, reason: 'free 2.0 GB' })
  const env = { ...process.env, BULKHEAD_STATE_DIR: state, BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 20, totalGb: 64 }) }
  const r = spawnSync(process.execPath, [bin, 'status'], { env, encoding: 'utf8' })
  assert.match(r.stdout, /slot-1\.json: npm test \(3 GB, pid \d+, [4-9] s/)
  assert.match(r.stdout, /waiting #1: cargo build \(4 GB, pid \d+, waited 4\d s/)
  assert.match(r.stdout, /- free 2\.0 GB/)
})
