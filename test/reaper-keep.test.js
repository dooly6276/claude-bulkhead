'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { findOrphans, keeper, run } = require('../src/orphan-reaper')
const { readLinux, readMac, parsePsKeep, isKeepValue } = require('../src/processes')
const notices = require('../src/notices')
const { message } = require('../src/config-check')
const { tempDir } = require('./helpers')

const T = Date.UTC(2026, 9, 13, 12)
const proc = (pid, ppid, name, cmd, extra = {}) => ({ pid, ppid, name, cmd, start: T + pid, rss: 0, claudePid: null, ...extra })
const kept = (p, ...rest) => keeper(...rest)(p)
const tree = (...extra) => [
  proc(1, 0, 'launchd', '/sbin/launchd', { start: T - 1e8 }),
  proc(100, 1, 'zsh', 'zsh', { claudePid: 50 }),
  ...extra,
]
const scan = (procs, listening) => findOrphans({ procs, listening: new Set(listening) }, T + 1e6, { self: -1, platform: 'darwin' })

test('keep marker: macOS ps -E lines, whole word only', () => {
  const text = [
    '  500 /usr/bin/node srv.js PATH=/usr/bin CLAUDE_PID=9 BULKHEAD_KEEP=1 HOME=/Users/a',
    '  501 node b.js BULKHEAD_KEEP=0 CLAUDE_PID=9',
    '  502 node c.js XBULKHEAD_KEEP=1',
    '  503 node d.js BULKHEAD_KEEP=true',
    '  504 node e.js BULKHEAD_KEEP=10',
  ].join('\n')
  assert.deepStrictEqual([...parsePsKeep(text)], [500, 503])
  assert.ok(isKeepValue('1') && isKeepValue(' yes ') && !isKeepValue('0') && !isKeepValue(''))
})

test('keep marker: macOS reader sets keep only when the environment was read', () => {
  const ps = [
    '  10     1  1000 Mon Oct 13 09:12:01 2026 node srv.js',
    '  11     1  1000 Mon Oct 13 09:12:01 2026 node b.js',
  ].join('\n')
  const fake = (f, a) => {
    if (f === 'lsof') return ''
    if (a[0] === '-axwwE') return '  10 node srv.js BULKHEAD_KEEP=1 CLAUDE_PID=5\n  11 node b.js CLAUDE_PID=5\n'
    return a[0] === '-axo' ? '  10 node\n  11 node\n' : ps
  }
  const withEnv = readMac(fake, { withEnv: true }).procs
  assert.strictEqual(withEnv.find(p => p.pid === 10).keep, true)
  assert.strictEqual(withEnv.find(p => p.pid === 11).keep, undefined)
  assert.strictEqual(readMac(fake).procs.find(p => p.pid === 10).keep, undefined)
})

test('keep marker: Linux reads it from /proc/PID/environ', () => {
  const stat = pid => `${pid} (node) S 1 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 1000 10 0\n`
  const files = {
    '/proc/stat': 'btime 1000\n',
    '/proc/20/stat': stat(20), '/proc/20/cmdline': 'node\0srv.js\0', '/proc/20/environ': 'CLAUDE_PID=7\0BULKHEAD_KEEP=1\0',
    '/proc/21/stat': stat(21), '/proc/21/cmdline': 'node\0b.js\0', '/proc/21/environ': 'CLAUDE_PID=7\0BULKHEAD_KEEP=0\0',
  }
  const io = {
    read: p => { if (!(p in files)) throw new Error('ENOENT'); return files[p] },
    list: p => { if (p === '/proc') return ['20', '21']; throw new Error('ENOENT') },
    link: () => { throw new Error('ENOENT') },
  }
  const procs = readLinux(io).procs
  assert.strictEqual(procs.find(p => p.pid === 20).keep, true)
  assert.strictEqual(procs.find(p => p.pid === 21).keep, undefined)
})

test('keep marker: a marked listener under a dead session is left alone, an unmarked one is not', () => {
  const procs = tree(
    proc(101, 100, 'node', 'node a.js', { claudePid: 50, keep: true }),
    proc(102, 100, 'node', 'node b.js', { claudePid: 50 }),
  )
  assert.deepStrictEqual(scan(procs, [101, 102]).map(o => o.pid), [102])
})

