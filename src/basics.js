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
// rm-root, rm-empty-var, rm-unquoted-var, rm-git-dir, rm-xargs-split, rm-through-link,
// force-push-main, protected-delete, discard-changes, agent-author, self-allow.

// ~, $HOME and %USERPROFILE% become the home directory; /c/... becomes C:/... on Windows.
// Returns null for anything with a variable we cannot expand.
function expand(arg, home, platform) {
  let a = arg
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|\$env:HOME|\$env:HOMEPATH|%USERPROFILE%|%HOMEPATH%|\$USERPROFILE)(?=[\\/]|$)/i, home)
    // the Windows system drive, written as a variable: $env:SystemDrive\ is C:\
    .replace(/^(?:\$env:(?:SystemDrive|HOMEDRIVE)|%(?:SystemDrive|HOMEDRIVE)%)(?=[\\/]|$)/i, 'C:')
  if (/[$%]/.test(a)) return null
  if (platform === 'win32') a = a.replace(/^\/(?:cygdrive\/)?([a-z])(?=\/|$)/i, '$1:')
  return a
}

// A Windows drive as a Linux-side shell mounts it: /mnt/c (WSL), /cygdrive/c (Cygwin).
const MOUNTED_DRIVE = /^\/(?:mnt|cygdrive)\/[a-z]$/i
// A Windows drive root written out (C:\, C:/) is the drive wherever the hook runs: an agent on
// Linux or macOS that writes it means the Windows drive, not a file named C:\ in the cwd.
const DRIVE_LETTER_ROOT = /^[a-z]:[\\/]*$/i

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

function rmTargets(t, mode = 'sh') {
  const cmd = path.basename(t[0] || '').replace(/\.exe$/i, '').toLowerCase()
  const args = t.slice(1)
  if (cmd === 'rm') {
    // options end at `--`; everything after it is a path, even one that starts with a dash
    const dash = args.indexOf('--')
    const opts = (dash < 0 ? args : args.slice(0, dash)).filter(a => a.startsWith('-'))
    const operands = dash < 0 ? args.filter(a => !a.startsWith('-')) : [...args.slice(0, dash).filter(a => !a.startsWith('-')), ...args.slice(dash + 1)]
    const recursive = opts.some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
    const force = opts.some(a => /^-[a-zA-Z]*f/.test(a) || a === '--force')
    // PowerShell's rm is Remove-Item: rm -Recurse $home, or rm -r in the PowerShell tool
    if (opts.some(a => PS_RECURSE.test(a) && (a.length > 2 || mode === 'ps'))) return psOperands(args)
    return recursive && force ? operands : []
  }
  if (/^(?:remove-item|ri|rmdir|rd|del|erase)$/.test(cmd) && args.some(a => PS_RECURSE.test(a))) return psOperands(args)
  if (/^(?:rd|rmdir)$/.test(cmd) && args.some(a => /^\/s$/i.test(a))) return args.filter(a => !/^\/[sq]$/i.test(a))
  return []
}

// PowerShell takes any unambiguous prefix of a parameter: -r, -rec and -Recurse are the same, and
// -Recurse:$true too. Remove-Item -Recurse deletes the tree without -Force; -Force only adds hidden
// and read-only items.
const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$true)?$/i
// Remove-Item parameters (and common ones) that take a value that is not a path
const PS_VALUE = /^-(?:fi(?:l(?:t(?:er?)?)?)?|inc(?:l(?:u(?:de?)?)?)?|ex(?:c(?:l(?:u(?:de?)?)?)?)?|cr(?:e(?:d(?:e(?:n(?:t(?:i(?:al?)?)?)?)?)?)?)?|st(?:r(?:e(?:am?)?)?)?|ea|erroraction|wa|warningaction|infa|informationaction|ev|errorvariable|ov|outvariable)$/i
function psOperands(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    if (PS_VALUE.test(args[i])) i++
    else if (!args[i].startsWith('-')) out.push(args[i])
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// PowerShell targets in parentheses: Remove-Item -Recurse -Force (Split-Path $home). The parser
// reads (...) as a command of its own, so the statement is read again here from its raw text.

const PS_REMOVE = /^(?:remove-item|ri|rm|rmdir|rd|del|erase)$/

// The raw text of one PowerShell statement from `from`: up to a ; | or newline outside quotes and
// parentheses. Words are split at blanks outside them, so (Split-Path $home) is one word.
function psWords(src, from) {
  const words = []
  let w = ''
  let depth = 0
  let quote = null
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) { w += c; if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") { quote = c; w += c; continue }
    if (c === '(') depth++
    else if (c === ')') { if (depth === 0) break; depth-- }
    if (depth === 0 && (c === ';' || c === '|' || c === '\n' || c === '&')) break
    if (depth === 0 && /\s/.test(c)) { if (w) words.push(w); w = ''; continue }
    w += c
  }
  if (w) words.push(w)
  return words
}

