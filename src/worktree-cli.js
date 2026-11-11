'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { option, rejectArgs, table, shortPath } = require('./cli-util')
const { selectFiles, copyFiles, isDefaultName, REBUILDABLE, git } = require('./worktree-copy')
const { stablePort } = require('./stable-port')

const USAGE = `usage:
  bulkhead worktree add <name> [--base REF] [--path DIR] [--install|--no-install] [--json]
      a new worktree ../<repo>-<name> on a new branch <name>, with your .env files copied
      (.worktreeinclude, or a safe default set), dependencies installed and a stable PORT set
  bulkhead worktree list [--json]
      worktrees of this repo: branch, age, dirty, ahead/behind, live session, port
  bulkhead worktree prune [--merged-into REF] [--older-than 7d] [--yes] [--json]
      worktrees that are safe to remove (merged, clean, no live session); a dry run without --yes (or with --dry-run)`

// ---- small helpers -------------------------------------------------------------------------

function norm(p, platform = process.platform) {
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  if (platform === 'win32') s = s.toLowerCase()
  return s
}

function inside(dir, root, platform) {
  const d = norm(dir, platform)
  const r = norm(root, platform)
  return d === r || d.startsWith(r + '/')
}

function real(p) {
  try { return fs.realpathSync(p) } catch { return p }
}

function age(elapsed) {
  const s = Math.max(0, Math.round(elapsed))
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

function parseDuration(text) {
  const m = /^(\d+)([mhdw])$/.exec(String(text))
  return m ? Number(m[1]) * { m: 60, h: 3600, d: 86400, w: 604800 }[m[2]] * 1000 : null
}

// First arguments that are not options; valued options swallow the word after them.
function positionals(args, valued) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) { if (valued.includes(a.slice(2)) && !a.includes('=')) i++; continue }
    out.push(a)
  }
  return out
}

function parseWorktrees(text) {
  return text.split(/\r?\n\r?\n/).filter(b => b.trim()).map(block => {
    const w = { path: '', head: '', branch: null, detached: false, bare: false, locked: false, prunable: false }
    for (const line of block.split(/\r?\n/)) {
      const [key, ...rest] = line.split(' ')
      const val = rest.join(' ')
      if (key === 'worktree') w.path = val
      else if (key === 'HEAD') w.head = val
      else if (key === 'branch') w.branch = val.replace(/^refs\/heads\//, '')
      else if (key === 'detached') w.detached = true
      else if (key === 'bare') w.bare = true
      else if (key === 'locked') w.locked = true
      else if (key === 'prunable') w.prunable = true
    }
    return w
  })
}

function defaultRun(cmd, args, { cwd, platform = process.platform }) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: platform === 'win32', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status === null ? 1 : r.status, output: `${r.stdout || ''}${r.stderr || ''}` }
}

function defaultWhich(cmd, platform = process.platform, env = process.env) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const d of dirs) for (const e of exts) if (fs.existsSync(path.join(d, cmd + e.toLowerCase())) || fs.existsSync(path.join(d, cmd + e))) return true
  return false
}

// null when sessions cannot be read at all, so callers that delete things can refuse.
function defaultSessions() {
  try {
    const { readProcesses } = require('./processes')
    const { readSessionFiles, findSessions } = require('./sessions')
    return findSessions(readProcesses(), readSessionFiles()).map(s => ({ pid: s.pid, cwd: s.cwd }))
  } catch { return null }
}

function context(deps = {}) {
  const platform = deps.platform || process.platform
  return {
    cwd: deps.cwd || process.cwd(),
    stdout: deps.stdout || process.stdout,
    stderr: deps.stderr || process.stderr,
    platform,
    now: deps.now || Date.now(),
    git: deps.git || git,
    run: deps.run || ((cmd, args, o) => defaultRun(cmd, args, { ...o, platform })),
    which: deps.which || (cmd => defaultWhich(cmd, platform)),
    getSessions: deps.getSessions || defaultSessions,
    bind: deps.bind,
  }
}

