'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { rejectArgs } = require('./cli-util')

// `bulkhead setup <agent> [--print|--write]`: the config that makes an agent call
// `bulkhead hook --agent <name>` before each shell command. --print (the default) shows it,
// --write merges it into the agent's config file after copying the original aside. Running it
// again changes nothing.

const SCRIPT = path.join(__dirname, '..', 'bin', 'bulkhead')
const MARK = 'bulkhead-managed'

const quote = s => (/[\s"]/.test(s) ? `"${s}"` : s)
// The node that runs this now, by absolute path: agents started from a desktop launcher often
// have no node on their PATH, and Copilot turns a hook that cannot start into a denial.
const launcher = (node = process.execPath, script = SCRIPT) => [node, script]
const commandLine = (agent, argv = launcher()) => [...argv.map(quote), 'hook', '--agent', agent].join(' ')
const isOurs = (text, agent) => new RegExp(`bulkhead\\\\?["']?\\s+hook\\s+--agent[ =]${agent}\\b`).test(text)
const pretty = v => JSON.stringify(v, null, 2) + '\n'

// The `command`/`bash` strings of every hook in a list of matcher groups.
const commandsIn = groups => JSON.stringify(groups || [])

// Adds `group` to doc[...path][event] unless one of our hooks is already there. Returns the doc.
function addGroup(doc, pathKeys, event, group, agent) {
  let node = doc
  for (const k of pathKeys) {
    if (node[k] === undefined) node[k] = {}
    if (!node[k] || typeof node[k] !== 'object' || Array.isArray(node[k])) throw new Error(`"${k}" is not an object`)
    node = node[k]
  }
  if (node[event] === undefined) node[event] = []
  if (!Array.isArray(node[event])) throw new Error(`"${event}" is not a list`)
  if (!isOurs(commandsIn(node[event]), agent)) node[event].push(group)
  return doc
}

function jsonPlan(file, existing, build) {
  const fragment = build({})
  const snippet = pretty(fragment)
  if (existing === null || !existing.trim()) return { file, snippet, next: snippet }
  let doc
  try {
    doc = JSON.parse(existing)
  } catch (e) {
    return { file, snippet, error: `${file} is not plain JSON (${e.message}); add the snippet by hand` }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { file, snippet, error: `${file} does not hold a JSON object; add the snippet by hand` }
  const before = pretty(doc)
  let next
  try {
    next = pretty(build(doc))
  } catch (e) {
    return { file, snippet, error: `${file}: ${e.message}; add the snippet by hand` }
  }
  return { file, snippet, next: next === before ? null : next }
}

// A file bulkhead owns outright (a script, a plugin): install it, update ours, never replace another's.
function ownedPlan(file, existing, content, agent) {
  if (existing !== null && !existing.includes(MARK) && !isOurs(existing, agent)) {
    return { file, snippet: content, error: `${file} already exists and is not from bulkhead; put the call to \`bulkhead hook --agent ${agent}\` in it by hand` }
  }
  return { file, snippet: content, next: existing === content ? null : content, mode: 0o755 }
}

// The opencode plugin body after its HOOK line, shared with opencode/plugin.mjs, the copy that
// ships in the npm package for opencode's `"plugin": ["claude-bulkhead"]` route.
const OPENCODE_PLUGIN = `export const BulkheadPlugin = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'bash') return
    const command = output.args && output.args.command
    if (typeof command !== 'string' || !command) return
    const cwd = (output.args && output.args.workdir) || directory
    const r = spawnSync(HOOK[0], HOOK.slice(1), {
      input: JSON.stringify({ command, cwd, session_id: input.sessionID }), encoding: 'utf8', timeout: 25000, windowsHide: true,
    })
    if (r.status === 2) throw new Error((r.stderr || 'blocked by bulkhead').trim())
  },
})
`

// The Pi extension body after its HOOK line, shared with pi/extension.js, the copy that Pi loads
// from the npm package (package.json "pi.extensions") after `pi install npm:claude-bulkhead`.
// Pi awaits the handler, so the guard runs in a child process without stopping Pi's event loop.
const PI_EXTENSION = `function ask(input) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(HOOK[0], HOOK.slice(1), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
    } catch {
      return resolve(null)
    }
    let err = ''
    const timer = setTimeout(() => child.kill(), 25000)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', d => (err += d))
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('close', code => { clearTimeout(timer); resolve(code === 2 ? err.trim() || 'blocked by bulkhead' : null) })
    child.stdin.end(JSON.stringify(input))
  })
}

module.exports = function bulkhead(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (!event || (event.toolName !== 'bash' && event.toolName !== 'powershell')) return undefined
    const command = event.input && event.input.command
    if (typeof command !== 'string' || !command) return undefined
    const sessions = ctx && ctx.sessionManager
    const session = sessions && typeof sessions.getSessionId === 'function' ? sessions.getSessionId() : undefined
    const reason = await ask({ command, cwd: (ctx && ctx.cwd) || process.cwd(), session_id: session, tool: event.toolName })
    return reason ? { block: true, reason } : undefined
  })
}
`

const pluginSource = (agent, argv) => ({
  pi: `// ${MARK}: written by \`bulkhead setup pi\`, safe to delete
'use strict'
const { spawn } = require('child_process')

const HOOK = ${JSON.stringify([...argv, 'hook', '--agent', 'pi'])}

${PI_EXTENSION}`,
  opencode: `// ${MARK}: written by \`bulkhead setup opencode\`, safe to delete
import { spawnSync } from 'node:child_process'

const HOOK = ${JSON.stringify([...argv, 'hook', '--agent', 'opencode'])}

${OPENCODE_PLUGIN}`,
  amp: `// ${MARK}: written by \`bulkhead setup amp\`, safe to delete
import { spawnSync } from 'node:child_process'
import type { PluginAPI } from '@ampcode/plugin'

const HOOK = ${JSON.stringify([...argv, 'hook', '--agent', 'amp'])}

export default function (amp: PluginAPI) {
  amp.on('tool.call', async event => {
    const shell = amp.helpers.shellCommandFromToolCall(event)
    if (!shell || !shell.command) return { action: 'allow' }
    const r = spawnSync(HOOK[0], HOOK.slice(1), {
      input: JSON.stringify({ command: shell.command, cwd: shell.dir || process.cwd(), session_id: event.thread.id }),
      encoding: 'utf8', timeout: 25000, windowsHide: true,
    })
    if (r.status === 2) return { action: 'reject-and-continue', message: (r.stderr || 'blocked by bulkhead').trim() }
    return { action: 'allow' }
  })
}
`,
})[agent]

const clineScript = (argv, platform) => platform === 'win32'
  ? `# ${MARK}: written by \`bulkhead setup cline\`\r\n$input | & ${argv.map(a => `"${a}"`).join(' ')} hook --agent cline\r\n`
  : `#!/usr/bin/env bash\n# ${MARK}: written by \`bulkhead setup cline\`\nexec ${argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')} hook --agent cline\n`

// agent: { where(home, env, platform) -> file, plan(file, existing, ctx) -> plan, note }
const SETUP = {
  codex: {
    where: (home, env) => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => addGroup(doc, ['hooks'], 'PreToolUse',
      { matcher: '^Bash$', hooks: [{ type: 'command', command: commandLine('codex', argv), timeout: 30, statusMessage: 'bulkhead guards' }] }, 'codex')),
    note: 'Codex asks you to review a new hook once: open /hooks in Codex and trust it.',
  },
  gemini: {
    where: home => path.join(home, '.gemini', 'settings.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => addGroup(doc, ['hooks'], 'BeforeTool',
      { matcher: 'run_shell_command', hooks: [{ name: 'bulkhead', type: 'command', command: commandLine('gemini', argv), timeout: 30000 }] }, 'gemini')),
  },
  copilot: {
    where: (home, env) => path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'hooks', 'bulkhead.json'),
    plan: (file, existing, { argv }) => {
      const command = commandLine('copilot', argv)
      return ownedPlan(file, existing, pretty({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: command, powershell: command, timeoutSec: 30 }] } }), 'copilot')
    },
    note: 'Copilot CLI treats a hook that fails to start as a denial. If you move or remove this node, run the setup again.',
  },
  cursor: {
    where: home => path.join(home, '.cursor', 'hooks.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => {
      doc.version = doc.version || 1
      const list = (doc.hooks = doc.hooks || {}).beforeShellExecution = (doc.hooks.beforeShellExecution || [])
      if (!isOurs(commandsIn(list), 'cursor')) list.push({ command: commandLine('cursor', argv), timeout: 30 })
      return doc
    }),
  },
  windsurf: {
    where: home => path.join(home, '.codeium', 'windsurf', 'hooks.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => {
      const list = (doc.hooks = doc.hooks || {}).pre_run_command = (doc.hooks.pre_run_command || [])
      if (!isOurs(commandsIn(list), 'windsurf')) list.push({ command: commandLine('windsurf', argv), show_output: false })
      return doc
    }),
    note: 'This is the Windsurf IDE user file. The JetBrains plugin reads ~/.codeium/hooks.json instead.',
  },
  droid: {
    // hooks.json wins over the hooks key in settings.json, so a user who only has the second keeps it
    where: home => {
      const hooks = path.join(home, '.factory', 'hooks.json')
      const settings = path.join(home, '.factory', 'settings.json')
      try {
        if (!fs.existsSync(hooks) && JSON.parse(fs.readFileSync(settings, 'utf8')).hooks) return settings
      } catch {}
      return hooks
    },
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => addGroup(doc, path.basename(file) === 'settings.json' ? ['hooks'] : [], 'PreToolUse',
      { matcher: 'Execute', hooks: [{ type: 'command', command: commandLine('droid', argv), timeout: 30 }] }, 'droid')),
  },
  devin: {
    where: (home, env, platform) => platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'devin', 'config.json')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'devin', 'config.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => addGroup(doc, ['hooks'], 'PreToolUse',
      { matcher: 'exec', hooks: [{ type: 'command', command: commandLine('devin', argv) }] }, 'devin')),
  },
  cline: {
    where: (home, env, platform) => path.join(env.CLINE_DIR || path.join(home, '.cline'), 'hooks', platform === 'win32' ? 'PreToolUse.ps1' : 'PreToolUse.sh'),
    plan: (file, existing, { argv, platform }) => ownedPlan(file, existing, clineScript(argv, platform), 'cline'),
  },
  opencode: {
    where: (home, env) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'plugins', 'bulkhead.js'),
    plan: (file, existing, { argv }) => ownedPlan(file, existing, pluginSource('opencode', argv), 'opencode'),
    note: 'Restart opencode to load the plugin.',
  },
  amp: {
    where: (home, env) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'amp', 'plugins', 'bulkhead.ts'),
    plan: (file, existing, { argv }) => ownedPlan(file, existing, pluginSource('amp', argv), 'amp'),
    note: 'Run `plugins: reload` from the Amp command palette to load the plugin.',
  },
  pi: {
    where: (home, env) => path.join(env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), 'extensions', 'bulkhead.js'),
    plan: (file, existing, { argv }) => ownedPlan(file, existing, pluginSource('pi', argv), 'pi'),
    note: 'Run /reload in Pi, or restart it, to load the extension. `pi install npm:claude-bulkhead` loads the same extension without this file; use one or the other.',
  },
  qwen: {
    where: (home, env) => path.join(env.QWEN_HOME || path.join(home, '.qwen'), 'settings.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => addGroup(doc, ['hooks'], 'PreToolUse',
      { matcher: '^run_shell_command$', hooks: [{ type: 'command', command: commandLine('qwen', argv), name: 'bulkhead', timeout: 30 }] }, 'qwen')),
  },
  kimi: {
    // Kimi Code reads ~/.kimi-code/config.toml ($KIMI_CODE_HOME); the older kimi-cli reads ~/.kimi/config.toml
    where: (home, env) => {
      if (env.KIMI_CODE_HOME) return path.join(env.KIMI_CODE_HOME, 'config.toml')
      const legacy = path.join(home, '.kimi')
      return !fs.existsSync(path.join(home, '.kimi-code')) && fs.existsSync(legacy) ? path.join(legacy, 'config.toml') : path.join(home, '.kimi-code', 'config.toml')
    },
    plan: (file, existing, { argv }) => tomlPlan(file, existing, commandLine('kimi', argv), 'kimi'),
    note: 'Kimi ignores the whole config file when a [[hooks]] entry has a key other than event, matcher, command and timeout.',
  },
  grok: {
    where: (home, env) => path.join(env.GROK_HOME || path.join(home, '.grok'), 'hooks', 'bulkhead.json'),
    plan: (file, existing, { argv }) => ownedPlan(file, existing, pretty({
      hooks: { PreToolUse: [{ matcher: 'Bash|bash|Shell|run_terminal', hooks: [{ type: 'command', command: commandLine('grok', argv), timeout: 30 }] }] },
    }), 'grok'),
    note: 'If Grok lists the hook as disabled, enable it with /hooks.',
  },
  antigravity: {
    where: home => path.join(home, '.gemini', 'config', 'hooks.json'),
    plan: (file, existing, { argv }) => jsonPlan(file, existing, doc => {
      // top-level keys are named hook groups; ours is "bulkhead"
      if (!isOurs(JSON.stringify(doc), 'antigravity')) {
        if (doc.bulkhead !== undefined) throw new Error('"bulkhead" is already used by another hook group')
        doc.bulkhead = { PreToolUse: [{ matcher: '^run_command$', hooks: [{ type: 'command', command: commandLine('antigravity', argv), timeout: 30 }] }] }
      }
      return doc
    }),
    note: 'Antigravity treats a hook that cannot start as a denial. If you move or remove this node, run the setup again.',
  },
}