const unquote = v => v.replace(/^"(.*)"$|^'(.*)'$/s, '$1$2')

// The path a parenthesized PowerShell expression gives, when it is the home directory or a path
// tool applied to it: (Split-Path $home) is the folder above home (C:\Users), (Split-Path -Qualifier
// $home) the drive. Returns null for anything else.
function psValue(word, home, platform, depth = 0) {
  const v = unquote(word.trim())
  if (depth > 4) return null
  if (!v.startsWith('(')) return expand(v, home, platform)
  if (!v.endsWith(')')) return null
  const inner = psWords(v.slice(1, -1), 0)
  if (!inner.length || !/^(?:split-path|resolve-path|convert-path)$/i.test(inner[0])) return inner.length === 1 ? psValue(inner[0], home, platform, depth + 1) : null
  const args = inner.slice(1)
  if (args.some(a => /^-(?:leaf|leafbase|extension|noqualifier|isabsolute|childpath|additionalchildpath)/i.test(a))) return null
  const operand = args.filter((a, i) => !a.startsWith('-') || /^-(?:path|literalpath)$/i.test(args[i - 1] || ''))
    .find(a => !a.startsWith('-'))
  if (!operand) return null
  const value = psValue(operand, home, platform, depth + 1)
  if (value === null) return null
  if (!/^split-path$/i.test(inner[0])) return value
  const p = pathFor(platform)
  if (args.some(a => /^-q(?:u(?:a(?:l(?:i(?:f(?:i(?:er?)?)?)?)?)?)?)?$/i.test(a))) {
    const q = /^[a-z]:/i.exec(value)
    return q ? q[0] + '\\' : null
  }
  const up = /^[a-z]:[\\/]/i.test(value) ? path.win32.dirname(value) : p.dirname(value.replace(/[\\/]+$/, '') || '/')
  return up
}