function fail(c, msg) {
  c.stderr.write(`bulkhead worktree: ${msg}\n`)
  process.exitCode = 1
}

function repo(c) {
  const top = c.git(['rev-parse', '--show-toplevel'], c.cwd)
  if (top.status !== 0) return null
  const trees = parseWorktrees(c.git(['worktree', 'list', '--porcelain'], c.cwd).stdout)
  return { top: top.stdout.trim(), trees, main: trees[0] ? trees[0].path : top.stdout.trim() }
}

function refExists(c, cwd, ref) {
  return c.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).status === 0
}

function defaultBranch(c, mainDir) {
  const sym = c.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], mainDir)
  if (sym.status === 0 && refExists(c, mainDir, sym.stdout.trim())) return sym.stdout.trim()
  for (const b of ['main', 'master']) if (refExists(c, mainDir, b)) return b
  const cur = c.git(['symbolic-ref', '--short', 'HEAD'], mainDir)
  return cur.status === 0 ? cur.stdout.trim() : 'HEAD'
}

const PORT_LINE = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d+)/m

function readPort(dir) {
  try {
    const m = PORT_LINE.exec(fs.readFileSync(path.join(dir, '.env.local'), 'utf8'))
    return m ? Number(m[1]) : null
  } catch { return null }
}

// ---- install -------------------------------------------------------------------------------

// The installer for a folder: the packageManager field wins when its lockfile is there, then the
// lockfile that exists. null without a lockfile.
function detectInstaller(dir) {
  const has = f => fs.existsSync(path.join(dir, f))
  const berry = has('.yarnrc.yml')
  const table_ = {
    bun: { lock: ['bun.lock', 'bun.lockb'], args: ['install', '--frozen-lockfile'] },
    pnpm: { lock: ['pnpm-lock.yaml'], args: ['install', '--frozen-lockfile'] },
    yarn: { lock: ['yarn.lock'], args: berry ? ['install', '--immutable'] : ['install', '--frozen-lockfile'] },
    npm: { lock: ['package-lock.json', 'npm-shrinkwrap.json'], args: ['ci'] },
  }
  let declared = null
  try { declared = /^([a-z]+)@/.exec(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).packageManager || '') } catch {}
  const order = declared && table_[declared[1]] ? [declared[1], ...Object.keys(table_)] : Object.keys(table_)
  for (const pm of order) {
    const lock = table_[pm].lock.find(has)
    if (lock) return { pm, lock, args: table_[pm].args }
  }
  return null
}

function install(c, dir, want) {
  const found = detectInstaller(dir)
  if (want === false) return { ran: false, reason: 'skipped (--no-install)' }
  if (!found) return { ran: false, reason: 'no lockfile', failed: want === true }
  if (!c.which(found.pm)) return { ran: false, reason: `${found.pm} is not on PATH`, command: `${found.pm} ${found.args.join(' ')}`, failed: want === true }
  const command = `${found.pm} ${found.args.join(' ')}`
  const t = Date.now()
  const r = c.run(found.pm, found.args, { cwd: dir })
  const seconds = Math.round((Date.now() - t) / 100) / 10
  const tail = String(r.output || '').trim().split('\n').slice(-12).join('\n')
  if (r.status !== 0) return { ran: true, command, ok: false, seconds, reason: `exit ${r.status}`, tail, failed: true }
  return { ran: true, command, ok: true, seconds }
}

// ---- add -----------------------------------------------------------------------------------