test('keep marker: Windows has no environment, so the word in a wrapper command line counts', () => {
  assert.ok(kept(proc(5, 1, 'bash.exe', '"C:\\Program Files\\Git\\bin\\bash.exe" -c "BULKHEAD_KEEP=1 node srv.js"')))
  assert.ok(kept(proc(6, 1, 'cmd.exe', 'cmd /c set BULKHEAD_KEEP=1 && node srv.js')))
  assert.ok(!kept(proc(7, 1, 'node.exe', 'node x.js --label=NOBULKHEAD_KEEP=1')))
  assert.ok(!kept(proc(8, 1, 'node.exe', 'node x.js BULKHEAD_KEEP=0')))
})

test('keepPatterns and keepNames', () => {
  const p = proc(5, 1, 'node', 'node /opt/My-Tunnel.sh --port 22')
  assert.ok(kept(p, [], ['my-tunnel.sh']))
  assert.ok(!kept(p, [], ['other']))
  assert.ok(kept(p, ['Node']))
  assert.ok(!kept(p, [], ['']), 'an empty pattern keeps nothing')
})

test('keep list: tunnels, databases, services, container runtimes', () => {
  const yes = [
    ['ssh', 'ssh -N -L 8080:localhost:80 host'],
    ['ssh', 'ssh -L8080:localhost:80 host'],
    ['ssh', 'ssh -fNT host'],
    ['ssh', 'ssh -o StrictHostKeyChecking=no -D 1080 host'],
    ['ssh', 'ssh -vR 9000:localhost:9000 host'],
    ['autossh', 'autossh -M 0 host'], ['cloudflared', 'cloudflared tunnel run x'], ['ngrok', 'ngrok http 3000'],
    ['tailscaled', 'tailscaled'], ['tailscale', 'tailscale up'],
    ['python3', '/usr/bin/python3 /usr/local/bin/jupyter-lab --no-browser'],
    ['python3', 'python3 -m jupyterlab'], ['jupyter-notebook', 'jupyter-notebook'],
    ['redis-server', 'redis-server *:6379'], ['postgres', 'postgres -D /data'], ['mysqld', 'mysqld'], ['mongod', 'mongod --dbpath x'],
    ['mariadbd', 'mariadbd'], ['code-server', 'code-server'], ['syncthing', 'syncthing serve'],
    ['colima', 'colima daemon'], ['limactl', 'limactl hostagent'], ['ollama', 'ollama serve'], ['docker', 'docker run x'], ['com.docker.backend', 'com.docker.backend'],
  ]
  for (const [name, cmd] of yes) assert.ok(kept(proc(5, 1, name, cmd)), `${cmd} is kept`)
  const no = [
    ['ssh', 'ssh host ls'], ['ssh', 'ssh -o ServerAliveInterval=5 host'], ['ssh', 'ssh -i ~/.ssh/key_NL host'],
    ['node', 'node server.js'], ['python3', 'python3 -m http.server 8000'], ['node', 'node jupyter-theme-build.js'],
  ]
  for (const [name, cmd] of no) assert.ok(!kept(proc(5, 1, name, cmd)), `${cmd} is not kept`)
})

test('keep list: a tunnel under a dead session is not reaped even with a listening port', () => {
  const procs = tree(
    proc(101, 100, 'ssh', 'ssh -N -L 5432:db:5432 host', { claudePid: 50 }),
    proc(102, 100, 'node', 'node srv.js', { claudePid: 50 }),
  )
  assert.deepStrictEqual(scan(procs, [101, 102]).map(o => o.pid), [102])
})

test('notice: labels', () => {
  assert.strictEqual(notices.label('node /Users/a/web/node_modules/.bin/vite --port 5231', 'node'), 'vite')
  assert.strictEqual(notices.label('node srv.js', 'node'), 'node srv.js')
  assert.strictEqual(notices.label('/usr/bin/python3 -u /x/app.py', 'python3'), 'python3 app.py')
  assert.strictEqual(notices.label('"C:\\Program Files\\nodejs\\node.exe" C:\\w\\srv.js', 'node.exe'), 'node srv.js')
  assert.strictEqual(notices.label('', 'sleep'), 'sleep')
})

test('notice: text as the user sees it', () => {
  const home = '/Users/a'
  const two = [{ label: 'vite', port: 5231, project: '/Users/a/dev/web' }, { label: 'node srv.js', port: 4000, project: null }]
  assert.strictEqual(notices.format(two, home),
    'bulkhead stopped 2 leftovers from ended sessions: vite :5231 (~/dev/web), node srv.js :4000. Keep one next time with BULKHEAD_KEEP=1. Details: bulkhead log --guard orphan-reaper')
  assert.match(notices.format([two[1]], home), /^bulkhead stopped 1 leftover from ended sessions: node srv\.js :4000\. /)
  const five = Array.from({ length: 5 }, (_, i) => ({ label: `w${i}`, port: null, project: null }))
  assert.match(notices.format(five, home), /: w0, w1, w2, and 2 more\. Keep/)
  assert.strictEqual(notices.format([]), null)
})

