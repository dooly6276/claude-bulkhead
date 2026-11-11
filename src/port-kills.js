'use strict'
// Finds the ports a command stops: `npx kill-port 3000`, `fuser -k 3000/tcp`, `fkill :3000`, and a
// lookup of the PID by port that feeds a kill, however the shell joins the two:
//   lsof -ti :3000 | xargs kill -9
//   lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill
//   kill -9 $(lsof -i :3000 | awk 'NR>1{print $2}')
//   for p in $(lsof -ti :3000); do kill $p; done
//   PID=$(lsof -ti :3000); kill $PID
//   netstat -anv | grep '\.3000 ' | awk '{print $9}' | xargs kill
//   ss -ltnp 'sport = :3000' | ... | xargs kill
// The text is read with the quote-aware lexer in shell.js, so a port in an echo or a grep pattern is not a kill.
const shell = require('./shell')

const numbers = s => (String(s).match(/\d+/g) || []).map(Number).filter(n => n > 0 && n < 65536)
const validPort = n => Number.isInteger(n) && n > 0 && n < 65536
const KILLS = /\b(?:kill|taskkill|Stop-Process|spps)\b(?!-port)/i
const KILL_HINT = /kill|fuser|Stop-Process|spps/i
const KILLERS = new Set(['kill', 'taskkill', 'stop-process', 'spps'])
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'gawk', 'sed', 'findstr', 'select-string'])
const PORT_KILLERS = /^(?:kill-port|fkill)$/

// Windows forms: Stop-Process on Get-NetTCPConnection, netstat | findstr :N, for /f ... taskkill.
// Statements are split on ; && || and newlines, but not on pipes, which carry the PID along.
function windowsKillPorts(cmd) {
  const ports = []
  for (const st of String(cmd || '').split(/\n|;|&&|\|\|/)) {
    if (/Get-NetTCPConnection/i.test(st) && KILLS.test(st)) {
      const lp = /-LocalPort\s+((?:\d+\s*,\s*)*\d+)/i.exec(st)
      if (lp) ports.push(...numbers(lp[1]))
    }
    if (/\bnetstat\b/i.test(st) && KILLS.test(st)) {
      const f = /\b(?:findstr|grep|Select-String)\b[^|]*?:(\d+)/i.exec(st)
      if (f) ports.push(Number(f[1]))
    }
  }
  return ports
}

