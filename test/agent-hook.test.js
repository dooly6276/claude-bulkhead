'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { ADAPTERS, AGENT_NAMES, run, clineCommands } = require('../src/agent-hook')
const { tempDir } = require('./helpers')

process.env.BULKHEAD_STATE_DIR = tempDir()
process.env.BULKHEAD_DISABLE = ''

const BLOCKED = 'pkill node'
const FINE = 'ls -la'
const BIN = path.join(__dirname, '..', 'bin', 'bulkhead')

// Payloads shaped like the ones in each agent's documentation (links in docs/other-agents.md).
const FIXTURES = {
  codex: cmd => ({
    session_id: '019a-codex', transcript_path: null, cwd: '/work/api', hook_event_name: 'PreToolUse', model: 'gpt-5.1-codex',
    turn_id: 'turn-1', permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: cmd },
  }),
  gemini: cmd => ({
    session_id: 'gem-1', transcript_path: '/home/dev/.gemini/tmp/x/chats/s.json', cwd: '/work/api', hook_event_name: 'BeforeTool',
    timestamp: '2026-11-11T08:00:00.000Z', tool_name: 'run_shell_command', tool_input: { command: cmd, description: 'run it', is_background: false },
  }),
  copilot: cmd => ({ sessionId: 'cop-1', timestamp: 1704614600000, cwd: '/work/api', toolName: 'bash', toolArgs: JSON.stringify({ command: cmd, description: 'run it' }) }),
  cursor: cmd => ({
    conversation_id: 'cur-1', generation_id: 'g-1', model: 'x', hook_event_name: 'beforeShellExecution', cursor_version: '2.0',
    workspace_roots: ['/work/api'], user_email: null, transcript_path: null, command: cmd, cwd: '/work/api', sandbox: false,
  }),
  windsurf: cmd => ({
    agent_action_name: 'pre_run_command', trajectory_id: 'traj-1', execution_id: 'exec-1', timestamp: '2026-11-11T08:00:00Z',
    model_name: 'Claude Sonnet 4', tool_info: { command_line: cmd, cwd: '/work/api' },
  }),
  droid: cmd => ({
    session_id: 'droid-1', transcript_path: '/home/dev/.factory/projects/x/session.jsonl', cwd: '/work/api', permission_mode: 'off',
    hook_event_name: 'PreToolUse', tool_name: 'Execute', tool_input: { command: cmd },
  }),
  devin: cmd => ({ hook_event_name: 'PreToolUse', tool_name: 'exec', tool_input: { command: cmd }, session_id: '3f8d1c2a', cwd: '/work/api' }),
  cline: cmd => ({
    hookName: 'tool_call', clineVersion: '1.0.0', timestamp: '2026-11-11T08:00:00Z', taskId: 'conv-1', workspaceRoots: ['/work/api'],
    userId: 'user', iteration: 1, tool_call: { id: 'call-1', name: 'run_commands', input: { commands: [cmd] } },
  }),
  opencode: cmd => ({ command: cmd, cwd: '/work/api', session_id: 'ses_1' }),
  amp: cmd => ({ command: cmd, cwd: '/work/api', session_id: 'T-1' }),
}

// What each agent's payload turns into for the guards.
const SESSION = { codex: '019a-codex', gemini: 'gem-1', copilot: 'cop-1', cursor: 'cur-1', windsurf: 'traj-1', droid: 'droid-1', devin: '3f8d1c2a', cline: 'conv-1', opencode: 'ses_1', amp: 'T-1' }

test('every adapter has a fixture and maps it to the shape the guards read', () => {
  assert.deepStrictEqual(Object.keys(FIXTURES).sort(), [...AGENT_NAMES].sort())
  for (const agent of AGENT_NAMES) {
    assert.deepStrictEqual(ADAPTERS[agent].read(FIXTURES[agent](FINE)), {
      tool_name: 'Bash', tool_input: { command: FINE }, cwd: '/work/api', session_id: SESSION[agent],
    }, agent)
  }
})

