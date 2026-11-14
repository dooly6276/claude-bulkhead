'use strict'
const { runHook, blocked, setting, enabled, ASK_USER } = require('./hook')
const shell = require('./shell')
const owners = require('./kill-owners')
const extras = require('./kill-extras')

// Programs that other sessions, editors and the user are likely running too.
const SHARED = [
  'node', 'python', 'python3', 'py', 'pythonw', 'ruby', 'java', 'javaw', 'dotnet',
  'chrome', 'chromium', 'chrome-headless-shell', 'msedge', 'firefox',
  'bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd', 'conhost',
  'git', 'ssh', 'sshd', 'code', 'claude',
  'npm', 'npx', 'pnpm', 'yarn', 'deno', 'bun', 'tsx', 'ts-node',
  'gradle', 'adb', 'ffmpeg', 'docker', 'vitest', 'jest', 'next', 'vite', 'esbuild', 'webpack',
  // apps and servers the user or another session has open
  'electron', 'simulator', 'xcode', 'postgres',
  'docker desktop', 'code helper', 'cursor', 'cursor helper',
  // other coding agents, whose sessions are as shared as Claude's
  'codex', 'gemini', 'copilot', 'opencode', 'cline', 'droid', 'cursor-agent',
  // dev servers and their children, by the names they show in ps and Activity Monitor
  'next-server', 'next-router-worker', 'next-render-worker', 'uvicorn', 'gunicorn', 'rails', 'puma', 'flask', 'expo', 'metro',
  'storybook', 'turbo', 'tsc', 'nodemon', 'qemu', 'emulator', 'playwright', 'puppeteer', 'ms-playwright', 'php',
  'headless_shell', 'headless-shell', 'chrome-headless', 'google chrome', 'google chrome helper', 'chrome helper', 'chromedriver',
  'http.server',
]
const bare = n => String(n).trim().replace(/^["']+|["']+$/g, '').toLowerCase().replace(/\.exe$/, '')

// killGuard.allowNames takes names off the list; killGuard.extraSharedNames adds some.
function nameList({ allowNames = [], extraSharedNames = [] } = {}) {
  const allow = new Set(allowNames.map(bare))
  return [...new Set([...SHARED.filter(n => !allow.has(n)), ...extraSharedNames.map(bare).filter(Boolean)])]
}

const globRe = g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')

// A process name as Get-Process, Stop-Process -Name and taskkill /IM take it: exact, or a
// wildcard such as node* that matches a shared name.
function nameHits(value, names) {
  const v = bare(value)
  if (!v) return false
  if (/[*?]/.test(v)) {
    if (v.length > 200) return false
    const re = globRe(v)
    return names.some(n => re.test(n) || re.test(n + '.exe'))
  }
  return names.includes(v)
}

// pkill -f "python scripts/worker.py" names a script, so only that script matches.
function scopedPattern(pattern) {
  const first = String(pattern).trim().split(/\s+/)[0] || ''
  return /[\\/]|\.(?:py|js|mjs|cjs|ts|mts|rb|php|sh|jar|ps1)\b/i.test(first) || /[\\/]|\.(?:py|js|mjs|cjs|ts|rb|php|sh|jar|ps1)\b/i.test(pattern)
}

// pkill -f "ssh -N -L 9333": a program name followed by arguments that name one job (a flag, a
// number, a path, a host). "next dev" and "node server" have none, so they still match every one.
function specificPattern(pattern) {
  return pattern.trim().split(/\s+/).slice(1).some(t => /^-|[\d:=/\\@~]|\.\w/.test(t))
}

const REGEX_CHARS = /[.*+?^${}()|[\]\\]/
// pkill -f dev, -f server: words that stand for "whatever dev server is running"
const DEV_WORDS = new Set(['dev', 'server', 'serve', 'start', 'runserver', 'http.server'])
const DEV_TAIL = 'dev next server serve start run'

// node22, nodejs and python3.11 are the shared name with a version
function sharedWord(lw, names) {
  if (names.includes(lw)) return true
  const base = lw.replace(/^nodejs$/, 'node').replace(/^(node|python|ruby|java)[\d.]+$/, '$1')
  return base !== lw && names.includes(base)
}

// One word of a pkill, killall or grep pattern against the shared names. Without -x the pattern
// is a regular expression searched in the name, so a part of a name ("ode") reaches it too.
function wordHits(w, names, { full, exact }) {
  if (!w) return false
  if (sharedWord(bare(w), names)) return true
  if (!REGEX_CHARS.test(w.replace(/\.exe$/i, ''))) {
    const lw = bare(w)
    if (sharedWord(lw, names) || (full && DEV_WORDS.has(lw))) return true
    // a name the user took off the list (allowNames) is not searched inside other names either
    return !exact && lw.length >= 3 && !SHARED.includes(lw) && names.some(n => n.includes(lw))
  }
  let re
  try {
    re = new RegExp(exact ? `^(?:${w})$` : w, 'i')
  } catch {
    return names.includes(bare(w))
  }
  if (names.some(n => re.test(n) || (!exact && re.test(n + '.exe')))) return true
  // pkill -f "node.*next": a name, then whatever a dev server's command line says
  return full && !exact && names.some(n => re.test(`${n} ${DEV_TAIL}`))
}

// A pkill, pgrep or grep pattern. Without -f it is a regular expression matched against the
// process name; with -f (and for grep over ps output) against the whole command line, where the
// first word of each alternative decides which program it hits. [n]ode is node.
function patternHits(pattern, names, { full = false, exact = false } = {}) {
  const p = String(pattern || '').trim()
  if (!p || p.length > 500) return false
  if (!full) return !scopedPattern(p) && wordHits(p, names, { full, exact })
  return p.split('|', 20).some(alt => {
    alt = alt.trim()
    if (!alt || scopedPattern(alt)) return false
    // "Google Chrome Helper": a name of several words
    if (/\s/.test(alt) && names.includes(bare(alt))) return true
    if (specificPattern(alt)) return false
    return wordHits(alt.split(/\s+/)[0], names, { full, exact }) || wordHits(alt, names, { full, exact })
  })
}

const PKILL_VALUE = new Set(['-g', '-G', '-P', '-s', '-t', '-u', '-U', '-F', '--signal', '--pgroup', '--group', '--parent', '--session', '--terminal', '--euid', '--uid', '--pidfile', '--ns', '--nslist', '--env'])
const KILLALL_VALUE = new Set(['-s', '-u', '-o', '-y', '-n', '--signal', '--user', '--older-than', '--younger-than', '--ns', '--context'])
// pkill -P <ppid>, -s <sid>, -t <tty>, -g <pgrp> and -F <pidfile> only reach a known group of processes
const PKILL_SCOPE_OPT = /^(?:-[PstgF]|--(?:parent|session|terminal|pgroup|pidfile))$/
// -s, -P and -g take numeric IDs; `pkill -s KILL node` mistakes -s for a signal and still kills by name
const NUMERIC_SCOPE = /^(?:-[Psg]|--(?:parent|session|pgroup))$/
const IDS = /^(?:\d+|\$[\w{}()$#!?-]+)(?:,(?:\d+|\$[\w{}()$#!?-]+))*$/
const PKILL_SCOPE = { test: ([o, v]) => PKILL_SCOPE_OPT.test(o) && (!NUMERIC_SCOPE.test(o) || IDS.test(String(v == null ? '' : v))) }

// Options and operands of pkill, pgrep or killall. With permute (GNU procps), options after the
// pattern are still options, as getopt reads them; BSD pkill (macOS) stops at the first operand,
// and everything after it is another pattern.
function parseKillByName(argv, valued, { permute = false } = {}) {
  const opts = []
  const operands = []
  let signal = null
  let ended = false
  for (let k = 1; k < argv.length; k++) {
    const v = argv[k]
    if (ended || (operands.length && !permute) || !/^-./.test(v)) {
      if (v === '--' && !ended && (!operands.length || permute)) { ended = true; continue }
      operands.push(v)
      continue
    }
    if (v === '--') { ended = true; continue }
    const eq = /^(--[\w-]+)=(.*)$/.exec(v)
    if (eq) { opts.push([eq[1], eq[2]]); if (eq[1] === '--signal') signal = eq[2]; continue }
    if (valued.has(v)) {
      opts.push([v, argv[k + 1]])
      if (v === '--signal' || (v === '-s' && valued === KILLALL_VALUE)) signal = argv[k + 1]
      k++
      continue
    }
    if (/^-(?:\d+|[A-Z][A-Z0-9+-]*|SIG\w+)$/.test(v)) { signal = v.slice(1); continue }
    opts.push([v, null])
  }
  const flags = opts.filter(([o]) => /^-[a-zA-Z]+$/.test(o)).map(([o]) => o.slice(1)).join('')
  return { opts, operands, signal, flags }
}

// pkill as the BSDs ship it: no long options, no option after the first pattern
const BSD = /^(?:darwin|freebsd|openbsd|netbsd)$/

const zeroSignal = s => s != null && /^(?:0|SIG0)$/i.test(String(s))

const NAME_WHY = 'pkill/killall matches every process with that name.'
const escapeRe = w => String(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A name that is no shared program but belongs to an app or a service the other sessions may be
// using: it counts only while another Claude session is alive.
function softName(pattern, full) {
  const words = full ? String(pattern).split('|', 20).map(a => a.trim()) : [String(pattern)]
  for (const w of words) {
    for (const cand of full ? [w, w.split(/\s+/)[0]] : [w]) {
      if (extras.isApp(cand)) return { rule: 'app-quit', why: `Quitting ${cand} closes it for everyone.` }
      if (extras.isService(cand)) return { rule: 'service-stop', why: `Stopping ${cand} takes it away from every session.` }
    }
  }
  return null
}

// pkill, killall: [rule, why] to block now, [rule, why, check] to block when check(table) says so.
function checkPkill(argv, names, { stdin = [], off = new Set(), platform = process.platform } = {}) {
  const b = shell.bin(argv[0])
  if (b === 'pkill') {
    const bsd = BSD.test(platform)
    const p = parseKillByName(argv, PKILL_VALUE, { permute: !bsd })
    if (bsd && !off.has('bsd-pkill')) {
      const long = p.opts.find(([o]) => o.startsWith('--'))
      if (long) return ['bsd-pkill', `pkill on macOS (BSD) has no long options such as ${long[0]}; it stops with a usage error before it kills anything, or, written after the pattern, reads it as another pattern.`]
      if (p.operands.length > 1) {
        const extra = p.operands.slice(1, 5).map(o => JSON.stringify(o)).join(', ')
        return ['bsd-pkill', `pkill on macOS (BSD) stops reading options at the first pattern, so ${extra} after it ${p.operands.length > 2 ? 'are more patterns' : 'is another pattern'}, and a process that matches any of them is killed. A short one such as "0" matches almost every command line (anthropics/claude-code#109627).`]
      }
    }
    if (zeroSignal(p.signal) || p.opts.some(ov => PKILL_SCOPE.test(ov))) return null
    const operands = p.operands.length ? p.operands : stdin.slice(0, 1)
    if (!operands.length) return null
    const full = /f/.test(p.flags) || p.opts.some(([o]) => o === '--full')
    const exact = /x/.test(p.flags)
    // BSD pkill kills what matches any of its patterns; GNU pkill takes one
    const later = []
    for (const o of bsd ? operands.slice(0, 20) : operands.slice(0, 1)) {
      const hit = byName(o, names, { full, exact }, off)
      if (hit && !hit[2]) return hit
      if (hit) later.push(hit)
    }
    if (later.length < 2) return later[0] || null
    // several patterns, each with a check on the process table: the first that finds something
    return ['other-session-match', '', (t, ctx) => {
      for (const [rule, why, fn] of later) {
        const r = fn(t, ctx)
        if (r && typeof r === 'object') return { rule: r.rule, text: [why, r.text].filter(Boolean).join(' ') }
        if (r) return { rule, text: [why, r].filter(Boolean).join(' ') }
      }
      return null
    }]
  }
  if (b === 'killall') {
    const p = parseKillByName(argv, KILLALL_VALUE)
    if (zeroSignal(p.signal)) return null
    const regex = /r/.test(p.flags) || p.opts.some(([o]) => o === '--regexp')
    const operands = (p.operands.length ? p.operands : stdin).slice(0, 100)
    let later = null
    for (const o of operands) {
      const hit = regex ? patternHits(o, names, { exact: true }) : sharedWord(bare(o), names)
      if (hit) return ['pkill', NAME_WHY]
      later = later || byName(regex ? o : escapeRe(o), names, { full: false, exact: true }, off, !regex && o)
    }
    return later
  }
  return null
}

function byName(pattern, names, { full, exact }, off, plain) {
  if (patternHits(pattern, names, { full, exact })) return ['pkill', NAME_WHY]
  const soft = softName(plain || pattern, full)
  if (soft && !off.has(soft.rule)) return [soft.rule, soft.why, t => owners.othersCheck(t)]
  const owner = !off.has('owner-check')
  const broad = full && !off.has('broad-pattern')
  if (!owner && !broad) return null
  return ['other-session-match', '', t => (owner && owners.patternCheck(t, pattern, { full, exact })) || (broad && owners.broadCheck(t, pattern, { full, exact })) || null]
}

// A comma list after a flag: -Name node,python or -Name node, python. Real lists are short; the
// first 256 names are enough, and a longer list is not copied name by name.
const MAX_LIST = 256

function listAfter(argv, k) {
  const out = []
  for (let j = k; j < argv.length && out.length < MAX_LIST; j++) {
    for (const s of argv[j].split(',', MAX_LIST)) {
      const t = s.trim()
      if (t && out.length < MAX_LIST) out.push(t)
    }
    if (!argv[j].endsWith(',') && !(argv[j + 1] || '').startsWith(',')) break
  }
  return out
}

function checkTaskkill(argv, names) {
  if (shell.bin(argv[0]) !== 'taskkill') return null
  let byPid = false
  const images = []
  const filters = []
  for (let k = 1; k < argv.length; k++) {
    const o = argv[k].replace(/^(?:\/\/?|-)/, '').toLowerCase()
    if (argv[k].toLowerCase() === o) continue
    if (o === 'im') images.push(argv[++k] || '')
    else if (o === 'pid') { byPid = true; k++ } else if (o === 'fi') filters.push(argv[++k] || '')
  }
  const hit = images.find(i => nameHits(i, names))
  if (hit) return ['taskkill-im', `taskkill /IM kills every process with that name: ${argv.join(' ')}.`]
  for (const f of filters) {
    if (/\bpid\s+(?:eq|ne|gt|lt|ge|le)\b/i.test(f) || byPid) continue
    const img = /\bimagename\s+eq\s+(\S+)/i.exec(f)
    if (img && !nameHits(img[1], names)) continue
    return ['taskkill-filter', `taskkill /FI picks processes by filter, not by PID: ${argv.join(' ')}.`]
  }
  return null
}

const STOP = /^(?:stop-process|spps|kill)$/i
const NAME_FLAG = /^-(?:n|na|nam|name|processname)(?::(.*))?$/i

function checkStopProcess(argv, names) {
  if (!STOP.test(argv[0])) return null
  if (argv.some(a => /^-whatif$/i.test(a))) return null
  for (let k = 1; k < argv.length; k++) {
    const m = NAME_FLAG.exec(argv[k])
    if (!m) continue
    const list = m[1] ? m[1].split(',') : listAfter(argv, k + 1)
    if (list.some(n => nameHits(n, names))) return ['stop-process-name', 'Stop-Process -Name kills every process with that name.']
  }
  return null
}

// wmic process where name='node.exe' delete, wmic process where "name like 'node%'" call terminate
function checkWmic(argv, names) {
  if (shell.bin(argv[0]) !== 'wmic') return null
  const text = argv.slice(1).join(' ')
  if (!/\bprocess\b/i.test(text) || !/\b(?:delete|terminate)\b/i.test(text)) return null
  if (/\b(?:processid|commandline|executablepath|parentprocessid)\b/i.test(text)) return null
  if (wmiNameHits(text, names)) return ['wmic-name', 'wmic process where name=... deletes every process with that name.']
  return null
}

// Name='node.exe', name like 'node%' in a WQL filter
function wmiNameHits(text, names) {
  for (const m of text.matchAll(/\bname\s*(=|like)\s*['"\\]*([^'"\\\s)]+)/gi)) {
    const v = m[1].toLowerCase() === 'like' ? m[2].replace(/%/g, '*').replace(/_/g, '?') : m[2]
    if (nameHits(v, names)) return true
  }
  return false
}

// Where-Object { $_.Name -eq 'node' }, ? ProcessName -like node*, ... and whether the filter
// narrows the selection to known processes (Id, CommandLine, Path).
function whereFilter(text, names) {
  const scoped = /\b(?:Id|ProcessId|CommandLine|Path|ExecutablePath|ParentProcessId)\b/i.test(text)
  let named = false
  for (const m of text.matchAll(/\b(?:Name|ProcessName|ImageName)\b['"]?\s*-[ic]?(eq|like|match|in|contains)\s+([^|}]{1,200})/gi)) {
    const op = m[1].toLowerCase()
    const values = m[2].split(/[\s,]+/).map(s => s.replace(/^[('"]+|[)'"]+$/g, '')).filter(Boolean)
    if (op === 'match') named = named || values.slice(0, 1).some(v => patternHits(v, names))
    else named = named || values.some(v => nameHits(v, names))
  }
  return { scoped, byName: named }
}

// Commands that only print or search text: their words are never a kill or a selection.
const INERT = /^(?:git|fgrep|rg|ag|echo|printf|cat|less|more|head|tail|select-string|sls|write-host|write-output|write-error|write-warning|write-verbose|out-host|man|help|get-help|which|type|get-command|gcm)$/i
const PS_SOURCE = /^(?:get-process|gps)$/i
const PS_SINKS = /^(?:stop-process|spps|invoke-cimmethod|remove-ciminstance|remove-wmiobject)$/i

// Does any of these commands select processes by a shared name, and does another one kill what
// they select? Commands of one statement are judged together: a pipe, $( ) and a loop body all
// carry the PIDs from one to the other.
function judgeStatement(cmds, names, mode, vars, cfg, deferred) {
  let selector = null
  let scoped = false
  let killer = false
  let usesVar = false
  let whereDepth = 0
  const listsProcesses = cmds.some(x => x.argv.length && /^(?:ps|tasklist|wmic|get-process|gps)$/i.test(shell.bin(x.argv[0])))
  // echo node | xargs pkill, pkill <<< node: what the pipe or here-string supplies
  const stdin = []
  for (const c of cmds) {
    const at = c.argv.indexOf('<<<')
    if (at > 0) { stdin.push(...c.argv.slice(at + 1)); c.argv = c.argv.slice(0, at) }
    else if (c.inert) stdin.push(...c.argv.slice(1).filter(a => !/^-[neE]+$/.test(a)))
  }
  for (const c of cmds) {
    const argv = c.argv
    if (!argv.length || c.inert) continue
    const b = shell.bin(argv[0])
    // direct kills by name
    const direct = checkPkill(argv, names, { stdin, off: cfg.off, platform: cfg.platform }) || checkTaskkill(argv, names) || checkStopProcess(argv, names) || checkWmic(argv, names)
    if (direct && !direct[2]) return direct
    if (direct) deferred.push(direct)
    if (c.remote) continue
    const more = extras.detect(argv, { mode, off: cfg.off, stmt: cmds, env: cfg.env || new Map() })
    if (more && !direct) deferred.push(more)
    // killers
    if (isKiller(argv, mode)) killer = true
    for (const w of argv) {
      if (/\.(?:kill|terminate)\s*\(/i.test(w)) killer = true
      if (vars.size && /\$\{?(\w+)/.test(w) && [...w.matchAll(/\$\{?(\w+)/g)].some(m => vars.has(m[1].toLowerCase()))) usesVar = true
    }
    for (let k = 0; k < argv.length - 1; k++) {
      if (/^(?:foreach-object|%)$/i.test(argv[k]) && /^(?:kill|terminate)$/i.test(argv[k + 1])) killer = true
      if (k > 0 && (argv[k - 1] === '{' || argv[k - 1].endsWith('{')) && isKiller(argv.slice(k, k + 8), mode)) killer = true
    }
    // selectors by name
    if (b === 'pgrep') {
      const p = parseKillByName(argv, PKILL_VALUE)
      if (!p.opts.some(ov => PKILL_SCOPE.test(ov)) && p.operands.length &&
          patternHits(p.operands[0], names, { full: /f/.test(p.flags), exact: /x/.test(p.flags) })) selector = selector || 'pgrep-kill'
    } else if (b === 'pidof') {
      if (argv.slice(1).some(a => !a.startsWith('-') && names.includes(bare(a)))) selector = selector || 'pgrep-kill'
    } else if ((b === 'grep' || b === 'egrep' || b === 'findstr') && listsProcesses) {
      if (grepHits(argv, names)) selector = selector || 'ps-grep-kill'
    } else if (b === 'ps' && mode !== 'ps') {
      const i = argv.findIndex(a => a === '-C' || a === '--command')
      if (i > 0 && (argv[i + 1] || '').split(',').some(n => names.includes(bare(n)))) selector = selector || 'ps-grep-kill'
    }
    const srcAt = argv.findIndex(a => PS_SOURCE.test(a) || (mode === 'ps' && /^ps$/i.test(a)))
    if (srcAt >= 0) {
      const rest = argv.slice(srcAt + 1)
      if (rest.some(a => /^-(?:id|inputobject)$/i.test(a))) scoped = true
      const picked = rest[0] && !rest[0].startsWith('-') ? listAfter(rest, 0) : []
      rest.forEach((a, k) => {
        const m = NAME_FLAG.exec(a)
        if (m) for (const n of m[1] ? m[1].split(',', MAX_LIST) : listAfter(rest, k + 1)) picked.push(n)
      })
      if (picked.some(n => nameHits(n, names))) selector = selector || 'get-process-pipe'
    }
    // a Where-Object block that a ( ) inside it split into several commands continues here
    const whereStart = /^(?:where-object|where|\?)$/i.test(argv[0]) || /^\?\{/.test(argv[0])
    if (whereStart || (whereDepth > 0 && !c.sub)) {
      const joined = argv.join(' ')
      if (whereStart) whereDepth = 0
      whereDepth += (joined.match(/\{/g) || []).length - (joined.match(/\}/g) || []).length
      const w = whereFilter(joined, names)
      if (w.scoped) scoped = true
      if (w.byName) selector = selector || 'get-process-pipe'
    }
    if (argv.some(a => /win32_process/i.test(a))) {
      const text = argv.join(' ')
      if (/\b(?:ProcessId|CommandLine|ExecutablePath|ParentProcessId|Handle)\s*(?:=|-eq|-like)/i.test(text)) scoped = true
      if (wmiNameHits(text, names)) selector = selector || 'win32-process-name'
    }
  }
  if (selector && !scoped && killer) return [selector, SELECTOR_WHY[selector]]
  if (usesVar && killer) return ['pgrep-kill', SELECTOR_WHY['pgrep-kill']]
  return selector && !scoped ? { assign: true } : null
}

const SELECTOR_WHY = {
  'pgrep-kill': 'pgrep <name> feeding kill matches every process with that name.',
  'ps-grep-kill': 'ps | grep <name> | kill matches every process with that name.',
  'get-process-pipe': 'Get-Process <name> | Stop-Process kills every process with that name.',
  'win32-process-name': 'Win32_Process selected by Name alone is terminated.',
}

function isKiller(argv, mode) {
  const b = shell.bin(argv[0])
  if (/^invoke-cimmethod$/i.test(argv[0])) return argv.some(a => /^terminate$/i.test(a))
  if (PS_SINKS.test(argv[0]) || /^(?:taskkill|tskill)$/.test(b)) return !argv.some(a => /^-whatif$/i.test(a))
  if (b === 'kill') {
    // kill -0 and kill -l only test or list
    return !argv.slice(1).some((a, i, r) => a === '-0' || a === '-l' || a === '-L' || (a === '-s' && r[i + 1] === '0'))
  }
  return mode === 'ps' && /^kill$/i.test(argv[0])
}

const GREP_VALUE = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--include', '--exclude', '--label', '--color', '--colour'])

function grepHits(argv, names) {
  if (shell.bin(argv[0]) === 'findstr') {
    if (argv.some(a => /^\/v$/i.test(a))) return false
    return argv.slice(1).filter(a => !/^\//.test(a)).some(w => w.split(/\s+/).some(x => patternHits(x, names, { full: true })))
  }
  let invert = false
  const patterns = []
  const operands = []
  for (let k = 1; k < argv.length; k++) {
    const v = argv[k]
    if (operands.length || !/^-./.test(v)) { operands.push(v); continue }
    if (v === '-e' || v === '--regexp') { patterns.push(argv[++k] || ''); continue }
    if (GREP_VALUE.has(v)) { k++; continue }
    if (/^-[a-zA-Z]*v[a-zA-Z]*$/.test(v) || v === '--invert-match') invert = true
  }
  if (invert) return false
  if (!patterns.length && operands.length) patterns.push(operands[0])
  return patterns.some(p => patternHits(p, names, { full: true }))
}

// `pids=$(pgrep node)` or `$procs = Get-Process node`: the variable now holds PIDs by name.
function assignedVar(cmds) {
  const first = cmds.find(c => !c.sub)
  if (!first) return null
  const w = first.words[0]
  if (!w) return null
  const sh = /^([A-Za-z_]\w*)=/.exec(w.v)
  if (sh) return sh[1].toLowerCase()
  const ps = /^\$([A-Za-z_]\w*)$/.exec(first.argv[0])
  if (ps && first.argv[1] === '=') return ps[1].toLowerCase()
  return null
}

// Interpreter code that starts shell commands from string literals: python3 -c "...os.system('...')",
// a python or node heredoc, perl -e. The strings are read as shell commands.
const INTERPRETER_WORD = /\b(?:python[\d.]*|py|pythonw|node|nodejs|deno|bun|ruby|perl|php)\b/
const SHELLING_OUT = /system|exec|spawn|popen|subprocess|passthru|`|%x/
const CODE_FLAGS = /^(?:-c|-e|-E|-r|-p|--eval|--print)$/

function embedded(cmd, mode) {
  if (!INTERPRETER_WORD.test(cmd) || !SHELLING_OUT.test(cmd)) return []
  const codes = []
  for (const c of shell.commands(shell.prepare(cmd, mode, ['shell', 'interp']), mode)) {
    if (!/^(?:python[\d.]*|py|pythonw|node|nodejs|deno|bun|ruby|perl|php)$/.test(shell.bin(c.argv[0]))) continue
    const i = c.argv.findIndex((a, k) => k > 0 && CODE_FLAGS.test(a))
    if (i > 0 && c.argv[i + 1]) codes.push(c.argv[i + 1])
  }
  if (cmd.includes('<<')) for (const d of shell.heredocs(cmd, (p, a) => shell.consumerOf(p, a, mode).kind === 'interp')) codes.push(d.body)
  return codes.flatMap(shell.embeddedShell)
}

// Rules that stop only while another Claude session is alive, and the table checks, are settled
// here: ctx.table() reads the process table once, and only now.
function resolve(hit, ctx) {
  if (!hit || !hit.deferred) return hit
  if (!ctx) return null
  const t = ctx.table()
  if (!t) return null
  for (const d of hit.deferred) {
    const detail = d.check(t, ctx)
    if (detail && typeof detail === 'object') return { rule: detail.rule, why: [d.why, detail.text].filter(Boolean).join(' ') }
    if (detail) return { rule: d.rule, why: [d.why, detail].filter(Boolean).join(' ') }
  }
  return null
}

// { rule, why } for the first kill, or null. ctx (see kill-owners makeContext) lets the checks
// that need the process table run; without it only what the text alone shows is judged.
function classify(cmd, names = {}, mode = 'sh', ctx = null, platform = process.platform) {
  const list = nameList(names)
  const cfg = { off: ctx ? ctx.off : new Set(), platform }
  const text = shell.unwrap(shell.prepare(String(cmd || ''), mode), mode)
  let hit = judge(text, list, mode, cfg)
  if (!hit || hit.deferred) {
    for (const inner of embedded(String(cmd || ''), mode)) {
      const more = judge(shell.unwrap(shell.prepare(inner, mode), mode), list, mode, cfg)
      if (more && !more.deferred) { hit = more; break }
      if (more) hit = { deferred: [...(hit ? hit.deferred : []), ...more.deferred] }
    }
  }
  return resolve(hit, ctx)
}

// Every kill this guard knows names one of these words, so text without them needs no parsing.
const KILL_WORD = /kill|stop-process|spps|terminate|remove-ciminstance|rcim|remove-wmiobject|rwmi|wmic|docker|podman|nerdctl|pm2|simctl|osascript|brew|launchctl|systemctl|service|adb\b/i

function judge(text, names, mode, cfg) {
  if (!KILL_WORD.test(text)) return null
  const { cmds, unterminated } = shell.lex(text, mode)
  const hit = judgeLexed(text, cmds, names, mode, cfg)
  if (hit || !unterminated) return hit
  // a quote that never closes: read the text again without quotes, as the shell never would
  return judgeLexed(text, shell.lex(text.replace(/["'`]/g, ' '), mode).cmds, names, mode, cfg)
}

function judgeLexed(text, lexed, names, mode, cfg) {
  const bySeg = new Map()
  const add = (seg, x) => {
    if (!bySeg.has(seg)) bySeg.set(seg, [])
    bySeg.get(seg).push(x)
  }
  let forF = false
  const assigned = new Map()
  cfg.env = assigned
  for (const c of lexed) {
    const s = shell.strip(text, c.words, mode)
    for (const w of c.words) {
      if (/^(?:export|declare|typeset|local)$/.test(w.v)) continue
      const m = /^([A-Za-z_]\w*)=([^$`]*)$/.exec(w.v)
      if (m) assigned.set(m[1], m[2])
      else break
    }
    const argv = s.argv.map(w => w.v)
    // cmd=pkill; $cmd node
    const ref = argv.length && /^\$\{?(\w+)\}?$/.exec(argv[0])
    if (ref && assigned.has(ref[1]) && assigned.get(ref[1])) argv.splice(0, 1, ...assigned.get(ref[1]).split(/\s+/).filter(Boolean))
    // cmd's for /f ... in ('tasklist ^| findstr node') do ...: the quoted command runs too
    if (forF && argv.length) {
      forF = false
      const inner = argv.join(' ').replace(/^'|'$/g, '').replace(/\^([|&<>^])/g, '$1')
      if (inner !== argv.join(' ') || argv.length === 1) {
        for (const ic of shell.lex(inner, 'cmd').cmds) {
          const iv = shell.strip(inner, ic.words, 'cmd').argv.map(w => w.v)
          if (iv.length && !INERT.test(shell.bin(iv[0]))) add(c.seg, { argv: iv, words: ic.words, remote: false, sub: true })
        }
        continue
      }
    }
    if (/^for$/i.test(argv[0] || '') && /^\/f$/i.test(argv[1] || '') && /^in$/i.test(argv[argv.length - 1])) forF = true
    if (argv.length && INERT.test(shell.bin(argv[0]))) {
      // echo node | xargs pkill: what an echo prints is what the next command reads
      if (/^(?:echo|printf)$/.test(shell.bin(argv[0]))) add(c.seg, { argv, words: c.words, remote: false, sub: c.sub, inert: true })
      continue
    }
    add(c.seg, { argv, words: c.words, remote: s.remote, sub: c.sub })
  }
  const vars = new Set()
  const deferred = []
  for (const cmds of bySeg.values()) {
    const r = judgeStatement(cmds, names, mode, vars, cfg, deferred)
    if (Array.isArray(r)) return { rule: r[0], why: r[1] }
    if (r && r.assign) {
      const v = assignedVar(cmds)
      if (v) vars.add(v)
    }
  }
  return deferred.length ? { deferred: deferred.map(([rule, why, fn]) => ({ rule, why, check: fn })) } : null
}

function check(cmd, names, mode, platform) {
  const hit = classify(cmd, names, mode, null, platform)
  return hit ? hit.why : null
}

// What to do instead, by what was blocked.
const FIX = {
  'docker-mass': 'Stop only your own containers, by name: docker stop <your container> (docker ps --filter name=<your project>).',
  'device-kill': 'Target your own device: adb -s <your device> emu kill, xcrun simctl shutdown <your device UDID>.',
  'app-quit': 'Close only what you opened: kill <your own pid>.',
  'service-stop': 'Stop only a service you started yourself, by its PID: kill <your own pid>.',
  'bsd-pkill': "Put every option before the one pattern: pkill -u <user> -f '<pattern>'. To check whether a process exists, use pgrep -f '<pattern>', which only lists. " +
    'Better still, stop only the process you started, by its PID: kill <your own pid>.',
  'broad-pattern': "Stop only the process you started, by its PID: pgrep -fl '<pattern>' shows everything a pattern reaches. " +
    'On macOS, BSD pkill reads options written after the pattern (-n, -u, -P) as more patterns, so they narrow nothing.',
}

function howToFix(platform, rule) {
  if (FIX[rule]) return FIX[rule]
  if (platform === 'win32') {
    return 'Stop only what you started: taskkill /PID <your own pid> /T /F (netstat -ano | findstr :<port> finds a port owner; ' +
      "Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*<your project dir>*' } finds your project's processes)."
  }
  return "Stop only what you started: kill <your own pid> (lsof -ti :<port> or pgrep -af '<your project dir>' finds it), or pkill -f '<your project dir>'."
}

function message(why, platform = process.platform, rule) {
  const sentence = /[.!?]$/.test(why) ? why : why + '.'
  return `[bulkhead] kill-guard: ${sentence}\n${howToFix(platform, rule)}`
}

// Rules with their own switch (config keys killGuard.<name>), on inside a guard that is on.
const RULES = ['mass-kill', 'docker-mass', 'device-kill', 'app-quit', 'service-stop', 'owner-check', 'broad-pattern', 'bsd-pkill']

function handle(input) {
  const cmd = input.tool_input && input.tool_input.command
  if (typeof cmd !== 'string' || !cmd) return
  const off = RULES.filter(rule => !enabled(rule))
  const ctx = owners.makeContext({ cwd: input.cwd || process.cwd(), off })
  const hit = classify(cmd, { allowNames: setting('killGuard.allowNames', []), extraSharedNames: setting('killGuard.extraSharedNames', []) }, shell.modeFor(input), ctx)
  if (!hit) return
  return blocked('kill-guard', hit.rule, input, `${message(hit.why, process.platform, hit.rule)}\n${ASK_USER}`)
}

if (require.main === module) runHook('kill-guard', handle)

module.exports = { handle, check, classify, message, nameHits, patternHits, nameList, RULES }
