'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { runHook, enabled, setting, blocked, oneLine, ASK_USER } = require('./hook')
const shell = require('./shell')
const { realPath } = require('./paths')
const { gitCall, gitEnv, parseArgs } = require('./gitargs')

// Narrow rules for mistakes that cannot be undone. Each can be turned off on its own:
// rm-root, rm-empty-var, rm-unquoted-var, rm-git-dir, force-push-main, protected-delete,
// discard-changes, agent-author, self-allow.

// ~, $HOME and %USERPROFILE% become the home directory; /c/... becomes C:/... on Windows.
// Returns null for anything with a variable we cannot expand.
function expand(arg, home, platform) {
  let a = arg
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|%USERPROFILE%|\$USERPROFILE)(?=[\\/]|$)/i, home)
  if (/[$%]/.test(a)) return null
  if (platform === 'win32') a = a.replace(/^\/([a-z])(?=\/|$)/i, '$1:')
  return a
}

const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix)

const norm = (p, platform) => {
  const n = pathFor(platform).resolve(p).replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return platform === 'win32' ? n.toLowerCase() : n
}
// git prints the repository's real path; the cwd and home may be spelled through a link or a
// Windows short name (C:\Users\RUNNER~1). Only those two folders are resolved, never a target:
// a target can be on an automounted or network path, and a hook must not wait on it. A hook
// process asks for the same two folders again and again, so the answers are kept.
const realCache = new Map()
function realOnce(p) {
  if (!realCache.has(p)) {
    if (realCache.size > 64) realCache.clear()
    realCache.set(p, realPath(p))
  }
  return realCache.get(p)
}
const isAncestorOrSame = (a, b) => b === a || b.startsWith(a.endsWith('/') ? a : a + '/')

function rmTargets(t) {
  const cmd = path.basename(t[0] || '').replace(/\.exe$/i, '').toLowerCase()
  const args = t.slice(1)
  if (cmd === 'rm') {
    // options end at `--`; everything after it is a path, even one that starts with a dash
    const dash = args.indexOf('--')
    const opts = (dash < 0 ? args : args.slice(0, dash)).filter(a => a.startsWith('-'))
    const operands = dash < 0 ? args.filter(a => !a.startsWith('-')) : [...args.slice(0, dash).filter(a => !a.startsWith('-')), ...args.slice(dash + 1)]
    const recursive = opts.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
    const force = opts.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')
    return recursive && force ? operands : []
  }
  if (/^(?:remove-item|ri|rmdir|rd|del|erase)$/.test(cmd) && args.some(a => /^-r(?:ecurse)?$/i.test(a)) && args.some(a => /^-fo(?:rce)?$/i.test(a))) {
    return args.filter(a => !a.startsWith('-'))
  }
  if (/^(?:rd|rmdir)$/.test(cmd) && args.some(a => /^\/s$/i.test(a))) return args.filter(a => !/^\/[sq]$/i.test(a))
  return []
}

// Folders directly in the home directory that are only caches and can always be rebuilt.
const HOME_CACHES = /^\.?(?:cache|caches|tmp|temp|npm|pnpm-store|yarn|bun|gradle|m2|nuget|cargo|rustup|deno|expo|Trash|node-gyp|pyenv|bundle|cocoapods)$/i