// Values a shell variable can have here: NAME=3000, for NAME in 3000 3001. Unknown names stay as written.
function knownVars(lexed) {
  const vars = new Map()
  for (const c of lexed) {
    if (c.sub) continue
    const first = c.words[0].v
    const at = /^(?:export|declare|local|readonly)$/.test(first) ? 1 : 0
    const m = c.words[at] && /^(\w+)=([\w.:/-]*)$/.exec(c.words[at].v)
    if (m) vars.set(m[1], [m[2]])
    if (first === 'for' && c.words.length > 2 && c.words[2].v === 'in' && /^\w+$/.test(c.words[1].v)) vars.set(c.words[1].v, c.words.slice(3).map(x => x.v).filter(x => !/[$`]/.test(x)))
  }
  return vars
}

function expand(word, vars, depth = 0) {
  const m = /\$(?:\{(\w+)\}|(\w+))/.exec(word)
  if (!m || depth > 3) return [word]
  const values = vars.get(m[1] || m[2])
  if (!values || !values.length) return [word]
  return values.slice(0, 8).flatMap(v => expand(word.slice(0, m.index) + v + word.slice(m.index + m[0].length), vars, depth + 1))
}

// lsof -i :3000, -iTCP:3000, -i tcp:3000, -ti:3000, -i @host:3000, -i :3000,3001
function lsofPorts(args, vars) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const m = /^-[a-zA-Z]*?i(.*)$/.exec(args[i])
    if (!m) continue
    for (const w of expand(m[1] !== '' ? m[1] : args[i + 1] || '', vars)) {
      const hit = /:([\d,-]+)$/.exec(w)
      if (hit) out.push(...numbers(hit[1]))
    }
  }
  return out.filter(validPort)
}

// ss -ltnp 'sport = :3000': any :N or sport N in the words
function socketPorts(args, vars) {
  const out = []
  for (const w of args.flatMap(a => expand(a, vars))) {
    for (const m of w.matchAll(/:(\d{1,5})(?!\d)/g)) out.push(Number(m[1]))
    const sp = /\b[sd]?port\s*(?:==?|eq)?\s*:?(\d{1,5})(?!\d)/.exec(w)
    if (sp) out.push(Number(sp[1]))
  }
  return out.filter(validPort)
}

// A port number in a grep, awk or findstr pattern: ':3000', '\.3000 ' (macOS netstat), 3000. Not part of an IP address.
function patternPorts(args, vars) {
  const out = []
  for (const raw of args.filter(a => !a.startsWith('-')).flatMap(a => expand(a, vars))) {
    const w = raw.replace(/\\/g, '')
    for (const m of w.matchAll(/\d{2,5}/g)) {
      const before = w[m.index - 1] || ''
      const after = w[m.index + m[0].length] || ''
      const afterDot = after === '.' && /\d/.test(w[m.index + m[0].length + 1] || '')
      const beforeDot = before === '.' && /\d/.test(w[m.index - 2] || '')
      if (/\d/.test(before) || /\d/.test(after) || afterDot || beforeDot) continue
      out.push(Number(m[0]))
    }
  }
  return out.filter(validPort)
}

function fuserPorts(args, vars) {
  if (!args.some(a => /^-[a-zA-Z]*k[a-zA-Z]*$/.test(a) || a === '--kill')) return []
  const tcp = args.some((a, i) => /^(?:-n|--namespace)$/.test(a) && /^tcp$/i.test(args[i + 1] || ''))
  const out = []
  for (const a of args.flatMap(x => expand(x, vars))) {
    const m = /^(\d+)\/tcp$/i.exec(a)
    if (m) out.push(Number(m[1]))
    else if (tcp && /^\d+$/.test(a)) out.push(Number(a))
  }
  return out.filter(validPort)
}

// npx kill-port 3000 3001, kill-port --port 3000,3001
function killPortPorts(args, vars) {
  const out = []
  for (const a of args.flatMap(x => expand(x, vars))) {
    if (/^(?:--port=)?[\d,]+$/.test(a)) out.push(...numbers(a))
  }
  return out.filter(validPort)
}

// fkill :3000 (a bare number is a PID)
const fkillPorts = (args, vars) => args.flatMap(a => expand(a, vars)).map(a => /^:(\d+)$/.exec(a)).filter(Boolean).map(m => Number(m[1])).filter(validPort)

// What one statement (a pipeline, a $( ), a loop) says: the ports it kills outright (fuser -k,
// kill-port, fkill), the ports it looks up, and whether it kills a PID.
const NO_ARGS = Object.freeze([])

function statementPorts(list, vars) {
  const direct = []
  const explicit = []
  const patterns = []
  let lookup = false
  let kills = false
  for (const argv of list) {
    const b = shell.bin(argv[0])
    const args = argv.length > 1 ? argv.slice(1) : NO_ARGS
    const at = PORT_KILLERS.test(b) ? 0 : argv.findIndex((a, i) => i > 0 && i < 6 && PORT_KILLERS.test(shell.bin(a)))
    if (b === 'lsof') { lookup = true; explicit.push(...lsofPorts(args, vars)) } else if (b === 'netstat' || b === 'ss') { lookup = true; explicit.push(...socketPorts(args, vars)) } else if (GREPS.has(b)) patterns.push(...patternPorts(args, vars))
    else if (b === 'fuser') direct.push(...fuserPorts(args, vars))
    else if (at >= 0 && /^(?:kill-port|fkill|npx|bunx|pnpx|pnpm|yarn|npm|bun)$/.test(b)) {
      const rest = argv.slice(at + 1)
      direct.push(...(shell.bin(argv[at]) === 'fkill' ? fkillPorts(rest, vars) : killPortPorts(rest, vars)))
    } else if (KILLERS.has(b) && !args.some(a => /^-(?:0|l|L)$/.test(a))) kills = true
  }
  // lsof with no port of its own and netstat are narrowed by a later grep or awk
  const looked = explicit.length ? explicit : lookup ? patterns : []
  return { direct, looked: [...new Set(looked)], kills }
}

function shellKillPorts(text) {
  const read = shell.lex(text)
  const lexed = read.cmds
  const vars = knownVars(lexed)
  const segs = new Map()
  for (const c of shell.commands(text, 'sh', 0, [], read)) {
    if (!segs.has(c.seg)) segs.set(c.seg, [])
    segs.get(c.seg).push(c.argv)
  }
  // variables a statement fills from a command: PID=$(lsof -ti :3000)
  const assigned = new Map()
  for (const c of lexed) {
    if (c.sub) continue
    const m = /^(?:\w+\s+)?(\w+)=(?:\$\(|`)/.exec(c.words.slice(0, 2).map(w => w.v).join(' '))
    if (m) assigned.set(c.seg, (assigned.get(c.seg) || []).concat(m[1]))
  }
  const found = new Set()
  const add = list => { for (const p of list) found.add(p) }
  const carried = new Map() // variable -> ports it came from
  for (const seg of [...segs.keys()].sort((a, b) => a - b)) {
    const list = segs.get(seg)
    const info = statementPorts(list, vars)
    add(info.direct)
    if (info.kills) {
      add(info.looked)
      if (carried.size) {
        for (const argv of list) {
          for (const w of argv) for (const m of w.matchAll(/\$\{?(\w+)/g)) if (carried.has(m[1])) add(carried.get(m[1]))
        }
      }
    }
    if (info.looked.length) for (const name of assigned.get(seg) || []) carried.set(name, info.looked)
  }
  return [...found]
}

// Ports a kill-by-port command aims at, or [] when the command does not kill by port.
function killPorts(cmd) {
  const text = String(cmd || '')
  const ports = new Set(windowsKillPorts(text))
  if (KILL_HINT.test(text)) {
    try {
      for (const p of shellKillPorts(text)) ports.add(p)
    } catch { /* a command we cannot read is not a kill we can name */ }
  }
  return [...ports].filter(validPort)
}

module.exports = { killPorts }
