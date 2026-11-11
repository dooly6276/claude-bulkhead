'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { line, cached, claudeCount } = require('../src/statusline')
const { tempDir } = require('./helpers')

const mem = { freeGb: 9.14, totalGb: 32 }

test('counts live sessions and live slots', () => {
  const files = new Map([[10, {}], [20, {}], [30, {}]])
  const slots = [{ pid: 10, at: Date.now() }, { pid: 99, at: Date.now() }]
  assert.strictEqual(line({ files, slots, mem, isAlive: pid => pid !== 30 && pid !== 99, count: 2 }), '2 sessions  1 heavy  9.1 GB free')
  assert.strictEqual(line({ files: new Map([[10, {}]]), slots: [], mem, isAlive: () => true, count: 1 }), '1 session  0 heavy  9.1 GB free')
})

test('counts Claude CLI processes, not reused pids or other programs', () => {
  const ps = [
    '  100 /Users/me/.local/share/claude/versions/2.1.0 --resume',
    '  200 claude',
    '  300 /Applications/Claude.app/Contents/MacOS/Claude',
    '  400 /usr/bin/vim notes.txt',
    '  500 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '  600 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=renderer',
  ].join('\n')
  assert.strictEqual(claudeCount({ platform: 'darwin', run: () => ps }), 3)
  assert.strictEqual(claudeCount({ platform: 'win32', run: () => ps }), null)
  assert.strictEqual(claudeCount({ platform: 'linux', run: () => { throw new Error('no ps') } }), null)
  assert.strictEqual(line({ files: new Map([[1, {}], [2, {}], [3, {}], [4, {}]]), slots: [], mem, count: claudeCount({ platform: 'darwin', run: () => ps }) }), '3 sessions  0 heavy  9.1 GB free')
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
  assert.match(r.stdout, /^\d+ sessions? {2}0 heavy {2}9\.1 GB free\n$/)
  assert.ok(Date.now() - t < 2000)
})
