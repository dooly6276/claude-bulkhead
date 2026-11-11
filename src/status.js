'use strict'
const os = require('os')
const path = require('path')
const { stateDir } = require('./hook')
const { rejectArgs } = require('./cli-util')
const { readMemory } = require('./memory')
const { readProcesses } = require('./processes')
const { readSessionFiles, findSessions, assignOwners, isClaudeCli } = require('./sessions')
const { enrich, fitPath, homeShort, stateLabel, branchLabel, mcpLine } = require('./session-info')
const { readSlots, slotDir, staleReason, readQueue, queueDir } = require('./slots')

const GB = 2 ** 30
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

// A failed process scan (no powershell, no /proc) still leaves slots and memory to show.
const orNull = f => { try { return f() } catch { return null } }

function collect({
  snapshot = orNull(() => readProcesses()),
  files = readSessionFiles(),
  slots = readSlots(slotDir(stateDir())).filter(s => !staleReason(s)),
  queue = readQueue(queueDir(stateDir())),
  mem = readMemory({ withCommit: true }),
  now = Date.now(),
  enrichOpts = {},
} = {}) {
  const found = snapshot ? enrich(findSessions(snapshot, files), snapshot, files, enrichOpts) : { sessions: [], mcp: [] }
  const sessions = found.sessions
  // the Claude session a job runs under: its process is somewhere below the session's process
  const owner = snapshot ? assignOwners(snapshot.procs, new Set(snapshot.procs.filter(isClaudeCli).map(p => p.pid))) : new Map()
  const whose = pid => {
    const session = owner.get(pid) || null
    const hit = sessions.find(x => x.pid === session)
    return { session, project: (hit && hit.cwd) || null }
  }
  return {
    at: now,
    sessions,
    mcp: found.mcp,
    slots: slots.map(s => ({ slot: path.basename(s.file || '', '.json'), label: s.label, gb: s.gb, pid: s.pid, at: s.at, ...whose(s.pid) })),
    queue: queue.map(q => ({ label: q.label, gb: q.gb, pid: q.pid, at: q.at, reason: q.reason, ...whose(q.pid) })),
    memory: mem,
  }
}

// 45 s, 12 min, 2 h 5 min
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

const pad2 = n => String(n).padStart(2, '0')

function when(ms, now) {
  const d = new Date(ms)
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  return d.toDateString() === new Date(now).toDateString() ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`
}

function size(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 2 ** 20)} MB`
}

function shortPath(p, home) {
  return homeShort(p, home) || '(unknown)'
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => (r[i] == null ? 0 : String(r[i]).length))))
  return rows.map(r => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ').trimEnd())
}

function render(st, { color = false, home = os.homedir(), width = Infinity } = {}) {
  const head = s => (color ? `\x1b[1m${s}\x1b[0m` : s)
  const paintState = (s, text) => (!color ? text : s.state === 'permission' ? `\x1b[31m${text}\x1b[0m` : s.state === 'waiting' ? `\x1b[33m${text}\x1b[0m` : text)
  const out = []
  if (st.sessions.length) {
    // the AGENT column only appears once a session is not Claude Code, so a Claude-only list reads as before
    const withAgent = st.sessions.some(s => s.agent && s.agent !== 'claude')
    const titles = ['SESSION', 'STATE', 'STARTED', 'RSS', 'BRANCH', 'PROJECT']
    if (withAgent) titles.splice(1, 0, 'AGENT')
    const rows = [titles]
    const stateCol = withAgent ? 2 : 1
    const projectCol = titles.length - 1
    const portsAfter = new Map()
    for (const s of st.sessions) {
      const cells = [s.pid, stateLabel(s, st.at), when(s.start, st.at), size(s.rss), branchLabel(s), shortPath(s.cwd, home)]
      if (withAgent) cells.splice(1, 0, s.agent || 'claude')
      rows.push(cells)
      portsAfter.set(rows.length - 1, s.ports)
    }
    // the project column takes what the other columns leave, never less than 12 characters
    const widths = rows[0].slice(0, -1).map((_, i) => Math.max(...rows.map(r => String(r[i]).length)))
    const room = Math.max(12, width - widths.reduce((n, w) => n + w + 2, 0))
    for (const r of rows.slice(1)) r[projectCol] = fitPath(r[projectCol], room)
    const lines = table(rows)
    out.push(head(lines[0]))
    for (let i = 1; i < lines.length; i++) {
      const s = st.sessions[i - 1]
      const stateText = rows[i][stateCol]
      out.push(color && s.state ? lines[i].replace(stateText, paintState(s, stateText)) : lines[i])
      for (const p of portsAfter.get(i)) out.push(`  :${p.port}  ${p.name}  pid ${p.pid}`)
    }
    for (const m of (st.mcp || []).filter(x => x.duplicate)) {
      out.push(`duplicate MCP: ${mcpLine(m, size)} (sessions ${m.sessions.join(', ')})`)
    }
  } else {
    out.push('no Claude sessions found')
  }
  out.push('')
  if (st.slots.length) {
    const lines = table([['SLOT', 'GB', 'PID', 'AGE', 'SESSION', 'PROJECT', 'COMMAND'],
      ...st.slots.map(s => [s.slot, s.gb, s.pid, duration(st.at - s.at), s.session || '-', s.project ? shortPath(s.project, home) : '-', s.label])])
    out.push(head(lines[0]), ...lines.slice(1), '')
  } else {
    out.push('no heavy jobs in bulkhead-slot', '')
  }
  if (st.queue && st.queue.length) {
    const lines = table([['WAITING', 'GB', 'PID', 'FOR', 'SESSION', 'PROJECT', 'COMMAND'],
      ...st.queue.map((q, i) => [`#${i + 1}`, q.gb, q.pid, duration(st.at - q.at), q.session || '-', q.project ? shortPath(q.project, home) : '-', q.label])])
    out.push(head(lines[0]), ...lines.slice(1), '')
  }
  const m = st.memory
  out.push(`${m.freeGb.toFixed(1)} GB free of ${m.totalGb.toFixed(1)} GB` + (m.commitPct == null ? '' : `, commit ${m.commitPct}%`))
  return out.join('\n')
}

function toJson(st) {
  return {
    at: new Date(st.at).toISOString(),
    sessions: st.sessions.map(({ stateSince, ...s }) => ({ ...s, start: new Date(s.start).toISOString(), stateSince: stateSince ? new Date(stateSince).toISOString() : null })),
    mcp: st.mcp || [],
    slots: st.slots.map(s => ({ ...s, at: new Date(s.at).toISOString() })),
    queue: (st.queue || []).map(q => ({ ...q, at: new Date(q.at).toISOString() })),
    memory: st.memory,
  }
}

function main(args, env = process.env, stdout = process.stdout) {
  if (rejectArgs('status', args, { flags: ['json'], valued: [] }, process.stderr, null)) return
  const st = collect()
  if (args.includes('--json')) return stdout.write(JSON.stringify(toJson(st), null, 2) + '\n')
  const color = Boolean(stdout.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb'
  stdout.write(render(st, { color, width: stdout.isTTY ? stdout.columns || Infinity : Infinity }) + '\n')
}

module.exports = { collect, render, toJson, main, size, when, duration }
