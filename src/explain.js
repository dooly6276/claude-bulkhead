'use strict'
const os = require('os')
const path = require('path')
const { enabled, setting, withWayOut } = require('./hook')
const { allowHint } = require('./allow-hint')
const { useColor, paint, shortPath, option, numberOption, rejectArgs } = require('./cli-util')

const USAGE = `usage: bulkhead explain [--cwd DIR] [--session-id ID|PID] [--timeout MS] [--json] -- <command...>

Runs the command through every Bash guard the way the PreToolUse hook would, against the
sessions, processes, ports and git tree on this machine right now. Nothing is executed and
nothing is logged. For each guard it prints pass or block, the rule, who owns the thing that is
in the way, the message the agent would see, and how to allow it once or for good.
--session-id explains it as that session (a session id or its pid); without it the command is
judged as a new session that none of the running ones is. --timeout is the tool call's timeout
in milliseconds, which wait-guard reads (the Bash tool's default is 120000).`

const ORDER = ['kill-guard', 'wait-guard', 'memory-guard', 'port-guard', 'checkout-guard', 'disk-guard', 'secrets-guard', 'basics']
const PREVIEW_SESSION = 'explain-preview'

// Reads the process table at most once, and only when a guard asks for it.
function lazy(fn) {
  let v
  let done = false
  return () => (done ? v : ((done = true), (v = fn())))
}

function liveContext(opts = {}) {
  const { readProcesses } = require('./processes')
  const { readSessionFiles } = require('./sessions')
  const { readMemory } = require('./memory')
  const { listening } = require('./port-guard')
  const files = lazy(() => readSessionFiles())
  const snapshot = lazy(() => readProcesses())
  return { files, snapshot, memory: () => readMemory(), probe: listening, mode: 'sh', ...opts }
}

// The session the command is judged as: { sessionId, pid } from --session-id (an id or a pid),
// or a new session no running one is.
function whoAmI(ctx, wanted) {
  if (!wanted) {
    // run from a Claude Code Bash tool: the session the shell belongs to
    const f = ctx.files().get(Number(process.env.CLAUDE_PID))
    return f && f.sessionId ? { sessionId: f.sessionId, pid: Number(process.env.CLAUDE_PID), given: false, inferred: true } : { sessionId: PREVIEW_SESSION, pid: null, given: false }
  }
  for (const [pid, f] of ctx.files()) {
    if (f.sessionId === wanted || String(pid) === String(wanted)) return { sessionId: f.sessionId || String(pid), pid, given: true, cwd: f.cwd }
  }
  return { sessionId: String(wanted), pid: null, given: true, unknown: true }
}

// Session owning each process in the snapshot, to say whose `node` a kill by name would stop.
function killEvidence(command, ctx) {
  try {
    const kill = require('./kill-guard')
    const { findSessions, assignOwners } = require('./sessions')
    const name = require('./allow-hint').killName(command)
    const snap = ctx.snapshot()
    if (!name || !snap) return []
    const sessions = findSessions(snap, ctx.files())
    const owner = assignOwners(snap.procs, new Set(sessions.map(s => s.pid)))
    const names = [name]
    const groups = new Map()
    for (const p of snap.procs) {
      if (!kill.nameHits(p.name, names)) continue
      const key = owner.get(p.pid) || 0
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(p.pid)
    }
    const lines = [...groups].map(([pid, pids]) => {
      const s = sessions.find(x => x.pid === pid)
      const list = `${pids.slice(0, 4).join(', ')}${pids.length > 4 ? ', ...' : ''}`
      return `${name} pid ${list} ${s ? `runs in the session with pid ${s.pid} (${shortPath(s.cwd)})` : 'belongs to no Claude session'}`
    })
    return lines.slice(0, 6)
  } catch {
    return []
  }
}

function ownerLine(owner, what) {
  return `${what} belongs to the session with pid ${owner.pid} (${shortPath(owner.cwd)})`
}

