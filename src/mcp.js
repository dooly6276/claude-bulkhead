'use strict'
const path = require('path')

// Stdio MCP servers are child processes of a session, one copy per session. Several sessions
// with the same server are N identical copies, each with its own memory. This finds them from
// command lines alone (heuristic, see docs/commands.md):
//  - the program is a launcher (npx, npm exec, pnpm dlx, yarn dlx, bunx, uvx, uv run, pipx, node,
//    bun, deno, python) or the program's own name looks like an MCP server;
//  - and one argument names an MCP package or path: @modelcontextprotocol/..., a package ending in
//    "mcp" or containing "mcp-" / "-mcp" / "mcp-server", or a path whose last two segments do.
// Options (--mcp-config and the like) never count.

const LAUNCHERS = /^(?:npx|npm|pnpm|pnpx|yarn|bunx|bun|uvx|uv|pipx|node|deno|python|python3|python3\.\d+|py|tsx|ts-node|docker)(?:\.exe|\.cmd)?$/i
const MCP_WORD = /(?:^|[\\/@_.-])mcp(?:$|[\\/@_.-])|mcp-?server|@modelcontextprotocol[\\/]/i

function tokens(cmd) {
  return String(cmd || '').match(/"[^"]*"|'[^']*'|\S+/g)?.map(t => t.replace(/^["']|["']$/g, '')) || []
}

function programOf(tok) {
  return path.basename(String(tok || '').replace(/\\/g, '/'))
}

// A path or package name reads as MCP: the last two segments only, so a project folder that
// happens to be called mcp-something does not make every command under it an MCP server.
function mentionsMcp(arg) {
  if (!arg || arg.startsWith('-')) return false
  const parts = arg.replace(/\\/g, '/').split('/').filter(Boolean)
  const tail = arg.startsWith('@') && parts.length === 2 ? parts.join('/') : parts.slice(-2).join('/')
  if (MCP_WORD.test(tail)) return true
  // a script deep inside an installed package: the package name decides
  const pkg = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/.exec(parts.join('/') + '/')
  return Boolean(pkg && MCP_WORD.test(pkg[1]))
}

function isMcpCommand(cmd) {
  const t = tokens(cmd)
  if (!t.length) return false
  const prog = programOf(t[0])
  if (LAUNCHERS.test(prog)) return t.slice(1).some(mentionsMcp)
  return /(?:^|[-_.])mcp(?:$|[-_.])|mcp-?server/i.test(prog) && !/^(?:claude|node|sh|bash|zsh)(?:\.exe)?$/i.test(prog)
}

// Package name for display: @scope/pkg without its version, else the program or script.
function serverName(cmd) {
  const t = tokens(cmd).slice(1)
  const arg = t.find(mentionsMcp)
  if (!arg) return programOf(tokens(cmd)[0])
  const scoped = /^(@[\w.-]+\/[\w.-]+?)(?:@[^/\s]*)?$/.exec(arg)
  if (scoped) return scoped[1]
  const bare = /^([\w.-]+?)@(?:latest|next|\d[^/\s]*)$/.exec(arg)
  if (bare) return bare[1]
  const parts = arg.replace(/\\/g, '/').split('/').filter(Boolean)
  const m = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)/.exec(arg.replace(/\\/g, '/'))
  return m ? m[1] : parts.slice(-2).join('/')
}

// The command line with what differs between sessions removed, so two sessions' copies compare
// equal: the session's folder, package versions, numbers (ports, pids), ids and temp paths.
function signature(cmd, cwd) {
  let s = String(cmd || '')
  if (cwd) s = s.split(cwd).join('<cwd>')
  return tokens(s).map((tok, i) => {
    if (i === 0) return programOf(tok).replace(/\.(?:exe|cmd)$/i, '')
    if (/^-{0,2}\d+$/.test(tok) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(tok) || /^[0-9a-f]{12,}$/i.test(tok)) return '#'
    if (/^(?:\/private)?\/(?:tmp|var\/folders)\//.test(tok) || /[\\/]Temp[\\/]/i.test(tok)) return '<tmp>'
    const eq = /^(--?[\w-]+)=(.*)$/.exec(tok)
    if (eq && /^\d+$/.test(eq[2])) return `${eq[1]}=#`
    return tok.replace(/(@[\w.-]+\/[\w.-]+|[\w.-]*mcp[\w.-]*)@(?:latest|next|\d[\w.+-]*)$/i, '$1')
  }).join(' ')
}

// owner: Map pid -> session pid (assignOwners). Returns
// { instances: [{ session, pid, name, signature, rss, procs }], groups: [{ name, copies, sessions, rss, duplicate }] }
// An instance is the whole tree of one server (npx, its shell and the node process count once).
function findMcp(procs, owner, sessions) {
  const byPid = new Map(procs.map(p => [p.pid, p]))
  const kids = new Map()
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(p)
  }
  const roots = new Set(sessions.map(s => s.pid))
  const candidate = p => owner.get(p.pid) !== undefined && !roots.has(p.pid) && isMcpCommand(p.cmd)
  const cwdOf = new Map(sessions.map(s => [s.pid, s.cwd]))
  // a server started through npx is a chain (npm exec, sh, node): only its top counts as the instance
  const hasCandidateAncestor = p => {
    let cur = byPid.get(p.ppid)
    for (let i = 0; cur && i < 20 && owner.get(cur.pid) === owner.get(p.pid) && !roots.has(cur.pid); i++) {
      if (candidate(cur)) return true
      cur = byPid.get(cur.ppid)
    }
    return false
  }
  const instances = []
  for (const p of procs) {
    if (!candidate(p)) continue
    if (hasCandidateAncestor(p)) continue
    const stack = [p]
    const seen = new Set()
    let rss = 0
    while (stack.length) {
      const q = stack.pop()
      if (seen.has(q.pid)) continue
      seen.add(q.pid)
      rss += q.rss || 0
      for (const k of kids.get(q.pid) || []) if (owner.get(k.pid) === owner.get(p.pid)) stack.push(k)
    }
    const session = owner.get(p.pid)
    instances.push({ session, pid: p.pid, name: serverName(p.cmd), signature: signature(p.cmd, cwdOf.get(session)), rss, procs: seen.size })
  }
  const bySig = new Map()
  for (const i of instances) {
    if (!bySig.has(i.signature)) bySig.set(i.signature, [])
    bySig.get(i.signature).push(i)
  }
  const groups = [...bySig.values()].map(list => {
    const sessionPids = [...new Set(list.map(i => i.session))].sort((a, b) => a - b)
    return {
      name: list[0].name,
      signature: list[0].signature,
      copies: list.length,
      sessions: sessionPids,
      rss: list.reduce((n, i) => n + i.rss, 0),
      duplicate: list.length >= 2 && sessionPids.length >= 2,
    }
  }).sort((a, b) => b.rss - a.rss)
  return { instances, groups }
}

module.exports = { isMcpCommand, serverName, signature, findMcp, mentionsMcp }
