'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { stateDir, log } = require('./hook')
const { readMemory } = require('./memory')
const { option: sharedOption, numberOption } = require('./cli-util')
const { take, release, readSlots, staleReason, slotDir, admit, queueDir, enqueue, readQueue, waitersBefore, signature } = require('./slots')

const POLL_MS = 1000
const RECHECK_MS = 5000
const PROGRESS_MS = Number(process.env.BULKHEAD_SLOT_PROGRESS_MS) || 30000

const USAGE = `usage:
  bulkhead-slot run [--gb=N] [--wait=MINUTES] [--label=TEXT] -- <command...>
  bulkhead-slot status [--gb=N]

run waits until the machine has room for a job of N GB (default 3), runs the
command, and releases the slot when it exits, even on failure. The exit code is
the command's. While it waits it prints one line to stderr every 30 seconds with its
position in line. --wait is in minutes (default 30); set it below the Bash tool's timeout
if the caller must not wait longer. status shows who holds slots, which session and
project each job belongs to, who waits, and whether a new job would start.`

// --name=value or --name value
function option(args, name, fallback) {
  const v = sharedOption(args, name)
  return typeof v === 'string' ? v : fallback
}

// The job size, or an error to print: --gb 4 and --gb=4 both work, nothing else is guessed.
function gbOption(args, totalGb = os.totalmem() / 2 ** 30) {
  return numberOption(args, 'gb', {
    fallback: 3, max: totalGb, tooBig: n => `--gb ${n} is more than this machine's RAM (${Math.round(totalGb * 10) / 10} GB)`,
  })
}

function bad(message) {
  console.error(`bulkhead-slot: ${message}`)
  process.exit(1)
}

function findGitBash(env = process.env, exists = fs.existsSync) {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && path.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  return candidates.find(f => f && exists(f)) || null
}

const posixQuote = a => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)
const cmdQuote = a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)

// One argument is a shell line as typed; several are an argv we quote back together,
// so `-- bash -c "a && b"` keeps its quotes.
function shellCommand(args, platform = process.platform, gitBash = null) {
  if (platform === 'win32' && !gitBash) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', args.length === 1 ? args[0] : args.map(cmdQuote).join(' ')] }
  }
  const line = args.length === 1 ? args[0] : args.map(posixQuote).join(' ')
  return { file: platform === 'win32' ? gitBash : '/bin/sh', args: ['-c', line] }
}

function measure(withCommit) {
  return readMemory({ withCommit })
}

function run(args) {
  const sep = args.indexOf('--')
  if (sep < 0 || sep === args.length - 1) {
    console.error(USAGE)
    return process.exit(1)
  }
  const opts = args.slice(0, sep)
  const command = args.slice(sep + 1)
  const g = gbOption(opts)
  if (g.error) return bad(g.error)
  const gb = g.value
  const w = numberOption(opts, 'wait', { fallback: 30, inclusive: true })
  if (w.error) return bad(w.error)
  const label = option(opts, 'label', command.join(' ').slice(0, 80))
  const deadline = Date.now() + w.value * 60000
  const dir = slotDir(stateDir())
  const me = { pid: process.pid, at: Date.now() }
  const qdir = queueDir(stateDir())
  let queued = null
  let lastMem = null
  let lastSig = null
  let lastFull = 0
  let lastLine = 0
  let lastReason = ''
  const unqueue = () => {
    if (queued) try { fs.unlinkSync(queued) } catch {}
    queued = null
  }
  process.on('exit', unqueue)
  const measureKept = withCommit => (lastMem = measure(withCommit))

  // position, what is held, what is free: enough for the agent to see the job has not hung
  const progress = (verb, reason) => {
    const line = waitLine(dir, qdir, me, lastMem)
    console.error(`[bulkhead-slot] ${verb} (${line}): ${reason}`)
    lastLine = Date.now()
  }

  const attempt = () => {
    const got = take(dir, { label, gb, pid: process.pid }, measureKept, (slot, why) => log('slot', `reclaimed ${slot.label}: ${why}`), waitersBefore(qdir, me))
    lastFull = Date.now()
    lastReason = got.reason
    if (got.file) {
      unqueue()
      return start(got.file)
    }
    if (Date.now() > deadline) {
      console.error(`[bulkhead-slot] gave up waiting: ${got.reason}. Holders: ${holders(dir)}`)
      return process.exit(3)
    }
    const first = !queued
    queued = enqueue(qdir, { label, gb, pid: process.pid, at: me.at, reason: got.reason })
    if (first) {
      progress('waiting', `${got.reason}. Holders: ${holders(dir)}`)
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130))
    }
    lastSig = signature(dir, qdir, me)
    setTimeout(poll, POLL_MS)
  }

  // Once a second only the slot files and the waiters ahead are read; the memory check and the
  // lock are taken when one of them changed, and every few seconds for the free-RAM wait.
  const poll = () => {
    if (Date.now() - lastFull >= RECHECK_MS || Date.now() > deadline || signature(dir, qdir, me) !== lastSig) return attempt()
    if (Date.now() - lastLine >= PROGRESS_MS) progress('still waiting', lastReason)
    setTimeout(poll, POLL_MS)
  }

  const start = file => {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(sig)
    console.error(`[bulkhead-slot] running ${label} (${gb} GB)`)
    const { file: shell, args: shellArgs } = shellCommand(command, process.platform, process.platform === 'win32' ? findGitBash() : null)
    const child = spawn(shell, shellArgs, { stdio: 'inherit', windowsHide: true })
    const done = code => {
      release(file)
      process.exit(code)
    }
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)))
    child.on('error', e => {
      console.error(`[bulkhead-slot] could not start: ${e.message}`)
      done(1)
    })
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => {
        try { child.kill(sig) } catch {}
        done(1)
      })
    }
  }

  attempt()
}