// One check per guard; each returns null (pass) or { rule, message, evidence: [text] }.
const CHECKS = {
  'kill-guard': async (cmd, ctx) => {
    const hit = require('./kill-guard').classify(cmd, {
      allowNames: setting('killGuard.allowNames', []), extraSharedNames: setting('killGuard.extraSharedNames', []),
    }, ctx.mode)
    if (!hit) return null
    const evidence = killEvidence(cmd, ctx)
    return {
      rule: hit.rule, message: `${require('./kill-guard').message(hit.why)}`,
      evidence: evidence.length ? evidence : [hit.why],
    }
  },
  'wait-guard': async (cmd, ctx) => {
    const wait = require('./wait-guard')
    const verdict = wait.judge(cmd, ctx.timeout, setting('waitGuard.limitSeconds', 180), ctx.mode)
    if (!verdict) return null
    return { rule: verdict.rule, message: wait.message(verdict), evidence: [`estimated wait ${verdict.est} s, the limit is ${verdict.maxSec} s`] }
  },
  'memory-guard': async (cmd, ctx) => {
    let mem = null
    const hit = require('./memory-guard').decide(cmd, () => (mem = ctx.memory()), undefined, ctx.mode)
    if (!hit) return null
    const evidence = hit.rule === 'low-memory' && mem
      ? [`${mem.freeGb.toFixed(1)} GB of ${mem.totalGb.toFixed(1)} GB RAM is free`]
      : ['the command writes a slot file by hand']
    return { ...hit, evidence }
  },
  'port-guard': async (cmd, ctx) => {
    const { inspect, checkKill } = require('./port-guard')
    const who = ctx.who
    const common = {
      probe: ctx.probe, snapshot: ctx.snapshot, files: ctx.files, mode: ctx.mode,
      // the session the command is judged as; a new session when none was named, so every running one is "another"
      self: procs => who.pid || (!who.given && require('./sessions').ownSession(procs)) || -1,
    }
    const hit = await inspect(cmd, { cwd: ctx.cwd, ...common })
    if (hit) return { rule: hit.rule, message: hit.message, evidence: [ownerLine(hit.owner, `${hit.name} pid ${hit.pid} on port ${hit.port}`)] }
    const kill = await checkKill(cmd, common)
    if (kill) return { rule: kill.rule, message: kill.message, evidence: [ownerLine(kill.owner, `${kill.name} pid ${kill.pid} on port ${kill.port}`)] }
    return null
  },
  'checkout-guard': async (cmd, ctx) => {
    const hit = require('./checkout-guard').classify(cmd, {
      cwd: ctx.cwd, sessionId: ctx.who.sessionId, mode: ctx.mode, files: ctx.files, platform: ctx.platform, home: ctx.home, isAlive: ctx.isAlive, run: ctx.run,
    })
    if (!hit) return null
    const evidence = hit.owner ? [ownerLine(hit.owner, 'the tree')] : [hit.rule]
    return { rule: hit.rule, message: hit.why, evidence }
  },
  'disk-guard': async (cmd, ctx) => {
    const hit = require('./disk-guard').check(cmd, { mode: ctx.mode })
    return hit ? { rule: hit.rule, message: hit.why, evidence: [hit.rule] } : null
  },
  'secrets-guard': async (cmd, ctx) => {
    const secrets = require('./secrets-guard')
    const hit = secrets.classifyCommand(cmd, {
      cwd: ctx.cwd, mode: ctx.mode, extra: setting('secretsGuard.extraPatterns', []), allow: setting('secretsGuard.allow', []),
    })
    return hit ? { rule: hit.rule, message: secrets.message(hit), evidence: [`${hit.label}: ${hit.what}`] } : null
  },
  basics: async (cmd, ctx) => {
    const basics = require('./basics')
    const why = basics.check(cmd, { cwd: ctx.cwd, mode: ctx.mode, run: ctx.run })
    if (!why) return null
    const rule = basics.ruleOf(why)
    return { rule, message: why, evidence: [why.split('\n')[0].replace(/^\[bulkhead\] basics: /, '')] }
  },
}

// Every guard's verdict on the command, in the order the hooks run them.
async function explain(command, opts = {}) {
  const ctx = liveContext(opts)
  ctx.cwd = path.resolve(opts.cwd || process.cwd())
  ctx.who = whoAmI(ctx, opts.sessionId)
  const guards = []
  for (const guard of ORDER) {
    if (!enabled(guard)) {
      guards.push({ guard, status: 'off' })
      continue
    }
    let hit = null
    try { hit = await CHECKS[guard](command, ctx) } catch (e) { guards.push({ guard, status: 'error', error: e.message }); continue }
    if (!hit) {
      guards.push({ guard, status: 'pass' })
      continue
    }
    const hint = allowHint(guard, hit.rule, { command, message: hit.message })
    const message = hit.rule === 'self-allow' ? hit.message : withWayOut(hit.message, { code: '<code>', json: hint.json })
    guards.push({
      guard, status: 'block', rule: hit.rule, evidence: hit.evidence, message,
      allowOnce: hit.rule !== 'self-allow', config: hint.json, disable: hint.disable,
    })
  }
  return { command, cwd: ctx.cwd, session: ctx.who, blocked: guards.some(g => g.status === 'block'), guards }
}