// The dangerous targets: a filesystem or drive root, a top-level folder such as /usr or /srv,
// the home directory or anything above it, a folder directly in it (~/Documents, ~/backups;
// caches excepted), and any directory above the repository the command runs in.
function dangerousTarget(arg, { cwd, home, platform, repoRoot }) {
  const expanded = expand(arg, home, platform)
  if (expanded === null) return null
  const dir = expanded.replace(/[\\/]\*$/, '') || '/'
  const rel = expanded === '*' ? '.' : dir
  // as written, and on this machine also from the real cwd and home: rm resolves .. from the
  // folder the cwd really is, not from the link it was entered through
  const views = [{ cwd, home }]
  if (platform === process.platform) views.push({ cwd: realOnce(cwd), home: realOnce(home) })
  for (const v of views) {
    const abs = norm(pathFor(platform).resolve(v.cwd, rel), platform)
    if (/^(?:\/|[a-z]:\/?)$/i.test(abs) || /^[a-z]:$/i.test(abs)) return 'a filesystem root'
    const homeKey = norm(v.home, platform)
    if (isAncestorOrSame(abs, homeKey)) return 'your home directory or a folder above it'
    const parent = pathFor('linux').dirname(abs)
    if (parent === homeKey && !HOME_CACHES.test(pathFor('linux').basename(abs))) return 'a folder directly in your home directory'
    if ((parent === '/' || /^[a-z]:\/?$/i.test(parent)) && !isAncestorOrSame(abs, norm(v.cwd, platform))) return 'a top-level folder of the drive'
    // a folder inside the current directory cannot be above the repository
    if (abs !== norm(v.cwd, platform) && isAncestorOrSame(norm(v.cwd, platform), abs)) continue
    const root = repoRoot()
    if (root && abs !== norm(root, platform) && isAncestorOrSame(abs, norm(root, platform))) return 'a folder above this repository'
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// rm-empty-var, rm-unquoted-var, rm-git-dir: deletes that are dangerous whoever runs them.

const NAME = '[A-Za-z_]\\w*'
// a variable reference that is empty when the variable is unset: $D, ${D}, $1, $@, $env:D, %D%
const EMPTYABLE = new RegExp(`^(\\$(?:${NAME}|\\{${NAME}\\}|[1-9@*])|\\$env:${NAME}|%${NAME}%)([\\\\/]+)(?:\\*|\\.\\*)?$`, 'i')
// always set by the shell, or already judged by rm-root once expanded
const ALWAYS_SET = /^(?:HOME|PWD|USERPROFILE)$/i
const varName = ref => ref.replace(/^\$env:|^\$\{?|^%|[}%]$/gi, '')

// $(...) or `...` at the start of a word: the index just past it, or -1
function substitutionEnd(v) {
  if (v.startsWith('`')) { const e = v.indexOf('`', 1); return e < 0 ? -1 : e + 1 }
  if (!v.startsWith('$(')) return -1
  let depth = 0
  let quote = null
  for (let i = 1; i < v.length; i++) {
    const c = v[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return -1
}

// Variables the same command line sets before using them, name -> raw value: D=..., export D=...,
// local D=..., PowerShell $D = ... and $env:D = ..., cmd set D=..., and for D in ... (value null).
const ASSIGN_SH = new RegExp(`(?:^|[\\s;&|(])(?:(?:export|local|declare|typeset|readonly)\\s+(?:-\\w+\\s+)*)?(${NAME})=((?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|\\$\\((?:[^()]|\\([^()]*\\))*\\)|\`[^\`]*\`|[^\\s;&|()"'\`])*)`, 'g')
const ASSIGN_PS = new RegExp(`\\$(?:env:)?(${NAME})\\s*=\\s*("[^"]*"|'[^']*'|\\$\\((?:[^()]|\\([^()]*\\))*\\)|[^\\s;|]+)`, 'gi')
const ASSIGN_CMD = new RegExp(`\\bset\\s+"?(${NAME})=([^"&|\\r\\n]*)`, 'gi')
const FOR_LOOP = new RegExp(`(?:^|[\\s;&|(])for\\s+(${NAME})\\s+in\\s`, 'g')
function assignments(text, mode) {
  const out = new Map()
  const re = mode === 'ps' ? ASSIGN_PS : mode === 'cmd' ? ASSIGN_CMD : ASSIGN_SH
  for (const m of text.matchAll(re)) out.set(mode === 'sh' ? m[1] : m[1].toUpperCase(), m[2])
  if (mode === 'sh') for (const m of text.matchAll(FOR_LOOP)) out.set(m[1], null)
  return out
}
const lookup = (vars, name, mode) => (mode === 'sh' ? vars.get(name) : vars.get(name.toUpperCase()))
const hasVar = (vars, name, mode) => vars.has(mode === 'sh' ? name : name.toUpperCase())

// Whether an assigned value can be empty. A literal, a mktemp, ${X:?} (stops when X is empty) and
// ${X:-default} cannot; a bare $OTHER or a command's output can.
function nonEmpty(raw) {
  if (raw === null) return true // a for loop's variable
  const v = raw.replace(/^["']/, '')
  if (/^(?:\$\(\s*|`\s*)mktemp\b/.test(v)) return true
  if (new RegExp(`^\\$\\{(?:${NAME}|\\d+):?(?:\\?|[-=][^}])`).test(v)) return true
  const rest = raw
    .replace(/\$\((?:[^()]|\([^()]*\))*\)|`[^`]*`|\$\{[^}]*\}|\$(?:env:)?\w+|\$[@*#?$!-]|%\w+%/g, '')
    .replace(/["']/g, '')
  return rest.length > 0
}

// Commands that print one path: deleting their output deletes whatever path that turns out to be.
const PATH_TOOLS = /^(?:cygpath|wslpath|dirname|realpath|readlink|pwd|mktemp)$/
// cygpath -u 'C:\', wslpath C:/, realpath /, dirname /: a drive or filesystem root
const ROOT_ARG = /^(?:[a-z]:[\\/]?|[\\/]+)$/i

// Why deleting this operand can delete a whole drive, or null:
//   { kind: 'var', what: '$D', name: 'D' }   $D/ or $D/* with D possibly empty: / or /*
//   { kind: 'sub', what: '$(...)', tail }    $(...)/: empty output gives /
//   { kind: 'whole', what: '$(...)' }        "$(...)" alone: the deleted path is whatever it prints
//   { kind: 'root', what: '$(...)' }         $(cygpath -u 'C:\')...: it prints a drive root
function emptyVarTarget(word, vars, mode) {
  const v = word.v
  const m = EMPTYABLE.exec(v)
  if (m) {
    const name = varName(m[1])
    if (ALWAYS_SET.test(name)) return null
    if (hasVar(vars, name, mode) && nonEmpty(lookup(vars, name, mode))) return null
    return { kind: 'var', what: m[1], name }
  }
  const end = substitutionEnd(v)
  if (end < 0) return null
  const what = v.slice(0, end)
  const tail = v.slice(end)
  const inner = shell.commands(v.startsWith('$(') ? what.slice(2, -1) : what.slice(1, -1), mode === 'cmd' ? 'sh' : mode, shell.MAX_DEPTH)
  const tool = inner.length === 1 && PATH_TOOLS.test(shell.bin(inner[0].argv[0]))
  if (tool && inner[0].argv.slice(1).some(a => !a.startsWith('-') && ROOT_ARG.test(a))) return { kind: 'root', what }
  if (/^[\\/]+(?:\*|\.\*)?$/.test(tail)) return { kind: 'sub', what, tail }
  // "$(...)" stands for one path; an unquoted $(find ...) is a list, and an empty list deletes nothing
  if (!tail && (word.q || tool)) return { kind: 'whole', what }
  return null
}

// rsync --delete makes the destination match the source: with an empty $D/ that destination is /.
// A bare empty $D also shifts the last source into the destination's place.
const RSYNC_DELETE = /^--(?:del|delete(?:-\w+)*|remove-source-files)$/
function rsyncDeleteDest(t, words, vars, mode) {
  if (shell.bin(t[0]) !== 'rsync' || !t.some(a => RSYNC_DELETE.test(a))) return null
  const k = t.length - 1
  if (k < 2 || t[k].startsWith('-')) return null
  const w = words[k]
  const bare = new RegExp(`^\\$(?:${NAME}|\\{${NAME}\\})$`).exec(w.v)
  if (bare) {
    const name = varName(bare[0])
    if (ALWAYS_SET.test(name) || (hasVar(vars, name, mode) && nonEmpty(lookup(vars, name, mode)))) return null
    return { kind: 'var', what: bare[0], name }
  }
  const hit = emptyVarTarget(w, vars, mode)
  return hit && hit.kind !== 'whole' ? hit : null
}

const GLOB_OR_SPACE = /[\s*?[]/
// An unquoted word with a variable whose value has a space or a glob character: bash and sh split
// it into several words and delete each of them. The value comes from an assignment earlier on the
// line, or from the environment when the line does not set it. A value from $(...) is not known.
function splitVar(word, vars, env) {
  if (word.q) return null
  for (const m of word.v.matchAll(new RegExp(`\\$(?:(${NAME})|\\{(${NAME})\\})`, 'g'))) {
    const name = m[1] || m[2]
    let value
    if (vars.has(name)) {
      const raw = vars.get(name)
      if (raw === null || /\$\(|`/.test(raw)) continue
      value = raw.replace(/^"(.*)"$|^'(.*)'$/s, '$1$2').replace(new RegExp(`\\$(?:(${NAME})|\\{(${NAME})\\})`, 'g'), (_, a, b) => env[a || b] || '')
        .replace(/\$\{[^}]*\}|\$[\d@*#?$!-]/g, '') // ${1:?}, $1: not known here
    } else value = env[name]
    if (value && GLOB_OR_SPACE.test(value)) return { what: m[0], name, value }
  }
  return null
}

// A path whose last part is .git: the repository's history, or a worktree's link to it.
const isGitDirPath = v => /(?:^|[\\/])\.git[\\/]*$/i.test(v)
function defaultIsDir(p) {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

// Whether deleting the .git operand loses history: it is a folder (a worktree's .git file only
// links to the history and goes with git worktree remove anyway), or it cannot be resolved here.
// A .git the same line creates (git clone, git init, a fresh mktemp folder) does not exist yet.
function gitDirAtRisk(v, { cwd, home, platform, vars, env, mode, isDir }) {
  let unknown = false
  let created = false
  const expanded = v
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(new RegExp(`\\$env:(${NAME})|\\$\\{(${NAME})\\}|\\$(${NAME})|%(${NAME})%`, 'gi'), (all, a, b, c, d) => {
      const name = a || b || c || d
      if (/^(?:HOME|USERPROFILE)$/i.test(name)) return home
      if (hasVar(vars, name, mode)) {
        const raw = lookup(vars, name, mode)
        if (raw !== null && /^["']?[^$`"']+["']?$/.test(raw)) return raw.replace(/["']/g, '')
        created = true
        return all
      }
      const val = env[name] !== undefined ? env[name] : env[name.toUpperCase()]
      if (val) return val
      unknown = true
      return all
    })
  if (created) return false
  if (unknown || /[$`*?[]/.test(expanded)) return true
  return isDir(pathFor(platform).resolve(cwd, expanded))
}

// find <start> -name .git -exec rm -rf {} +: removes the .git of the repository it starts in
function findRemovesGit(t) {
  if (shell.bin(t[0]) !== 'find') return false
  const named = t.some((a, i) => /^-(?:i?name|i?path|wholename)$/.test(a) && /^(?:\*\/)?\.git$/.test(t[i + 1] || ''))
  if (!named) return false
  const exec = t.findIndex(a => a === '-exec' || a === '-execdir')
  if (exec < 0) return false
  const stop = t.findIndex((a, i) => i > exec && (a === ';' || a === '+'))
  if (!rmTargets(t.slice(exec + 1, stop < 0 ? undefined : stop)).length) return false
  const starts = []
  for (let i = 1; i < t.length && !/^[-(!]/.test(t[i]); i++) starts.push(t[i])
  // with no start, find starts in the current directory; a start inside the project (vendor/) only
  // reaches nested copies
  return !starts.length || starts.some(s => /^(?:\.{1,2}[\\/]?|[\\/~$%]|[a-z]:)/i.test(s))
}

function emptyVarMessage(seg, operand, hit, rsync) {
  const rest = operand.slice(hit.what.length)
  const becomes = rsync ? `${rest.replace(/^[\\/]+/, '/') || 'missing'}, and --delete then deletes everything there the source does not have` : `${rest.replace(/^[\\/]+/, '/')}, the whole drive`
  const sub = `\`${oneLine(hit.what, 60)}\``
  const why = {
    var: `if ${hit.name} is empty or unset, ${operand} becomes ${becomes}`,
    sub: `if ${sub} prints nothing (it failed or found nothing), ${operand} becomes ${becomes}`,
    whole: `it deletes whatever path ${sub} prints, and a path command can print a drive root (cygpath -u 'C:\\' prints /c/)`,
    root: `${sub} prints a drive or filesystem root, so this deletes at the root of the drive`,
  }[hit.kind]
  const tool = rsync ? 'rsync --delete <source>/' : 'rm -rf'
  const safe = hit.kind === 'var' && !/^%|^\$env:/i.test(hit.what)
    ? `${tool} "\${${hit.name}:?}${rest}"`
    : `D=$(...) first, check it, then ${tool} "\${D:?}/"`
  return `[bulkhead] basics: \`${oneLine(seg, 120)}\` is dangerous: ${why}.\n` +
    `Use \`${safe}\` (the shell stops when the variable is empty), or write the path out.`
}

function splitVarMessage(seg, hit) {
  return `[bulkhead] basics: \`${oneLine(seg, 120)}\` leaves ${hit.what} unquoted, and its value (${oneLine(hit.value, 60)}) has a space or a wildcard, so bash splits it into several paths and deletes each one.\n` +
    `Quote it: rm -rf "${hit.what}".`
}

function gitDirMessage(seg) {
  return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes the repository's history: every commit not pushed, the other branches and the stashes. Nothing brings it back.\n` +
    'To remove a checkout, use `git worktree remove <path>` or move the folder to the trash. To start the history over, ask the user first.'
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function forcePushToMain(rest, branch, protectedBranches = ['main', 'master']) {
  if (rest[0] !== 'push') return false
  const args = rest.slice(1)
  // --force-with-lease and --force-if-includes are the safe forms and do not count
  const force = args.some(a => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'))
  if (!force) return false
  const refs = args.filter(a => !a.startsWith('-')).slice(1).map(r => r.replace(/^\+/, '').split(':').pop())
  const targets = refs.length ? refs.map(r => (r === 'HEAD' ? branch() : r)) : [branch()]
  return targets.some(r => protectedBranches.includes(String(r || '').replace(/^refs\/heads\//, '')))
}

// git push origin :main, git push --delete origin main, git push -d origin main, and
// git branch -D main (or -d -f, --delete --force): removing a protected branch. A plain
// git branch -d refuses unmerged work and is left alone.
function deletesProtected(rest, protectedBranches = ['main', 'master']) {
  const name = r => String(r || '').replace(/^\+/, '').replace(/^refs\/heads\//, '')
  const isProtected = r => protectedBranches.includes(name(r))
  if (rest[0] === 'push') {
    const o = parseArgs(rest.slice(1), { valuedShort: 'o', valuedLong: ['repo', 'push-option', 'receive-pack', 'exec'] })
    const del = o.short.has('d') || [...o.long].some(n => n.length >= 3 && 'delete'.startsWith(n))
    return o.pos.slice(1).map(r => r.replace(/^\+/, '')).some(r => (r.startsWith(':') ? isProtected(r.slice(1)) : del && isProtected(r)))
  }
  if (rest[0] === 'branch') {
    const o = parseArgs(rest.slice(1), { valuedShort: 'uts', valuedLong: ['set-upstream-to', 'track', 'sort', 'format', 'contains', 'merged', 'no-merged', 'points-at'] })
    const del = o.short.has('D') || o.short.has('d') || o.long.has('delete')
    const force = o.short.has('D') || o.short.has('f') || o.long.has('force')
    return del && force && o.pos.some(isProtected)
  }
  return false
}

// An identity that is the agent, not the person: Claude <noreply@anthropic.com> and the like.
const AGENT_ID = /\bclaude\b|anthropic/i

// The --author value of git commit, the value git config sets for user.name or user.email, or a
// -c user.name=... before the subcommand.
function agentAuthor(t, rest) {
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '-c' && /^user\.(?:name|email)=/i.test(t[i + 1] || '') && AGENT_ID.test(t[i + 1].split('=').slice(1).join('='))) return t[i + 1]
  }
  if (rest[0] === 'commit' || rest[0] === 'merge' || rest[0] === 'cherry-pick' || rest[0] === 'revert') {
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i]
      const v = a.startsWith('--author=') ? a.slice(9) : a === '--author' ? rest[i + 1] : null
      if (v && AGENT_ID.test(v)) return `--author ${v}`
    }
  }
  if (rest[0] === 'config') {
    const args = rest.slice(1).filter(a => !/^--(?:global|local|system|worktree|replace-all|add)$/.test(a))
    if (/^user\.(?:name|email)$/i.test(args[0] || '') && args[1] && AGENT_ID.test(args[1])) return `${args[0]} ${args[1]}`
  }
  return null
}

// GIT_AUTHOR_NAME=Claude git commit, export GIT_COMMITTER_EMAIL=noreply@anthropic.com, $env:GIT_AUTHOR_NAME = "Claude"
const AGENT_ENV = /\bGIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL)\s*=\s*["']?([^"'\s;&|]*)/gi
function agentEnv(text) {
  for (const m of text.matchAll(AGENT_ENV)) if (AGENT_ID.test(m[1])) return m[0]
  return null
}

function agentMessage(what) {
  return `[bulkhead] basics: \`${oneLine(what, 120)}\` makes the agent the author of the commit.\n` +
    'Commits authored as Claude or Anthropic do not count as the user\'s work on GitHub (contribution graph, achievements), and later blame points at a bot.\n' +
    'Commit with the git identity already configured: leave user.name and user.email alone and drop --author. A Co-Authored-By line in the message is fine.'
}

function check(cmd, {
  cwd = process.cwd(), home = os.homedir(), platform = process.platform, run = git,
  protectedBranches = setting('basics.protectedBranches', ['main', 'master']), mode = 'sh',
  env = process.env, isDir = defaultIsDir,
} = {}) {
  // each rule's switch and the repository root are read once, however many commands the line has
  const once = fn => { let v; let done = false; return () => (done ? v : ((done = true), (v = fn()))) }
  const rmRoot = once(() => enabled('rm-root'))
  const forcePush = once(() => enabled('force-push-main'))
  const discard = once(() => enabled('discard-changes'))
  const protectedDelete = once(() => enabled('protected-delete'))
  const author = once(() => enabled('agent-author'))
  const emptyVar = once(() => enabled('rm-empty-var'))
  const unquotedVar = once(() => enabled('rm-unquoted-var'))
  const gitDir = once(() => enabled('rm-git-dir'))
  if (/allow/i.test(String(cmd || '')) && enabled('self-allow')) {
    const self = require('./self-allow').check(cmd, { mode })
    if (self) return self
  }
  const prepared = shell.prepare(String(cmd || ''), mode)
  const cmds = shell.commands(prepared, mode).filter(x => !x.remote)
  if (author() && /GIT_(?:AUTHOR|COMMITTER)_/i.test(prepared)) {
    // only the shell's own words: a heredoc body handed to python or node is code, not a variable
    const runsGit = cmds.some(c => shell.bin(c.argv[0]) === 'git')
    for (const c of cmds) {
      const own = c.depth === 0 ? prepared.slice(c.s, c.e) : c.argv.join(' ')
      const setsAgent = agentEnv(own)
      if (setsAgent && (runsGit || /^(?:export|set|setx|\$env:)/i.test(own.trim()))) return agentMessage(setsAgent)
    }
  }
  const repoRoot = once(() => { try { return run(['rev-parse', '--show-toplevel'], cwd) } catch { return null } })
  // wsl [options] -- bash -c '...' runs a Linux shell; read the commands inside it too
  for (const c of [...cmds]) {
    if (shell.bin(c.argv[0] || '') !== 'wsl' || c.depth >= shell.MAX_DEPTH) continue
    const k = c.argv.findIndex((a, i) => i > 0 && (a === '--' || a === '-e' || a === '--exec'))
    const linux = k > 0 ? c.argv.slice(k + 1) : []
    const sh = linux.length && /^(?:bash|sh|zsh|dash)$/.test(shell.bin(linux[0])) ? linux.findIndex(a => /^-[a-z]*c[a-z]*$/.test(a)) : -1
    const inner = sh > 0 ? linux[sh + 1] : linux.length ? linux.join(' ') : null
    if (inner) cmds.push(...shell.commands(inner, 'sh', c.depth + 1))
  }
  for (const c of cmds) {
    const t = c.argv
    if (!t.length) continue
    const seg = t.join(' ')
    const targets = rmTargets(t)
    if (targets.length && rmRoot()) {
      for (const target of targets) {
        const what = dangerousTarget(target, { cwd, home, platform, repoRoot })
        if (what) {
          return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes ${what} (${target}).\n` +
            'Name the folder you mean inside the project instead, for example rm -rf ./dist.'
        }
      }
    }
    const cmdMode = c.depth > 0 && mode !== 'sh' && !/^(?:rd|rmdir|del|erase|remove-item|ri)$/i.test(shell.bin(t[0])) ? 'sh' : mode
    // variables the same shell sets before this command: the text before it in the string it was read from
    const vars = (targets.length || shell.bin(t[0]) === 'rsync') ? assignments(String(c.src || '').slice(0, c.s), cmdMode) : null
    if (targets.length && emptyVar()) {
      const operands = c.words.filter((w, i) => i > 0 && targets.includes(w.v))
      for (const w of operands) {
        const hit = emptyVarTarget(w, vars, cmdMode)
        if (hit) return emptyVarMessage(seg, w.v, hit, false)
      }
    }
    if (vars && shell.bin(t[0]) === 'rsync' && emptyVar()) {
      const hit = rsyncDeleteDest(t, c.words, vars, cmdMode)
      if (hit) return emptyVarMessage(seg, t[t.length - 1], hit, true)
    }
    if (targets.length && cmdMode === 'sh' && unquotedVar()) {
      for (const w of c.words.filter((x, i) => i > 0 && targets.includes(x.v))) {
        const hit = splitVar(w, vars, env)
        if (hit) return splitVarMessage(seg, hit)
      }
    }
    if (gitDir() && ((targets.length && targets.some(v => isGitDirPath(v) && gitDirAtRisk(v, { cwd, home, platform, vars, env, mode: cmdMode, isDir }))) || findRemovesGit(t))) {
      return gitDirMessage(seg)
    }
    if (path.basename(t[0]).replace(/\.exe$/i, '') !== 'git') continue
    const call = gitCall(t, cwd, c.depth === 0 ? gitEnv(prepared.slice(c.s, c.e)) : {})
    const dir = call.dir
    const rest = call.sub ? [call.sub, ...call.args] : []
    const who = author() && agentAuthor(t, rest)
    if (who) return agentMessage(who)
    if (rest[0] === 'push' && forcePush() && forcePushToMain(rest, () => { try { return run(['rev-parse', '--abbrev-ref', 'HEAD'], dir) } catch { return '' } }, protectedBranches)) {
      return `[bulkhead] basics: force-pushing to ${protectedBranches.join(' or ')} rewrites history other people and sessions have pulled.\n` +
        'Push to a branch, or use --force-with-lease if you are sure.'
    }
    if (rest[0] && protectedDelete() && deletesProtected(rest, protectedBranches)) {
      return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes the protected branch (${protectedBranches.join(', ')}), and the work on it goes with it.\n` +
        'Delete a feature branch instead, or turn the rule off for this project if you really mean it.'
    }
    const reset = rest[0] === 'reset' && rest.includes('--hard')
    const clean = rest[0] === 'clean' && rest.some(a => /^-[a-z]*f/.test(a) || a === '--force') && rest.some(a => /^-[a-z]*[dx]/.test(a))
    if ((reset || clean) && discard()) {
      let status
      try { status = run([...call.opts, 'status', '--porcelain'], dir) } catch { continue }
      const lines = status.split('\n').filter(Boolean)
      const lost = reset ? lines.filter(l => !l.startsWith('??')) : lines.filter(l => l.startsWith('??'))
      if (lost.length) {
        return `[bulkhead] basics: \`${oneLine(seg, 120)}\` would throw away ${lost.length} ${reset ? 'uncommitted change' : 'untracked file'}${lost.length === 1 ? '' : 's'}` +
          ` (${lost.slice(0, 3).map(l => l.slice(3)).join(', ')}${lost.length > 3 ? ', ...' : ''}).\n` +
          'Commit them, or move the files somewhere else, first. `git clean -n` and `git status` show what would go.'
      }
    }
  }
  return null
}

function handle(input) {
  const cmd = input.tool_input && input.tool_input.command
  const why = typeof cmd === 'string' && cmd && check(cmd, { cwd: input.cwd || process.cwd(), mode: shell.modeFor(input) })
  if (!why) return
  return blocked('basics', ruleOf(why), input, ruleOf(why) === 'self-allow' ? why : `${why}\n${ASK_USER}`)
}

if (require.main === module) runHook('basics', handle)

function ruleOf(message) {
  if (/cannot approve its own blocks/.test(message)) return 'self-allow'
  if (/makes the agent the author/.test(message)) return 'agent-author'
  if (/force-pushing/.test(message)) return 'force-push-main'
  if (/deletes the protected branch/.test(message)) return 'protected-delete'
  if (/would throw away/.test(message)) return 'discard-changes'
  if (/` is dangerous: /.test(message)) return 'rm-empty-var'
  if (/bash splits it into several paths/.test(message)) return 'rm-unquoted-var'
  if (/deletes the repository's history/.test(message)) return 'rm-git-dir'
  return 'rm-root'
}

module.exports = { handle, check, rmTargets, dangerousTarget, emptyVarTarget, splitVar, assignments, nonEmpty, findRemovesGit, forcePushToMain, deletesProtected, ruleOf, agentAuthor }
