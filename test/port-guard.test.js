'use strict'
const test = require('node:test')
const assert = require('node:assert')
const net = require('net')
const { check, checkKill, killPorts, freePort, listening } = require('../src/port-guard')
const { ownSession } = require('../src/sessions')
const { runScript } = require('./helpers')

const t0 = Date.UTC(2026, 9, 13, 8)
const proc = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd, start, rss: 0, claudePid: null })

// Session 100 runs `next dev` on 3000. Session 200 is the one asking. 5432 belongs to nobody.
const snap = {
  procs: [
    proc(100, 1, 'claude', 'claude', t0),
    proc(110, 100, 'bash', 'bash -c "npm run dev"', t0 + 10e3),
    proc(111, 110, 'node', 'node next dev', t0 + 11e3),
    proc(200, 1, 'claude', 'claude', t0 + 60e3),
    proc(210, 200, 'node', 'node vite', t0 + 70e3),
    proc(300, 1, 'postgres', 'postgres', t0 - 1e6),
  ],
  ports: [{ port: 3000, pid: 111 }, { port: 3001, pid: 111 }, { port: 5173, pid: 210 }, { port: 5432, pid: 300 }],
}
const files = () => new Map([[100, { cwd: '/home/dev/src/acme-web', startedAt: 0 }]])
const as = me => ({ cwd: '/w', probe: async () => true, snapshot: () => snap, files, self: () => me })

test('blocks a port held by another session and names it', async () => {
  const msg = await check('npx next dev', as(200))
  assert.match(msg, /port 3000 is already used by another Claude session \(session 100 in \/home\/dev\/src\/acme-web\): node pid 111/)
  assert.match(msg, /Port 3002 is free:\n {2}npx next dev --port 3002/)
  assert.match(await check('python -m http.server 3000', as(200)), /http\.server 3002/)
})

test('allows the same session, free ports, non-Claude owners and unknowns', async () => {
  assert.strictEqual(await check('npx next dev', as(100)), null)
  assert.strictEqual(await check('npx vite', as(200)), null)
  assert.strictEqual(await check('next dev -p 4000', as(200)), null)
  assert.strictEqual(await check('PORT=5432 next dev', as(200)), null)
  assert.strictEqual(await check('next dev --port $PORT', as(200)), null)
  assert.strictEqual(await check('npx next dev', as(null)), null)
  assert.strictEqual(await check('npm test', { ...as(200), snapshot: () => assert.fail('no scan for other commands') }), null)
  assert.strictEqual(await check('npx next dev', { ...as(200), snapshot: () => null }), null)
})

test('finds its own session through the parent chain', () => {
  const procs = [...snap.procs, proc(220, 200, 'bash', 'bash', t0 + 80e3), proc(221, 220, 'node', 'node port-guard.js', t0 + 81e3)]
  assert.strictEqual(ownSession(procs, 221, {}), 200)
  assert.strictEqual(ownSession(procs, 999, { CLAUDE_PID: '100' }), 100)
  assert.strictEqual(ownSession(procs, 999, {}), null)
})

test('nothing answering on the port means no process scan', async () => {
  const quiet = { ...as(200), probe: async () => false, snapshot: () => assert.fail('no scan when the port is free') }
  assert.strictEqual(await check('npx next dev', quiet), null)
})

test('listening() sees a real socket', async () => {
  const server = net.createServer().listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const { port } = server.address()
  try {
    assert.strictEqual(await listening(port), true)
  } finally {
    server.close()
  }
  await new Promise(resolve => server.once('close', resolve))
  assert.strictEqual(await listening(port), false)
})

test('free port skips taken ones', () => {
  assert.strictEqual(freePort(3000, new Set([3000, 3001, 3002])), 3003)
})

