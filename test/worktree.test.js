'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { tempDir } = require('./helpers')
const { main, parseWorktrees, detectInstaller, norm, inside, parseDuration } = require('../src/worktree-cli')
const { stablePort, startOffset } = require('../src/stable-port')

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV })
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// <tmp>/shop is the main checkout, one commit on branch main.
function makeRepo(files = {}) {
  const base = fs.realpathSync(tempDir())
  const root = path.join(base, 'shop')
  fs.mkdirSync(root)
  sh(root, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(root, '.gitignore'), '.env\n.env.*\n!.env.example\nnode_modules\nsecrets/\n*.log\n')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), body)
  }
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'init')
  return { base, root }
}

function stream() {
  let text = ''
  return { write: s => { text += s }, get text() { return text } }
}

async function run(args, deps = {}) {
  const stdout = stream()
  const stderr = stream()
  process.exitCode = 0
  const saved = { ...process.env }
  Object.assign(process.env, ENV)
  try {
    await main(args, { stdout, stderr, getSessions: () => [], bind: async () => true, run: () => ({ status: 0, output: '' }), which: () => true, ...deps })
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  }
  const code = process.exitCode
  process.exitCode = 0
  return { out: stdout.text, err: stderr.text, code }
}

// a branch with one commit, merged into main
function mergedBranch(root, name, { merge = true } = {}) {
  sh(root, 'worktree', 'add', '-q', '-b', name, path.join(path.dirname(root), `shop-${name}`))
  const wt = path.join(path.dirname(root), `shop-${name}`)
  fs.writeFileSync(path.join(wt, `${name}.txt`), name)
  sh(wt, 'add', '-A')
  sh(wt, 'commit', '-q', '-m', name)
  if (merge) sh(root, 'merge', '-q', '--no-edit', name)
  return wt
}

// ---- stable port --------------------------------------------------------------------------

test('stablePort: same root gives the same port, probing forward past taken ones', async () => {
  const bind = async () => true
  const a = await stablePort('/x/shop-a', { min: 4000, max: 4099 }, { bind })
  assert.strictEqual(a, await stablePort('/x/shop-a', { min: 4000, max: 4099 }, { bind }))
  assert.ok(a >= 4000 && a <= 4099)
  assert.strictEqual(a, 4000 + startOffset('/x/shop-a', 100))
  const taken = new Set([a])
  const b = await stablePort('/x/shop-a', { min: 4000, max: 4099 }, { bind: async (h, p) => !taken.has(p) })
  assert.strictEqual(b, a + 1 > 4099 ? 4000 : a + 1)
  assert.strictEqual(await stablePort('/x/shop-a', { min: 4000, max: 4003 }, { bind: async () => false }), null)
})

test('stablePort: Windows paths ignore case, others do not', () => {
  assert.strictEqual(startOffset('C:\\Dev\\Shop', 1000, 'win32'), startOffset('c:\\dev\\shop', 1000, 'win32'))
  assert.notStrictEqual(startOffset('/a/Shop', 1 << 20, 'linux'), startOffset('/a/shop', 1 << 20, 'linux'))
})

// ---- helpers ------------------------------------------------------------------------------

test('path helpers handle Windows separators and case through the platform argument', () => {
  assert.strictEqual(norm('C:\\Dev\\Shop\\', 'win32'), 'c:/dev/shop')
  assert.strictEqual(norm('/Dev/Shop/', 'linux'), '/Dev/Shop')
  assert.ok(inside('C:\\dev\\shop-x\\src', 'C:/Dev/shop-x', 'win32'))
  assert.ok(!inside('C:\\dev\\shop-xy', 'C:/Dev/shop-x', 'win32'))
  assert.ok(!inside('/Dev/shop', '/dev/shop', 'linux'))
  assert.strictEqual(parseDuration('7d'), 7 * 86400000)
  assert.strictEqual(parseDuration('12h'), 12 * 3600000)
  assert.strictEqual(parseDuration('soon'), null)
})

test('parseWorktrees reads porcelain output', () => {
  const t = parseWorktrees('worktree /a/shop\nHEAD abc\nbranch refs/heads/main\n\nworktree /a/shop-x\nHEAD def\ndetached\nlocked\n\nworktree /a/gone\nHEAD 1\nbranch refs/heads/g\nprunable gitdir file points to non-existent location\n')
  assert.deepStrictEqual(t.map(w => [w.path, w.branch, w.detached, w.locked, w.prunable]), [['/a/shop', 'main', false, false, false], ['/a/shop-x', null, true, true, false], ['/a/gone', 'g', false, false, true]])
})