test('block answers use each agent\'s own format', async () => {
  const answer = async agent => run(agent, JSON.stringify(FIXTURES[agent](BLOCKED)))
  const text = /\[bulkhead\] kill-guard: pkill\/killall/

  const codex = await answer('codex')
  assert.strictEqual(codex.code, 0)
  const c = JSON.parse(codex.out).hookSpecificOutput
  assert.strictEqual(c.hookEventName, 'PreToolUse')
  assert.strictEqual(c.permissionDecision, 'deny')
  assert.match(c.permissionDecisionReason, text)

  const gemini = JSON.parse((await answer('gemini')).out)
  assert.strictEqual(gemini.decision, 'deny')
  assert.match(gemini.reason, text)

  const copilot = JSON.parse((await answer('copilot')).out)
  assert.strictEqual(copilot.permissionDecision, 'deny')
  assert.match(copilot.permissionDecisionReason, text)

  const cursor = JSON.parse((await answer('cursor')).out)
  assert.strictEqual(cursor.permission, 'deny')
  assert.match(cursor.agent_message, text)
  assert.ok(!cursor.user_message.includes('\n'))

  const droid = JSON.parse((await answer('droid')).out).hookSpecificOutput
  assert.strictEqual(droid.permissionDecision, 'deny')
  assert.match(droid.permissionDecisionReason, text)

  const cline = JSON.parse((await answer('cline')).out)
  assert.strictEqual(cline.cancel, true)
  assert.match(cline.errorMessage, text)

  // exit code 2 with the reason on stderr
  for (const agent of ['windsurf', 'devin', 'opencode', 'amp']) {
    const r = await answer(agent)
    assert.strictEqual(r.code, 2, agent)
    assert.match(r.err, text, agent)
    assert.ok(!r.out, agent)
    assert.ok(!r.err.endsWith('\n\n'), agent)
  }
})

test('allowed commands answer silently, or with the explicit allow Cursor and Cline need', async () => {
  const expected = { cursor: '{"permission":"allow"}', cline: '{}' }
  for (const agent of AGENT_NAMES) {
    const r = await run(agent, JSON.stringify(FIXTURES[agent](FINE)))
    assert.deepStrictEqual(r, { out: expected[agent] || '', code: 0 }, agent)
  }
})

test('anything that is not a shell command passes', async () => {
  const other = {
    codex: { ...FIXTURES.codex(BLOCKED), tool_name: 'apply_patch' },
    gemini: { ...FIXTURES.gemini(BLOCKED), tool_name: 'write_file', tool_input: { file_path: 'a', content: BLOCKED } },
    copilot: { ...FIXTURES.copilot(BLOCKED), toolName: 'edit' },
    windsurf: { agent_action_name: 'pre_read_code', tool_info: { file_path: '/a' } },
    droid: { ...FIXTURES.droid(BLOCKED), tool_name: 'Create' },
    devin: { ...FIXTURES.devin(BLOCKED), tool_name: 'read' },
    cline: { ...FIXTURES.cline(BLOCKED), tool_call: { id: 'c', name: 'read_files', input: { filePath: BLOCKED } } },
  }
  for (const [agent, payload] of Object.entries(other)) {
    assert.strictEqual((await run(agent, JSON.stringify(payload))).code, 0, agent)
    assert.ok(!JSON.parse((await run(agent, JSON.stringify(payload))).out || '{}').permissionDecision, agent)
  }
})

test('fails open on bad input: no JSON, wrong shapes, missing fields', async () => {
  const expected = { cursor: '{"permission":"allow"}', cline: '{}' }
  for (const agent of AGENT_NAMES) {
    for (const raw of ['', 'not json', '{}', 'null', '[]', '42', '{"tool_name":"Bash","tool_input":"pkill node"}', '{"toolName":"bash","toolArgs":"{broken"}',
      '{"tool_info":{"command_line":5}}', '{"tool_call":{"name":"run_commands","input":null}}', '{"command":{"a":1}}']) {
      assert.deepStrictEqual(await run(agent, raw), { out: expected[agent] || '', code: 0 }, `${agent}: ${raw}`)
    }
  }
})

test('one guard that throws does not silence the others', async () => {
  const kill = require('../src/kill-guard')
  const real = kill.handle
  kill.handle = () => { throw new Error('boom') }
  try {
    assert.strictEqual((await run('windsurf', JSON.stringify(FIXTURES.windsurf(BLOCKED)))).code, 0)
    const r = await run('windsurf', JSON.stringify(FIXTURES.windsurf('git push --force origin main')))
    assert.strictEqual(r.code, 2)
    assert.match(r.err, /force-pushing/)
  } finally {
    kill.handle = real
  }
})

test('BULKHEAD_DISABLE turns a guard off here too', async () => {
  process.env.BULKHEAD_DISABLE = 'kill-guard'
  try {
    assert.strictEqual((await run('windsurf', JSON.stringify(FIXTURES.windsurf(BLOCKED)))).code, 0)
  } finally {
    process.env.BULKHEAD_DISABLE = ''
  }
})

