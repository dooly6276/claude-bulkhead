'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

// Fixed, not CLAUDE_PLUGIN_DATA: the bulkhead-slot CLI runs from the Bash tool, which
// does not receive that variable, and both sides must see the same slot files.
function stateDir() {
  return process.env.BULKHEAD_STATE_DIR || path.join(os.homedir(), '.claude', 'bulkhead')
}

// BULKHEAD_DISABLE first, then the config files. A broken config file never turns a guard off.
function enabled(name) {
  const off = (process.env.BULKHEAD_DISABLE || '').split(/[\s,]+/).filter(Boolean)
  if (off.includes(name) || off.includes('all')) return false
  try {
    return require('./config').isEnabled(name)
  } catch {
    return true
  }
}

// A value from the config files or its environment variable (see config.js).
function setting(key, fallback) {
  try {
    const v = require('./config').get(key)
    return v == null ? fallback : v
  } catch {
    return fallback
  }
}

function envNumber(name, fallback) {
  const n = Number(process.env[name])
  return process.env[name] && Number.isFinite(n) ? n : fallback
}

function log(name, line) {
  try {
    const dir = stateDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'guards.log')
    const text = `${new Date().toISOString()} ${name} ${line}\n`
    let size = 0
    try { size = fs.statSync(file).size } catch {}
    // kept to about 1 MB, the previous MB in guards.log.1
    if (size + text.length > 1024 * 1024) require('./events').rotate(file, 1024 * 1024 - text.length)
    fs.appendFileSync(file, text)
  } catch {}
}

// One line for the agent and the person reading it: a block can be intentional, and the answer
// to that is a question to the user, not a way around the guard. <code> is the allow-once code
// of this block; blocked() fills it in, and adds the config snippet of the rule that fired.
const ASK_USER = 'If the user wants this on purpose, ask them to run `bulkhead allow <code>` in their own terminal (allows it once), or allow it in .claude/bulkhead.json.'

// The block text with the one-line way out: the allow-once command and the exact config snippet.
function withWayOut(message, { code = null, json = null } = {}) {
  const once = code ? `run \`bulkhead allow ${code}\` in their own terminal (allows it once)` : null
  const perm = json ? `set ${json} in .claude/bulkhead.json` : null
  const how = [once, perm].filter(Boolean).join(', or ')
  const line = how ? `If the user wants this on purpose, ask them to ${how}.` : ''
  const body = message.includes(ASK_USER) ? message.split(ASK_USER).join(line).replace(/\n+$/, '') : message
  return line && !message.includes(ASK_USER) ? `${body}\n${line}` : body
}

// Records a block in guards.log and events.jsonl and returns the hook result that stops the call.
// Returns nothing when the user allowed this exact command once (bulkhead allow <code>).
function blocked(name, rule, input, message, command = input && input.tool_input && input.tool_input.command) {
  const cwd = input && input.cwd
  const allow = rule === 'self-allow' ? null : require('./allow-once')
  if (allow && allow.consume(name, rule, command, cwd)) {
    log(name, `allowed once ${rule}: ${oneLine(command || '')}`)
    return undefined
  }
  log(name, `blocked ${rule}: ${oneLine(command || '')}`)
  recordEvent(name, rule, input, command)
  let code = null
  if (allow) code = allow.issue({ guard: name, rule, command, cwd, session: input && input.session_id })
  let json = null
  try { json = require('./allow-hint').allowHint(name, rule, { command, message }).json } catch {}
  return { block: withWayOut(message, { code, json }) }
}

function recordEvent(name, rule, input = {}, command = null, extra = {}) {
  if (setting('log.enabled', true) === false) return
  require('./events').record(stateDir(), {
    guard: name,
    rule,
    session: input.session_id || null,
    project: process.env.CLAUDE_PROJECT_DIR || input.cwd || null,
    command,
    // set by `bulkhead hook --agent <name>`; absent for Claude Code
    ...(process.env.BULKHEAD_AGENT ? { agent: process.env.BULKHEAD_AGENT } : {}),
    ...extra,
  })
}

function oneLine(s, max = 300) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max)
}

// Reads the hook payload from stdin and hands it to `handler`. The handler returns
// nothing to allow, { block: message } to stop the tool call (exit 2), or
// { output: object } to print JSON, or a promise of either. Any error lets the call through.
function runHook(name, handler) {
  if (!enabled(name)) return
  // process reads give up sooner inside a hook: a slow ps lets the tool call through instead of stalling it
  process.env.BULKHEAD_IN_HOOK = '1'
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => (raw += d))
  process.stdin.on('end', () => {
    Promise.resolve().then(() => handler(JSON.parse(raw || '{}'))).then(result => {
      if (result && result.block) {
        process.stderr.write(result.block.endsWith('\n') ? result.block : result.block + '\n')
        process.exit(2)
      }
      if (result && result.output) process.stdout.write(JSON.stringify(result.output))
      process.exit(0)
    }, () => process.exit(0))
  })
}

module.exports = {
  ASK_USER, withWayOut, runHook, enabled, setting, envNumber, log, oneLine, stateDir, blocked, recordEvent }