// "#2 of 3 in line, 8 GB held by 2 jobs, 6.1 GB free"
function waitLine(dir, qdir, me, mem) {
  const live = readSlots(dir).filter(s => !staleReason(s))
  const ahead = waitersBefore(qdir, me).length
  const held = live.reduce((n, s) => n + (s.gb || 0), 0)
  return `#${ahead + 1} in line, ${held} GB held by ${live.length} job${live.length === 1 ? '' : 's'}` +
    (mem ? `, ${mem.freeGb.toFixed(1)} GB free` : '')
}

function holders(dir) {
  return readSlots(dir).map(s => `${s.label} (${s.gb} GB, pid ${s.pid})`).join(', ') || 'none'
}

// "session 812, ~/src/app": which Claude session a job runs under. Empty when the process scan fails.
function whose(jobs) {
  try {
    const st = require('./status').collect({ slots: jobs.slots, queue: jobs.queue, mem: { freeGb: 0, totalGb: 0 } })
    const text = j => (j.session ? `, session ${j.session}${j.project ? ` in ${j.project}` : ''}` : '')
    return { slot: i => text(st.slots[i]), wait: i => text(st.queue[i]) }
  } catch {
    return { slot: () => '', wait: () => '' }
  }
}

function status(args) {
  const dir = slotDir(stateDir())
  const g = gbOption(args)
  if (g.error) return bad(g.error)
  const gb = g.value
  const held = readSlots(dir)
  const waiting = readQueue(queueDir(stateDir()))
  const owner = whose({ slots: held.filter(s => !staleReason(s)), queue: waiting })
  const { duration } = require('./status')
  if (!held.length) console.log('no slots held')
  let liveIndex = 0
  for (const s of held) {
    const why = staleReason(s)
    console.log(`${path.basename(s.file)}: ${s.label} (${s.gb} GB, pid ${s.pid}, ${duration(Date.now() - s.at)}${why ? '' : owner.slot(liveIndex++)})${why ? ` stale: ${why}` : ''}`)
  }
  waiting.forEach((q, i) => console.log(`waiting #${i + 1}: ${q.label} (${q.gb} GB, pid ${q.pid}, waited ${duration(Date.now() - q.at)}${owner.wait(i)})${q.reason ? ` - ${q.reason}` : ''}`))
  const live = held.filter(s => !staleReason(s))
  const mem = measure(live.length > 0)
  const reason = admit({ held: live, mem, gb })
  const commit = mem.commitPct == null ? '' : `, commit ${mem.commitPct}%`
  console.log(`free ${mem.freeGb.toFixed(1)} of ${mem.totalGb.toFixed(1)} GB${commit}. A ${gb} GB job would ${reason ? `wait: ${reason}` : 'start now'}.`)
}

function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'run') return run(rest)
  if (cmd === 'status') return status(rest)
  console.error(USAGE)
  process.exit(cmd === '--help' || cmd === '-h' ? 0 : 1)
}

if (require.main === module) main(process.argv.slice(2))

module.exports = { main, shellCommand, findGitBash }
