'use strict'
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { spawnSync } = require('child_process')
const { numberOption } = require('../src/cli-util')
const { tempDir } = require('./helpers')

const root = path.join(__dirname, '..')
const run = (bin, ...args) => spawnSync(process.execPath, [path.join(root, 'bin', bin), ...args], {
  encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: tempDir(), BULKHEAD_DISABLE: '' },
})

test('--version, -v and version print the package version', () => {
  const v = require('../package.json').version
  for (const a of ['--version', '-v', 'version']) assert.strictEqual(run('bulkhead', a).stdout.trim(), v)
})

test('an unknown command is named before the usage, and exits 1', () => {
  const r = run('bulkhead', 'foo')
  assert.strictEqual(r.status, 1)
  assert.match(r.stderr, /^bulkhead: unknown command "foo"\nusage:/)
})

test('-h and --help print that command\'s usage instead of running it; help <cmd> too', () => {
  for (const cmd of ['status', 'doctor', 'config', 'explain', 'allow', 'log']) {
    for (const flag of ['-h', '--help']) {
      const r = run('bulkhead', cmd, flag)
      assert.strictEqual(r.status, 0, `${cmd} ${flag}`)
      assert.match(r.stdout, /^usage:/, `${cmd} ${flag}`)
      assert.match(r.stdout, new RegExp(`bulkhead ${cmd}`))
    }
    assert.strictEqual(run('bulkhead', 'help', cmd).stdout, run('bulkhead', cmd, '-h').stdout)
  }
  assert.ok(!/bulkhead top/.test(run('bulkhead', 'status', '-h').stdout), 'only its own lines')
})

test('numberOption: absent, space form, equals form and the refusals', () => {
  assert.deepStrictEqual(numberOption([], 'gb', { fallback: 3 }), { value: 3 })
  assert.deepStrictEqual(numberOption(['--gb', '4'], 'gb'), { value: 4 })
  assert.deepStrictEqual(numberOption(['--gb=2.5'], 'gb'), { value: 2.5 })
  assert.match(numberOption(['--gb=abc'], 'gb').error, /--gb needs a number, got abc/)
  assert.match(numberOption(['--gb'], 'gb').error, /got nothing/)
  assert.match(numberOption(['--gb=0'], 'gb').error, /above 0/)
  assert.match(numberOption(['--gb=-1'], 'gb').error, /above 0/)
  assert.deepStrictEqual(numberOption(['--wait=0'], 'wait', { inclusive: true }), { value: 0 })
  assert.match(numberOption(['--gb=999'], 'gb', { max: 64 }).error, /at most 64/)
  assert.match(numberOption(['--gb=999'], 'gb', { max: 64, tooBig: n => `${n} is too much` }).error, /999 is too much/)
})

test('bad numbers are refused with a message; --gb 1 works with a space', () => {
  const slot = (...a) => run('bulkhead-slot', ...a)
  assert.strictEqual(slot('run', '--gb', '1', '--', 'echo', 'hi').stdout.trim().split('\n').pop(), 'hi')
  for (const gb of ['abc', '0', '-1']) {
    const r = slot('run', `--gb=${gb}`, '--', 'true')
    assert.strictEqual(r.status, 1)
    assert.match(r.stderr, /^bulkhead-slot: --gb /)
  }
  assert.match(slot('run', '--gb=99999', '--', 'true').stderr, /more than this machine's RAM/)
  assert.match(run('bulkhead', 'log', '-n', 'abc').stderr, /-n needs a number, got abc/)
  assert.match(run('bulkhead', 'log', '--since').stderr, /--since needs a value/)
  assert.match(run('bulkhead', 'top', '--interval=abc').stderr, /--interval needs a number, got abc/)
})
