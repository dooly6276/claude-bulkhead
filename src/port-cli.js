'use strict'
const net = require('net')
const { sequence, keyFor, parseRange, DEFAULT_RANGE } = require('./stable-port')
const { option, rejectArgs } = require('./cli-util')

const USAGE = `usage: bulkhead port [--near PORT] [--json]
       bulkhead port --stable [--name NAME] [--range 3000-3999] [--json]

Prints the first port at or above PORT (default 3000) that nothing is listening on,
so a dev server can start there without taking another session's port:
  npm run dev -- --port $(bulkhead port --near 3000)

--stable gives this git worktree its own port, the same every time: it is picked from a hash of
the worktree's root folder (or of --name), and moves on to the next port in a fixed order only
when something else is listening there. It says which session holds a port it skipped.
  npm run dev -- --port $(bulkhead port --stable)`

// Ports browsers refuse to open (the fetch spec's "bad ports"), so a dev server there is useless.
const BROWSER_BLOCKED = new Set([1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080])

// One address at a time: on Windows a server on 127.0.0.1 does not stop a bind to 0.0.0.0 or ::1,
// so only a port all four accept is really free. Hosts without IPv6 report EADDRNOTAVAIL, which is fine.
const HOSTS = ['127.0.0.1', '0.0.0.0', '::1', '::']

function canBind(host, port) {
  return new Promise(resolve => {
    const s = net.createServer()
    s.unref()
    s.once('error', e => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES'))
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(true)))
  })
}

async function isFree(port, bind = canBind) {
  for (const h of HOSTS) if (!(await bind(h, port))) return false
  return true
}

async function findFree(near = 3000, { bind = canBind, span = 1000 } = {}) {
  for (let p = Math.max(1024, near); p < Math.min(65536, near + span); p++) {
    if (BROWSER_BLOCKED.has(p)) continue
    if (await isFree(p, bind)) return p
  }
  return null
}

// The key a worktree's stable port comes from: --name, else the root of the git worktree, else the folder.
function stableKey(name, cwd = process.cwd()) {
  if (name) return { key: `name:${name}`, root: null, name }
  const { gitInfo } = require('./git-info')
  const g = gitInfo(cwd)
  const root = g ? g.root : cwd
  return { key: keyFor(root), root, name: null }
}

// Who listens on each busy port: { port: { pid, name, session: text|null } }, one process scan.
function defaultOwners(ports) {
  const out = {}
  try {
    const { readProcesses } = require('./processes')
    const { readSessionFiles, findSessions } = require('./sessions')
    const { describeSession } = require('./session-info')
    const snap = readProcesses()
    if (!snap) return out
    const sessions = findSessions(snap, readSessionFiles())
    for (const port of ports) {
      const l = snap.ports.find(x => x.port === port)
      if (!l) continue
      const owner = sessions.find(s => s.ports.some(x => x.pid === l.pid))
      const proc = snap.procs.find(x => x.pid === l.pid)
      out[port] = { pid: l.pid, name: proc ? proc.name : null, session: owner ? describeSession(owner) : null }
    }
  } catch {}
  return out
}

// { port, preferred, skipped: [{ port, pid, name, session }] }; port is null when the range is full.
async function findStable(key, range = DEFAULT_RANGE, { bind = canBind, owners = defaultOwners } = {}) {
  const busy = []
  let port = null
  for (const p of sequence(key, range)) {
    if (await isFree(p, bind)) { port = p; break }
    busy.push(p)
  }
  const who = busy.length ? owners(busy.slice(0, 5)) : {}
  return { port, preferred: sequence(key, range)[0], skipped: busy.slice(0, 5).map(p => ({ port: p, pid: null, name: null, session: null, ...who[p] })) }
}

async function stable(args, { stdout, stderr }) {
  const rangeArg = option(args, 'range')
  const range = rangeArg === undefined ? DEFAULT_RANGE : parseRange(rangeArg)
  if (!range) {
    stderr.write(`bulkhead port: --range needs LOW-HIGH between 1024 and 65535, got ${rangeArg}\n`)
    process.exitCode = 1
    return
  }
  const name = option(args, 'name')
  const k = stableKey(typeof name === 'string' ? name : null)
  const r = await findStable(k.key, range)
  if (args.includes('--json')) {
    stdout.write(JSON.stringify({ port: r.port, preferred: r.preferred, range, root: k.root, name: k.name, skipped: r.skipped }) + '\n')
  } else {
    if (r.port) stdout.write(`${r.port}\n`)
    for (const s of r.skipped) {
      stderr.write(`bulkhead port: ${s.port} is in use by ${s.session || (s.name ? `${s.name} pid ${s.pid}` : 'another process')}` + (s.port === r.skipped[r.skipped.length - 1].port && r.port ? `; using ${r.port}\n` : '\n'))
    }
  }
  if (!r.port) {
    if (!args.includes('--json')) stderr.write(`bulkhead port: no free port between ${range.min} and ${range.max}\n`)
    process.exitCode = 1
  }
}

async function main(args, { stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  if (rejectArgs('port', args, { flags: ['json', 'stable'], valued: ['near', 'name', 'range'] }, stderr, USAGE)) return
  if (args.includes('--stable')) return stable(args, { stdout, stderr })
  const nearArg = option(args, 'near')
  const near = nearArg === undefined ? 3000 : Number(nearArg)
  if (!Number.isInteger(near) || near < 1 || near > 65535) {
    stderr.write(`bulkhead port: --near needs a port number, got ${nearArg}\n`)
    process.exitCode = 1
    return
  }
  const port = await findFree(near)
  if (args.includes('--json')) stdout.write(JSON.stringify({ port }) + '\n')
  else if (port) stdout.write(`${port}\n`)
  if (!port) {
    if (!args.includes('--json')) stderr.write(`bulkhead port: no free port between ${near} and ${near + 999}\n`)
    process.exitCode = 1
  }
}

module.exports = { main, findStable, stableKey, findFree, isFree, canBind, BROWSER_BLOCKED }
