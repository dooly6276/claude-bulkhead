#!/usr/bin/env node
'use strict'
// Measures how long each PreToolUse guard takes per tool call, the way Claude Code runs it:
// a fresh node process with the hook payload on stdin. Prints the median of N runs.
//   node scripts/bench-hooks.js [runs]
// "pass" is an everyday command the guard lets through. "block" is one it stops; it is timed
// with the event log on and off, so the difference is what logging costs. bash-guards is the one
// hook Claude Code actually runs for Bash and PowerShell; it runs all the guards above in one
// process. --sessions N also times N tool calls arriving at once, old layout against new.
//   node scripts/bench-hooks.js 9 --sessions 10
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, spawn } = require('child_process')

const runs = Number(process.argv[2]) || 15
const sessionsArg = process.argv.indexOf('--sessions')
const sessions = sessionsArg > 0 ? Number(process.argv[sessionsArg + 1]) || 10 : 0
const src = path.join(__dirname, '..', 'src')

const cases = [
  ['kill-guard', 'ls -la', 'pkill node'],
  ['wait-guard', 'sleep 2 && curl -s localhost:3000', 'sleep 600'],
  ['memory-guard', 'ls -la', 'echo x > ~/.claude/bulkhead/slots/slot-1.json'],
  ['port-guard', 'ls -la', null],
  ['checkout-guard', 'git status', null],
  ['disk-guard', 'du -sh dist', 'du -sh ~'],
  ['basics', 'ls -la', 'rm -rf /'],
  ['bash-guards', 'git status && npm test', 'pkill node'],
]

function time(file, command, env) {
  const input = JSON.stringify({ session_id: 'bench', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command, timeout: 600000 } })
  const out = []
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint()
    spawnSync(process.execPath, [file], { input, env })
    out.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  out.sort((a, b) => a - b)
  return out[Math.floor(out.length / 2)]
}

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-bench-'))
const base = { ...process.env, BULKHEAD_STATE_DIR: state, CLAUDE_PROJECT_DIR: state, BULKHEAD_DISABLE: '' }
const empty = path.join(state, 'empty.js')
fs.writeFileSync(empty, '')
const ms = n => (n == null ? '-' : `${n.toFixed(1)} ms`)

console.log(`${os.platform()} ${os.release()}, node ${process.version}, median of ${runs} runs`)
console.log(`node startup alone: ${ms(time(empty, 'ls', base))}`)
console.log('')
console.log('GUARD           PASS       BLOCK+LOG  BLOCK NO-LOG')
for (const [name, pass, block] of cases) {
  const file = path.join(src, `${name}.js`)
  const p = time(file, pass, base)
  const b = block ? time(file, block, base) : null
  const n = block ? time(file, block, { ...base, BULKHEAD_NO_LOG: '1' }) : null
  console.log(`${name.padEnd(16)}${ms(p).padEnd(11)}${ms(b).padEnd(11)}${ms(n)}`)
}
const lines = fs.existsSync(path.join(state, 'events.jsonl')) ? fs.readFileSync(path.join(state, 'events.jsonl'), 'utf8').trim().split('\n').length : 0
console.log(`\nevents written: ${lines}`)

// N sessions making a tool call at the same moment: one process per guard against one bash-guards
async function concurrent() {
  const input = JSON.stringify({ session_id: 'bench', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'git status && npm test' } })
  const one = file => new Promise(resolve => {
    const c = spawn(process.execPath, [file], { env: base })
    c.on('exit', resolve)
    c.stdin.end(input)
  })
  const each = cases.filter(([n]) => n !== 'bash-guards').map(([n]) => path.join(src, `${n}.js`))
  const median = async fn => {
    const out = []
    for (let i = 0; i < Math.min(runs, 9); i++) {
      const t0 = process.hrtime.bigint()
      await fn()
      out.push(Number(process.hrtime.bigint() - t0) / 1e6)
    }
    return out.sort((a, b) => a - b)[Math.floor(out.length / 2)]
  }
  const apart = await median(() => Promise.all(Array.from({ length: sessions }, () => Promise.all(each.map(one)))))
  const together = await median(() => Promise.all(Array.from({ length: sessions }, () => one(path.join(src, 'bash-guards.js')))))
  console.log(`\n${sessions} tool calls at once: ${ms(apart)} with one process per guard, ${ms(together)} with bash-guards`)
}

;(sessions ? concurrent() : Promise.resolve()).finally(() => fs.rmSync(state, { recursive: true, force: true }))
