'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { runScript } = require('./helpers')
const { judge, ORDER } = require('../src/bash-guards')

const bash = command => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: process.cwd(), session_id: 't' })

// stand-in guards: each records that it ran and answers what it was told to
function fake(answers, ran) {
  return Object.entries(answers).map(([name, answer]) => [name, {
    handle: async () => {
      ran.push(name)
      if (answer === 'throw') throw new Error('bug')
      return answer
    },
  }])
}

test('the order lists every Bash guard once, text-only checks first', () => {
  const names = ORDER.map(([n]) => n)
  assert.deepStrictEqual([...names].sort(), ['basics', 'checkout-guard', 'disk-guard', 'kill-guard', 'memory-guard', 'port-guard', 'secrets-guard', 'wait-guard'])
  assert.ok(names.indexOf('wait-guard') < names.indexOf('port-guard'))
  assert.ok(names.indexOf('kill-guard') < names.indexOf('memory-guard'))
  for (const [, file] of ORDER) assert.strictEqual(typeof require(file.replace('./', '../src/')).handle, 'function', file)
})

test('the first block wins and the rest do not run', async () => {
  const ran = []
  const order = fake({ a: undefined, b: { block: 'b says no' }, c: { block: 'c says no' } }, ran)
  assert.deepStrictEqual(await judge(bash('x'), { order }), { block: 'b says no' })
  assert.deepStrictEqual(ran, ['a', 'b'])
})

test('a guard that throws is skipped, a later block still counts', async () => {
  const ran = []
  const order = fake({ a: 'throw', b: { block: 'no' } }, ran)
  assert.deepStrictEqual(await judge(bash('x'), { order }), { block: 'no' })
})

test('a rewrite (memory-guard queue) passes through unless a later guard blocks, and can be dropped', async () => {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'queued' } } }
  assert.deepStrictEqual(await judge(bash('x'), { order: fake({ q: { output: out }, b: undefined }, []) }), { output: out })
  assert.deepStrictEqual(await judge(bash('x'), { order: fake({ q2: { output: out }, b2: { block: 'no' } }, []) }), { block: 'no' })
  assert.strictEqual(await judge(bash('x'), { order: fake({ q3: { output: out } }, []), rewrite: false }), null)
})

test('the hook script blocks with exit 2 and the guard\'s message, and lets a plain command through', () => {
  const pk = 'p' + 'kill node'
  const kill = runScript('bash-guards', bash(pk))
  assert.strictEqual(kill.status, 2)
  assert.match(kill.stderr, /^\[bulkhead\] kill-guard:/)
  const wait = runScript('bash-guards', { ...bash('sleep 100000'), tool_input: { command: 'sleep 100000', timeout: 600000 } })
  assert.strictEqual(wait.status, 2)
  assert.match(wait.stderr, /wait-guard/)
  const ok = runScript('bash-guards', bash('ls -la'))
  assert.strictEqual(ok.status, 0)
  assert.strictEqual(ok.stdout, '')
  assert.strictEqual(ok.stderr, '')
})

test('turned-off guards are skipped; BULKHEAD_DISABLE=all passes everything; bad input fails open', () => {
  const pk = 'p' + 'kill node'
  assert.strictEqual(runScript('bash-guards', bash(pk), { BULKHEAD_DISABLE: 'kill-guard' }).status, 0)
  assert.strictEqual(runScript('bash-guards', bash('sleep 100000'), { BULKHEAD_DISABLE: 'all' }).status, 0)
  assert.strictEqual(runScript('bash-guards', 'not json').status, 0)
  assert.strictEqual(runScript('bash-guards', { tool_name: 'Bash', tool_input: {} }).status, 0)
})