// The parser ends the command at a ( that starts a word: Remove-Item -Recurse (Split-Path $home)
const parenNext = c => /^\s*\(/.test(String(c.src || '').slice(c.e, c.e + 32))

// The parenthesized targets of a recursive PowerShell delete, each { word, path }.
function psParenTargets(c, home, platform) {
  if (!c.src || !PS_REMOVE.test(shell.bin(c.argv[0] || '')) || !parenNext(c)) return []
  const words = psWords(c.src, c.words[0].s)
  if (!words.slice(1).some(a => PS_RECURSE.test(a) || /^\/s$/i.test(a) || /^-(?=[a-zA-Z]*[rR])[rRfv]{1,3}$/.test(a))) return []
  const out = []
  for (const w of words.slice(1)) {
    if (!w.startsWith('(')) continue
    const p = psValue(w, home, platform)
    if (p !== null) out.push({ word: w, path: p })
  }
  return out
}

// A delete PowerShell runs: its own cmdlet, or an alias (rm, rd, rmdir) with -Recurse, or any delete
// from the PowerShell tool.
function psDelete(t, mode) {
  const b = shell.bin(t[0] || '')
  if (/^(?:remove-item|ri|del|erase)$/.test(b) || (mode === 'ps' && PS_REMOVE.test(b))) return true
  return /^(?:rd|rmdir|rm)$/.test(b) && t.slice(1).some(a => PS_RECURSE.test(a) && (a.length > 2 || b !== 'rm'))
}

// A PowerShell delete that names $home or a profile variable: say what that variable is.
function psHomeNote(target) {
  if (!/\$(?:home\b|\{home\}|env:(?:userprofile|homepath)\b)|split-path/i.test(target)) return ''
  return '\n$home (in any case, $HOME too) is PowerShell\'s automatic variable for your user profile folder (C:\\Users\\<you>): it is always set and read-only, so it is never empty, and $env:USERPROFILE is the same folder. (Split-Path $home) is therefore C:\\Users, the folder with every user\'s profile.'
}

// Folders directly in the home directory that are only caches and can always be rebuilt.
const HOME_CACHES = /^\.?(?:cache|caches|tmp|temp|npm|pnpm-store|yarn|bun|gradle|m2|nuget|cargo|rustup|deno|expo|Trash|node-gyp|pyenv|bundle|cocoapods)$/i

// Folders in a home directory that hold the apps' data, documents and keys. Deleting one of them as a
// whole loses what no build brings back; a folder deeper inside (~/Library/Caches/x, ~/.config/x) passes.
const HOME_KEEP = /^(?:library|documents|desktop|downloads|pictures|movies|music|videos|onedrive|appdata|\.ssh|\.gnupg|\.config|\.local|\.aws)$/i
const HOME_KEEP_INNER = /^(?:library\/(?:application support|containers|group containers|preferences|keychains|mobile documents|mail|messages|cloudstorage)|appdata\/(?:roaming|local|locallow)|\.local\/(?:share|state))$/i
// A user's home folder, own or another's: /Users/<name>, /home/<name>, C:/Users/<name>, and the
// same drive seen from WSL, Cygwin or Git Bash (/mnt/c/Users/<name>, /c/Users/<name>).
const USER_HOME = /^(?:[a-z]:|\/(?:mnt\/|cygdrive\/)?[a-z])?\/users\/[^/]+|^\/home\/[^/]+/i

// Why deleting abs (normalized) loses a home directory or what it holds, or null.
function homeReason(abs, homeKey) {
  if (isAncestorOrSame(abs, homeKey)) return 'your home directory or a folder above it'
  const own = isAncestorOrSame(homeKey, abs)
  const base = own ? homeKey : (USER_HOME.exec(abs) || [])[0]
  if (!base) return null
  const rel = abs.slice(base.length).replace(/^\//, '')
  if (!rel) return 'a user\'s home directory'
  if (HOME_KEEP_INNER.test(rel) || HOME_KEEP.test(rel)) return own ? 'a folder in your home directory that holds your apps\' data, documents or keys' : 'a folder in a user\'s home directory that holds their apps\' data, documents or keys'
  if (own && !rel.includes('/') && !HOME_CACHES.test(rel)) return 'a folder directly in your home directory'
  return null
}

// The dangerous targets: a filesystem or drive root, a top-level folder such as /usr or /srv,
// the home directory or anything above it, a folder directly in it (~/Documents, ~/backups;
// caches excepted), the folders in it that hold app data (~/Library/Application Support,
// ~/AppData/Roaming), another user's home and those folders in it, and any directory above the
// repository the command runs in.
function dangerousTarget(arg, { cwd, home, platform, repoRoot }) {
  const expanded = expand(arg, home, platform)
  if (expanded === null) return null
  const dir = expanded.replace(/[\\/]\*$/, '') || '/'
  const rel = expanded === '*' ? '.' : dir
  if (DRIVE_LETTER_ROOT.test(dir)) return 'a filesystem root'
  // C:\Users\x written out is a Windows path wherever the hook runs, as C:\ is
  if (platform !== 'win32' && /^[a-z]:[\\/]/i.test(dir)) {
    const abs = norm(path.win32.resolve(dir), 'win32')
    if (/^[a-z]:\/[^/]+$/.test(abs)) return 'a top-level folder of the drive'
    return homeReason(abs, norm(home, platform))
  }
  // as written, and on this machine also from the real cwd and home: rm resolves .. from the
  // folder the cwd really is, not from the link it was entered through
  const views = [{ cwd, home }]
  if (platform === process.platform) views.push({ cwd: realOnce(cwd), home: realOnce(home) })
  for (const v of views) {
    const abs = norm(pathFor(platform).resolve(v.cwd, rel), platform)
    if (/^(?:\/|[a-z]:\/?)$/i.test(abs) || /^[a-z]:$/i.test(abs)) return 'a filesystem root'
    if (MOUNTED_DRIVE.test(abs)) return 'a filesystem root'
    if (MOUNTED_DRIVE.test(pathFor('linux').dirname(abs)) && !isAncestorOrSame(abs, norm(v.cwd, platform))) return 'a top-level folder of the drive'
    const atHome = homeReason(abs, norm(v.home, platform))
    if (atHome) return atHome
    const parent = pathFor('linux').dirname(abs)
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

// ---------------------------------------------------------------------------------------------
// rm-root through a variable the same line sets: D=/; rm -rf "$D/" deletes / just as rm -rf / does
// (anthropics/claude-code#95426).

// $D, ${D}, ${D:?msg}, ${D?}, ${D:-x}, ${D:=x}, $env:D, %D%
const VAR_REF = `\\$\\{(${NAME})(?::?[?=-][^}]*)?\\}|\\$env:(${NAME})|\\$(${NAME})|%(${NAME})%`
const refName = m => m[1] || m[2] || m[3] || m[4]

// The text an assigned value stands for, when it is written out: D=/, D='C:\', D="$HOME/x". A
// value with a command substitution or another variable (other than a leading $HOME) is not known.
function literalValue(raw) {
  if (raw === null || raw === undefined) return null
  if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1)
  const v = raw.replace(/^"(.*)"$/s, '$1')
  if (/`|\$\(|["']/.test(v)) return null
  return v
}

// Writes each variable the line sets to a literal into the path, so rm-root can judge it.
// Returns null when no variable was replaced.
function substituteVars(target, vars, mode) {
  let changed = false
  const text = target.replace(new RegExp(VAR_REF, 'gi'), (all, ...groups) => {
    const name = refName([all, ...groups])
    if (ALWAYS_SET.test(name) || !hasVar(vars, name, mode)) return all
    const value = literalValue(lookup(vars, name, mode))
    // an empty value: ${D:?} stops the shell, and $D/ is rm-empty-var's case
    if (!value) return all
    changed = true
    return value
  })
  return changed ? text : null
}

// The value is a drive or filesystem root, or the home directory.
function isRootValue(p, home, platform) {
  const s = p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1')
  if (/^(?:\/+|[a-z]:\/?|\/(?:(?:mnt|cygdrive)\/)?[a-z])$/i.test(s)) return true
  const h = home.replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? s.toLowerCase() === h.toLowerCase() : s === h
}

// D=$(cygpath -u 'C:\'), D=$(wslpath C:/), D=$(realpath ~), D=$(dirname /x): a path command whose
// argument is a drive or filesystem root (or home) prints that root, so ${D:?} proves the value is
// not empty but not that it is not the root. Returns the substitution, or null.
const ROOT_TOOLS = /^(?:cygpath|wslpath|realpath|readlink|dirname)$/
function rootTool(raw, mode, home, platform) {
  if (raw === null || raw === undefined) return null
  const v = raw.replace(/^"(.*)"$/s, '$1')
  if (substitutionEnd(v) !== v.length) return null
  const inner = shell.commands(v.startsWith('$(') ? v.slice(2, -1) : v.slice(1, -1), mode === 'cmd' ? 'sh' : mode, shell.MAX_DEPTH)
  if (inner.length !== 1 || !ROOT_TOOLS.test(shell.bin(inner[0].argv[0] || ''))) return null
  const dirname = shell.bin(inner[0].argv[0]) === 'dirname'
  for (const a of inner[0].argv.slice(1)) {
    if (a.startsWith('-')) continue
    const p = expand(a, home, platform)
    if (p === null) continue
    if (isRootValue(p, home, platform) || (dirname && isRootValue(path.posix.dirname(p.replace(/\\/g, '/')), home, platform))) return v
  }
  return null
}

// A target that is such a variable alone, or followed only by / or /*: "${D:?}", "${D:?}/", "$D"/*.
// A folder after it ("${D:?}/sub") deletes only that folder.
function rootToolTarget(target, vars, mode, home, platform) {
  const m = new RegExp(`^(?:${VAR_REF})(?:[\\\\/]+(?:\\*|\\.\\*)?)?$`, 'i').exec(target)
  if (!m) return null
  const name = refName(m)
  if (ALWAYS_SET.test(name) || !hasVar(vars, name, mode)) return null
  const sub = rootTool(lookup(vars, name, mode), mode, home, platform)
  return sub ? { name, sub } : null
}

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

// ---------------------------------------------------------------------------------------------
// rm-xargs-split: xargs splits its input at blanks and newlines and reads quotes and backslashes,
// unless -0 or -d says what separates the items. A path with a space reaches rm as several shorter
// paths, and dirname turns such a piece into its parent: find ~/Library/Application\ Support/x |
// xargs -n1 dirname | xargs rm -rf deleted ~/Library (a r/ClaudeCode report).

// The xargs in front of a command (the parser takes it off the words), or null:
// { whole } when -0/--null or -d/--delimiter keeps each item whole, { replace } for -I/-i/--replace.
function xargsOf(c) {
  const first = c.words && c.words[0]
  if (!c.src || !first || first.s <= c.s) return null
  const words = c.src.slice(c.s, first.s).split(/\s+/).filter(Boolean).map(unquote)
  const at = words.map(w => shell.bin(w)).lastIndexOf('xargs')
  if (at < 0) return null
  let whole = false
  let replace = false
  for (const w of words.slice(at + 1)) {
    if (w === '--null' || /^--delimiter(?:=|$)/.test(w)) whole = true
    else if (/^--replace(?:=|$)/.test(w)) replace = true
    else if (/^-[^-]/.test(w)) {
      for (const ch of w.slice(1)) {
        if (ch === '0') whole = true
        else if (ch === 'd') { whole = true; break }
        else if (ch === 'I' || ch === 'i') { replace = true; break }
        else if ('nPLlsEeaJR'.includes(ch)) break
      }
    }
  }
  return { whole, replace }
}

const recursiveRm = t => {
  if (shell.bin(t[0] || '') !== 'rm') return false
  const dash = t.indexOf('--')
  return (dash < 0 ? t : t.slice(0, dash)).slice(1).some(a => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive')
}

// The commands that feed c through pipes, nearest first: same string, same level, a | between.
const indexCache = new WeakMap()
function upstream(cmds, c) {
  if (!indexCache.has(cmds)) indexCache.set(cmds, new Map(cmds.map((x, i) => [x, i])))
  const out = []
  let next = c
  // a pipeline longer than 64 commands is not a real one; the bound keeps a huge line linear
  for (let i = indexCache.get(cmds).get(c) - 1; i >= 0 && out.length < 64; i--) {
    const p = cmds[i]
    if (p.src !== c.src || p.depth !== c.depth || p.sub || p.e > next.s) continue
    const gap = c.src.slice(p.e, next.s).replace(/\d*>&\d+|&>/g, '')
    if (!/^[^;&|\n]*\|&?\s*$/.test(gap)) break
    out.push(p)
    next = p
  }
  return out
}

// Why this rm is fed paths that xargs split, or null: { kind: 'split' | 'dirname', via, replace }.
function xargsSplit(cmds, c) {
  const t = c.argv
  if (!recursiveRm(t)) return null
  const x = xargsOf(c)
  if (!x) return null
  const feed = upstream(cmds, c)
  // echo a b | xargs rm -rf: the words are written out on the line, splitting them is the point
  const source = feed[feed.length - 1]
  if (source && /^(?:echo|printf)$/.test(shell.bin(source.argv[0])) && source.argv.slice(1).every(a => !/[$`*?[]/.test(a))) return null
  const namer = feed.find(p => /^(?:dirname|basename)$/.test(shell.bin(p.argv[0] || '')) && xargsOf(p))
  if (namer) {
    const nx = xargsOf(namer)
    const zero = namer.argv.some(a => a === '-z' || a === '--zero')
    if (!(x.whole && nx.whole && zero)) return { kind: 'dirname', via: shell.bin(namer.argv[0]), replace: x.replace }
  }
  return x.whole ? null : { kind: 'split', replace: x.replace }
}

function xargsSplitMessage(text, hit) {
  const head = `[bulkhead] basics: \`${oneLine(text, 140)}\` `
  const how = hit.replace
    ? 'feeds rm -rf through xargs -I without -0: -I still splits its input at newlines and reads quotes and backslashes in it (C:\\Users\\me\\x becomes C:Usersmex), so rm can get other paths than the ones printed.'
    : 'feeds rm -rf through xargs without -0: xargs splits its input at every space, tab and newline and reads quotes and backslashes in it, so a path with a space (~/Library/Application Support/x) reaches rm as several shorter paths, and rm deletes each one.'
  const why = hit.kind === 'dirname'
    ? `runs ${hit.via} on paths xargs splits at spaces, so a piece such as ~/Library/Application turns into its parent folder, ~/Library, and the rm -rf at the end of the pipeline deletes that folder whole. This is how a user lost ~/Library.`
    : how
  return head + why + '\n' +
    'Keep each path whole: `find ... -print0 | xargs -0 rm -rf --`, or let find delete (`find ... -delete`, `find ... -exec rm -rf {} +`). Or print the list first, check it, and delete the folders by name.'
}

// ---------------------------------------------------------------------------------------------
// rm-through-link: a delete that can follow a link out of the folder. Junctions in a worktree that
// point at shared data (D:\models, a .venv) went with it when two old worktrees were removed on
// Windows (r/ClaudeAI, about 230 GB). GNU and BSD rm, Git Bash's rm (it sees a junction as a link),
// rd /s and current git delete the link and not what it points at, but Windows PowerShell 5.1
// Remove-Item -Recurse and older Git for Windows follow junctions. So on Windows the PowerShell
// deletes are checked, and git worktree remove --force everywhere: --force skips git's own check,
// and a worktree is where links to shared data live. A plain rm -rf node_modules in Git Bash, whose
// workspace junctions point outside it, stays allowed. On every platform, rm -rf link/ with a slash
// deletes the folder the link points at, not the link.

const LINK_BUDGET = { entries: 2000, depth: 6 }

// A link (symbolic link or junction) inside root whose target is outside root and exists, or null.
// Breadth first, so the links at the top (.venv, models) are seen before a deep node_modules uses up
// the budget; past the budget it gives up and lets the command through.
function outwardLink(root, budget = LINK_BUDGET) {
  let rootReal
  try {
    if (!fs.lstatSync(root).isDirectory()) return null
    rootReal = fs.realpathSync(root)
  } catch { return null }
  const key = p => norm(p, process.platform)
  const roots = [key(root), key(rootReal)]
  const inside = p => roots.some(r => isAncestorOrSame(r, key(p)))
  const queue = [[root, 0]]
  let seen = 0
  for (let q = 0; q < queue.length; q++) {
    const [dir, depth] = queue[q]
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (++seen > budget.entries) return null
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        let to
        try { to = fs.readlinkSync(p) } catch { continue }
        const target = path.resolve(dir, to.replace(/^\\\\\?\\|^\\\?\?\\/, ''))
        if (!inside(target) && fs.existsSync(target)) return { link: p, target }
      } else if (e.isDirectory() && e.name !== '.git' && depth + 1 < budget.depth) queue.push([p, depth + 1])
    }
  }
  return null
}

