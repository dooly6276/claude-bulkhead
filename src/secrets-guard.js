'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runHook, blocked, setting, ASK_USER } = require('./hook')
const shell = require('./shell')

// Opt-in (secretsGuard.enabled). Stops the agent from reading secret files into the conversation:
// the Read and Grep tools on them, and shell commands that print, encode or upload them or dump the
// whole environment. Writing a secret file is fine, and so are ls, stat, test -f and git check-ignore.
// This is a guard against careless reads, not a sandbox: a program that opens the file itself is not seen.

const SAFE_ENV = /^\.env\.(?:example|sample|template|dist|defaults|tpl|schema)$/i
const SSH_SAFE = /^(?:config|known_hosts(?:\.old)?|authorized_keys2?|allowed_signers|environment|rc)$|\.pub$/i
const PUBLIC_PEM = /-----BEGIN (?:CERTIFICATE|TRUSTED CERTIFICATE|PUBLIC KEY|X509 CRL|CERTIFICATE REQUEST)-----/
const NPM_TOKEN = /_authToken|_auth\b|_password|:_password/i
// Files that hold a secret only some of the time: read, and block when they do.
const CONTENT_RULES = [
  [/(?:^|\/)\.npmrc$/i, NPM_TOKEN, 'an npm auth token'],
  [/(?:^|\/)\.yarnrc\.yml$/i, /npmAuthToken|npmAuthIdent/i, 'an npm auth token'],
  [/(?:^|\/)\.pypirc$/i, /password|token/i, 'a PyPI password or token'],
  [/(?:^|\/)\.docker\/config\.json$/i, /"auth"\s*:|identitytoken|registrytoken/i, 'Docker registry credentials'],
]
// Names a shell glob such as .env* or ~/.ssh/* could expand to.
const SAMPLES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'server.pem', 'server.key', 'credentials',
  'hosts.yml', '.netrc', 'config', 'config.json', 'credentials.db', 'access_tokens.db', 'application_default_credentials.json', '.npmrc']

const SECRET_DIRS = /\/(?:\.ssh|\.aws|\.kube|\.azure|\.config\/gh|\.config\/gcloud)$/i
const READERS = new Set(['cat', 'tac', 'less', 'more', 'most', 'head', 'tail', 'nl', 'bat', 'batcat', 'cut', 'sort', 'uniq', 'od', 'xxd',
  'hexdump', 'strings', 'base64', 'base32', 'basenc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'nawk',
  'jq', 'yq', 'diff', 'cmp', 'comm', 'paste', 'column', 'fold', 'rev', 'get-content', 'gc', 'type', 'select-string', 'sls',
  'cp', 'scp', 'rsync', 'curl', 'wget'])
// the first plain argument of these is a pattern or a program, not a file
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk', 'gawk', 'mawk', 'nawk', 'jq', 'yq', 'select-string', 'sls'])
const COPIERS = new Set(['cp', 'scp', 'rsync'])
// options of the copy tools that take a value which is not a file to copy (scp -i ~/.ssh/id_rsa names a key it uses)
const VALUE_FLAGS = { cp: ['-t', '-S'], scp: ['-i', '-o', '-P', '-F', '-J', '-l', '-c', '-S'], rsync: ['-e', '--rsh', '--port', '--rsync-path', '--exclude', '--include'] }
const UPLOAD_FLAG = /^(?:-T|--upload-file|--post-file|--body-file|-d|--data|--data-binary|--data-urlencode|-F|--form|--json)$/
const CLI_PRINTERS = [
  [/^gh auth token\b|^gh auth status\b.*(?:\s-t\b|--show-token)/, 'the GitHub CLI token'],
  [/^gcloud auth (?:application-default )?print-(?:access|identity)-token\b/, 'a Google Cloud access token'],
  [/^aws configure get\s+\S*(?:secret|token|key)/i, 'an AWS secret'],
  [/^npm (?:config|c) get\s+\S*(?:_auth|token|password)/i, 'an npm auth token'],
]

function globRegex(pattern, { shellGlob = false } = {}) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') { re += '.*'; i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp((shellGlob && !pattern.startsWith('.') ? '^(?!\\.)' : '^') + re + '$', 'i')
}

function expand(arg, cwd, home) {
  let p = String(arg).replace(/\\/g, '/')
  p = p.replace(/^~(?=\/|$)/, home).replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=\/|$)/i, home)
  p = p.replace(/^(?:\$PWD|\$\{PWD\})(?=\/|$)/, cwd)
  return path.posix.normalize(/^(?:\/|[a-zA-Z]:\/)/.test(p) ? p : `${cwd.replace(/\\/g, '/')}/${p}`)
}