async function add(args, c) {
  const spec = { flags: ['json', 'install', 'no-install'], valued: ['base', 'path'] }
  const [name] = positionals(args, spec.valued)
  if (!name) return fail(c, 'add needs a name, like: bulkhead worktree add fix-login')
  if (rejectArgs('worktree add', args.filter((a, i) => i !== args.indexOf(name)), spec, c.stderr, USAGE)) return
  if (args.includes('--install') && args.includes('--no-install')) return fail(c, '--install and --no-install cannot be used together')
  if (name.startsWith('-') || c.git(['check-ref-format', '--branch', name], c.cwd).status !== 0) return fail(c, `${name} is not a usable branch name`)
  const info = repo(c)
  if (!info) return fail(c, 'not inside a git repository')
  const base = option(args, 'base')
  const explicit = option(args, 'path')
  if (base === true || explicit === true) return fail(c, `--${base === true ? 'base' : 'path'} needs a value`)
  const dest = explicit ? path.resolve(c.cwd, explicit) : path.join(path.dirname(info.main), `${path.basename(info.main)}-${name.replace(/[\\/]/g, '-')}`)
  if (fs.existsSync(dest)) return fail(c, `${dest} already exists; pick another name or --path (nothing was changed)`)
  if (refExists(c, c.cwd, `refs/heads/${name}`)) return fail(c, `branch ${name} already exists; pick another name (nothing was changed)`)
  const created = c.git(['worktree', 'add', '-b', name, dest, base || 'HEAD'], c.cwd)
  if (created.status !== 0) return fail(c, `git worktree add failed: ${(created.stderr || created.stdout).trim()}`)

  const sel = selectFiles(info.top, c.git)
  const copied = copyFiles(info.top, dest, sel.files)

  const wantInstall = args.includes('--install') ? true : args.includes('--no-install') ? false : undefined
  const inst = install(c, dest, wantInstall)

  let port = readPort(dest)
  let wrote = false
  if (port === null) {
    port = await stablePort(dest, undefined, { bind: c.bind, platform: c.platform })
    if (port !== null) {
      const file = path.join(dest, '.env.local')
      let body = ''
      try { body = fs.readFileSync(file, 'utf8') } catch {}
      fs.writeFileSync(file, `${body}${body && !body.endsWith('\n') ? '\n' : ''}PORT=${port}\n`)
      wrote = true
    }
  }
  const next = `cd ${dest.includes(' ') ? `"${dest}"` : dest} && claude`
  const result = { path: dest, branch: name, base: base || 'HEAD', copied, skipped: sel.skipped, copySource: sel.source, install: inst, port, portWritten: wrote, next }
  if (inst.failed) process.exitCode = 1
  if (args.includes('--json')) return c.stdout.write(JSON.stringify(result) + '\n')

  const out = [`created ${shortPath(dest)} on new branch ${name} from ${base || 'HEAD'}`]
  out.push(copied.length ? `copied ${copied.join(', ')} (${sel.source === 'default' ? 'default set' : '.worktreeinclude'})` : `copied nothing (${sel.source === 'default' ? 'no .env files found' : 'no .worktreeinclude match'})`)
  for (const s of sel.skipped) out.push(`left out ${s.path}: ${s.why}`)
  if (inst.ran) out.push(inst.ok ? `${inst.command}: done in ${inst.seconds}s` : `${inst.command}: failed (${inst.reason})\n${inst.tail}`)
  else out.push(`install: ${inst.reason}`)
  if (port === null) out.push('port: none free in 3000-3999, PORT not set')
  else out.push(wrote ? `wrote PORT=${port} to .env.local` : `kept PORT=${port} already in .env.local`)
  out.push(`next: ${next}`)
  c.stdout.write(out.join('\n') + '\n')
}

// ---- inspecting worktrees ------------------------------------------------------------------

// pids of live sessions per worktree path; a session belongs to the deepest worktree around its cwd.
function sessionMap(sessions, trees, platform) {
  const map = new Map(trees.map(t => [t.path, []]))
  for (const s of sessions || []) {
    if (!s.cwd) continue
    let best = null
    for (const t of trees) {
      if ((inside(s.cwd, t.path, platform) || inside(real(s.cwd), real(t.path), platform)) && (!best || norm(t.path, platform).length > norm(best.path, platform).length)) best = t
    }
    if (best) map.get(best.path).push(s.pid)
  }
  return map
}

function lastActivity(c, t) {
  const r = c.git(['log', '-1', '--format=%ct', t.branch || t.head || 'HEAD'], t.path)
  let sec = r.status === 0 ? Number(r.stdout.trim()) || 0 : 0
  try {
    const st = fs.statSync(t.path)
    sec = Math.max(sec, st.mtimeMs / 1000, st.birthtimeMs / 1000)
  } catch {}
  return sec
}

