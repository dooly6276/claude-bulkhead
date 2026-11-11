'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const os = require('os')
const { runHook, blocked, oneLine, enabled, ASK_USER } = require('./hook')
const { readSessionFiles, PID_REUSE_SLACK_MS } = require('./sessions')
const shell = require('./shell')
const { rmTargets } = require('./basics')

// The git commands a line runs on this machine, wrappers (bash -c, env, VAR=value) opened.
function gitCommands(cmd, mode = 'sh') {
  return shell.commands(shell.prepare(String(cmd || ''), mode), mode).filter(c => !c.remote && shell.bin(c.argv[0]) === 'git')
}

const { gitCall: parseGitCall, gitEnv, treeOf, parseArgs } = require('./gitargs')

// git <sub> args, global options (-C, --git-dir, --work-tree, -c, --no-pager, ...) pulled out.
// Returns null for anything that is not git. Takes the words of one command, or a command line
// (read as its first command).
function gitCall(seg, cwd, env) {
  const t = Array.isArray(seg) ? seg : ((shell.commands(seg)[0] || {}).argv || [])
  return parseGitCall(t, cwd, env)
}

const DONE = /^--(?:abort|continue|skip|quit)$/

// A long option may be shortened as long as it stays unambiguous: --upd is --update.
const longIs = (o, full, min = 3) => [...o.long].some(n => n.length >= min && full.startsWith(n))

// A pathspec that excludes (:!x, :^x, :(exclude)x) narrows nothing down.
const excluding = p => /^:(?:[!^]|\([^)]*\bexclude\b[^)]*\))/.test(p)

