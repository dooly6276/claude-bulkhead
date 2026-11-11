'use strict'
const fs = require('fs')
const path = require('path')
const shell = require('./shell')

// Rewrites a heavy command so it runs through bulkhead-slot, which queues it against the
// machine-wide RAM budget. Pure functions: the hook (memory-guard.js) supplies the settings.

// Typical peak RAM per tool, in GB. memoryGuard.estimatesGb overrides single entries.
const ESTIMATES_GB = {
  vitest: 3, jest: 3, karma: 2, playwright: 4, cypress: 4, gradle: 4, gradlew: 4, mvn: 3, mvnw: 3,
  dotnet: 2, next: 3, vite: 2, tsc: 2, webpack: 3, ffmpeg: 2, cargo: 4, go: 3, pytest: 3,
  docker: 3, 'docker-compose': 3, bazel: 6, turbo: 4, nx: 4, xcodebuild: 6, swift: 4, fastlane: 4,
  npm: 3, pnpm: 3, yarn: 3, bun: 3, browser: 3,
}
const DEFAULT_GB = 3

function estimateGb(name, overrides) {
  const n = overrides && overrides[name]
  if (typeof n === 'number' && n > 0 && n <= 256) return n
  return ESTIMATES_GB[name] || DEFAULT_GB
}

// A short name for bulkhead status: "npm test", "cargo build". Only characters that need no
// quoting inside the label, so a command's own quotes never reach the wrapper.
function labelFor(argv) {
  const sub = argv.slice(1).find(a => !a.startsWith('-')) || ''
  const raw = `${shell.bin(argv[0])} ${sub}`.trim().slice(0, 40)
  return raw.replace(/[^\w .:/@=+-]/g, '_')
}

// One word for each shell. bash: single quotes, a quote inside becomes '\''. PowerShell: single
// quotes, a quote inside is doubled. cmd: double quotes, a quote inside is doubled.
const SAFE = /^[\w@%+=:,./-]+$/
const SAFE_WIN = /^[\w@%+=:,./\\-]+$/
const quoters = {
  sh: a => (SAFE.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`),
  ps: a => (SAFE_WIN.test(a) ? a : `'${a.replace(/'/g, "''")}'`),
  cmd: a => (SAFE_WIN.test(a) ? a : `"${a.replace(/"/g, '""')}"`),
}

function which(name, env = process.env, exists = fs.existsSync, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  const file = platform === 'win32' ? `${name}.exe` : name
  return dirs.some(d => exists(path.join(d, file))) ? name : null
}

// The slot script of this package, from the plugin root when Claude Code sets it. null when the
// file is missing: the caller then leaves the command alone.
function slotScript({ env = process.env, exists = fs.existsSync, dir = __dirname } = {}) {
  const roots = [env.CLAUDE_PLUGIN_ROOT, path.join(dir, '..')].filter(Boolean)
  for (const r of roots) {
    const f = path.join(r, 'bin', 'bulkhead-slot')
    if (exists(f)) return f
  }
  return null
}

// The command text with `-- <command>` handed to bulkhead-slot, or null when this shell cannot
// carry it (a newline in a cmd line is a second command). The original runs in the same kind
// of shell as before: bash -c for the Bash tool, an encoded script for PowerShell.
function wrap(command, { shell: sh = 'sh', node = process.execPath, script, gb, label, wait, env = process.env, exists, platform } = {}) {
  const q = quoters[sh]
  if (!q || !script) return null
  const head = [node, script].map(q)
  const opts = ['run', `--gb=${gb}`, q(`--label=${label}`)]
  if (wait) opts.push(`--wait=${wait}`)
  let tail
  if (sh === 'sh') tail = `bash -c ${q(command)}`
  else if (sh === 'ps') {
    const exe = which('pwsh', env, exists, platform) || 'powershell'
    tail = `${exe} -NoProfile -EncodedCommand ${Buffer.from(command, 'utf16le').toString('base64')}`
  } else {
    if (/[\r\n]/.test(command)) return null
    tail = q(command)
  }
  return `${sh === 'ps' ? '& ' : ''}${head.join(' ')} ${opts.join(' ')} -- ${tail}`
}

// A single & backgrounds a command, so the slot would be released at once and hold nothing.
function backgrounded(command, mode = 'sh') {
  const text = String(command)
  if (mode === 'ps') return /\bStart-(?:Job|Process)\b|\bsaps\b/i.test(text)
  const bare = text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ' ').replace(/&&|\d?>&\d?|&>>?|\|&/g, ' ')
  return bare.includes('&') || /\b(?:nohup|setsid|disown)\b/.test(bare)
}

// Already queued, or this is the wrapper we wrote.
function wrapped(command) {
  return /bulkhead(?:-|\s+)slot/.test(String(command))
}

module.exports = { ESTIMATES_GB, estimateGb, labelFor, wrap, slotScript, backgrounded, wrapped, quoters, which }