// Whether `p` (absolute, forward slashes) matches a user pattern: a plain file name, or a path
// pattern that may start with ~ and use * and **.
function userMatch(p, patterns, home) {
  return patterns.some(raw => {
    const pat = raw.replace(/\\/g, '/').replace(/^~(?=\/|$)/, home)
    if (!pat.includes('/')) return globRegex(pat).test(p.slice(p.lastIndexOf('/') + 1))
    const re = globRegex(pat.replace(/^\*\*\//, ''))
    return pat.startsWith('/') || /^[a-zA-Z]:/.test(pat) ? globRegex(pat).test(p) : new RegExp(`(?:^|/)${re.source.slice(1)}`, 'i').test(p)
  })
}

function peek(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(32768)
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0))
    } finally {
      fs.closeSync(fd)
    }
  } catch { return null }
}

// The kind of secret the file is, or null. `p` is absolute with forward slashes.
function classifyPath(p, { home = os.homedir().replace(/\\/g, '/'), extra = [], allow = [], read = peek } = {}) {
  if (allow.length && userMatch(p, allow, home)) return null
  const base = p.slice(p.lastIndexOf('/') + 1)
  const lower = p.toLowerCase()
  const parent = lower.split('/').slice(-2, -1)[0]
  if (/^\.env(?:\..+)?$/i.test(base) && !SAFE_ENV.test(base)) return 'an environment file'
  if (/\.(?:pem|key|p12|pfx)$/i.test(base)) {
    const text = /\.(?:pem|key)$/i.test(base) ? read(p) : null
    return text && PUBLIC_PEM.test(text) && !/PRIVATE KEY/.test(text) ? null : 'a private key file'
  }
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)/i.test(base) && !/\.pub$/i.test(base)) return 'an SSH private key'
  if (parent === '.ssh' && !SSH_SAFE.test(base)) return 'an SSH private key'
  if (/^(?:\.netrc|_netrc)$/i.test(base)) return 'netrc credentials'
  if (/^(?:\.git-credentials|\.pgpass|\.vault-token)$/i.test(base)) return 'stored credentials'
  if (/\/\.aws\/credentials$/.test(lower) || /\/\.aws\/sso\/cache\//.test(lower)) return 'AWS credentials'
  if (/\/\.config\/gh\/hosts\.yml$/.test(lower)) return 'the GitHub CLI token'
  if (/\/\.kube\/config$/.test(lower)) return 'Kubernetes credentials'
  if (/\/\.azure\/accesstokens\.json$/.test(lower)) return 'Azure tokens'
  if (/\/gcloud\/(?:credentials\.db|access_tokens\.db|application_default_credentials\.json|legacy_credentials\/)/.test(lower)) return 'Google Cloud credentials'
  if (/^\/proc\/[^/]+\/environ$/.test(lower)) return 'a process environment'
  for (const [name, content, label] of CONTENT_RULES) {
    if (!name.test(lower)) continue
    const text = read(p)
    return text && content.test(text) ? label : null
  }
  if (extra.length && userMatch(p, extra, home)) return 'a file you listed in secretsGuard.extraPatterns'
  return null
}

