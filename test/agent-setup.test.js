'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { spawnSync } = require('child_process')
const { plan, apply, commandLine, isOurs, SETUP, AGENT_NAMES, main } = require('../src/agent-setup')
const { tempDir } = require('./helpers')

const NODE = '/usr/local/bin/node'
const SCRIPT = '/opt/bulkhead/bin/bulkhead'
const ctx = (home, extra = {}) => ({ home, env: {}, platform: 'linux', argv: [NODE, SCRIPT], ...extra })
const read = f => fs.readFileSync(f, 'utf8')
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const backups = f => fs.readdirSync(path.dirname(f)).filter(n => n.startsWith(path.basename(f) + '.bulkhead-backup'))

test('every agent has a setup, and the printed config calls bulkhead hook for that agent', () => {
  assert.deepStrictEqual([...AGENT_NAMES].sort(), ['amp', 'cline', 'codex', 'copilot', 'cursor', 'devin', 'droid', 'gemini', 'opencode', 'windsurf'])
  for (const agent of AGENT_NAMES) {
    const home = tempDir()
    const p = plan(agent, ctx(home))
    assert.ok(!p.error, agent)
    assert.ok(p.file.startsWith(home), agent)
    assert.ok(p.snippet.includes(`${SCRIPT} hook --agent ${agent}`) || p.snippet.includes(`"hook","--agent","${agent}"`) || p.snippet.includes(`${SCRIPT}' hook --agent ${agent}`), agent)
    // plugins carry a marker comment instead of a command line
    assert.ok(isOurs(p.snippet, agent) || p.snippet.includes('bulkhead-managed'), agent)
    assert.ok(!isOurs(p.snippet, agent === 'codex' ? 'gemini' : 'codex'), agent)
    assert.ok(!fs.existsSync(p.file), `${agent}: planning must not write`)
  }
})

test('writing twice changes nothing the second time, and the original is kept once', () => {
  for (const agent of AGENT_NAMES) {
    const home = tempDir()
    const first = plan(agent, ctx(home))
    write(first.file, agent === 'cline' || agent === 'opencode' || agent === 'amp' || agent === 'copilot' ? '' : '{"keep":{"me":1}}')
    if (['cline', 'opencode', 'amp', 'copilot'].includes(agent)) fs.rmSync(first.file)
    const p1 = plan(agent, ctx(home))
    const done = apply(p1)
    assert.strictEqual(done.wrote, true, agent)
    const after = read(p1.file)
    const p2 = plan(agent, ctx(home))
    assert.strictEqual(p2.next, null, agent)
    assert.deepStrictEqual(apply(p2), { wrote: false, backup: null }, agent)
    assert.strictEqual(read(p1.file), after, agent)
    assert.strictEqual(backups(p1.file).length, done.backup ? 1 : 0, agent)
    if (done.backup) assert.ok(read(done.backup).includes('"keep"'), agent)
    // still found after the file is reformatted by hand or by the agent
    if (p1.file.endsWith('.json') && !['copilot'].includes(agent)) {
      fs.writeFileSync(p1.file, JSON.stringify(JSON.parse(after)))
      assert.strictEqual(plan(agent, ctx(home)).next, null, `${agent}: compact`)
    }
  }
})

test('merging keeps what the file already had', () => {
  const home = tempDir()
  const gemini = path.join(home, '.gemini', 'settings.json')
  write(gemini, JSON.stringify({ theme: 'dark', hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ type: 'command', command: 'audit.sh' }] }], AfterTool: [] } }))
  apply(plan('gemini', ctx(home)))
  const doc = JSON.parse(read(gemini))
  assert.strictEqual(doc.theme, 'dark')
  assert.deepStrictEqual(doc.hooks.AfterTool, [])
  assert.strictEqual(doc.hooks.BeforeTool.length, 2)
  assert.strictEqual(doc.hooks.BeforeTool[0].hooks[0].command, 'audit.sh')
  assert.strictEqual(doc.hooks.BeforeTool[1].matcher, 'run_shell_command')

  const cursor = path.join(home, '.cursor', 'hooks.json')
  write(cursor, JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }], beforeShellExecution: [{ command: './mine.sh' }] } }))
  apply(plan('cursor', ctx(home)))
  const c = JSON.parse(read(cursor))
  assert.deepStrictEqual(c.hooks.afterFileEdit, [{ command: './format.sh' }])
  assert.deepStrictEqual(c.hooks.beforeShellExecution.map(h => h.command.slice(0, 7)), ['./mine.', NODE.slice(0, 7)])
})

