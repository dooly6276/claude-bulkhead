'use strict'
// Left pane of the demo: the same screen as `bulkhead top`, limited to the demo sessions
// (so the machine's other Claude Code sessions never show). Run: node docs/demo-top.js
const path = require('path')
const src = path.join(__dirname, '..', 'src')
const { collect } = require(path.join(src, 'status'))
const { readProcesses } = require(path.join(src, 'processes'))
const { frame } = require(path.join(src, 'top'))
const { tailEvents } = require(path.join(src, 'events'))
const { stateDir } = require(path.join(src, 'hook'))
const repo = process.env.DEMO_REPO
let tick = 0
function draw() {
  // withEnv also matches servers that outlived their shell through CLAUDE_PID (the stand-in session's server)
  const st = collect({ snapshot: readProcesses(process.platform, { withEnv: true }) })
  st.sessions = st.sessions.filter(s => s.cwd && s.cwd.startsWith(repo + '/'))
    .map(s => ({ ...s, cwd: path.basename(s.cwd), ports: s.ports.map(p => ({ ...p, port: `${p.port} ${p.pid}` })) })) // PORTS shows port and the server's PID
  const view = { st, scanning: false, lastScanMs: null, interval: 1000, tick: tick++, events: tailEvents(stateDir(), 2).map(e => ({ ...e, project: path.basename(e.project || '') })) }
  let lines = frame(view, { width: process.stdout.columns, height: process.stdout.rows, color: true, home: '/nonexistent' })
  // RECENT BLOCKS drawn here with short fields so nothing is cut off in the narrow pane
  const at = lines.findIndex(l => l.includes('RECENT BLOCKS'))
  if (at >= 0) {
    lines = lines.slice(0, at + 1)
    const evs = view.events.slice().reverse()
    if (!evs.length) lines.push('\x1b[2mnone recorded\x1b[0m')
    for (const e of evs) {
      const t = new Date(e.time), hm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
      lines.push(`${hm}  \x1b[31m${e.guard}\x1b[0m  ${(e.command || '').split(/\s*(?:&&|;)\s*/)[0]}  ${e.project}`)
    }
  }
  process.stdout.write('\x1b[H' + lines.map(l => l + '\x1b[K').join('\n') + '\x1b[J')
}
process.stdout.write('\x1b[?25l\x1b[2J')
draw(); setInterval(draw, 1000)