test('finds the ports a kill-by-port command aims at', () => {
  const cases = [
    ['npx kill-port 3000', [3000]],
    ['npx -y kill-port 3000 3001', [3000, 3001]],
    ['npx kill-port --port 3000,3001', [3000, 3001]],
    ['fuser -k 3000/tcp', [3000]],
    ['fuser -k -n tcp 3000', [3000]],
    ['fuser -k 3000/tcp 8080/tcp', [3000, 8080]],
    ['lsof -ti :3000 | xargs kill -9', [3000]],
    ['lsof -t -i:3000 | xargs kill', [3000]],
    ['lsof -ti tcp:5173 | xargs -r kill', [5173]],
    ['kill $(lsof -t -i:3000)', [3000]],
    ['kill -9 `lsof -ti :3000`', [3000]],
    ['Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess -Force', [3000]],
    ['Get-NetTCPConnection -LocalPort 3000 | Select-Object -ExpandProperty OwningProcess | Stop-Process', [3000]],
    ["for /f \"tokens=5\" %a in ('netstat -aon ^| findstr :3000') do taskkill /F /PID %a", [3000]],
    ["netstat -ano | findstr :8080 | awk '{print $5}' | xargs taskkill //F //PID", [8080]],
    ['cd app && npx kill-port 4000 && npm run dev', [4000]],
  ]
  for (const [cmd, want] of cases) assert.deepStrictEqual(killPorts(cmd), want, cmd)
  // looking is not killing
  for (const cmd of ['lsof -ti :3000', 'netstat -ano | findstr :3000', 'Get-NetTCPConnection -LocalPort 3000', 'fuser 3000/tcp',
    'kill 4242', 'taskkill /PID 4242 /F', 'npm i -D kill-port', 'grep -rn "kill-port" .']) {
    assert.deepStrictEqual(killPorts(cmd), [], cmd)
  }
})

test('blocks a kill by port only when another session owns the port', async () => {
  const msg = (await checkKill('npx kill-port 3000', as(200))).message
  assert.match(msg, /`npx kill-port 3000` would stop node pid 111, the server another Claude session runs on port 3000 \(session 100 in \/home\/dev\/src\/acme-web\)/)
  assert.match(msg, /3002 is free/)
  assert.match(msg, /bulkhead port/)
  assert.ok(await checkKill('lsof -ti :3000 | xargs kill -9', as(200)))
  assert.ok(await checkKill('npx kill-port 5173 3000', as(200)))
  // own session, nobody's port, unknown self, nothing listening, no snapshot
  assert.strictEqual(await checkKill('npx kill-port 3000', as(100)), null)
  assert.strictEqual(await checkKill('npx kill-port 5173', as(200)), null)
  assert.strictEqual(await checkKill('fuser -k 5432/tcp', as(200)), null)
  assert.strictEqual(await checkKill('npx kill-port 3000', as(null)), null)
  assert.strictEqual(await checkKill('npx kill-port 3000', { ...as(200), probe: async () => false, snapshot: () => assert.fail('no scan') }), null)
  assert.strictEqual(await checkKill('npx kill-port 3000', { ...as(200), snapshot: () => null }), null)
  assert.strictEqual(await checkKill('ls', { ...as(200), probe: () => assert.fail('no probe') }), null)
})

test('suggests the stable port of the current worktree when the cwd is in a git tree', async () => {
  const fs = require('fs')
  const path = require('path')
  const { tempDir } = require('./helpers')
  const { pickFree, keyFor, sequence } = require('../src/stable-port')
  const repo = tempDir()
  fs.mkdirSync(path.join(repo, '.git'))
  fs.mkdirSync(path.join(repo, 'web'))
  const msg = await check('npx next dev', { ...as(200), cwd: path.join(repo, 'web') })
  const stable = pickFree(keyFor(repo), new Set([3000, 3001, 5173, 5432]))
  assert.match(msg, new RegExp(`Port ${stable} is free \\(this worktree's own port\\):\\n {2}npx next dev --port ${stable}`))
  // the same answer every time
  assert.strictEqual(await check('npx next dev', { ...as(200), cwd: repo }), msg)
  // a busy stable port moves on to the next one in the fixed order
  const first = sequence(keyFor(repo))[0]
  const busy = { ...snap, ports: [...snap.ports, { port: first, pid: 300 }] }
  const next = pickFree(keyFor(repo), new Set(busy.ports.map(l => l.port)))
  const msg2 = await check('npx next dev', { ...as(200), cwd: repo, snapshot: () => busy })
  assert.ok(msg2.includes(`--port ${next}`), msg2)
})