// Kimi's config is TOML. bulkhead appends one [[hooks]] table with exactly the four keys Kimi
// accepts, and never rewrites anything that is already there.
const tomlString = s => JSON.stringify(s)
function tomlPlan(file, existing, command, agent) {
  const block = `# ${MARK}: added by \`bulkhead setup ${agent}\`\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "^(Bash|Shell)$"\ncommand = ${tomlString(command)}\ntimeout = 30\n`
  if (existing === null || !existing.trim()) return { file, snippet: block, next: block }
  if (isOurs(existing.replace(/\\\\/g, '\\'), agent)) return { file, snippet: block, next: null }
  if (/^\s*hooks\s*=/m.test(existing)) return { file, snippet: block, error: `${file} sets hooks as an inline array; add the [[hooks]] table by hand` }
  return { file, snippet: block, next: `${existing.replace(/\n*$/, '\n')}\n${block}` }
}

const AGENT_NAMES = Object.keys(SETUP)

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

// What `setup` would do for one agent. { file, snippet, next, error?, note }; next is null when
// the file already has it.
function plan(agent, { home = os.homedir(), env = process.env, platform = process.platform, argv = launcher() } = {}) {
  const spec = SETUP[agent]
  const file = spec.where(home, env, platform)
  let existing
  try { existing = readIfExists(file) } catch (e) { return { file, snippet: '', error: `cannot read ${file}: ${e.message}` } }
  return { ...spec.plan(file, existing, { argv, platform }), existing, note: spec.note || null }
}