test('notice: pending list is written, claimed once, and cleared', () => {
  const dir = tempDir()
  const done = [
    { orphan: { pid: 10, name: 'node', cmd: 'node srv.js' }, pids: [10, 11] },
    { orphan: { pid: 20, name: 'sleep', cmd: 'sleep 300' }, pids: [20] },
  ]
  const list = notices.items(done, [{ port: 4000, pid: 11 }], () => '/p')
  assert.deepStrictEqual(list.map(i => [i.label, i.port, i.project]), [['node srv.js', 4000, '/p'], ['sleep 300', null, '/p']])
  assert.ok(notices.append(dir, list))
  assert.strictEqual(notices.claim(dir).length, 2)
  assert.deepStrictEqual(notices.claim(dir), [])
  assert.ok(!fs.existsSync(path.join(dir, notices.PENDING)))
  assert.strictEqual(notices.append(dir, []), false)
})

test('notice: a corrupt or oversized pending file never throws', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, notices.PENDING), 'not json\n{"label":"a","port":1}\n')
  assert.deepStrictEqual(notices.claim(dir).map(i => i.label), ['a'])
  fs.writeFileSync(path.join(dir, notices.PENDING), 'x'.repeat(70 * 1024))
  assert.strictEqual(notices.append(dir, [{ label: 'a' }]), false)
})

test('first run: one line, then never again', () => {
  const dir = path.join(tempDir(), 'state')
  assert.strictEqual(notices.firstRun(dir), notices.FIRST_RUN_TEXT)
  assert.strictEqual(notices.firstRun(dir), null)
  assert.strictEqual(notices.firstRun(dir), null)
  assert.strictEqual(notices.FIRST_RUN_TEXT, 'bulkhead is on: it blocks commands that would hit other Claude Code sessions. See what it did: bulkhead log. Check your setup: bulkhead doctor.')
})

test('first run: an install that already has a log gets no line, only the marker', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'guards.log'), 'x\n')
  assert.strictEqual(notices.firstRun(dir), null)
  assert.ok(fs.existsSync(path.join(dir, notices.FIRST_RUN)))
})

test('first run: fails open when the state dir cannot be created', () => {
  const dir = tempDir()
  const file = path.join(dir, 'a-file')
  fs.writeFileSync(file, '')
  assert.strictEqual(notices.firstRun(path.join(file, 'sub')), null)
})

test('SessionStart message joins first run and reaped notices, then goes quiet', () => {
  const dir = tempDir()
  notices.append(dir, [{ label: 'vite', port: 5231, project: null }])
  const first = message({ cwd: dir }, dir)
  assert.match(first, /^bulkhead is on: /)
  assert.match(first, /\nbulkhead stopped 1 leftover from ended sessions: vite :5231\./)
  assert.strictEqual(message({ cwd: dir }, dir), null)
})

test('a pass records what it stopped for the next SessionStart and in events', () => {
  const dir = tempDir()
  const prev = process.env.BULKHEAD_STATE_DIR
  process.env.BULKHEAD_STATE_DIR = dir
  const procs = tree(proc(101, 100, 'node', 'node srv.js', { claudePid: 50 }))
  const realKill = process.kill
  let dead = false
  process.kill = (pid, sig) => {
    if (pid !== 101 && pid !== 100) return realKill(pid, sig)
    if (sig === 'SIGTERM') dead = true
    else if (dead) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }
  try {
    const snap = ports => ({ procs, listening: new Set([101]), ports })
    const done = run({ platform: 'darwin', trigger: 'startup', project: '/p', snap: snap([{ port: 4000, pid: 101 }]) })
    assert.strictEqual(done.length, 1)
    assert.deepStrictEqual(notices.claim(dir).map(i => [i.label, i.port, i.project]), [['node srv.js', 4000, '/p']])
    assert.match(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /"guard":"orphan-reaper"[^\n]*"port":4000/)
    // a manual run prints its own result and leaves no notice
    dead = false
    run({ platform: 'darwin', trigger: 'manual', project: '/p', snap: snap([]) })
    assert.deepStrictEqual(notices.claim(dir), [])
  } finally {
    process.kill = realKill
    if (prev === undefined) delete process.env.BULKHEAD_STATE_DIR
    else process.env.BULKHEAD_STATE_DIR = prev
  }
})