test('files that are not plain JSON objects are left alone', () => {
  const home = tempDir()
  const f = path.join(home, '.gemini', 'settings.json')
  write(f, '{\n  // my settings\n  "theme": "dark"\n}\n')
  const p = plan('gemini', ctx(home))
  assert.match(p.error, /not plain JSON/)
  assert.ok(p.snippet.includes('run_shell_command'))
  assert.strictEqual(read(f), '{\n  // my settings\n  "theme": "dark"\n}\n')
  write(f, '[1]')
  assert.match(plan('gemini', ctx(home)).error, /does not hold a JSON object/)
  write(f, '{"hooks":{"BeforeTool":"x"}}')
  assert.match(plan('gemini', ctx(home)).error, /"BeforeTool" is not a list/)
  write(f, '   \n')
  assert.ok(!plan('gemini', ctx(home)).error)
})

test('files bulkhead owns are replaced only when they are bulkhead\'s', () => {
  for (const [agent, rel] of [['copilot', '.copilot/hooks/bulkhead.json'], ['cline', '.cline/hooks/PreToolUse.sh'], ['opencode', '.config/opencode/plugins/bulkhead.js'], ['amp', '.config/amp/plugins/bulkhead.ts']]) {
    const home = tempDir()
    const file = path.join(home, rel)
    write(file, 'someone else\'s hook\n')
    const p = plan(agent, ctx(home))
    assert.match(p.error, /already exists and is not from bulkhead/, agent)
    assert.strictEqual(read(file), 'someone else\'s hook\n', agent)
    // ours, from an older node: updated in place
    fs.rmSync(file)
    apply(plan(agent, ctx(home, { argv: ['/old/node', SCRIPT] })))
    const next = plan(agent, ctx(home))
    assert.ok(next.next && next.next.includes(NODE), agent)
    assert.strictEqual(apply(next).wrote, true, agent)
    assert.ok(read(file).includes(NODE) && !read(file).includes('/old/node'), agent)
  }
})