function backupName(file, exists = fs.existsSync, now = Date.now()) {
  const base = file + '.bulkhead-backup'
  return exists(base) ? `${base}-${now}` : base
}

// Writes the plan. Returns { wrote, backup }. The original is copied first and the new content
// goes in through a temporary file, so a crash never leaves a half-written config.
function apply(p) {
  if (p.next === null || p.next === undefined) return { wrote: false, backup: null }
  fs.mkdirSync(path.dirname(p.file), { recursive: true })
  let backup = null
  if (p.existing !== null && p.existing !== undefined) {
    backup = backupName(p.file)
    fs.copyFileSync(p.file, backup)
  }
  const tmp = `${p.file}.bulkhead-tmp-${process.pid}`
  fs.writeFileSync(tmp, p.next, { mode: p.mode || 0o644 })
  fs.renameSync(tmp, p.file)
  return { wrote: true, backup }
}

function main(args, { stdout = process.stdout, stderr = process.stderr, exit = process.exit, ctx = {} } = {}) {
  const agent = args.find(a => !a.startsWith('--'))
  const list = () => `agents: ${AGENT_NAMES.join(', ')}`
  if (rejectArgs('setup', args.filter(a => a !== agent), { flags: ['print', 'write'], valued: [] }, stderr, null)) return exit(1)
  if (!agent || !SETUP[agent]) {
    stderr.write(`usage: bulkhead setup <agent> [--print|--write]\n${list()}\n`)
    return exit(1)
  }
  if (args.includes('--print') && args.includes('--write')) {
    stderr.write('bulkhead setup: use --print or --write, not both\n')
    return exit(1)
  }
  const p = plan(agent, ctx)
  if (p.error) {
    stderr.write(`bulkhead setup: ${p.error}\n`)
    if (p.snippet) stderr.write(`\n${p.snippet}`)
    return exit(1)
  }
  if (!args.includes('--write')) {
    stdout.write(`# ${p.file}${p.next === null ? '  (already set up)' : ''}\n${p.snippet}`)
    if (p.note) stdout.write(`# ${p.note}\n`)
    return exit(0)
  }
  const done = apply(p)
  stdout.write(done.wrote
    ? `${p.existing === null ? 'created' : 'updated'} ${p.file}${done.backup ? `\nbackup of the original: ${done.backup}` : ''}\n`
    : `${p.file} already has bulkhead; nothing changed\n`)
  if (p.note) stdout.write(`${p.note}\n`)
  return exit(0)
}

module.exports = { main, plan, apply, backupName, commandLine, isOurs, SETUP, AGENT_NAMES, OPENCODE_PLUGIN, PI_EXTENSION, pluginSource, tomlPlan }
