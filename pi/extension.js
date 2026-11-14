// bulkhead for the Pi coding agent, loaded through package.json "pi.extensions" after
// `pi install npm:claude-bulkhead`. Before each bash or powershell tool call it pipes
// { command, cwd, session_id, tool } to `bulkhead hook --agent pi`, which runs the same guards as
// the Claude Code hook; exit code 2 blocks the call with bulkhead's message as the reason.
// The body below is the same as the extension `bulkhead setup pi` writes (test/plugins.test.js).
'use strict'
const { spawn } = require('child_process')
const path = require('path')

const HOOK = [/^node(?:\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : 'node', path.join(__dirname, '..', 'bin', 'bulkhead'), 'hook', '--agent', 'pi']

function ask(input) {
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