function inspect(c, info, base, sessions) {
  const map = sessionMap(sessions, info.trees, c.platform)
  return info.trees.map((t, i) => {
    const present = fs.existsSync(t.path)
    const row = { path: t.path, branch: t.branch, main: i === 0, detached: t.detached, locked: t.locked, missing: t.prunable || !present, ahead: null, behind: null, dirty: null, ageSeconds: null, sessions: map.get(t.path), port: present ? readPort(t.path) : null }
    if (!present) return row
    // the .env copies and the PORT line `worktree add` wrote are not the user's changes
    const st = c.git(['status', '--porcelain'], t.path)
    row.dirty = st.status === 0 ? st.stdout.split('\n').filter(l => l && !(l.startsWith('?? ') && isDefaultName(l.slice(3)))).length > 0 : null
    const lr = c.git(['rev-list', '--left-right', '--count', `${base}...HEAD`], t.path)
    if (lr.status === 0) [row.behind, row.ahead] = lr.stdout.trim().split(/\s+/).map(Number)
    const ct = c.git(['log', '-1', '--format=%ct'], t.path)
    row.ageSeconds = ct.status === 0 ? Math.round(c.now / 1000 - Number(ct.stdout.trim())) : null
    return row
  })
}

function list(args, c) {
  if (rejectArgs('worktree list', args, { flags: ['json'], valued: [] }, c.stderr, USAGE)) return
  const info = repo(c)
  if (!info) return fail(c, 'not inside a git repository')
  const base = defaultBranch(c, info.main)
  const sessions = c.getSessions()
  const rows = inspect(c, info, base, sessions)
  if (args.includes('--json')) return c.stdout.write(JSON.stringify({ base, sessionsKnown: sessions !== null, worktrees: rows }) + '\n')
  const cells = [['PATH', 'BRANCH', 'AGE', 'STATE', `VS ${base}`, 'SESSION', 'PORT']]
  for (const r of rows) {
    cells.push([
      shortPath(r.path),
      (r.branch || (r.detached ? '(detached)' : '?')) + (r.main ? ' (main)' : ''),
      r.ageSeconds === null ? '-' : age(r.ageSeconds),
      r.missing ? 'missing' : r.dirty === null ? '?' : r.dirty ? 'dirty' : 'clean',
      r.ahead === null ? '-' : `+${r.ahead}/-${r.behind}`,
      sessions === null ? '?' : r.sessions.length ? r.sessions.map(p => `pid ${p}`).join(', ') : '-',
      r.port === null ? '-' : String(r.port),
    ])
  }
  c.stdout.write(table(cells).join('\n') + '\n')
}

// ---- prune ---------------------------------------------------------------------------------

// Entries of git status that would be lost when the worktree goes. Tracked changes, untracked
// files that are not env copies, and ignored files that are not rebuildable all count.
function lostWork(c, t, mainDir, includeSet) {
  const st = c.git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], t.path)
  if (st.status !== 0) return { why: 'git status failed', disposable: [] }
  const parts = st.stdout.split('\0').filter(Boolean)
  const disposable = []
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2)
    const rel = parts[i].slice(3)
    if (code[0] === 'R' || code[0] === 'C') i++
    if (code !== '??' && code !== '!!') return { why: 'uncommitted changes', disposable }
    const segs = rel.replace(/\/$/, '').split('/')
    const envCopy = !rel.endsWith('/') && ((segs.length === 1 && isDefaultName(segs[0])) || includeSet.has(rel))
    if (code === '!!') {
      if (envCopy || segs.some(s => REBUILDABLE.has(s)) || /\.log$/.test(rel)) continue
      return { why: `ignored file ${rel} would be lost`, disposable }
    }
    if (!envCopy) return { why: `untracked ${rel}`, disposable }
    disposable.push(rel)
  }
  // an untracked env copy may be deleted only when it is a plain copy of the main checkout's file
  // or the PORT line this tool wrote; anything else is the user's own content
  for (const rel of disposable) {
    let mine
    try { mine = fs.readFileSync(path.join(t.path, rel), 'utf8') } catch { continue }
    let theirs = null
    try { theirs = fs.readFileSync(path.join(mainDir, rel), 'utf8') } catch {}
    const portOnly = rel === '.env.local' && /^\s*PORT=\d+\s*$/.test(mine)
    if (mine !== theirs && !portOnly) return { why: `untracked ${rel} differs from the main checkout`, disposable }
  }
  return { why: null, disposable }
}