test('installer is chosen per lockfile, packageManager first', () => {
  const pick = files => {
    const dir = tempDir()
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b)
    const f = detectInstaller(dir)
    return f && `${f.pm} ${f.args.join(' ')}`
  }
  assert.strictEqual(pick({ 'package-lock.json': '{}' }), 'npm ci')
  assert.strictEqual(pick({ 'npm-shrinkwrap.json': '{}' }), 'npm ci')
  assert.strictEqual(pick({ 'pnpm-lock.yaml': '' }), 'pnpm install --frozen-lockfile')
  assert.strictEqual(pick({ 'yarn.lock': '' }), 'yarn install --frozen-lockfile')
  assert.strictEqual(pick({ 'yarn.lock': '', '.yarnrc.yml': '' }), 'yarn install --immutable')
  assert.strictEqual(pick({ 'bun.lockb': '' }), 'bun install --frozen-lockfile')
  assert.strictEqual(pick({ 'bun.lock': '' }), 'bun install --frozen-lockfile')
  assert.strictEqual(pick({ 'package-lock.json': '{}', 'pnpm-lock.yaml': '', 'package.json': '{"packageManager":"pnpm@9.1.0"}' }), 'pnpm install --frozen-lockfile')
  assert.strictEqual(pick({ 'package-lock.json': '{}', 'pnpm-lock.yaml': '', 'package.json': '{"packageManager":"npm@10"}' }), 'npm ci')
  assert.strictEqual(pick({ 'package.json': '{}' }), null)
})

// ---- add ----------------------------------------------------------------------------------

