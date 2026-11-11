'use strict'
const os = require('os')
const path = require('path')
const { stateDir } = require('./hook')
const { rejectArgs } = require('./cli-util')
const { readMemory } = require('./memory')
const { readProcesses } = require('./processes')
const { readSessionFiles, findSessions } = require('./sessions')
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
  return {
    at: now,
    sessions: found.sessions,
    mcp: found.mcp,
    slots: slots.map(s => ({ slot: path.basename(s.file || '', '.json'), label: s.label, gb: s.gb, pid: s.pid, at: s.at })),
    queue: queue.map(q => ({ label: q.label, gb: q.gb, pid: q.pid, at: q.at, reason: q.reason })),
    memory: mem,
  }
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
    const rows = [['SESSION', 'STATE', 'STARTED', 'RSS', 'BRANCH', 'PROJECT']]
    const portsAfter = new Map()
    for (const s of st.sessions) {
      rows.push([s.pid, stateLabel(s, st.at), when(s.start, st.at), size(s.rss), branchLabel(s), shortPath(s.cwd, home)])
      portsAfter.set(rows.length - 1, s.ports)
    }
    // the project column takes what the other columns leave, never less than 12 characters
    const widths = rows[0].slice(0, -1).map((_, i) => Math.max(...rows.map(r => String(r[i]).length)))
    const room = Math.max(12, width - widths.reduce((n, w) => n + w + 2, 0))
    for (const r of rows.slice(1)) r[5] = fitPath(r[5], room)
    const lines = table(rows)
    out.push(head(lines[0]))
    for (let i = 1; i < lines.length; i++) {
      const s = st.sessions[i - 1]
      const stateText = rows[i][1]
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
    const lines = table([['SLOT', 'GB', 'PID', 'AGE', 'COMMAND'],
      ...st.slots.map(s => [s.slot, s.gb, s.pid, `${Math.round((st.at - s.at) / 60000)} min`, s.label])])
    out.push(head(lines[0]), ...lines.slice(1), '')
  } else {
    out.push('no heavy jobs in bulkhead-slot', '')
  }
  if (st.queue && st.queue.length) {
    const lines = table([['WAITING', 'GB', 'PID', 'FOR', 'COMMAND'],
      ...st.queue.map((q, i) => [`#${i + 1}`, q.gb, q.pid, `${Math.round((st.at - q.at) / 60000)} min`, q.label])])
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

module.exports = { collect, render, toJson, main, size, when }