// classifyPath for an argument: a literal path, or a glob that could expand to a secret.
function classifyArg(arg, ctx, opts) {
  if (!arg || typeof arg !== 'string') return null
  const p = expand(arg, ctx.cwd, ctx.home)
  const name = p.slice(p.lastIndexOf('/') + 1)
  if (!/[*?[]/.test(name)) return classifyPath(p, opts)
  const dir = p.slice(0, p.lastIndexOf('/'))
  const likely = `${dir}/${name.replace(/[*?[\]]/g, 'x')}`
  if (opts.extra && opts.extra.length && !(opts.allow && opts.allow.length && userMatch(likely, opts.allow, opts.home)) && userMatch(likely, opts.extra, opts.home)) {
    return 'a file you listed in secretsGuard.extraPatterns'
  }
  // a bare * says nothing about which names it expands to; only a folder of secrets makes it a hit
  if (/^[*?]+$/.test(p.slice(p.lastIndexOf('/') + 1)) && !SECRET_DIRS.test(dir)) return null
  const re = globRegex(p.slice(p.lastIndexOf('/') + 1), { shellGlob: true })
  for (const s of SAMPLES) {
    if (!re.test(s)) continue
    const found = classifyPath(`${dir}/${s}`, opts)
    if (found) return found
  }
  return null
}

// A folder that holds secrets (~/.ssh, ~/.aws), for commands that read everything below it.
function classifyDir(arg, ctx, opts) {
  const p = expand(arg, ctx.cwd, ctx.home).replace(/\/+$/, '')
  return SECRET_DIRS.test(p) ? classifyArg(`${p}/*`, ctx, opts) : null
}

// The files a reader command names, in the places a file can be named.
function fileArgs(argv, b) {
  const args = argv.slice(1)
  if (b === 'sed' && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return []
  const out = []
  const takesPattern = PATTERN_FIRST.has(b) && !args.some(a => /^(?:-e|-f|--regexp|--file|--expression|-Pattern)(?:=|$)/i.test(a))
  let seen = !takesPattern
  const upload = b === 'curl' || b === 'wget'
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (/^(?:\d*>>?|&>>?|>\||\d*>&.*)$/.test(a) || a === '<<<' || a === '<<') { i++; continue }
    if (/^\d*>/.test(a)) continue
    if (a === '<') { if (args[i + 1]) out.push(args[++i]); continue }
    if (/^<[^<(]/.test(a)) { out.push(a.slice(1)); continue }
    if ((VALUE_FLAGS[b] || []).includes(a)) { i++; continue }
    if (upload) {
      const m = /^(-T|--upload-file|--post-file|--body-file|-d|--data|--data-binary|--data-urlencode|-F|--form|--json)(?:=(.*))?$/.exec(a) || /^(-[dFT])(.+)$/.exec(a)
      if (m && UPLOAD_FLAG.test(m[1])) {
        const v = m[2] !== undefined ? m[2] : args[++i]
        if (v == null) continue
        if (/^(?:-T|--upload-file|--post-file|--body-file)$/.test(m[1])) out.push(v)
        else {
          const f = /(?:^|=)[@<](.+)$/.exec(v) || /^[\w-]+@(.+)$/.exec(v) || /^@(.+)$/.exec(v)
          if (f) out.push(f[1].split(';')[0])
        }
      }
      continue
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=')
      if (a.startsWith('--') && eq > 0) out.push(a.slice(eq + 1))
      continue
    }
    if (!seen) { seen = true; continue }
    out.push(a)
  }
  if (COPIERS.has(b)) out.pop()
  return b === 'scp' || b === 'rsync' ? out.filter(a => !/^[^/\\]{2,}:/.test(a)) : out
}

// A pipe straight into something that only counts or tests keeps the values out of the output.
function harmlessPipe(text, end) {
  const m = /^\s*\|&?\s*([\w./-]+)((?:\s+-[\w-]+)*)/.exec(text.slice(end))
  if (!m) return false
  const b = shell.bin(m[1])
  return b === 'wc' || (/^e?grep$/.test(b) && /(?:^|\s)-[a-zA-Z]*[qcl]/.test(m[2]))
}

function withoutRedirects(words) {
  const out = []
  for (let i = 0; i < words.length; i++) {
    if (/^(?:\d*>>?|&>>?|>\||<)$/.test(words[i])) i++
    else if (!/^\d*[<>]/.test(words[i])) out.push(words[i])
  }
  return out
}

// `env`, `printenv`, `export -p`, a bare `set`: the whole environment.
function dumpsEnvironment(text, mode) {
  const bare = rest => rest.every(a => /^-[a-zA-Z0-9-]*$/.test(a) && a !== '-S')
  let unwrapped = text
  try { unwrapped = shell.unwrap(text, mode) } catch {}
  for (const c of shell.lex(unwrapped, mode).cmds) {
    const i = c.words.findIndex(w => !/^(?:sudo|doas|command|exec|nohup|time|builtin)$/.test(shell.bin(w.v)) && !(w.v.startsWith('-') && !shell.bin(w.v)))
    if (i < 0) continue
    const b = shell.bin(c.words[i].v)
    const rest = withoutRedirects(c.words.slice(i + 1).map(w => w.v))
    const dump = ((b === 'env' || b === 'printenv') && bare(rest)) ||
      ((b === 'export' || b === 'declare' || b === 'typeset') && rest.length && rest.every(a => /^-[pxf]+$/.test(a)) && !rest.includes('-f')) ||
      ((b === 'export' || b === 'set') && !rest.length) ||
      (b === 'compgen' && rest.join(' ') === '-e') ||
      (/^(?:get-childitem|gci|dir|ls)$/.test(b) && rest.some(a => /^env:\\?\*?$/i.test(a)) && !rest.some(a => /^env:\\?\w/i.test(a)))
    if (dump && !harmlessPipe(unwrapped, c.e)) return true
  }
  return false
}

function findHit(argv, ctx, opts) {
  const args = argv.slice(1)
  const exec = args.findIndex(a => /^-(?:exec|execdir|ok|okdir)$/.test(a))
  if (exec < 0 || !READERS.has(shell.bin(args[exec + 1] || ''))) return null
  const starts = []
  for (const a of args) { if (a.startsWith('-') || a === '(' || a === '!') break; starts.push(a) }
  for (const s of starts) {
    const hit = classifyDir(s, ctx, opts)
    if (hit) return { label: hit, what: s }
  }
  for (let i = 0; i < args.length - 1; i++) {
    if (!/^-(?:i?name|i?path|i?wholename)$/.test(args[i])) continue
    const hit = classifyArg(args[i + 1], { ...ctx, cwd: '/x' }, opts)
    if (hit) return { label: hit, what: args[i + 1] }
  }
  return null
}

// { rule, label, what } for the first secret the command would show, or null.
function classifyCommand(cmd, { cwd = process.cwd(), home = os.homedir().replace(/\\/g, '/'), extra = [], allow = [], read = peek, mode = 'sh' } = {}) {
  const ctx = { cwd: cwd.replace(/\\/g, '/'), home }
  const opts = { home, extra, allow, read }
  const text = shell.prepare(String(cmd || ''), mode)
  for (const c of shell.commands(text, mode)) {
    if (c.remote) continue
    const b = shell.bin(c.argv[0])
    const joined = c.argv.join(' ')
    if (b === 'find') {
      const hit = findHit(c.argv, ctx, opts)
      if (hit) return { rule: 'print-file', label: hit.label, what: hit.what }
    }
    for (const [re, label] of CLI_PRINTERS) if (re.test(joined)) return { rule: 'print-token', label, what: joined }
    if (!READERS.has(b)) continue
    for (const a of fileArgs(c.argv, b)) {
      const label = classifyArg(a, ctx, opts) || (/^(?:grep|egrep|fgrep|rg|ag|ack|get-content|gc|type|cat|cp|scp|rsync)$/.test(b) ? classifyDir(a, ctx, opts) : null)
      if (label) return { rule: b === 'cp' || b === 'scp' || b === 'rsync' || b === 'curl' || b === 'wget' ? 'copy-file' : 'print-file', label, what: a }
    }
  }
  if (/\benv\b|printenv|export|declare|typeset|\bset\b|compgen|get-childitem|gci|\bdir\b|\bls\b/i.test(text) && dumpsEnvironment(text, mode)) {
    return { rule: 'dump-env', label: 'every environment variable', what: 'the whole environment' }
  }
  return null
}

function classifyTool(input, opts) {
  const t = input.tool_input || {}
  const cwd = (input.cwd || process.cwd()).replace(/\\/g, '/')
  const ctx = { cwd, home: opts.home }
  if (input.tool_name === 'Read') {
    const label = classifyArg(t.file_path, ctx, opts)
    return label && { rule: 'read-file', label, what: t.file_path }
  }
  if (input.tool_name === 'Grep') {
    const label = classifyArg(t.path, ctx, opts) || (t.glob ? classifyArg(`${t.path || '.'}/${t.glob}`, ctx, opts) : null)
    return label && { rule: 'read-file', label, what: t.path || t.glob }
  }
  return null
}

function message(hit) {
  return `[bulkhead] secrets-guard: this would show ${hit.label} (${hit.what}) to the model.\n` +
    'Ask the user for the specific value you need, or use it by name (for example $API_KEY or --env-file .env) without printing it.\n' +
    ASK_USER
}

if (require.main === module) {
  runHook('secrets-guard', input => {
    const home = os.homedir().replace(/\\/g, '/')
    const opts = { home, extra: setting('secretsGuard.extraPatterns', []), allow: setting('secretsGuard.allow', []) }
    const cmd = input.tool_input && input.tool_input.command
    const hit = cmd
      ? classifyCommand(cmd, { ...opts, cwd: input.cwd || process.cwd(), mode: shell.modeFor(input) })
      : classifyTool(input, opts)
    if (!hit) return
    return blocked('secrets-guard', hit.rule, input, message(hit), cmd || hit.what)
  })
}

module.exports = { classifyCommand, classifyTool, classifyPath, classifyArg, message, globRegex }
