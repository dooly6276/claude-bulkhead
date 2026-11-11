'use strict'
const path = require('path')
const { enabled } = require('./hook')
const { option } = require('./cli-util')

// `bulkhead hook --agent <name>`: the Bash guards for coding agents other than Claude Code. The
// agent pipes its pre-tool payload on stdin; the adapter maps it to the shape the guards read
// ({ tool_name, tool_input: { command }, cwd, session_id }), runs the same guards as the Claude
// Code PreToolUse hook, and answers in the agent's own block format. Anything unexpected lets
// the command through, and Copilot and Cursor treat a crash or bad output as a denial, so those
// two always get an explicit allow.

// The same order as hooks/hooks.json.
const GUARDS = [
  ['kill-guard', './kill-guard'],
  ['wait-guard', './wait-guard'],
  ['memory-guard', './memory-guard'],
  ['port-guard', './port-guard'],
  ['checkout-guard', './checkout-guard'],
  ['disk-guard', './disk-guard'],
  ['basics', './basics'],
]

const str = v => (typeof v === 'string' && v ? v : null)
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const json = v => JSON.stringify(v)

function asObject(v) {
  if (typeof v !== 'string') return obj(v)
  try { return obj(JSON.parse(v)) } catch { return null }
}

const sh = (command, cwd, session, extra = {}) =>
  command ? { tool_name: 'Bash', tool_input: { command, ...extra }, cwd: cwd || undefined, session_id: session || undefined } : null

const powershell = input => (input ? { ...input, tool_name: 'PowerShell' } : null)

// Cline's run_commands takes a string, a list, { commands }, { command, args } or { cmd }.
function clineCommands(input) {
  const quote = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
  const one = c => (typeof c === 'string' ? c : obj(c) && str(c.command) ? [c.command, ...(Array.isArray(c.args) ? c.args.map(String) : [])].map(quote).join(' ') : null)
  let list = []
  if (typeof input === 'string') list = [input]
  else if (Array.isArray(input)) list = input
  else if (obj(input)) {
    if ('commands' in input) list = Array.isArray(input.commands) ? input.commands : [input.commands]
    else if ('command' in input) list = [input]
    else if ('cmd' in input) list = [input.cmd]
  }
  return list.map(one).filter(Boolean).join('\n')
}

const resolveDir = (cwd, dir) => (str(dir) ? path.resolve(cwd || process.cwd(), dir) : cwd)