// The folder a delete operand names, when it can be read here: no variable, no glob but a last /*.
function operandDir(arg, cwd, home, platform) {
  const v = expand(arg, home, platform)
  if (v === null || /[*?[`]/.test(v.replace(/[\\/]\*$/, ''))) return null
  return path.resolve(cwd, v.replace(/[\\/]\*$/, '') || '/')
}

// rm -rf link/ (or link/* or link/.): the slash makes rm go into the folder the link points at.
function slashThroughLink(arg, cwd, home, platform) {
  if (!/[\\/](?:\*|\.)?$/.test(arg) || /^[\\/]+$/.test(arg)) return null
  const v = expand(arg.replace(/[\\/](?:\*|\.)?$/, ''), home, platform)
  if (v === null || !v || /[*?[`]/.test(v)) return null
  const p = path.resolve(cwd, v)
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return null
    const target = fs.realpathSync(p)
    return fs.statSync(target).isDirectory() ? { link: p, target, slash: true } : null
  } catch { return null }
}

function linkMessage(text, hit, platform) {
  const head = `[bulkhead] basics: \`${oneLine(text, 140)}\` `
  if (hit.slash) {
    return head + `goes through a link: ${hit.link} is a symbolic link to ${hit.target}, and with the slash after it rm deletes what is in ${hit.target} instead of the link.\n` +
      `To remove only the link, leave out the slash: rm ${hit.link} (or unlink ${hit.link}).`
  }
  const unlink = platform === 'win32' ? `cmd /c rmdir "${hit.link}"` : `unlink ${hit.link}`
  return head + `would delete through a link: ${hit.link} is a junction or symbolic link to ${hit.target}, outside the folder being deleted. ` +
    'Some tools follow such links when they delete a folder (Windows PowerShell 5.1 Remove-Item -Recurse, older Git for Windows), and then the files at the other end are deleted too.\n' +
    `Remove the link itself first (${unlink}; this deletes only the link, never its target), then run the command again.`
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
  const head = `[bulkhead] basics: \`${oneLine(seg, 120)}\` is dangerous: ${why}.\n`
  if (hit.kind === 'var' && /^%|^\$env:/i.test(hit.what)) {
    return head + `Check that ${hit.name} is set before deleting (PowerShell: \`if (-not $env:${hit.name}) { throw '${hit.name} is empty' }\`, cmd: \`if not defined ${hit.name} exit /b 1\`), or write the path out.`
  }
  if (hit.kind === 'root') {
    return head + `Name the folder under that root: \`D=$(...); ${tool} ${guarded('D', '/<folder>')}\`, or write the path out.`
  }
  const safe = hit.kind === 'var' ? `${tool} ${guarded(hit.name, rest)}` : `D=$(...) first, check it, then ${tool} ${guarded('D', rest)}`
  return head + `Use \`${safe}\` (the shell stops when the variable is empty), or write the path out.`
}

