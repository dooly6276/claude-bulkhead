'use strict'
const net = require('net')
const os = require('os')
const { runHook, blocked, setting, oneLine } = require('./hook')
const { detect } = require('./dev-servers')
const { killPorts } = require('./port-kills')
const { readProcesses } = require('./processes')
const { readSessionFiles, findSessions, ownSession } = require('./sessions')
const shell = require('./shell')

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'eval', 'source', 'xargs'])

// A heredoc is code for the shell only when a shell (or eval, source) reads it; python, node, cat,
// a while loop and the like get it as data, and a command inside that text is not run.
function readsShell(prefix) {
  return prefix.split(/[;&|(]/).pop().trim().split(/\s+/).some(w => SHELLS.has(shell.bin(w)))
}

function withoutDataHeredocs(src) {
  const docs = shell.heredocs(src, (prefix, after) => !readsShell(prefix) && !/\|\s*(?:[\w.-]+\s+)*(?:sh|bash|zsh|dash|ksh|fish|source|xargs)\b/.test(after))
  if (!docs.length) return src
  let out = ''
  let last = 0
  for (const d of docs) {
    out += src.slice(last, d.start) + ' ' + d.rest
    last = d.end
  }
  return out + src.slice(last)
}

// The command with heredoc bodies, commit messages and shell wrappers (bash -c "...") resolved.
const opened = (cmd, mode = 'sh') => shell.unwrap(withoutDataHeredocs(shell.prepare(String(cmd || ''), mode)), mode)

function freePort(port, taken) {
  for (let p = port + 1; p < port + 200 && p < 65536; p++) if (!taken.has(p)) return p
  return null
}

function shortPath(p) {
  const home = os.homedir()
  return p && p.toLowerCase().startsWith(home.toLowerCase()) ? '~' + p.slice(home.length).replace(/\\/g, '/') : p || 'unknown directory'
}

// A connect attempt takes a few milliseconds; reading the process list takes a second or two
// on Windows, so we only read it when something answers on the port.
function listening(port, timeoutMs = 300) {
  const one = host => new Promise(resolve => {
    const sock = net.connect({ host, port })
    const done = ok => { sock.destroy(); resolve(ok) }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
  return Promise.all([one('127.0.0.1'), one('::1')]).then(r => r.some(Boolean))
}

// Resolves to a block message, or null. Anything we cannot pin down is allowed.
async function check(cmd, {
  cwd, probe = listening, snapshot = () => readProcesses(), files = () => readSessionFiles(), self = ownSession, ignore = setting('portGuard.ignorePorts', []), mode = 'sh',
} = {}) {
  const server = detect(opened(cmd, mode), { cwd })
  const ports = server ? (server.ports || [server.port]).filter(p => p && !ignore.includes(p)) : []
  if (!ports.length) return null
  const live = []
  for (const p of ports) if (await probe(p)) live.push(p)
  if (!live.length) return null
  const snap = snapshot()
  if (!snap) return null
  const sessions = findSessions(snap, files())
  const me = self(snap.procs)
  if (!me) return null
  for (const port of live) {
    const holder = snap.ports.find(l => l.port === port)
    const owner = holder && sessions.find(s => s.ports.some(l => l.pid === holder.pid))
    if (!owner || me === owner.pid) continue
    const name = (snap.procs.find(p => p.pid === holder.pid) || {}).name || 'a process'
    const free = freePort(port, new Set(snap.ports.map(l => l.port)))
    return `[bulkhead] port-guard: port ${port} is already used by another Claude session ` +
      `(session pid ${owner.pid}, ${shortPath(owner.cwd)}): ${name} pid ${holder.pid}.\n` +
      'Leave that server alone; it is the other session\'s work. If you start yours anyway, it either fails or moves to the ' +
      `next port, and requests to localhost:${port} reach the other project.\n` +
      (free ? `Port ${free} is free:\n  ${server.hint(free)}` : `Pick a free port and pass it explicitly; \`bulkhead port --near ${port}\` prints one.`)
  }
  return null
}

// Resolves to a block message when a kill by port would hit another live session's server.
async function checkKill(cmd, {
  probe = listening, snapshot = () => readProcesses(), files = () => readSessionFiles(), self = ownSession, ignore = setting('portGuard.ignorePorts', []), mode = 'sh',
} = {}) {
  const ports = killPorts(opened(cmd, mode)).filter(p => !ignore.includes(p))
  if (!ports.length) return null
  const live = []
  for (const p of ports) if (await probe(p)) live.push(p)
  if (!live.length) return null
  const snap = snapshot()
  if (!snap) return null
  const sessions = findSessions(snap, files())
  const me = self(snap.procs)
  if (!me) return null
  for (const port of live) {
    for (const holder of snap.ports.filter(l => l.port === port)) {
      const owner = sessions.find(s => s.ports.some(l => l.pid === holder.pid))
      if (!owner || owner.pid === me) continue
      const name = (snap.procs.find(p => p.pid === holder.pid) || {}).name || 'a process'
      const free = freePort(port, new Set(snap.ports.map(l => l.port)))
      return {
        port,
        message: `[bulkhead] port-guard: \`${oneLine(cmd, 120)}\` would stop ${name} pid ${holder.pid}, the server another Claude session ` +
          `runs on port ${port} (session pid ${owner.pid}, ${shortPath(owner.cwd)}).\n` +
          'That server is the other session\'s work. Stopping it breaks whatever that session is running or testing.\n' +
          (free ? `If you need a server of your own, start it on a free port instead: ${free} is free.\n` : 'If you need a server of your own, start it on another port.\n') +
          `\`bulkhead port --near ${port}\` prints a port no session holds.\n` +
          'To stop a process you started yourself, stop it by its PID.',
      }
    }
  }
  return null
}

if (require.main === module) {
  runHook('port-guard', async input => {
    const cmd = input.tool_input && input.tool_input.command
    if (typeof cmd !== 'string' || !cmd) return
    const mode = shell.modeFor(input)
    const why = await check(cmd, { cwd: input.cwd, mode })
    if (why) return blocked('port-guard', 'port-in-use', input, why)
    const kill = await checkKill(cmd, { mode })
    if (kill) return blocked('port-guard', 'kill-by-port', input, kill.message)
  })
}

module.exports = { check, checkKill, killPorts, freePort, listening }