// A list of changed files that git prints, as an argument: $(git ls-files -m), $(git diff --name-only).
// Naming a folder or file ($(git ls-files -m src)) limits the list to it.
function changedList(p) {
  if (!/^(?:\$\(|`)/.test(p)) return false
  const inner = shell.commands(p.replace(/^(?:\$\(|`)/, '').replace(/(?:\)|`)$/, ''))[0]
  const call = inner && parseGitCall(inner.argv, '.')
  const o = call && parseArgs(call.args)
  if (!call || o.pos.length) return false
  if (call.sub === 'diff') return o.long.has('name-only') || o.long.has('name-status')
  if (call.sub === 'status') return o.long.has('porcelain') || o.long.has('short') || o.short.has('s')
  return call.sub === 'ls-files'
}

// A pathspec that stands for the whole tree: ., ./, *, ./*, .*, :/, :(top), :(glob)**, $PWD,
// $(pwd), $(git rev-parse --show-toplevel), and a list of every changed file.
function wholeTree(p) {
  if (/^(?:\$\{?PWD\}?|\$\(\s*pwd\s*\)|`\s*pwd\s*`)\/?$/.test(p)) return true
  if (/^(?:\$\(|`)\s*git\s+rev-parse\s+--show-toplevel\s*(?:\)|`)\/?$/.test(p)) return true
  if (changedList(p)) return true
  const rest = p.replace(/^:(?:\/|\((?:[a-z]+,?)+\))?/i, '').replace(/^(?:\.\/+)+/, '').replace(/\/+$/, '')
  return /^(?:|\.|\*\*?|\.\*|\*\/\*\*)$/.test(rest)
}

// A pathspec written to leave the folder git runs in: it can still name the whole tree.
const farPath = p => /^(?:[\\/]|~|\.\.|[A-Za-z]:)/.test(p)

// A pathspec that covers many files: a glob, a folder, a magic pathspec.
function broad(p, dir, isDir) {
  if (/[*?[]|^:|[\\/]$/.test(p)) return true
  return isDir(path.resolve(dir, p))
}
const dirOf = p => { try { return fs.statSync(p).isDirectory() } catch { return false } }

// The pathspecs a checkout or restore overwrites files from, or [] when it switches something.
function restoreSpecs({ sub, args, dir = '.' }, exists) {
  if (sub === 'restore') {
    const o = parseArgs(args, { valuedShort: 's', valuedLong: ['source', 'pathspec-from-file'] })
    // --staged alone only unstages; the files on disk stay as they are
    const worktree = o.short.has('W') || o.long.has('worktree')
    if ((o.short.has('S') || o.long.has('staged')) && !worktree) return []
    return o.pos
  }
  const o = parseArgs(args, { valuedShort: 'bBt', valuedLong: ['orphan', 'conflict', 'pathspec-from-file', 'track'] })
  if (o.after.length) return o.after
  if (o.short.has('b') || o.short.has('B') || o.long.has('orphan')) return []
  // git checkout src/app.js restores a file; only a branch or commit moves the tree
  return o.pos.length && o.pos.every(n => exists(path.resolve(dir, n))) ? o.pos : []
}

// What the command does to a shared working tree, or null when it leaves it alone.
// 'dirty-only' means it matters only when there are uncommitted changes. Three more answers need
// a look at the repository first and are settled by classify: 'add-paths' (does a far pathspec
// name the whole tree), 'restore-paths' (does a folder or glob cover uncommitted changes) and
// 'unstages' (is anything staged).
function changesTree({ sub, args, dir = '.' }, exists = fs.existsSync, isDir = dirOf) {
  // git <cmd> --help and -h only print usage
  const before = args.indexOf('--') >= 0 ? args.slice(0, args.indexOf('--')) : args
  if (before.includes('--help') || before.includes('-h')) return null
  switch (sub) {
    case 'checkout': {
      const o = parseArgs(args, { valuedShort: 'bBt', valuedLong: ['orphan', 'conflict', 'pathspec-from-file', 'track'] })
      const specs = restoreSpecs({ sub, args, dir }, exists)
      const restores = () => (specs.some(wholeTree) ? 'restores every file' : specs.some(p => broad(p, dir, isDir)) ? 'restore-paths' : null)
      if (o.after.length) return restores()
      if (args.includes('-') || o.short.has('b') || o.short.has('B') || o.long.has('orphan')) return 'switches the branch'
      if (o.pos.some(wholeTree)) return 'restores every file'
      if (specs.length) return restores()
      if (o.pos.length) return 'switches the branch'
      // git checkout -f with nothing to switch to throws the changes away
      return o.short.has('f') || o.long.has('force') ? 'restores every file' : null
    }
    case 'switch':
      return 'switches the branch'
    case 'restore': {
      const specs = restoreSpecs({ sub, args, dir }, exists)
      if (specs.some(wholeTree)) return 'restores every file'
      return specs.some(p => broad(p, dir, isDir)) ? 'restore-paths' : null
    }
    case 'stash': {
      const first = args[0]
      if (/^(?:list|show|create|store)$/.test(first || '')) return null
      const explicit = first === 'push'
      if (first && !explicit && !first.startsWith('-')) return /^(?:save|pop|apply|drop|clear|branch)$/.test(first) ? 'stashes or unstashes changes' : null
      // git stash push -- src/a.js moves only those files: allowed
      const o = parseArgs(explicit ? args.slice(1) : args, { valuedShort: 'm', valuedLong: ['message', 'pathspec-from-file'] })
      return o.pos.length || o.long.has('pathspec-from-file') ? null : 'stashes or unstashes changes'
    }
    case 'reset': {
      const o = parseArgs(args)
      if (o.long.has('hard') || o.long.has('merge') || o.long.has('keep')) return 'resets the files'
      if (o.long.has('soft') || o.long.has('patch') || o.short.has('p')) return null
      // a word with a variable may be a list of files; it is not guessed at
      if (o.pos.some(p => p.includes('$'))) return null
      const specs = o.after.length ? o.after : o.pos.length > 1 ? o.pos.slice(1) : o.pos.length === 1 && exists(path.resolve(dir, o.pos[0])) ? o.pos : []
      if (specs.length && !specs.some(wholeTree)) return null
      return 'unstages'
    }
    case 'clean':
      if (args.some(a => /^-[a-z]*n/.test(a) || a === '--dry-run')) return null
      return args.some(a => /^-[a-z]*f/.test(a) || a === '--force') ? 'deletes untracked files' : null
    case 'rebase':
      return args.some(a => DONE.test(a)) ? null : 'rebases the branch'
    case 'merge':
      return args.some(a => DONE.test(a)) ? null : 'merges into the branch'
    case 'pull':
      return 'dirty-only'
    case 'cherry-pick':
      return args.some(a => DONE.test(a)) ? null : 'applies commits to the tree'
    case 'revert':
      return args.some(a => DONE.test(a)) ? null : 'reverts commits in the tree'
    case 'am':
      return args.some(a => DONE.test(a) || a === '--show-current-patch' || a === '--retry') ? null : 'applies patches to the tree'
    case 'apply': {
      const o = parseArgs(args, { valuedLong: ['directory', 'exclude', 'include', 'whitespace', 'reject'] })
      // --cached works on the index only; --check and the stat options write nothing
      const readOnly = ['cached', 'check', 'stat', 'numstat', 'summary'].some(n => o.long.has(n))
      return readOnly && !o.long.has('index') ? null : 'applies a patch to the tree'
    }
    case 'checkout-index': {
      const o = parseArgs(args)
      // --prefix writes the copy somewhere else
      if (o.long.has('prefix')) return null
      return (o.short.has('a') || o.long.has('all')) && (o.short.has('f') || o.long.has('force')) ? 'overwrites the files from the index' : null
    }
    case 'read-tree': {
      const o = parseArgs(args)
      return o.short.has('u') && (o.long.has('reset') || o.short.has('m')) ? 'rewrites the files' : null
    }
    case 'submodule': {
      const o = parseArgs(args.slice(1))
      return args[0] === 'update' && (o.short.has('f') || o.long.has('force')) ? 'resets the submodule files' : null
    }
    case 'rm': {
      const o = parseArgs(args)
      if (o.short.has('n') || o.long.has('dry-run') || o.long.has('cached')) return null
      // a folder, or the whole tree; named files and narrow globs (sample-*.jpg) are an ordinary cleanup
      return o.pos.some(p => wholeTree(p) || (o.short.has('r') && broad(p, dir, isDir) && !/[*?[]/.test(p.replace(/^.*\//, '')))) ? 'removes files' : null
    }
    // git add -A, git add ., git commit -a: everything changed in the tree goes into one commit,
    // including the files the other session is in the middle of editing. A pathspec narrows it:
    // git add -A src/ is the files in src/.
    case 'add': {
      const o = parseArgs(args, { valuedLong: ['pathspec-from-file'] })
      if (o.short.has('n') || longIs(o, 'dry-run')) return null
      const specs = o.pos.filter(p => !excluding(p))
      if (specs.some(wholeTree)) return 'stage-all'
      if (o.long.has('pathspec-from-file')) return null
      const all = o.short.has('A') || o.short.has('u') || longIs(o, 'all') || longIs(o, 'update')
      if (!specs.length) return all ? 'stage-all' : null
      return specs.some(farPath) ? 'add-paths' : null
    }
    case 'commit': {
      const o = parseArgs(args, { valuedShort: 'mFCct', valuedLong: ['message', 'file', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'author', 'date', 'cleanup', 'template', 'trailer'] })
      if (o.long.has('dry-run')) return null
      return o.short.has('a') || longIs(o, 'all') ? 'stage-all' : null
    }
    default:
      return null
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// When a process started, in ms, or 0 when it cannot be read.
function startOf(pid, platform = process.platform) {
  try {
    if (platform === 'win32') {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      return Date.parse(out.trim()) || 0
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } })
    return Date.parse(out.trim()) || 0
  } catch {
    return 0
  }
}

// Is this session file's process still running? A file left behind by a session that died can
// name a pid another program now holds. The cheap check is that the pid exists; `deep` also
// compares the process start with the time the file says the session started, which costs a
// process lookup, so callers ask it only for the few sessions in the tree at hand. A start time
// that cannot be read counts as the same process.
function liveSession(pid, file, deep = false, startTime = startOf) {
  if (!alive(pid)) return false
  if (!deep || !file || !file.startedAt) return true
  const started = startTime(pid)
  return !started || Math.abs(started - file.startedAt) < PID_REUSE_SLACK_MS
}

// git prints the real path of the tree; a session may have started through a symlink, a junction
// or a Windows short name (C:\Users\RUNNER~1), so both sides are resolved before comparing.
const real = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const key = (p, platform) => {
  const n = real(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return platform === 'win32' ? n.toLowerCase() : n
}
const inside = (child, parent) => child === parent || child.startsWith(parent + '/')

// Other live sessions whose project directory is in the same working tree. A session started in
// a subfolder of this tree could still be in a nested worktree or submodule, so git decides those.
function sharers(top, sessionId, { files, isAlive, run, platform }) {
  const topKey = key(top, platform)
  const out = []
  for (const [pid, f] of files) {
    if (!f.cwd || f.sessionId === sessionId || !isAlive(pid, f, false)) continue
    const cwdKey = key(f.cwd, platform)
    if (!inside(cwdKey, topKey)) continue
    if (cwdKey !== topKey) {
      let theirs
      try { theirs = run(['rev-parse', '--show-toplevel'], f.cwd) } catch { continue }
      if (key(theirs, platform) !== topKey) continue
    }
    if (!isAlive(pid, f, true)) continue
    out.push({ pid, ...f })
  }
  return out
}

function when(ms) {
  if (!ms) return 'unknown time'
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ` +
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// git worktree remove <path> and rm -rf <path>: the folders the command deletes.
function removedDirs(c, cwd, home, known = true) {
  const call = gitCall(c.argv, cwd)
  if (call && call.sub === 'worktree' && call.args[0] === 'remove') {
    const rest = call.args.slice(1)
    const target = rest.find(a => !a.startsWith('-'))
    return target ? [{ dir: path.resolve(call.dir, expandHome(target, home)), how: 'git worktree remove', force: rest.some(a => a === '-f' || a === '--force') }] : []
  }
  return [...rmTargets(c.argv), ...findDeletes(c.argv)]
    .map(t => expandHome(t, home))
    .map(t => expandPwd(t, cwd))
    .map(t => deleted(t, cwd, known))
    .filter(Boolean)
}

// find <paths> -delete and find <paths> -exec rm: what they remove, when nothing narrows the
// files they reach (-name, -path, -mtime, -empty ...). find . -type f -delete is the whole tree.
const FIND_FILTER = /^-(?:i?name|i?path|i?wholename|i?regex|i?lname|newer\w*|[mac]time|[mac]min|empty|size|user|group|perm|samefile|inum|links|executable|readable|writable|used)$/
function findDeletes(t) {
  if (shell.bin(t[0] || '') !== 'find') return []
  let i = 1
  while (/^-(?:[HLP]|O\d|D)$/.test(t[i] || '')) i++
  const start = []
  while (i < t.length && !/^(?:-|!$|\()/.test(t[i])) start.push(t[i++])
  const expr = t.slice(i)
  const removes = expr.includes('-delete') || expr.some((a, k) => /^-(?:exec|execdir|ok|okdir)$/.test(a) && /^(?:rm|unlink|shred|rmdir)$/.test(shell.bin(expr[k + 1] || '')))
  return removes && !expr.some(a => FIND_FILTER.test(a)) ? (start.length ? start : ['.']) : []
}

// What one deletion target removes: the folder it names; every file in the folder for dir/*; the
// repository's whole folder for .git (without its history the folder is no longer a repository).
function deleted(t, cwd, known = true) {
  // after a cd we cannot follow, a relative target means a folder we do not know
  if (!t || (!known && !path.isAbsolute(t))) return null
  const star = /^(?:(.*)[\\/])?\.?\*+$/.exec(t)
  if (star && !/[$%*?`]/.test(star[1] || '')) return { dir: path.resolve(cwd, star[1] || '.'), how: 'deleting', force: true, what: 'everything in' }
  if (/[$%*?`]/.test(t)) return null
  const dir = path.resolve(cwd, t)
  if (path.basename(dir) === '.git') return { dir: path.dirname(dir), how: 'deleting', force: true, what: 'the git data of' }
  return { dir, how: 'deleting', force: true, what: '' }
}

// $PWD, ${PWD}, $(pwd) and `pwd` are the folder the command runs in.
function expandPwd(arg, cwd) {
  return String(arg).replace(/^(?:\$PWD|\$\{PWD\}|\$\(\s*pwd\s*\)|`\s*pwd\s*`)(?=[\\/]|$)/, cwd.replace(/\\/g, '/'))
}

function expandHome(arg, home) {
  return String(arg)
    .replace(/^~(?=[\\/]|$)/, home)
    .replace(/^(?:\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i, home)
}

// Links in the first two levels of a folder (node_modules linked to the main checkout is the
// usual one). On Windows, git worktree remove --force has followed a junction and deleted what
// it pointed to.
function linksIn(dir) {
  const out = []
  const walk = (d, depth) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.git') continue
      const p = path.join(d, e.name)
      if (e.isSymbolicLink()) out.push(p)
      else if (e.isDirectory() && depth < 2) walk(p, depth + 1)
      if (out.length >= 3) return
    }
  }
  walk(dir, 1)
  return out
}

// git ls-files -m | xargs git add: git add is fed every changed file. A list limited by a
// pathspec (git ls-files -m src) is not.
function fedByChangedList(all, c, call, text, cwd) {
  if (c.depth !== 0 || !/(?:^|\s)xargs(?:\s|$)/.test(text.slice(c.s, c.e)) || parseArgs(call.args).pos.length) return false
  return all.some(p => {
    if (p === c || p.seg !== c.seg || p.depth !== 0 || p.s >= c.s) return false
    const src = gitCall(p.argv, cwd)
    if (!src) return false
    const o = parseArgs(src.args)
    if (o.after.length) return false
    if (src.sub === 'ls-files') return !o.pos.length
    if (src.sub === 'diff') return o.long.has('name-only') || o.long.has('name-status')
    return src.sub === 'status' && (o.long.has('porcelain') || o.short.has('s') || o.long.has('short'))
  })
}

// The paths in `git status --porcelain` output (the new name of a rename). The output has been
// trimmed, so the first line can have lost the space that starts its status.
function changedPaths(status) {
  return status.split('\n').map(l => (/^[ MADRCTU?!]{1,2} (.+)$/.exec(l) || [])[1]).filter(Boolean).map(f => f.split(' -> ').pop().replace(/^"|"$/g, ''))
}

// Does a pathspec (as typed in folder `dir`) cover a changed file (path from the tree top)?
function covers(spec, file, dir, top, platform) {
  const abs = path.join(top, file)
  if (/^:[^/(]/.test(spec) || /^:\((?!top\))/.test(spec)) return true
  const top2 = /^:(?:\/|\(top\))/.test(spec)
  const body = spec.replace(/^:(?:\/|\([^)]*\))?/, '')
  const base = top2 ? top : dir
  if (/[*?[]/.test(body)) {
    const re = new RegExp('^' + path.resolve(base, body).replace(/\\/g, '/').replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    const sep = abs.replace(/\\/g, '/')
    return sep.split('/').some((_, i, a) => re.test(a.slice(0, i + 1).join('/') || '/'))
  }
  return inside(key(abs, platform), key(path.resolve(base, body), platform))
}

// The folder each command runs in: the hook's folder, moved by the cd commands before it. A cd
// to a folder we cannot work out (a variable, `cd -`, a folder that does not exist), or a ( cd x )
// subshell, makes the folder unknown: the command is then read from the hook's folder, but
// relative deletions are skipped.
function cwdsOf(all, text, cwd, home, folderExists = fs.existsSync) {
  let cur = cwd
  let known = !/\(\s*(?:cd|pushd)\b/.test(text)
  return all.map(c => {
    const here = { cwd: cur, known }
    if (c.depth === 0 && known && /^(?:cd|pushd|chdir)$/.test(shell.bin(c.argv[0]))) {
      const t = c.argv.slice(1).find(a => !a.startsWith('-') || a === '-')
      const dest = t === undefined ? home : expandPwd(expandHome(t, home), cur)
      const next = path.resolve(cur, dest)
      // a folder that is not there yet (made by this very command) or a Git Bash style /c/... path on Windows
      if (t === '-' || /[$`%]/.test(dest) || !folderExists(next)) known = false
      else cur = next
    }
    return here
  })
}

function classify(cmd, {
  cwd = process.cwd(), sessionId = null, files = () => readSessionFiles(), isAlive = liveSession, run = git, platform = process.platform, mode = 'sh',
  home = os.homedir(), links = linksIn, removeRule = () => enabled('remove-session-dir'), stageRule = () => enabled('stage-all'), isDir = dirOf, folderExists = fs.existsSync,
} = {}) {
  const text = shell.prepare(String(cmd || ''), mode)
  const all = shell.commands(text, mode).filter(c => !c.remote)
  let live = null
  const liveOthers = () => live || (live = new Map([...files()].filter(([pid, f]) => f.cwd && f.sessionId !== sessionId && isAlive(pid, f, false))))

  const where = cwdsOf(all, text, cwd, home, folderExists)
  for (const [i, c] of all.entries()) {
    const removals = removedDirs(c, where[i].cwd, home, where[i].known)
    if (!removals.length) continue
    const seg = oneLine(c.argv.join(' '), 120)
    for (const r of removals) {
      if (r.how === 'git worktree remove' && r.force && platform === 'win32') {
        const found = links(r.dir)
        if (found.length) {
          return {
            rule: 'worktree-force-links',
            why: `[bulkhead] checkout-guard: \`${seg}\` force-removes a worktree that holds links (${found.map(f => path.relative(r.dir, f)).join(', ')}).\n` +
              'On Windows, git worktree remove --force can follow a junction and delete what it points to, such as the main checkout\'s node_modules.\n' +
              'Remove the links first (rmdir <link> removes a junction, not its target), check none are left, then run git worktree remove without --force.',
          }
        }
      }
      if (!sessionId || !removeRule()) continue
      const others = liveOthers()
      if (!others.size) continue
      const target = key(r.dir, platform)
      // a deletion of the folder a session works in, or of a folder above it
      const hit = [...others].find(([pid, f]) => inside(key(f.cwd, platform), target) && isAlive(pid, f, true))
      if (hit) {
        const [pid, f] = hit
        return {
          rule: 'remove-session-dir',
          why: `[bulkhead] checkout-guard: \`${seg}\` removes ${r.what ? r.what + ' ' : ''}${r.dir}, and another Claude session works in it (pid ${pid}, started ${when(f.startedAt)}, in ${f.cwd}).\n` +
            'Its files, its dev server and its next commit would disappear under it.\n' +
            'Leave this folder to that session. If it is really finished, wait until it exits (`bulkhead status` lists the live sessions), then remove it.',
        }
      }
    }
  }

  if (!sessionId) return null
  for (const [i, c] of all.entries()) {
    if (shell.bin(c.argv[0]) !== 'git') continue
    const call = gitCall(c.argv, where[i].cwd, c.depth === 0 ? gitEnv(text.slice(c.s, c.e)) : {})
    const seg = c.argv.join(' ')
    if (!call) continue
    let what = changesTree(call, fs.existsSync, isDir)
    if (!what && call.sub === 'add' && fedByChangedList(all, c, call, text, cwd)) what = 'stage-all'
    const staging = what === 'stage-all' || what === 'add-paths'
    if (!what || (staging && !stageRule())) continue
    if (!liveOthers().size) continue
    const gitRun = args => run([...call.opts, ...args], call.dir)
    let top
    try { top = treeOf(call, run) } catch { continue }
    const others = sharers(top, sessionId, { files: liveOthers(), isAlive, run, platform })
    if (!others.length) continue
    const o = others[0]
    const who = `another Claude session works in the same tree (pid ${o.pid}, started ${when(o.startedAt)}` +
      (others.length > 1 ? `, and ${others.length - 1} more` : '') + ')'
    if (what === 'add-paths') {
      // a pathspec such as /work/shop or .. can still be the whole tree
      const topKey = key(top, platform)
      const far = parseArgs(call.args).pos.filter(p => !excluding(p) && farPath(p))
      if (!far.some(p => key(path.resolve(call.dir, expandHome(p, home)), platform) === topKey)) continue
      what = 'stage-all'
    }
    if (what === 'restore-paths') {
      let status = ''
      try { status = gitRun(['status', '--porcelain']) } catch { continue }
      const specs = restoreSpecs(call, fs.existsSync)
      const lost = changedPaths(status).filter(f => specs.some(sp => covers(sp, f, call.dir, top, platform)))
      if (!lost.length) continue
      return {
        rule: `git-${call.sub}`,
        why: `[bulkhead] checkout-guard: \`${oneLine(seg, 120)}\` overwrites ${lost.length} file${lost.length === 1 ? '' : 's'} with uncommitted changes in ${top} (${lost.slice(0, 3).join(', ')}${lost.length > 3 ? ', ...' : ''}), ` +
          `and ${who}.\n` +
          'Some of those changes are probably its work, and they would be lost.\n' +
          'Restore the single files you changed, by name: git restore src/a.ts, or leave the folder alone.',
      }
    }
    if (what === 'unstages') {
      let out = ''
      try { out = gitRun(['diff', '--cached', '--name-only']) } catch { continue }
      const names = out.split('\n').filter(Boolean)
      if (!names.length) continue
      return {
        rule: 'git-reset',
        why: `[bulkhead] checkout-guard: \`${oneLine(seg, 120)}\` unstages ${names.length} file${names.length === 1 ? '' : 's'} in ${top} (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''}), ` +
          `and ${who}.\n` +
          'That staged work is probably its own, and it would have to stage it again.\n' +
          'Unstage only your files, by name: git reset -- src/a.ts (or git restore --staged src/a.ts).',
      }
    }
    if (what === 'stage-all') {
      let status = ''
      try { status = gitRun(['status', '--porcelain']) } catch { continue }
      const changed = status.split('\n').filter(Boolean)
      if (!changed.length) continue
      return {
        rule: 'stage-all',
        why: `[bulkhead] checkout-guard: \`${oneLine(seg, 120)}\` stages every change in ${top} (${changed.length} file${changed.length === 1 ? '' : 's'}), ` +
          `and ${who}.\n` +
          'Some of those changes are probably its half-finished work, and they would go into your commit.\n' +
          'Stage only the files you changed, by name: git add src/a.ts src/b.ts, or commit them directly with git commit -m "..." -- src/a.ts src/b.ts.',
      }
    }
    if (what === 'dirty-only') {
      let status = ''
      try { status = gitRun(['status', '--porcelain', '--untracked-files=no']) } catch { continue }
      if (!status) continue
      what = 'merges into a tree with uncommitted changes'
    }
    const name = path.basename(top)
    if (call.sub === 'pull') {
      return {
        rule: 'git-pull',
        why: `[bulkhead] checkout-guard: \`${oneLine(seg, 120)}\` ${what} in ${top}, and ${who}.\n` +
          'A pull rewrites the files that session has open, and a conflict would stop halfway through its edits.\n' +
          'Wait until it has committed or stashed its changes, or pull from a clone no other session is using.',
      }
    }
    return {
      rule: `git-${call.sub}`,
      why: `[bulkhead] checkout-guard: \`${oneLine(seg, 120)}\` ${what} in ${top}, and ${who}.\n` +
        'Its files and branch would change under it. Work in your own worktree instead:\n' +
        `  git worktree add ../${name}-<task> -b <branch>`,
    }
  }
  return null
}

function check(cmd, opts) {
  const hit = classify(cmd, opts)
  return hit ? hit.why : null
}

if (require.main === module) {
  runHook('checkout-guard', input => {
    const cmd = input.tool_input && input.tool_input.command
    if (!cmd) return
    const hit = classify(cmd, { cwd: input.cwd || process.cwd(), sessionId: input.session_id || null, mode: shell.modeFor(input) })
    if (!hit) return
    return blocked('checkout-guard', hit.rule, input, `${hit.why}\n${ASK_USER}`)
  })
}

// `git-checkout`, `git-stash` and so on: the first git command that moves the tree.
function ruleOf(cmd, cwd = '.', mode = 'sh') {
  for (const c of gitCommands(cmd, mode)) {
    const call = gitCall(c.argv, cwd)
    const what = call && changesTree(call)
    if (what) return what === 'stage-all' ? 'stage-all' : `git-${call.sub}`
  }
  return 'git'
}

module.exports = { check, classify, changesTree, gitCall, ruleOf, linksIn, liveSession }