test('add: default set copies env files, never templates, node_modules or big files', async () => {
  const { root, base } = makeRepo({ '.env.example': 'K=\n' })
  for (const [n, b] of Object.entries({ '.env': 'A=1\n', '.env.production': 'B=2\n', '.envrc': 'use node\n', '.nvmrc': '20\n', '.tool-versions': 'node 20\n', 'other.txt': 'x' })) fs.writeFileSync(path.join(root, n), b)
  fs.writeFileSync(path.join(root, '.env.big'), Buffer.alloc(5 * 1024 * 1024 + 1))
  fs.mkdirSync(path.join(root, 'node_modules/p'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules/p/.env'), 'no')
  const r = await run(['add', 'fix-login'], { cwd: root })
  assert.strictEqual(r.code, 0, r.err)
  const wt = path.join(base, 'shop-fix-login')
  assert.deepStrictEqual(fs.readdirSync(wt).filter(n => n.startsWith('.env') || n.startsWith('.')).sort(), ['.env', '.env.example', '.env.local', '.env.production', '.envrc', '.git', '.gitignore', '.nvmrc', '.tool-versions'])
  assert.ok(!fs.existsSync(path.join(wt, 'node_modules')))
  assert.ok(!fs.existsSync(path.join(wt, 'other.txt')))
  assert.match(r.out, /left out \.env\.big: over 5 MB/)
  assert.match(r.out, new RegExp(`next: cd ${wt.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')} && claude`))
  assert.strictEqual(sh(wt, 'branch', '--show-current'), 'fix-login')
})

test('add: .worktreeinclude copies only ignored files that match, with gitignore syntax', async () => {
  const { root, base } = makeRepo({ '.worktreeinclude': '# secrets\n.env\nsecrets/**\n!secrets/skip.txt\nrun.log\na.txt\n' })
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n')
  fs.writeFileSync(path.join(root, '.nvmrc'), '20\n')
  fs.mkdirSync(path.join(root, 'secrets'))
  fs.writeFileSync(path.join(root, 'secrets/k.json'), '{}')
  fs.writeFileSync(path.join(root, 'secrets/skip.txt'), 'x')
  fs.writeFileSync(path.join(root, 'run.log'), 'log')
  const r = await run(['add', 'inc', '--json'], { cwd: root })
  const j = JSON.parse(r.out)
  assert.strictEqual(j.copySource, '.worktreeinclude')
  assert.deepStrictEqual(j.copied.sort(), ['.env', 'run.log', 'secrets/k.json'])
  const wt = path.join(base, 'shop-inc')
  assert.ok(!fs.existsSync(path.join(wt, '.nvmrc')), 'default set is not used when the include file exists')
  assert.ok(!fs.existsSync(path.join(wt, 'secrets/skip.txt')))
  assert.strictEqual(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8'), 'a\n', 'tracked file untouched')
})

test('add: refuses an existing path or branch and changes nothing', async () => {
  const { root, base } = makeRepo()
  fs.mkdirSync(path.join(base, 'shop-x'))
  let r = await run(['add', 'x'], { cwd: root })
  assert.strictEqual(r.code, 1)
  assert.match(r.err, /already exists/)
  assert.strictEqual(sh(root, 'branch', '--list', 'x'), '')
  sh(root, 'branch', 'y')
  r = await run(['add', 'y'], { cwd: root })
  assert.match(r.err, /branch y already exists/)
  assert.ok(!fs.existsSync(path.join(base, 'shop-y')))
  r = await run(['add', 'z', '--path', path.join(base, 'shop-x')], { cwd: root })
  assert.match(r.err, /already exists/)
  r = await run(['add', 'bad name'], { cwd: root })
  assert.match(r.err, /not a usable branch name/)
  r = await run(['add'], { cwd: root })
  assert.strictEqual(r.code, 1)
  r = await run(['add', 'q'], { cwd: base })
  assert.match(r.err, /not inside a git repository/)
})

test('add: --base and --path, and a nested branch name makes a flat folder', async () => {
  const { root, base } = makeRepo()
  sh(root, 'branch', 'release')
  fs.writeFileSync(path.join(root, 'later.txt'), 'l')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'later')
  const dest = path.join(base, 'elsewhere')
  const r = await run(['add', 'hot', '--base', 'release', '--path', dest, '--json'], { cwd: root })
  assert.strictEqual(r.code, 0, r.err)
  assert.ok(fs.existsSync(path.join(dest, 'a.txt')) && !fs.existsSync(path.join(dest, 'later.txt')))
  const r2 = await run(['add', 'feat/x', '--json'], { cwd: root })
  assert.strictEqual(JSON.parse(r2.out).path, path.join(base, 'shop-feat-x'))
  const r3 = await run(['add', 'w', '--base', 'nope'], { cwd: root })
  assert.strictEqual(r3.code, 1)
  assert.match(r3.err, /git worktree add failed/)
})

test('add from inside a linked worktree names the folder after the main checkout', async () => {
  const { root, base } = makeRepo()
  const first = await run(['add', 'one', '--json'], { cwd: root })
  const r = await run(['add', 'two', '--json'], { cwd: JSON.parse(first.out).path })
  assert.strictEqual(JSON.parse(r.out).path, path.join(base, 'shop-two'))
})

test('add: PORT is written to .env.local only when it has none', async () => {
  const { root, base } = makeRepo()
  let r = await run(['add', 'p1', '--json'], { cwd: root, bind: async () => true })
  let j = JSON.parse(r.out)
  assert.strictEqual(j.portWritten, true)
  assert.strictEqual(fs.readFileSync(path.join(j.path, '.env.local'), 'utf8'), `PORT=${j.port}\n`)
  assert.strictEqual(j.port, await stablePort(j.path, undefined, { bind: async () => true }))

  // .env.local copied from the main checkout with a PORT is kept
  fs.writeFileSync(path.join(root, '.env.local'), 'PORT=4321\nX=1\n')
  r = await run(['add', 'p2', '--json'], { cwd: root })
  j = JSON.parse(r.out)
  assert.strictEqual(j.port, 4321)
  assert.strictEqual(j.portWritten, false)
  assert.strictEqual(fs.readFileSync(path.join(j.path, '.env.local'), 'utf8'), 'PORT=4321\nX=1\n')

  // a copied .env.local without PORT gets the line appended, even without a trailing newline
  fs.writeFileSync(path.join(root, '.env.local'), 'X=1')
  r = await run(['add', 'p3', '--json'], { cwd: root })
  j = JSON.parse(r.out)
  assert.strictEqual(fs.readFileSync(path.join(j.path, '.env.local'), 'utf8'), `X=1\nPORT=${j.port}\n`)
  assert.ok(fs.existsSync(path.join(base, 'shop-p3')))
  r = await run(['add', 'p4'], { cwd: root })
  assert.match(r.out, /wrote PORT=\d+ to \.env\.local/)
})

test('add: probes past a taken port', async () => {
  const { root } = makeRepo()
  const free = await run(['add', 'a1', '--json'], { cwd: root })
  const want = JSON.parse(free.out).port
  const r = await run(['add', 'a2', '--json'], { cwd: root, bind: async (h, p) => p !== want })
  assert.ok(JSON.parse(r.out).port >= 3000)
})

test('add: installs with the lockfile\'s installer, through the injected runner', async () => {
  const { root } = makeRepo({ 'pnpm-lock.yaml': '', 'package.json': '{}' })
  const calls = []
  const runner = (cmd, args, o) => { calls.push([cmd, args.join(' '), o.cwd]); return { status: 0, output: 'ok\n' } }
  let r = await run(['add', 'i1', '--json'], { cwd: root, run: runner })
  assert.deepStrictEqual(calls.map(c => c.slice(0, 2)), [['pnpm', 'install --frozen-lockfile']])
  assert.strictEqual(calls[0][2], JSON.parse(r.out).path)
  assert.strictEqual(JSON.parse(r.out).install.ok, true)

  calls.length = 0
  r = await run(['add', 'i2', '--no-install'], { cwd: root, run: runner })
  assert.strictEqual(calls.length, 0)
  assert.match(r.out, /install: skipped/)

  r = await run(['add', 'i3'], { cwd: root, run: runner, which: cmd => cmd !== 'pnpm' })
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(r.code, 0, 'an automatic install that cannot run is not an error')
  assert.match(r.out, /pnpm is not on PATH/)
  r = await run(['add', 'i4', '--install'], { cwd: root, run: runner, which: cmd => cmd !== 'pnpm' })
  assert.strictEqual(r.code, 1)

  r = await run(['add', 'i5'], { cwd: root, run: () => ({ status: 1, output: 'boom\nERR!' }) })
  assert.strictEqual(r.code, 1)
  assert.match(r.out, /failed \(exit 1\)\nboom\nERR!/)
})

test('add: no lockfile means no install; --install without one is an error; npm ci for package-lock', async () => {
  const { root } = makeRepo()
  const calls = []
  const runner = (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { status: 0, output: '' } }
  let r = await run(['add', 'n1'], { cwd: root, run: runner })
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(r.code, 0)
  r = await run(['add', 'n2', '--install'], { cwd: root, run: runner })
  assert.strictEqual(r.code, 1)
  const b = makeRepo({ 'package-lock.json': '{}', 'package.json': '{}' })
  await run(['add', 'n3'], { cwd: b.root, run: runner })
  assert.deepStrictEqual(calls, ['npm ci'])
  r = await run(['add', 'n4', '--install', '--no-install'], { cwd: b.root, run: runner })
  assert.strictEqual(r.code, 1)
})

test('add never links node_modules', async () => {
  const { root } = makeRepo({ 'package.json': '{}' })
  fs.mkdirSync(path.join(root, 'node_modules'))
  const r = await run(['add', 'nl', '--json'], { cwd: root })
  assert.ok(!fs.existsSync(path.join(JSON.parse(r.out).path, 'node_modules')))
})

// ---- list ---------------------------------------------------------------------------------

test('list: branch, age, state, ahead/behind, session and port', async () => {
  const { root } = makeRepo()
  const wtA = JSON.parse((await run(['add', 'ahead', '--json'], { cwd: root })).out).path
  fs.writeFileSync(path.join(wtA, 'n.txt'), 'n')
  sh(wtA, 'add', '-A')
  sh(wtA, 'commit', '-q', '-m', 'n')
  fs.writeFileSync(path.join(root, 'm.txt'), 'm')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'm')
  fs.writeFileSync(path.join(wtA, 'dirty.txt'), 'd')
  const sessions = [{ pid: 4242, cwd: path.join(wtA, 'src') }, { pid: 7, cwd: root }]
  const r = await run(['list', '--json'], { cwd: root, getSessions: () => sessions })
  const j = JSON.parse(r.out)
  assert.strictEqual(j.base, 'main')
  const first = j.worktrees[0]
  const a = j.worktrees[1]
  assert.strictEqual(first.main, true)
  assert.deepStrictEqual(first.sessions, [7])
  assert.strictEqual(a.branch, 'ahead')
  assert.strictEqual(a.dirty, true)
  assert.deepStrictEqual([a.ahead, a.behind], [1, 1])
  assert.deepStrictEqual(a.sessions, [4242])
  assert.ok(a.port >= 3000)
  const t = await run(['list'], { cwd: root, getSessions: () => sessions })
  assert.match(t.out, /^PATH +BRANCH +AGE +STATE +VS main +SESSION +PORT/m)
  assert.match(t.out, /ahead +\d+m +dirty +\+1\/-1 +pid 4242 +\d+/)
  assert.match(t.out, /main \(main\)/)
  const unknown = await run(['list'], { cwd: root, getSessions: () => null })
  assert.match(unknown.out, /\?/)
})

test('list: a session in a nested worktree does not count for the outer one', () => {
  const { sessionMap } = require('../src/worktree-cli')
  const trees = [{ path: '/w/shop' }, { path: '/w/shop/.claude/worktrees/x' }]
  const m = sessionMap([{ pid: 1, cwd: '/w/shop/.claude/worktrees/x/src' }, { pid: 2, cwd: '/w/shop/web' }, { pid: 3, cwd: null }], trees, 'linux')
  assert.deepStrictEqual(m.get('/w/shop'), [2])
  assert.deepStrictEqual(m.get('/w/shop/.claude/worktrees/x'), [1])
  const w = sessionMap([{ pid: 1, cwd: 'C:\\Dev\\Shop-x\\src' }], [{ path: 'c:/dev/shop-x' }], 'win32')
  assert.deepStrictEqual(w.get('c:/dev/shop-x'), [1])
})

// ---- prune --------------------------------------------------------------------------------

test('prune safety matrix: dry run lists only merged, clean, idle, non-main worktrees', async () => {
  const { root } = makeRepo()
  const ok = mergedBranch(root, 'done')
  const unmerged = mergedBranch(root, 'wip', { merge: false })
  const dirty = mergedBranch(root, 'dirty')
  fs.writeFileSync(path.join(dirty, 'a.txt'), 'changed')
  const untracked = mergedBranch(root, 'untr')
  fs.writeFileSync(path.join(untracked, 'notes.md'), 'hi')
  const ignored = mergedBranch(root, 'ign')
  fs.mkdirSync(path.join(ignored, 'secrets'))
  fs.writeFileSync(path.join(ignored, 'secrets/k'), 'k')
  const live = mergedBranch(root, 'live')
  const fresh = path.join(path.dirname(root), 'shop-fresh')
  sh(root, 'worktree', 'add', '-q', '-b', 'fresh', fresh)
  const modules = mergedBranch(root, 'mods')
  fs.mkdirSync(path.join(modules, 'node_modules/x'), { recursive: true })
  fs.writeFileSync(path.join(modules, 'node_modules/x/i.js'), '1')
  fs.writeFileSync(path.join(modules, '.env'), 'A=1\n')

  const r = await run(['prune', '--json'], { cwd: root, getSessions: () => [{ pid: 9, cwd: path.join(live, 'src') }] })
  const j = JSON.parse(r.out)
  assert.strictEqual(j.dryRun, true)
  assert.deepStrictEqual(j.safe.map(s => s.branch).sort(), ['done', 'mods'])
  const why = Object.fromEntries(j.kept.map(k => [k.branch, k.why]))
  assert.match(why.wip, /not merged into main/)
  assert.match(why.dirty, /uncommitted changes/)
  assert.match(why.untr, /untracked notes\.md/)
  assert.match(why.ign, /ignored file secrets\//)
  assert.match(why.live, /live session/)
  assert.match(why.fresh, /no commits of its own/)
  assert.ok([ok, unmerged, dirty, untracked, ignored, live, fresh, modules].every(p => fs.existsSync(p)), 'dry run removes nothing')
  assert.ok(!j.kept.some(k => k.path === root), 'the main worktree is never listed')
  const text = await run(['prune'], { cwd: root })
  assert.match(text.out, /would remove .*shop-done \(done\)/)
  assert.match(text.out, /dry run: run again with --yes/)
})

test('prune --yes removes with git worktree remove and git branch -d, never forcing', async () => {
  const { root } = makeRepo()
  const ok = mergedBranch(root, 'done')
  const mods = mergedBranch(root, 'mods')
  fs.mkdirSync(path.join(mods, 'node_modules'))
  fs.writeFileSync(path.join(mods, 'node_modules/i.js'), '1')
  const wip = mergedBranch(root, 'wip', { merge: false })
  const r = await run(['prune', '--yes'], { cwd: root })
  assert.strictEqual(r.code, 0, r.err)
  assert.ok(!fs.existsSync(ok) && !fs.existsSync(mods))
  assert.ok(fs.existsSync(wip))
  assert.strictEqual(sh(root, 'branch', '--list', 'done'), '')
  assert.match(sh(root, 'branch', '--list', 'wip'), /wip/)
})

test('prune: untracked env copies are removed only when identical to the main checkout', async () => {
  const { root } = makeRepo()
  // the include file is untracked here, so the tree has not-ignored env files
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n')
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
  sh(root, 'commit', '-q', '-am', 'stop ignoring env')
  const same = mergedBranch(root, 'same')
  fs.writeFileSync(path.join(same, '.env'), 'A=1\n')
  fs.writeFileSync(path.join(same, '.env.local'), 'PORT=3100\n')
  const differs = mergedBranch(root, 'differs')
  fs.writeFileSync(path.join(differs, '.env'), 'A=changed\n')
  const r = await run(['prune', '--yes', '--json'], { cwd: root })
  const j = JSON.parse(r.out)
  assert.deepStrictEqual(j.removed.map(s => s.branch), ['same'])
  assert.match(j.kept.find(k => k.branch === 'differs').why, /differs from the main checkout/)
  assert.ok(fs.existsSync(path.join(differs, '.env')))
})

test('prune never removes a live session\'s dir, even when the session shows up after the plan', async () => {
  const { root } = makeRepo()
  const wt = mergedBranch(root, 'late')
  let calls = 0
  // the first read (the plan) sees nothing, the re-read right before deleting sees a session
  const getSessions = () => (++calls === 1 ? [] : [{ pid: 5, cwd: wt }])
  const r = await run(['prune', '--yes', '--json'], { cwd: root, getSessions })
  const j = JSON.parse(r.out)
  assert.strictEqual(j.removed.length, 0)
  assert.match(j.failed[0].error, /live session/)
  assert.ok(fs.existsSync(wt))
  assert.strictEqual(r.code, 1)
})

test('prune refuses when sessions cannot be read, when run from inside, and for locked worktrees', async () => {
  const { root } = makeRepo()
  const a = mergedBranch(root, 'a')
  const b = mergedBranch(root, 'b')
  sh(root, 'worktree', 'lock', b)
  let r = await run(['prune', '--yes', '--json'], { cwd: root, getSessions: () => null })
  assert.strictEqual(JSON.parse(r.out).removed.length, 0)
  assert.ok(fs.existsSync(a))
  r = await run(['prune', '--yes', '--json'], { cwd: path.join(a), getSessions: () => [] })
  const j = JSON.parse(r.out)
  assert.ok(fs.existsSync(a) && fs.existsSync(b))
  assert.match(j.kept.find(k => k.branch === 'a').why, /you are inside it/)
  assert.match(j.kept.find(k => k.branch === 'b').why, /locked/)
})

test('prune: sessions with a Windows-style cwd protect the worktree', async () => {
  const { root } = makeRepo()
  const a = mergedBranch(root, 'a')
  const winCwd = a.replace(/\//g, '\\').toUpperCase()
  const r = await run(['prune', '--json'], { cwd: root, platform: 'win32', getSessions: () => [{ pid: 3, cwd: winCwd }] })
  assert.match(JSON.parse(r.out).kept[0].why, /live session/)
})

test('prune --merged-into and --older-than', async () => {
  const { root } = makeRepo()
  sh(root, 'branch', 'develop')
  const a = mergedBranch(root, 'a')
  let r = await run(['prune', '--merged-into', 'nope'], { cwd: root })
  assert.match(r.err, /nope is not a branch/)
  r = await run(['prune', '--older-than', 'x'], { cwd: root })
  assert.match(r.err, /--older-than needs/)
  // merged into main but not into develop
  r = await run(['prune', '--json', '--merged-into', 'develop'], { cwd: root })
  assert.match(JSON.parse(r.out).kept[0].why, /not merged into develop/)
  // freshly touched: kept under --older-than 7d, listed when the clock moves on
  r = await run(['prune', '--json', '--older-than', '7d'], { cwd: root })
  assert.match(JSON.parse(r.out).kept[0].why, /touched/)
  r = await run(['prune', '--json', '--older-than', '7d'], { cwd: root, now: Date.now() + 30 * 86400000 })
  assert.deepStrictEqual(JSON.parse(r.out).safe.map(s => s.branch), ['a'])
  assert.ok(fs.existsSync(a))
})

// ---- cli ----------------------------------------------------------------------------------

test('bulkhead worktree is wired into the cli and rejects unknown input', async () => {
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead')
  const r = spawnSync(process.execPath, [bin, 'worktree', 'list'], { cwd: tempDir(), encoding: 'utf8', env: ENV })
  assert.strictEqual(r.status, 1)
  assert.match(r.stderr, /not inside a git repository/)
  const u = await run(['frob'])
  assert.strictEqual(u.code, 1)
  assert.match(u.err, /unknown command frob/)
  const bad = await run(['add', 'x', '--bogus'])
  assert.match(bad.err, /unknown option --bogus/)
  const h = await run(['--help'])
  assert.match(h.out, /bulkhead worktree add/)
})

test('prune: a squash-merged branch counts as merged and is deleted with -D; one with more work is kept', async () => {
  const { root } = makeRepo()
  const squashed = mergedBranch(root, 'sq', { merge: false })
  sh(root, 'merge', '-q', '--squash', 'sq')
  sh(root, 'commit', '-q', '-m', 'squash sq')
  const more = mergedBranch(root, 'more', { merge: false })
  sh(root, 'merge', '-q', '--squash', 'more')
  sh(root, 'commit', '-q', '-m', 'squash more')
  fs.writeFileSync(path.join(more, 'later.txt'), 'later')
  sh(more, 'add', '-A')
  sh(more, 'commit', '-q', '-m', 'after the squash')
  const dry = JSON.parse((await run(['prune', '--json'], { cwd: root })).out)
  assert.deepStrictEqual(dry.safe.map(s => [s.branch, s.squashed]), [['sq', true]])
  assert.match(dry.kept.find(k => k.branch === 'more').why, /not merged into main/)
  const r = await run(['prune', '--yes'], { cwd: root })
  assert.strictEqual(r.code, 0, r.err)
  assert.match(r.out, /removed .*\(sq, squash-merged\)/)
  assert.ok(!fs.existsSync(squashed) && fs.existsSync(more))
  assert.strictEqual(sh(root, 'branch', '--list', 'sq'), '')
})

test('prune: a branch whose commits were cherry-picked onto main counts as merged, even after main moved on', async () => {
  const { root } = makeRepo()
  const picked = mergedBranch(root, 'picked', { merge: false })
  const head = sh(picked, 'rev-parse', 'HEAD').trim()
  // main moves first, so the pick is a new commit and not the branch's own (same second, same hash)
  fs.writeFileSync(path.join(root, 'other.txt'), 'other\n')
  sh(root, 'add', 'other.txt')
  sh(root, 'commit', '-q', '-m', 'other work on main')
  sh(root, 'cherry-pick', head)
  // main changes the same file again afterwards, so merging the branch would not be a no-op
  const file = sh(root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')[0]
  fs.appendFileSync(path.join(root, file), 'edited on main\n')
  sh(root, 'commit', '-q', '-am', 'edit after the pick')
  const dry = JSON.parse((await run(['prune', '--json'], { cwd: root })).out)
  assert.deepStrictEqual(dry.safe.map(s => [s.branch, s.squashed]), [['picked', true]])
})

test('list: the .env copies and PORT line from add do not make a worktree dirty', async () => {
  // a repository whose .gitignore does not list the env files, so they show up as untracked
  const { root } = makeRepo()
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n')
  sh(root, 'commit', '-q', '-am', 'narrow ignore')
  fs.writeFileSync(path.join(root, '.env'), 'A=1\n')
  const wt = JSON.parse((await run(['add', 'fresh', '--json'], { cwd: root })).out).path
  assert.ok(fs.existsSync(path.join(wt, '.env.local')) && fs.existsSync(path.join(wt, '.env')))
  assert.match(sh(wt, 'status', '--porcelain'), /\?\? \.env/)
  let row = JSON.parse((await run(['list', '--json'], { cwd: root })).out).worktrees[1]
  assert.strictEqual(row.dirty, false)
  fs.writeFileSync(path.join(wt, 'notes.txt'), 'mine')
  row = JSON.parse((await run(['list', '--json'], { cwd: root })).out).worktrees[1]
  assert.strictEqual(row.dirty, true)
})
