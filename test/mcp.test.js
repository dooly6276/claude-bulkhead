'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { isMcpCommand, serverName, signature, findMcp } = require('../src/mcp')
const { assignOwners } = require('../src/sessions')

const MB = 2 ** 20

test('recognizes MCP servers by command line', () => {
  const yes = [
    'npm exec @playwright/mcp@latest',
    'npx -y @modelcontextprotocol/server-filesystem /Users/me/dev',
    'node /Users/me/.npm/_npx/abc/node_modules/.bin/playwright-mcp --headless',
    'node /Users/me/.npm/_npx/abc/node_modules/@playwright/mcp/cli.js',
    'uvx mcp-server-git --repository /Users/me/dev/api',
    'python3 -m mcp_server_fetch',
    'python -m mcp.server.fastmcp run server.py',
    '/usr/local/bin/github-mcp-server stdio',
    '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@upstash\\context7-mcp\\dist\\index.js',
    'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\.bin\\mcp-server-time.cmd',
    'bunx @upstash/context7-mcp',
    'docker run -i --rm ghcr.io/github/github-mcp-server',
  ]
  for (const c of yes) assert.strictEqual(isMcpCommand(c), true, c)
})

test('does not mistake other commands for MCP servers', () => {
  const no = [
    'claude --mcp-config /tmp/mcp.json',
    'node /Users/me/dev/mcp-hub/node_modules/.bin/vite',
    'node /Users/me/dev/mcp-hub/node_modules/vite/bin/vite.js',
    'npm run dev',
    'node next dev',
    'python3 manage.py runserver',
    'bash -c "echo mcp"',
    'vim mcp.md',
    'node --inspect /Users/me/app/index.js --mcp',
    '',
  ]
  for (const c of no) assert.strictEqual(isMcpCommand(c), false, c)
})

test('server names drop versions and paths', () => {
  assert.strictEqual(serverName('npm exec @playwright/mcp@latest'), '@playwright/mcp')
  assert.strictEqual(serverName('npx -y @modelcontextprotocol/server-filesystem@1.2.3 /x'), '@modelcontextprotocol/server-filesystem')
  assert.strictEqual(serverName('uvx mcp-server-git --repository /x'), 'mcp-server-git')
  assert.strictEqual(serverName('node /h/node_modules/@playwright/mcp/cli.js'), '@playwright/mcp')
  assert.strictEqual(serverName('/usr/local/bin/github-mcp-server stdio'), 'github-mcp-server')
})

test('signatures ignore session-specific arguments', () => {
  const a = signature('node /h/node_modules/.bin/playwright-mcp --port 8931 --user-data-dir /private/tmp/x1', '/Users/me/a')
  const b = signature('node /h/node_modules/.bin/playwright-mcp --port 8932 --user-data-dir /private/tmp/x2', '/Users/me/b')
  assert.strictEqual(a, b)
  assert.strictEqual(signature('npm exec @playwright/mcp@latest'), signature('npm exec @playwright/mcp@0.0.41'))
  assert.strictEqual(signature('uvx mcp-server-git --repository /Users/me/a', '/Users/me/a'), signature('uvx mcp-server-git --repository /Users/me/b', '/Users/me/b'))
  assert.notStrictEqual(signature('npm exec @playwright/mcp@latest'), signature('npm exec @upstash/context7-mcp'))
  assert.strictEqual(signature('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\mcp\\index.js 4001'), signature('node C:\\x\\mcp\\index.js 4002'))
})

const proc = (pid, ppid, name, cmd, rssMb, start = 1000 + pid) => ({ pid, ppid, name, cmd, start, rss: rssMb * MB, claudePid: null })

// three sessions, each started playwright through npx (npm exec -> sh -> node), session 3 also has a filesystem server
function fixture(platform) {
  const node = platform === 'win32' ? '"C:\\Program Files\\nodejs\\node.exe" C:\\u\\_npx\\a\\node_modules\\.bin\\playwright-mcp' : 'node /u/_npx/a/node_modules/.bin/playwright-mcp'
  const procs = []
  for (const [i, s] of [[1, 100], [2, 200], [3, 300]]) {
    procs.push(proc(s, 1, 'claude', 'claude', 400, 10 + s))
    procs.push(proc(s + 1, s, 'npm', 'npm exec @playwright/mcp@latest', 60))
    procs.push(proc(s + 2, s + 1, 'sh', 'sh -c playwright-mcp', 2))
    procs.push(proc(s + 3, s + 2, 'node', node, 340))
    procs.push(proc(s + 4, s + 3, 'chrome', 'chrome --headless', 500)) // the server's own browser counts toward it
    procs.push(proc(s + 5, s, 'node', 'node next dev', 900))
    void i
  }
  procs.push(proc(306, 300, 'node', 'npx -y @modelcontextprotocol/server-filesystem /u/c', 50))
  procs.push(proc(900, 1, 'node', 'npm exec @playwright/mcp@latest', 60)) // not under any session
  return procs
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`groups copies across sessions and sums memory (${platform})`, () => {
    const procs = fixture(platform)
    const sessions = [{ pid: 100, cwd: '/u/a' }, { pid: 200, cwd: '/u/b' }, { pid: 300, cwd: '/u/c' }]
    const owner = assignOwners(procs, new Set([100, 200, 300]))
    const { instances, groups } = findMcp(procs, owner, sessions)
    assert.strictEqual(instances.length, 4) // three playwright trees, one filesystem server; the pid 900 orphan has no session
    const pw = groups.find(g => g.name === '@playwright/mcp')
    assert.deepStrictEqual([pw.copies, pw.sessions, pw.duplicate], [3, [100, 200, 300], true])
    assert.strictEqual(pw.rss, 3 * (60 + 2 + 340 + 500) * MB)
    const fsrv = groups.find(g => g.name === '@modelcontextprotocol/server-filesystem')
    assert.deepStrictEqual([fsrv.copies, fsrv.duplicate], [1, false])
    assert.strictEqual(groups[0].name, '@playwright/mcp') // largest first
    assert.ok(instances.every(i => i.procs >= 1))
  })
}

test('two copies inside one session are not flagged as duplicates across sessions', () => {
  const procs = [
    proc(100, 1, 'claude', 'claude', 400),
    proc(101, 100, 'node', 'node /x/node_modules/@playwright/mcp/cli.js', 100),
    proc(102, 100, 'node', 'node /x/node_modules/@playwright/mcp/cli.js', 100),
  ]
  const owner = assignOwners(procs, new Set([100]))
  const { groups } = findMcp(procs, owner, [{ pid: 100, cwd: '/x' }])
  assert.deepStrictEqual([groups[0].copies, groups[0].duplicate], [2, false])
})

test('no sessions, no processes, no MCP servers', () => {
  assert.deepStrictEqual(findMcp([], new Map(), []), { instances: [], groups: [] })
  const procs = [proc(100, 1, 'claude', 'claude', 400), proc(101, 100, 'node', 'node server.js', 50)]
  assert.deepStrictEqual(findMcp(procs, assignOwners(procs, new Set([100])), [{ pid: 100 }]).groups, [])
})
