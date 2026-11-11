'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { line, cached, claudeCount, waitingCount } = require('../src/statusline')
const { tempDir } = require('./helpers')

const mem = { freeGb: 9.14, totalGb: 32 }

test('counts live sessions and live slots', () => {
  const files = new Map([[10, {}], [20, {}], [30, {}]])
  const slots = [{ pid: 10, at: Date.now() }, { pid: 99, at: Date.now() }]
  assert.strictEqual(line({ files, slots, mem, isAlive: pid => pid !== 30 && pid !== 99, count: 2 }), '2 sessions  1 heavy  9.1 GB free')
  assert.strictEqual(line({ files: new Map([[10, {}]]), slots: [], mem, isAlive: () => true, count: 1 }), '1 session  0 heavy  9.1 GB free')
})

test('counts session files whose pid is a Claude CLI that started when the file says', () => {
  const ps = [
    '  100 Mon Nov  9 10:00:00 2026 /Users/me/.local/share/claude/versions/2.1.0 --resume',
    '  200 Tue Nov 10 09:00:00 2026 claude',
    '  300 Tue Nov 10 09:00:00 2026 /usr/bin/vim notes.txt',
    '  500 Tue Nov 10 09:00:00 2026 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '  600 Wed Nov 11 08:00:00 2026 claude',
  ].join('\n')
  const at = s => new Date(s).getTime()
  const files = new Map([
    [100, { startedAt: at('2026-11-09T10:00:30') }], [200, { startedAt: 0 }], [300, { startedAt: 0 }],
    [500, { startedAt: at('2026-11-10T09:00:00') }],
    [600, { startedAt: at('2026-11-10T09:00:00') }], // the pid was reused by a newer claude: a different start
    [700, { startedAt: 0 }], // gone: not in the ps output
  ])
  const calls = []
  const run = (cmd, args) => { calls.push([cmd, args]); return ps }
  assert.strictEqual(claudeCount({ platform: 'darwin', run, files, isAlive: pid => pid !== 700 }), 3)
  assert.deepStrictEqual(calls[0][1].slice(-2), ['-p', '100,200,300,500,600']) // only the session pids, never every process
  assert.strictEqual(claudeCount({ platform: 'linux', run, files, isAlive: () => true }), 3)
  assert.strictEqual(claudeCount({ platform: 'win32', run, files }), null)
  assert.strictEqual(claudeCount({ platform: 'linux', run: () => { throw new Error('no ps') }, files, isAlive: () => true }), null)
  assert.strictEqual(claudeCount({ platform: 'linux', run, files: new Map() }), 0)
  // ps exits 1 when one of the pids is gone and still lists the others
  const partial = () => { throw Object.assign(new Error('x'), { stdout: ps }) }
  assert.strictEqual(claudeCount({ platform: 'linux', run: partial, files, isAlive: () => true }), 3)
  assert.strictEqual(line({ files, slots: [], mem, isAlive: () => true, count: 3, waiting: 0 }), '3 sessions  0 heavy  9.1 GB free')
})

test('shows how many live sessions wait for you, compactly', () => {
  const files = new Map([[10, { sessionId: 'a' }], [20, { sessionId: 'b' }], [30, { sessionId: 'c' }]])
  const states = new Map([
    ['a', { session: 'a', state: 'waiting' }], ['b', { session: 'b', state: 'permission' }], ['c', { session: 'c', state: 'working' }],
    ['dead', { session: 'dead', state: 'waiting' }], ['gone', { session: 'gone', state: 'waiting', ppid: 99 }],
  ])
  assert.strictEqual(waitingCount(files, states, () => true), 2)
  assert.strictEqual(waitingCount(files, states, pid => pid !== 20), 1)
  assert.strictEqual(line({ files, slots: [], mem, isAlive: () => true, count: 3, waiting: 2 }), '3 sessions  2 waiting  0 heavy  9.1 GB free')
  assert.strictEqual(waitingCount(new Map(), new Map(), () => true), 0)
})

test('the cache is written through a temp file and renamed', () => {
  const dir = tempDir()
  const file = path.join(dir, 'statusline.json')
  cached(file, 1000, () => 'x')
  assert.deepStrictEqual(fs.readdirSync(dir), ['statusline.json'])
})

test('reuses the cached line for a few seconds', () => {
  const file = path.join(tempDir(), 'statusline.json')
  let calls = 0
  const compute = () => `run ${++calls}`
  assert.strictEqual(cached(file, 1000, compute), 'run 1')
  assert.strictEqual(cached(file, 4000, compute), 'run 1')
  assert.strictEqual(cached(file, 7000, compute), 'run 2')
  fs.writeFileSync(file, 'garbage')
  assert.strictEqual(cached(file, 7001, compute), 'run 3')
})

test('bin prints one line quickly', () => {
  const t = Date.now()
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'bulkhead-statusline')], {
    input: '{"session_id":"x"}',
    encoding: 'utf8',
    env: { ...process.env, BULKHEAD_STATE_DIR: tempDir(), CLAUDE_CONFIG_DIR: tempDir(), BULKHEAD_TEST_MEMORY: JSON.stringify(mem) },
  })
  assert.match(r.stdout, /^\d+ sessions? {2}(?:\d+ waiting {2})?0 heavy {2}9\.1 GB free\n$/)
  assert.ok(Date.now() - t < 2000)
})