test('where each agent keeps its config', () => {
  const home = '/home/dev'
  const where = (agent, env = {}, platform = 'linux') => SETUP[agent].where(home, env, platform).replace(/\\/g, '/')
  assert.strictEqual(where('codex'), '/home/dev/.codex/hooks.json')
  assert.strictEqual(where('codex', { CODEX_HOME: '/x/codex' }), '/x/codex/hooks.json')
  assert.strictEqual(where('gemini'), '/home/dev/.gemini/settings.json')
  assert.strictEqual(where('copilot'), '/home/dev/.copilot/hooks/bulkhead.json')
  assert.strictEqual(where('copilot', { COPILOT_HOME: '/x/cop' }), '/x/cop/hooks/bulkhead.json')
  assert.strictEqual(where('cursor'), '/home/dev/.cursor/hooks.json')
  assert.strictEqual(where('windsurf'), '/home/dev/.codeium/windsurf/hooks.json')
  assert.strictEqual(where('opencode'), '/home/dev/.config/opencode/plugins/bulkhead.js')
  assert.strictEqual(where('opencode', { XDG_CONFIG_HOME: '/xdg' }), '/xdg/opencode/plugins/bulkhead.js')
  assert.strictEqual(where('amp'), '/home/dev/.config/amp/plugins/bulkhead.ts')
  assert.strictEqual(where('cline'), '/home/dev/.cline/hooks/PreToolUse.sh')
  assert.strictEqual(where('cline', { CLINE_DIR: '/x/cline' }), '/x/cline/hooks/PreToolUse.sh')
  assert.strictEqual(where('cline', {}, 'win32'), '/home/dev/.cline/hooks/PreToolUse.ps1')
  assert.strictEqual(where('devin'), '/home/dev/.config/devin/config.json')
  assert.strictEqual(where('devin', { APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'win32').toLowerCase(), 'c:/users/dev/appdata/roaming/devin/config.json')
})

test('droid: hooks.json when it exists, else the hooks key of settings.json, else a new hooks.json', () => {
  const home = tempDir()
  const settings = path.join(home, '.factory', 'settings.json')
  const hooks = path.join(home, '.factory', 'hooks.json')
  assert.strictEqual(plan('droid', ctx(home)).file, hooks)
  write(settings, '{"model":"x"}')
  assert.strictEqual(plan('droid', ctx(home)).file, hooks)
  write(settings, JSON.stringify({ model: 'x', hooks: { PostToolUse: [] } }))
  const p = plan('droid', ctx(home))
  assert.strictEqual(p.file, settings)
  apply(p)
  const doc = JSON.parse(read(settings))
  assert.strictEqual(doc.model, 'x')
  assert.strictEqual(doc.hooks.PreToolUse[0].matcher, 'Execute')
  write(hooks, '{}')
  assert.strictEqual(plan('droid', ctx(home)).file, hooks)
  assert.ok(Object.keys(JSON.parse(plan('droid', ctx(home)).snippet)).includes('PreToolUse'))
})

test('commands are quoted for paths with spaces, and Windows gets a PowerShell hook for Cline', () => {
  assert.strictEqual(commandLine('codex', ['C:\\Program Files\\nodejs\\node.exe', 'C:\\bh\\bin\\bulkhead']), '"C:\\Program Files\\nodejs\\node.exe" C:\\bh\\bin\\bulkhead hook --agent codex')
  assert.ok(isOurs(commandLine('codex', ['/a b/node', '/c d/bin/bulkhead']), 'codex'))
  assert.ok(isOurs(JSON.stringify({ c: commandLine('cursor', ['/a b/node', '/c d/bin/bulkhead']) }), 'cursor'))
  const win = plan('cline', ctx(tempDir(), { platform: 'win32', argv: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\bh\\bin\\bulkhead'] }))
  assert.match(win.snippet, /\$input \| & "C:\\Program Files\\nodejs\\node\.exe" "C:\\bh\\bin\\bulkhead" hook --agent cline\r\n$/)
  const sh = plan('cline', ctx(tempDir(), { argv: ["/home/o'brien/node", SCRIPT] }))
  assert.match(sh.snippet, /^#!\/usr\/bin\/env bash\n.*\nexec '\/home\/o'\\''brien\/node' '\/opt\/bulkhead\/bin\/bulkhead' hook --agent cline\n$/)
  assert.strictEqual(sh.mode, 0o755)
})

function run(args, env, platform) {
  const out = []
  const err = []
  let code = null
  main(args, { stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) }, exit: c => { code = c }, ctx: ctx(env, platform) })
  return { out: out.join(''), err: err.join(''), code }
}

test('bulkhead setup <agent> prints by default and writes only with --write', () => {
  const home = tempDir()
  const printed = run(['codex'], home)
  assert.strictEqual(printed.code, 0)
  assert.match(printed.out, /^# .*\.codex[\\/]hooks\.json\n\{\n {2}"hooks"/)
  assert.match(printed.out, /# Codex asks you to review a new hook once/)
  assert.deepStrictEqual(run(['codex', '--print'], home).out, printed.out)
  assert.ok(!fs.existsSync(path.join(home, '.codex')))

  const wrote = run(['codex', '--write'], home)
  assert.strictEqual(wrote.code, 0)
  assert.match(wrote.out, /^created .*hooks\.json\n/)
  assert.ok(isOurs(read(path.join(home, '.codex', 'hooks.json')), 'codex'))
  assert.match(run(['codex', '--write'], home).out, /already has bulkhead; nothing changed/)
  assert.match(run(['codex'], home).out, /\(already set up\)/)

  write(path.join(home, '.codex', 'hooks.json'), '{"description":"mine"}')
  assert.match(run(['codex', '--write'], home).out, /^updated .*\nbackup of the original: .*hooks\.json\.bulkhead-backup\n/)
})

test('bulkhead setup rejects what it cannot do', () => {
  const home = tempDir()
  assert.strictEqual(run([], home).code, 1)
  assert.match(run([], home).err, /agents: codex, gemini/)
  assert.strictEqual(run(['nope'], home).code, 1)
  assert.match(run(['codex', '--print', '--write'], home).err, /not both/)
  assert.strictEqual(run(['codex', '--bogus'], home).code, 1)
  const f = path.join(home, '.gemini', 'settings.json')
  write(f, '{ nope')
  const bad = run(['gemini', '--write'], home)
  assert.strictEqual(bad.code, 1)
  assert.match(bad.err, /not plain JSON/)
  assert.match(bad.err, /run_shell_command/)
  assert.strictEqual(read(f), '{ nope')
  process.exitCode = 0
})

test('the opencode plugin blocks a bash tool call when the hook exits 2, and only then', async () => {
  const dir = tempDir()
  const stub = path.join(dir, 'hook.js')
  fs.writeFileSync(stub, `let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => {
    require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, s)
    if (JSON.parse(s).command.includes('boom')) { console.error('[bulkhead] stopped'); process.exit(2) }
  })`)
  const file = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(file, plan('opencode', ctx(dir, { argv: [process.execPath, stub] })).snippet)
  const { BulkheadPlugin } = await import(pathToFileURL(file).href)
  const hooks = await BulkheadPlugin({ directory: '/work/api' })
  const before = hooks['tool.execute.before']
  await before({ tool: 'bash', sessionID: 'ses_9', callID: 'c' }, { args: { command: 'ls' } })
  assert.deepStrictEqual(JSON.parse(read(path.join(dir, 'seen.json'))), { command: 'ls', cwd: '/work/api', session_id: 'ses_9' })
  await assert.rejects(before({ tool: 'bash', sessionID: 'ses_9', callID: 'c' }, { args: { command: 'boom', workdir: '/other' } }), /\[bulkhead\] stopped/)
  assert.strictEqual(JSON.parse(read(path.join(dir, 'seen.json'))).cwd, '/other')
  fs.rmSync(path.join(dir, 'seen.json'))
  await before({ tool: 'read', sessionID: 's', callID: 'c' }, { args: { filePath: 'boom' } })
  await before({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: {} })
  assert.ok(!fs.existsSync(path.join(dir, 'seen.json')))
  // a hook that cannot start lets the call through
  fs.writeFileSync(file, plan('opencode', ctx(dir, { argv: ['/nonexistent/node', stub] })).snippet)
  const again = await import(pathToFileURL(file).href + '?second')
  await (await again.BulkheadPlugin({ directory: '/w' }))['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c' }, { args: { command: 'boom' } })
})

test('the Amp plugin rejects a shell tool call when the hook exits 2, and only then', async () => {
  const dir = tempDir()
  const stub = path.join(dir, 'hook.js')
  fs.writeFileSync(stub, `let s = ''; process.stdin.on('data', d => (s += d)).on('end', () => {
    if (JSON.parse(s).command.includes('boom')) { console.error('[bulkhead] stopped'); process.exit(2) }
  })`)
  // the plugin is TypeScript for Bun; strip the two type annotations to load it as a module here
  const ts = plan('amp', ctx(dir, { argv: [process.execPath, stub] })).snippet
  assert.match(ts, /import type \{ PluginAPI \} from '@ampcode\/plugin'/)
  const file = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(file, ts.replace(/^import type .*\n/m, '').replace(': PluginAPI', ''))
  const mod = await import(pathToFileURL(file).href)
  let handler
  const amp = {
    on: (name, fn) => { assert.strictEqual(name, 'tool.call'); handler = fn },
    helpers: { shellCommandFromToolCall: e => (e.tool === 'Bash' ? { command: e.input.command, dir: e.input.cwd } : null) },
  }
  mod.default(amp)
  const call = (tool, command) => handler({ toolUseID: 't', tool, input: { command, cwd: '/w' }, thread: { id: 'T-1' } })
  assert.deepStrictEqual(await call('Bash', 'ls'), { action: 'allow' })
  assert.deepStrictEqual(await call('Read', 'boom'), { action: 'allow' })
  assert.deepStrictEqual(await call('Bash', 'boom'), { action: 'reject-and-continue', message: '[bulkhead] stopped' })
})

test('the command line works end to end', () => {
  const home = tempDir()
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'bulkhead'), 'setup', 'cursor', '--write'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } })
  assert.strictEqual(r.status, 0)
  assert.match(r.stdout, /^created /)
  const cfg = JSON.parse(read(path.join(home, '.cursor', 'hooks.json')))
  assert.strictEqual(cfg.version, 1)
  const cmd = cfg.hooks.beforeShellExecution[0].command
  // the written command is a real command line: run it with a blocked payload
  const hook = spawnSync(cmd, { shell: true, input: JSON.stringify({ conversation_id: 'c', command: 'git push --force origin main', cwd: '/tmp' }), encoding: 'utf8', env: { ...process.env, BULKHEAD_STATE_DIR: tempDir(), BULKHEAD_DISABLE: '' } })
  assert.strictEqual(JSON.parse(hook.stdout).permission, 'deny')
})