// A branch merged with --squash or rebased is not an ancestor of ref, but merging it into ref
// changes nothing: the merge result has ref's own tree. Needs git 2.38+ (merge-tree --write-tree);
// older git answers no and the branch is kept.
// Merged without being an ancestor: squash-merged (merging it would change nothing), or every
// commit already applied on ref by cherry-pick or rebase (git cherry marks each one with "-").
function squashMerged(c, dir, branch, ref) {
  const m = c.git(['merge-tree', '--write-tree', ref, branch], dir)
  const t = c.git(['rev-parse', `${ref}^{tree}`], dir)
  if (m.status === 0 && t.status === 0 && m.stdout.trim().split('\n')[0] === t.stdout.trim()) return true
  const ch = c.git(['cherry', ref, branch], dir)
  const lines = ch.status === 0 ? ch.stdout.split('\n').filter(Boolean) : []
  return lines.length > 0 && lines.every(l => l.startsWith('-'))
}

function judge(c, t, ctx) {
  const { info, ref, olderThan, sessions } = ctx
  if (t.path === info.main) return 'main worktree'
  if (t.bare) return 'bare'
  if (t.locked) return 'locked'
  if (t.prunable || !fs.existsSync(t.path)) return 'folder is missing (git worktree prune clears it)'
  if (!t.branch) return 'detached HEAD'
  if (sessions === null) return 'live sessions could not be read'
  if (sessionMap(sessions, [t], c.platform).get(t.path).length) return 'a live session works in it'
  if (inside(c.cwd, t.path, c.platform) || inside(real(c.cwd), real(t.path), c.platform)) return 'you are inside it'
  const merged = c.git(['merge-base', '--is-ancestor', t.branch, ref], info.main).status === 0
  if (!merged) {
    if (!squashMerged(c, info.main, t.branch, ref)) return `not merged into ${ref}`
    ctx.squashed.add(t.branch)
  }
  // a branch nobody has committed to is "merged" into anything ahead of it; its reflog has the creation entry only
  const untouched = c.git(['reflog', 'show', '--format=%H', `refs/heads/${t.branch}`], info.main).stdout.split('\n').filter(Boolean).length <= 1
  const idle = c.now / 1000 - lastActivity(c, t)
  if (untouched && olderThan === null) return 'no commits of its own yet (new?); add --older-than to include it'
  if (olderThan !== null && idle * 1000 < olderThan) return `touched ${age(idle)} ago`
  const inc = fs.existsSync(path.join(info.main, '.worktreeinclude'))
    ? c.git(['ls-files', '-z', '-o', '-i', `--exclude-from=${path.join(info.main, '.worktreeinclude')}`], t.path).stdout.split('\0').filter(Boolean)
    : []
  const lost = lostWork(c, t, info.main, new Set(inc))
  ctx.disposable.set(t.path, lost.disposable)
  return lost.why
}