// "${D:?}" followed by the rest of the path. A trailing * or .* stays outside the quotes, where the
// shell still expands it: "${D:?}"/*, not "${D:?}/*", which names a file called *.
function guarded(name, rest) {
  const g = /^(.*?)([\\/]+)(\*|\.\*)$/s.exec(rest)
  return g ? `"\${${name}:?}${g[1]}"${g[2]}${g[3]}` : `"\${${name}:?}${rest}"`
}

function rootToolMessage(seg, target, hit) {
  return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes a filesystem root (${target}): ${hit.name} is set earlier on the line to \`${oneLine(hit.sub, 60)}\`, which prints a drive or filesystem root (or the home directory), and :? only stops an empty value.\n` +
    `Name the folder under it instead, for example rm -rf ${guarded(hit.name, '/<folder>')}.`
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
  const xargsSplitOn = once(() => enabled('rm-xargs-split'))
  const throughLink = once(() => enabled('rm-through-link'))
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
    if (!inner) continue
    // Without --exec, wsl hands its command line to the Linux login shell, and Windows quotes each
    // argument with double quotes on the way: that shell expands $R before bash -c runs, so an
    // assignment inside the bash -c string comes too late (anthropics/claude-code#109735).
    const viaShell = c.argv[k] === '--'
    cmds.push(...shell.commands(inner, 'sh', c.depth + 1).map(x => (viaShell ? { ...x, src: '' } : x)))
  }
  for (const c of cmds) {
    const t = c.argv
    if (!t.length) continue
    const seg = t.join(' ')
    const targets = rmTargets(t, mode)
    const cmdMode = c.depth > 0 && mode !== 'sh' && !/^(?:rd|rmdir|del|erase|remove-item|ri)$/i.test(shell.bin(t[0])) ? 'sh' : mode
    // variables the same shell sets before this command: the text before it in the string it was read from
    const vars = (targets.length || shell.bin(t[0]) === 'rsync') ? assignments(String(c.src || '').slice(0, c.s), cmdMode) : null
    const ps = psDelete(t, mode) && (targets.length > 0 || parenNext(c))
    const nameIt = ps ? 'Name the folder you mean inside the project instead, for example Remove-Item -Recurse -Force .\\dist.' : 'Name the folder you mean inside the project instead, for example rm -rf ./dist.'
    if (ps && rmRoot()) {
      for (const hit of psParenTargets(c, home, platform)) {
        const what = dangerousTarget(hit.path, { cwd, home, platform, repoRoot })
        if (what) return `[bulkhead] basics: \`${oneLine(psWords(c.src, c.words[0].s).join(' '), 120)}\` deletes ${what} (${hit.word} is ${hit.path}).\n${nameIt}${psHomeNote(hit.word)}`
      }
    }
    if (targets.length && rmRoot()) {
      for (const target of targets) {
        const what = dangerousTarget(target, { cwd, home, platform, repoRoot })
        if (what) return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes ${what} (${target}).\n${nameIt}${ps ? psHomeNote(target) : ''}`
        const tool = rootToolTarget(target, vars, cmdMode, home, platform)
        if (tool) return rootToolMessage(seg, target, tool)
        const written = substituteVars(target, vars, cmdMode)
        const whatThen = written !== null && dangerousTarget(written, { cwd, home, platform, repoRoot })
        if (whatThen) {
          return `[bulkhead] basics: \`${oneLine(seg, 120)}\` deletes ${whatThen} (${target} is ${oneLine(written.replace(/([\\/])[\\/]+/g, '$1'), 60)}, set earlier on the line).\n` +
            'Name the folder you mean inside the project instead, for example rm -rf ./dist.'
        }
      }
    }
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
    if (xargsSplitOn()) {
      const hit = xargsSplit(cmds, c)
      if (hit) return xargsSplitMessage(String(c.src || '').slice((upstream(cmds, c).pop() || c).s, c.e), hit)
    }
    if (targets.length && throughLink()) {
      for (const target of targets) {
        const hit = slashThroughLink(target, cwd, home, platform) ||
          (platform === 'win32' && ps && !dangerousTarget(target, { cwd, home, platform, repoRoot }) && outwardLink(operandDir(target, cwd, home, platform) || ''))
        if (hit) return linkMessage(seg, hit, platform)
      }
    }
    if (path.basename(t[0]).replace(/\.exe$/i, '') !== 'git') continue
    const call = gitCall(t, cwd, c.depth === 0 ? gitEnv(prepared.slice(c.s, c.e)) : {})
    const dir = call.dir
    const rest = call.sub ? [call.sub, ...call.args] : []
    // git worktree remove --force: checked on every platform (see rm-through-link above)
    if (rest[0] === 'worktree' && rest[1] === 'remove' && throughLink() && rest.slice(2).some(a => a === '--force' || /^-[a-z]*f/.test(a))) {
      const where = rest.slice(2).filter(a => !a.startsWith('-')).pop()
      const hit = where && outwardLink(operandDir(where, dir, home, platform) || '')
      if (hit) return linkMessage(seg, hit, platform)
    }
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
  if (/through xargs (?:-I )?without -0|on paths xargs splits at spaces/.test(message)) return 'rm-xargs-split'
  if (/delete through a link|` goes through a link: /.test(message)) return 'rm-through-link'
  return 'rm-root'
}

module.exports = { handle, check, rmTargets, dangerousTarget, outwardLink, xargsOf, psValue, emptyVarTarget, splitVar, assignments, nonEmpty, findRemovesGit, forcePushToMain, deletesProtected, ruleOf, agentAuthor }