function render(r, { color = false, home = os.homedir() } = {}) {
  const out = []
  const b = s => paint(color, 'bold', s)
  out.push(`${b('command')}  ${r.command}`)
  out.push(`${b('folder')}   ${shortPath(r.cwd, home)}`)
  out.push(`${b('as')}       ${r.session.given ? `session ${r.session.sessionId}${r.session.pid ? ` (pid ${r.session.pid})` : ' (not running)'}` : r.session.inferred ? `this shell's session (pid ${r.session.pid})` : 'a new session (--session-id names one)'}`)
  const blockers = r.guards.filter(g => g.status === 'block')
  out.push(`${b('verdict')}  ${blockers.length ? paint(color, 'red', `BLOCKED by ${blockers.map(g => `${g.guard} ${g.rule}`).join(', ')}`) : paint(color, 'green', 'passes every guard')}`)
  out.push('')
  for (const g of r.guards) {
    if (g.status === 'pass') out.push(`${g.guard.padEnd(15)} ${paint(color, 'green', 'pass')}`)
    else if (g.status === 'off') out.push(`${g.guard.padEnd(15)} ${paint(color, 'gray', 'off (turned off in the config or BULKHEAD_DISABLE)')}`)
    else if (g.status === 'error') out.push(`${g.guard.padEnd(15)} ${paint(color, 'yellow', `could not be checked: ${g.error}`)}`)
    else {
      out.push(`${g.guard.padEnd(15)} ${paint(color, 'red', 'BLOCK')}  rule ${g.rule}`)
      for (const e of g.evidence) out.push(`  evidence   ${e}`)
      out.push('  the agent sees:')
      for (const line of g.message.split('\n')) out.push(`    ${line}`)
      if (g.allowOnce) out.push('  allow once   the user runs `bulkhead allow <code>` in their terminal; the code is in the real block message')
      if (g.config) out.push(`  allow always ${g.config} in .claude/bulkhead.json`)
      if (g.disable) out.push(`  or           BULKHEAD_DISABLE=${g.disable}`)
      if (!g.allowOnce) out.push('  not allowable: only the user can approve, and not through the agent')
    }
    out.push('')
  }
  return out.join('\n').replace(/\n+$/, '')
}

// Everything after `--` is the command: several words are quoted back as a shell line.
function commandFrom(args) {
  const sep = args.indexOf('--')
  const words = sep >= 0 ? args.slice(sep + 1) : null
  if (!words || !words.length) return null
  if (words.length === 1) return words[0]
  return words.map(a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')
}

async function main(args, { stdout = process.stdout, stderr = process.stderr, env = process.env, context } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  const sep = args.indexOf('--')
  const opts = sep >= 0 ? args.slice(0, sep) : args
  if (rejectArgs('explain', opts, { flags: ['json'], valued: ['cwd', 'session-id', 'timeout'] }, stderr, USAGE)) return
  const command = commandFrom(args)
  if (!command) {
    stderr.write(USAGE + '\n')
    process.exitCode = 1
    return
  }
  const cwd = option(opts, 'cwd')
  const sessionId = option(opts, 'session-id')
  const timeout = numberOption(opts, 'timeout')
  if (timeout.error) {
    stderr.write(`bulkhead explain: ${timeout.error}\n`)
    process.exitCode = 1
    return
  }
  const r = await explain(command, { cwd: typeof cwd === 'string' ? cwd : undefined, sessionId: typeof sessionId === 'string' ? sessionId : undefined, timeout: timeout.value, ...context })
  if (opts.includes('--json')) return stdout.write(JSON.stringify(r, null, 2) + '\n')
  stdout.write(render(r, { color: useColor(stdout, env) }) + '\n')
}

module.exports = { main, explain, render, commandFrom, USAGE, ORDER }