test('hook fails open', () => {
  assert.strictEqual(runScript('port-guard', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0)
  assert.strictEqual(runScript('port-guard', 'not json').status, 0)
  assert.strictEqual(runScript('port-guard', { tool_input: { command: 'npx next dev' } }, { BULKHEAD_DISABLE: 'port-guard' }).status, 0)
})

test('finds kill-by-port through pipes, loops, variables and other tools', () => {
  const cases = [
    ["lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill", [3000]],
    ["lsof -iTCP:3000 -sTCP:LISTEN | awk 'NR==2{print $2}' | xargs kill", [3000]],
    ["kill -9 $(lsof -i :3000 | awk 'NR>1{print $2}')", [3000]],
    ['PID=$(lsof -ti :3000); kill $PID', [3000]],
    ['pids=$(lsof -ti :3000); for p in $pids; do kill -9 $p; done', [3000]],
    ['for p in $(lsof -ti :3000); do kill $p; done', [3000]],
    ['lsof -ti :3000 | while read p; do kill -9 $p; done', [3000]],
    ['for port in 3000 3001; do kill $(lsof -ti :$port); done', [3000, 3001]],
    ['PORT=3000; kill $(lsof -ti :$PORT)', [3000]],
    ['npx fkill :3000', [3000]],
    ['fkill -f :3000 :3001', [3000, 3001]],
    ["netstat -anv | grep '\\.3000 ' | awk '{print $9}' | xargs kill", [3000]],
    ["ss -ltnp 'sport = :3000' | awk 'NR>1{print $6}' | grep -o 'pid=[0-9]*' | cut -d= -f2 | xargs kill", [3000]],
    ['fuser -n tcp -k 3000', [3000]],
    ['fuser -k -n tcp 3000 3001', [3000, 3001]],
    ['sudo lsof -nP -iTCP:3000 -sTCP:LISTEN -t | xargs kill -9', [3000]],
    ['pnpm dlx kill-port 3000', [3000]],
  ]
  for (const [cmd, want] of cases) assert.deepStrictEqual(killPorts(cmd), want, cmd)
  // looking is not killing, and a number in text or another statement is not a port
  for (const cmd of ['lsof -i :3000 | grep LISTEN', 'lsof -ti :3000; kill 1234', 'lsof -i :3000 && kill 1234', 'kill -0 $(lsof -ti :3000)', 'echo "lsof -ti :3000 | xargs kill"',
    'grep -rn "kill-port 3000" docs', 'ps aux | grep 3000', 'ss -ltnp "sport = :3000"', "netstat -anv | grep '\\.3000 '", 'fuser 3000/tcp', 'fkill --help', 'fkill 3000',
    'lsof -i :3000 | xargs echo kill', 'git commit -m "kill $(lsof -ti :3000)"']) {
    assert.deepStrictEqual(killPorts(cmd), [], cmd)
  }
})

test('a dev server that publishes several ports is checked on each', async () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pg-compose-'))
  try {
    require('fs').writeFileSync(require('path').join(dir, 'compose.yaml'), 'services:\n  a:\n    ports:\n      - "4999:80"\n      - "3001:5173"\n')
    const msg = await check('docker compose up -d', { ...as(200), cwd: dir })
    assert.match(msg, /port 3001 is already used by another Claude session/)
    assert.match(await check('docker run -p 4998:80 -p 3000:80 nginx', as(200)), /port 3000 is already used/)
    assert.strictEqual(await check('docker run -p 4998:80 nginx', as(200)), null)
    assert.strictEqual(await check('grep -E "next dev|vite|playwright" f', as(200)), null)
    assert.strictEqual(await check('vite --version', as(200)), null)
  } finally {
    require('fs').rmSync(dir, { recursive: true, force: true })
  }
})

test('a heredoc is code only for a shell', async () => {
  const body = 'import os\\ns = "PORT=3000 npm start; kill $(lsof -ti :3000)"\\n'
  for (const consumer of ['python3 -', 'node -', 'cat > f', 'while read c; do echo "$c"; done']) {
    assert.strictEqual(await check(`${consumer} <<'E'\n${body}E`, as(200)), null, consumer)
    assert.strictEqual(await checkKill(`${consumer} <<'E'\n${body}E`, as(200)), null, consumer)
  }
  assert.ok(await checkKill("bash <<'E'\nkill $(lsof -ti :3000)\nE", as(200)))
  assert.ok(await check("cat <<'E' | bash\nnpx next dev\nE", as(200)))
  assert.ok(await check("ssh localhost bash <<'E'\nnpx next dev\nE", as(200)))
})