function prune(args, c) {
  // --dry-run is accepted because it is what prune does without --yes
  const spec = { flags: ['yes', 'json', 'dry-run'], valued: ['merged-into', 'older-than'] }
  if (rejectArgs('worktree prune', args, spec, c.stderr, USAGE)) return
  const info = repo(c)
  if (!info) return fail(c, 'not inside a git repository')
  const refArg = option(args, 'merged-into')
  const ref = refArg && refArg !== true ? refArg : defaultBranch(c, info.main)
  if (!refExists(c, info.main, ref)) return fail(c, `${ref} is not a branch or commit here`)
  const ageArg = option(args, 'older-than')
  const olderThan = ageArg === undefined ? null : parseDuration(ageArg)
  if (ageArg !== undefined && olderThan === null) return fail(c, `--older-than needs a number and m, h, d or w, like 7d (got ${ageArg})`)
  const ctx = { info, ref, olderThan, sessions: c.getSessions(), disposable: new Map(), squashed: new Set() }
  const keep = []
  const safe = []
  for (const t of info.trees) {
    const why = judge(c, t, ctx)
    if (why === 'main worktree') continue
    ;(why ? keep : safe).push({ path: t.path, branch: t.branch, why, squashed: ctx.squashed.has(t.branch) })
  }
  const removed = []
  const failed = []
  if (args.includes('--yes')) {
    for (const s of safe) {
      const err = removeOne(c, info, ctx, s)
      if (err) failed.push({ ...s, error: err })
      else removed.push(s)
    }
  }
  if (failed.length) process.exitCode = 1
  if (args.includes('--json')) return c.stdout.write(JSON.stringify({ ref, dryRun: !args.includes('--yes'), safe: safe.map(s => ({ path: s.path, branch: s.branch, squashed: s.squashed })), kept: keep, removed: removed.map(s => ({ path: s.path, branch: s.branch })), failed }) + '\n')
  const out = []
  const verb = args.includes('--yes') ? 'removed' : 'would remove'
  const done = args.includes('--yes') ? removed : safe
  for (const s of done) out.push(`${verb} ${shortPath(s.path)} (${s.branch}${s.squashed ? ', squash-merged' : ''})`)
  for (const f of failed) out.push(`could not remove ${shortPath(f.path)}: ${f.error}`)
  for (const k of keep) out.push(`keep ${shortPath(k.path)} (${k.branch || 'detached'}): ${k.why}`)
  if (!out.length) out.push('no other worktrees')
  if (!args.includes('--yes') && safe.length) out.push(`dry run: run again with --yes to remove ${safe.length === 1 ? 'it' : 'them'} (merged branches are deleted with git branch -d, squash-merged ones with -D)`)
  c.stdout.write(out.join('\n') + '\n')
}

// Re-reads the sessions right before deleting: one may have started in the folder since the plan
// was made. Never forces; git itself refuses a worktree with changes.
function removeOne(c, info, ctx, s) {
  const sessions = c.getSessions()
  if (sessions === null) return 'live sessions could not be read'
  if (sessionMap(sessions, [{ path: s.path }], c.platform).get(s.path).length) return 'a live session started working in it'
  for (const rel of ctx.disposable.get(s.path) || []) {
    try { fs.rmSync(path.join(s.path, rel), { force: true }) } catch {}
  }
  const r = c.git(['worktree', 'remove', s.path], info.main)
  if (r.status !== 0) return (r.stderr || r.stdout).trim().split('\n')[0]
  // -d refuses a squash-merged branch; its changes are in ref already (squashMerged checked the tree)
  const b = c.git(['branch', s.squashed ? '-D' : '-d', s.branch], info.main)
  if (b.status !== 0) return `worktree removed, branch ${s.branch} kept: ${(b.stderr || b.stdout).trim().split('\n')[0]}`
  return null
}

// ---- entry ---------------------------------------------------------------------------------

async function main(args, deps) {
  const c = context(deps)
  const [sub, ...rest] = args
  if (!sub || sub === '--help' || sub === '-h' || rest.includes('--help') || rest.includes('-h')) {
    c.stdout.write(USAGE + '\n')
    if (sub && !['--help', '-h'].includes(sub) && !['add', 'list', 'prune'].includes(sub)) process.exitCode = 1
    return
  }
  if (sub === 'add') return add(rest, c)
  if (sub === 'list') return list(rest, c)
  if (sub === 'prune') return prune(rest, c)
  c.stderr.write(`bulkhead worktree: unknown command ${sub}\n${USAGE}\n`)
  process.exitCode = 1
}

module.exports = { main, parseWorktrees, detectInstaller, norm, inside, parseDuration, sessionMap, USAGE }