// How each agent's payload maps and how it wants a block (and, where silence is unsafe, an allow)
// answered. read() returns null for anything that is not a shell command.
const ADAPTERS = {
  // https://developers.openai.com/codex/hooks: PreToolUse, tool_name "Bash", tool_input.command
  codex: {
    read: p => (p.tool_name === 'Bash' ? sh(str(obj(p.tool_input) && p.tool_input.command), p.cwd, p.session_id) : null),
    block: msg => ({ out: json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg } }) }),
  },
  // https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md: BeforeTool, run_shell_command
  gemini: {
    read: p => {
      const ti = obj(p.tool_input)
      if (p.tool_name !== 'run_shell_command' || !ti) return null
      return sh(str(ti.command), resolveDir(p.cwd, ti.dir_path), p.session_id, ti.is_background ? { run_in_background: true } : {})
    },
    block: msg => ({ out: json({ decision: 'deny', reason: msg }) }),
  },
  // https://docs.github.com/en/copilot/reference/hooks-configuration: preToolUse, camelCase or
  // (PreToolUse) snake_case payload; toolArgs may be a JSON string
  copilot: {
    read: p => {
      const name = String(p.toolName || p.tool_name || '').toLowerCase()
      if (name !== 'bash' && name !== 'powershell') return null
      const args = asObject(p.toolArgs !== undefined ? p.toolArgs : p.tool_input)
      const input = sh(str(args && args.command), p.cwd, p.sessionId || p.session_id)
      return name === 'powershell' ? powershell(input) : input
    },
    block: msg => ({ out: json({ permissionDecision: 'deny', permissionDecisionReason: msg }) }),
    allow: '',
  },
  // https://cursor.com/docs/hooks: beforeShellExecution { command, cwd }, answer { permission }
  cursor: {
    read: p => sh(str(p.command), str(p.cwd) || (Array.isArray(p.workspace_roots) && str(p.workspace_roots[0])), p.conversation_id),
    block: msg => ({ out: json({ permission: 'deny', user_message: msg.split('\n')[0], agent_message: msg }) }),
    allow: json({ permission: 'allow' }),
  },
  // Windsurf (Cascade) pre_run_command { tool_info: { command_line, cwd } }; exit 2 blocks
  windsurf: {
    read: p => {
      const ti = obj(p.tool_info)
      return ti ? sh(str(ti.command_line), ti.cwd, p.trajectory_id) : null
    },
    block: msg => ({ err: msg, code: 2 }),
  },
  // https://docs.factory.ai/reference/hooks-reference: PreToolUse, tool_name "Execute"
  droid: {
    read: p => (p.tool_name === 'Execute' ? sh(str(obj(p.tool_input) && p.tool_input.command), p.cwd, p.session_id) : null),
    block: msg => ({ out: json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg } }) }),
  },
  // https://docs.devin.ai/cli/extensibility/hooks/overview.md: PreToolUse, tool_name "exec"; exit 2 blocks
  devin: {
    read: p => (/^(?:exec|execute|bash|shell)$/i.test(String(p.tool_name)) ? sh(str(obj(p.tool_input) && p.tool_input.command), p.cwd, p.session_id) : null),
    block: msg => ({ err: msg, code: 2 }),
  },
  // https://github.com/cline/cline/blob/main/sdk/examples/hooks/README.md: PreToolUse file hook, run_commands
  cline: {
    read: p => {
      const call = obj(p.tool_call)
      if (!call || call.name !== 'run_commands') return null
      return sh(clineCommands(call.input), Array.isArray(p.workspaceRoots) ? p.workspaceRoots[0] : null, p.taskId)
    },
    block: msg => ({ out: json({ cancel: true, errorMessage: msg }) }),
    allow: '{}',
  },
  // The opencode and Amp plugins that `bulkhead setup` writes pipe { command, cwd, session_id }
  // and turn exit code 2 into a rejected tool call.
  opencode: { read: p => sh(str(p.command), p.cwd, p.session_id), block: msg => ({ err: msg, code: 2 }) },
  amp: { read: p => sh(str(p.command), p.cwd, p.session_id), block: msg => ({ err: msg, code: 2 }) },
}

const AGENT_NAMES = Object.keys(ADAPTERS)

// First guard that blocks wins, like the separate Claude Code hooks (which run together and any
// block stops the call).
async function judge(input) {
  for (const [name, file] of GUARDS) {
    if (!enabled(name)) continue
    let result = null
    // each hook is its own process under Claude Code, so one broken guard never silences the rest
    try { result = await require(file).handle(input) } catch {}
    if (result && result.block) return result.block
  }
  return null
}

// raw: the payload text. Returns { out, err, code } to write and exit with; never throws.
async function run(agent, raw) {
  const adapter = ADAPTERS[agent]
  const allow = { out: adapter.allow || '', code: 0 }
  try {
    const input = adapter.read(JSON.parse(raw || '{}'))
    if (!input) return allow
    process.env.BULKHEAD_AGENT = agent
    const message = await judge(input)
    if (!message) return allow
    const answer = adapter.block(message.endsWith('\n') ? message.slice(0, -1) : message)
    return { out: '', err: '', code: 0, ...answer }
  } catch {
    return allow
  }
}

function readStdin(stream) {
  return new Promise(resolve => {
    if (stream.isTTY) return resolve('')
    let raw = ''
    stream.setEncoding('utf8')
    stream.on('data', d => (raw += d))
    stream.on('end', () => resolve(raw))
    stream.on('error', () => resolve(''))
  })
}

async function main(args, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, exit = process.exit } = {}) {
  const agent = option(args, 'agent')
  if (typeof agent !== 'string' || !ADAPTERS[agent]) {
    stderr.write(`usage: bulkhead hook --agent <${AGENT_NAMES.join('|')}>   (reads the agent's pre-tool payload on stdin)\n`)
    return exit(1)
  }
  const { out, err, code } = await run(agent, await readStdin(stdin))
  if (err) stderr.write(err.endsWith('\n') ? err : err + '\n')
  // exit only once the pipe has taken the answer
  if (out) stdout.write(out, () => exit(code))
  else exit(code)
}

module.exports = { main, run, judge, ADAPTERS, AGENT_NAMES, clineCommands }