test('field mapping per agent', () => {
  // Gemini: dir_path is where the command runs, is_background marks a background job
  assert.deepStrictEqual(ADAPTERS.gemini.read({ cwd: '/work', tool_name: 'run_shell_command', tool_input: { command: 'npm run dev', dir_path: 'web', is_background: true }, session_id: 's' }),
    { tool_name: 'Bash', tool_input: { command: 'npm run dev', run_in_background: true }, cwd: path.resolve('/work', 'web'), session_id: 's' })
  // Copilot: camelCase with toolArgs as a JSON string or an object, the VS Code snake_case form, PowerShell
  const args = { command: 'git status' }
  assert.deepStrictEqual(ADAPTERS.copilot.read({ sessionId: 's', cwd: '/w', toolName: 'bash', toolArgs: args }).tool_input, args)
  assert.deepStrictEqual(ADAPTERS.copilot.read({ session_id: 's', cwd: '/w', tool_name: 'Bash', tool_input: args, hook_event_name: 'PreToolUse' }),
    { tool_name: 'Bash', tool_input: args, cwd: '/w', session_id: 's' })
  const ps = ADAPTERS.copilot.read({ sessionId: 's', cwd: 'C:\\w', toolName: 'powershell', toolArgs: '{"command":"Get-Date"}' })
  assert.strictEqual(ps.tool_name, 'PowerShell')
  // Cursor: the folder falls back to the first workspace root
  assert.strictEqual(ADAPTERS.cursor.read({ conversation_id: 'c', command: 'ls', cwd: '', workspace_roots: ['/ws'] }).cwd, '/ws')
  // Devin names its shell tool "exec"
  assert.ok(ADAPTERS.devin.read({ tool_name: 'exec', tool_input: { command: 'ls' } }))
})

test('cline run_commands inputs: string, list, { commands }, { command, args }, { cmd }', () => {
  assert.strictEqual(clineCommands('ls'), 'ls')
  assert.strictEqual(clineCommands(['ls', 'pwd']), 'ls\npwd')
  assert.strictEqual(clineCommands({ commands: ['a', 'b'] }), 'a\nb')
  assert.strictEqual(clineCommands({ commands: 'a' }), 'a')
  assert.strictEqual(clineCommands({ command: 'git', args: ['commit', '-m', 'two words'] }), "git commit -m 'two words'")
  assert.strictEqual(clineCommands({ cmd: 'ls' }), 'ls')
  assert.strictEqual(clineCommands({ commands: [{ command: 'rm', args: ['-rf', 'build'] }, 'ls'] }), 'rm -rf build\nls')
  assert.strictEqual(clineCommands(null), '')
  assert.strictEqual(clineCommands({ commands: [] }), '')
})

function cli(agent, input, env = {}) {
  return spawnSync(process.execPath, [BIN, 'hook', ...(agent ? ['--agent', agent] : [])], {
    input, encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: process.env.BULKHEAD_STATE_DIR, BULKHEAD_DISABLE: '', ...env },
  })
}

test('bulkhead hook --agent, as the agents run it', () => {
  const codex = cli('codex', JSON.stringify(FIXTURES.codex(BLOCKED)))
  assert.strictEqual(codex.status, 0)
  assert.strictEqual(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, 'deny')

  const windsurf = cli('windsurf', JSON.stringify(FIXTURES.windsurf(BLOCKED)))
  assert.strictEqual(windsurf.status, 2)
  assert.match(windsurf.stderr, /kill-guard/)
  assert.strictEqual(windsurf.stdout, '')

  // Cursor and Copilot read a crash or odd output as a denial, so garbage in still gets a clean answer
  const cursor = cli('cursor', 'garbage')
  assert.strictEqual(cursor.status, 0)
  assert.deepStrictEqual(JSON.parse(cursor.stdout), { permission: 'allow' })
  const copilot = cli('copilot', 'garbage')
  assert.strictEqual(copilot.status, 0)
  assert.strictEqual(copilot.stdout, '')

  // the block is logged with the agent that caused it
  const events = fs.readFileSync(path.join(process.env.BULKHEAD_STATE_DIR, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(events.some(e => e.guard === 'kill-guard' && e.agent === 'codex' && e.session === '019a-codex'))
  assert.ok(events.some(e => e.agent === 'windsurf'))
})

test('bulkhead hook needs a known agent', () => {
  for (const agent of [null, 'nope']) {
    const r = cli(agent, '{}')
    assert.strictEqual(r.status, 1)
    assert.match(r.stderr, /usage: bulkhead hook --agent <codex\|gemini\|copilot\|cursor\|windsurf\|droid\|devin\|cline\|opencode\|amp>/)
  }
})
