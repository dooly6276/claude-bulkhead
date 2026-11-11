'use strict'
// The command reader every guard shares: words, wrappers, heredocs and message text.
const test = require('node:test')
const assert = require('node:assert')
const shell = require('../src/shell')

const argvs = (src, mode) => shell.commands(src, mode).map(c => c.argv.join(' '))

test('lex splits commands and keeps quoting out of the words', () => {
  const { cmds } = shell.lex(`echo "a b" 'c'; ls -la | grep x && npm test`)
  assert.deepStrictEqual(cmds.map(c => c.words.map(w => w.v)), [['echo', 'a b', 'c'], ['ls', '-la'], ['grep', 'x'], ['npm', 'test']])
  assert.deepStrictEqual(cmds.map(c => c.seg), [0, 1, 1, 2])
})

test('lex marks $( ), backticks and <( ) as sub commands', () => {
  const { cmds } = shell.lex('kill $(pgrep node) `cat pid` <(ls)')
  const subs = cmds.filter(c => c.sub).map(c => c.words.map(w => w.v).join(' '))
  assert.deepStrictEqual(subs.sort(), ['cat pid', 'ls', 'pgrep node'])
})

test('lex keeps redirections such as 2>&1 and &> inside the statement', () => {
  const { cmds } = shell.lex('npm test > out.log 2>&1 && echo ok')
  assert.deepStrictEqual(cmds.map(c => c.seg), [0, 1])
  assert.ok(cmds[0].words.some(w => w.v === '2>&1'))
})

test('lex reads PowerShell and cmd quoting', () => {
  assert.deepStrictEqual(shell.lex("Write-Host 'it''s' \"a`\"b\"", 'ps').cmds[0].words.map(w => w.v), ['Write-Host', "it's", 'a"b'])
  assert.deepStrictEqual(shell.lex('echo a^&b', 'cmd').cmds[0].words.map(w => w.v), ['echo', 'a&b'])
})

test('lex reports an unterminated quote', () => {
  assert.strictEqual(shell.lex('echo "open').unterminated, true)
  assert.strictEqual(shell.lex('echo "closed"').unterminated, false)
})

test('strip drops prefixes and assignments before the real command', () => {
  for (const [src, want] of [
    ['sudo -u dev pkill node', 'pkill node'],
    ['env FOO=1 BAR=2 npm test', 'npm test'],
    ['NODE_ENV=test nice -n 5 nohup time npm test', 'npm test'],
    ['timeout 60 npm test', 'npm test'],
    ['xargs -I{} rm {}', 'rm {}'],
  ]) assert.deepStrictEqual(argvs(src), [want], src)
})

test('commands opens shell wrappers up to three levels deep', () => {
  assert.deepStrictEqual(argvs('bash -c "pkill node"'), ['pkill node'])
  assert.deepStrictEqual(argvs(`sh -c "bash -c 'zsh -c \\"ls\\"'"`), ['ls'])
  assert.deepStrictEqual(argvs('cmd /c "taskkill /F /IM node.exe"'), ['taskkill /F /IM node.exe'])
  assert.deepStrictEqual(argvs('pwsh -NoProfile -Command "Get-Process node"'), ['Get-Process node'])
  assert.deepStrictEqual(argvs("eval 'npm test'"), ['npm test'])
  const deep = 'bash -c "bash -c \\"bash -c \\\\\\"bash -c ls\\\\\\"\\""'
  assert.ok(argvs(deep).every(a => a.startsWith('bash')), 'the fourth level stays closed')
})

test('commands decodes powershell -EncodedCommand', () => {
  const enc = Buffer.from('Get-Process node', 'utf16le').toString('base64')
  assert.deepStrictEqual(argvs(`powershell -EncodedCommand ${enc}`), ['Get-Process node'])
})

test('commands marks ssh and container exec as remote', () => {
  for (const src of ['ssh build-host pkill node', 'docker exec web pkill node', 'kubectl exec api-0 -- pkill node']) {
    assert.strictEqual(shell.commands(src)[0].remote, true, src)
  }
  assert.strictEqual(shell.commands('docker ps')[0].remote, false)
})

test('unwrap with remote opens the command that runs on the other side', () => {
  assert.match(shell.unwrap('ssh build-host "sleep 300"', 'sh', 0, { remote: true }), /\(\s*sleep 300\s*\)/)
  assert.strictEqual(shell.unwrap('docker exec -d web sleep 600', 'sh', 0, { remote: true }), 'docker exec -d web sleep 600')
  assert.strictEqual(shell.unwrap('ls -la'), 'ls -la')
})

test('prepare removes commit and pull request text', () => {
  for (const src of [
    'git commit -m "pkill node"',
    'git commit --message="sleep 600"',
    'gh pr create --title "rm -rf /" --body "taskkill /IM node.exe"',
    "gh release create v1 --notes 'killall node'",
    "git commit -F - <<'EOF'\npkill node\nEOF",
  ]) {
    const out = shell.prepare(src)
    assert.doesNotMatch(out, /pkill|sleep 600|rm -rf|taskkill|killall/, src)
  }
})

test('prepare keeps heredocs that a shell runs and drops the rest', () => {
  assert.match(shell.prepare("bash <<'EOF'\npkill node\nEOF"), /pkill node/)
  assert.doesNotMatch(shell.prepare("python3 - <<'EOF'\nimport time\nEOF"), /import time/)
  assert.doesNotMatch(shell.prepare("cat > run.sh <<'EOF'\npkill node\nEOF"), /pkill node/)
})

test('modeFor picks PowerShell from the tool name', () => {
  assert.strictEqual(shell.modeFor({ tool_name: 'PowerShell' }), 'ps')
  assert.strictEqual(shell.modeFor({ tool_name: 'Bash' }), 'sh')
  assert.strictEqual(shell.modeFor(null), 'sh')
})

test('nested openers stay linear', () => {
  for (const unit of ['$(', '<(', '`', '((']) {
    const src = unit.repeat(100000)
    const t = Date.now()
    shell.commands(src)
    shell.commands(src, 'ps')
    assert.ok(Date.now() - t < 2000, `${unit} x 100000 took ${Date.now() - t} ms`)
  }
})

test('a heredoc is code only for a shell; everything else reads it as data', () => {
  const kind = src => {
    const at = src.indexOf('<<')
    return shell.consumerOf(src.slice(0, at), src.slice(at).replace(/^<<-?\s*['"]?\w+['"]?/, ''), 'sh').kind
  }
  for (const [src, want] of [
    ["bash <<'E'", 'shell'], ['sh -s <<E', 'shell'], ['sudo zsh <<E', 'shell'], ['cat <<E | bash', 'shell'], ["cat <<'E' | sh -s", 'shell'],
    ["ssh localhost bash <<'E'", 'shell'], ['cat <<E | ssh 127.0.0.1 sh', 'shell'], ['eval "$(cat <<\'E\'', 'shell'], ["source /dev/stdin <<'E'", 'shell'],
    ["xargs sh -c 'x' <<E", 'shell'], ["ssh host bash <<'E'", 'remote'], ["cat <<'E' | ssh host bash", 'remote'], ["docker exec -i web sh <<'E'", 'remote'],
    ["python3 - <<'E'", 'interp'], ["node - <<'E'", 'interp'], ['cat <<E | python3', 'interp'], ['ruby <<E', 'interp'],
    ["cat <<'E'", 'data'], ["cat > f <<'E'", 'data'], ['tee f <<E', 'data'], ['cat <<E | wc -l', 'data'], ['cat <<E | sort | uniq', 'data'],
    ['while read c; do echo "$c"; done <<\'E\'', 'data'], ["node test.js <<'E'", 'data'], ['read -r x <<E', 'data'], ["git commit -F - <<'E'", 'data'],
    ["gh pr create --body-file - <<'E'", 'data'], ['psql db <<E', 'data'], ['./run.sh <<E', 'data'],
  ]) assert.strictEqual(kind(src), want, src)
})

test('prepare drops heredoc data for every guard and keeps what a shell runs', () => {
  assert.doesNotMatch(shell.prepare("while read c; do echo \"$c\"; done <<'E'\npkill node\nE"), /pkill/)
  assert.doesNotMatch(shell.prepare("node test.js <<'E'\npkill node\nE"), /pkill/)
  assert.doesNotMatch(shell.prepare('cat <<E | wc -l\npkill node\nE'), /pkill/)
  assert.doesNotMatch(shell.prepare("python3 - <<'E'\nimport time\nE"), /import time/)
  assert.doesNotMatch(shell.prepare("cat <<'E' | ssh host bash\npkill node\nE"), /pkill/)
  assert.match(shell.prepare("bash <<'E'\npkill node\nE"), /pkill node/)
  assert.match(shell.prepare("cat <<'E' | sh\npkill node\nE"), /pkill node/)
  assert.match(shell.prepare("ssh localhost bash <<'E'\npkill node\nE"), /pkill node/)
  // wait-guard also keeps what another machine runs, since the session waits for it
  assert.match(shell.prepare("ssh host bash <<'E'\nsleep 600\nE", 'sh', ['shell', 'remote']), /sleep 600/)
  assert.match(shell.prepare("python3 - <<'E'\nimport time\nE", 'sh', ['shell', 'interp']), /import time/)
})

test('ssh to this machine is a local shell; ssh to another machine is not', () => {
  for (const host of ['localhost', 'user@localhost', '127.0.0.1', 'me@127.0.0.5', '::1']) {
    assert.deepStrictEqual(shell.commands(`ssh -p 22 ${host} "echo hi"`).map(c => c.argv.join(' ')), ['echo hi'], host)
  }
  const far = shell.commands('ssh prod "echo hi"')
  assert.strictEqual(far.length, 1)
  assert.strictEqual(far[0].remote, true)
})

test('commands opens indirect shells', () => {
  const run = src => shell.commands(src).map(c => c.argv.join(' '))
  assert.ok(run('echo "ls -la" | sh').includes('ls -la'))
  assert.ok(run("printf 'ls -la' | bash").includes('ls -la'))
  assert.ok(run('source <(echo "ls -la")').includes('ls -la'))
  assert.ok(run("tmux new -d 'ls -la'").includes('ls -la'))
  assert.ok(run('screen -dmS x ls -la').includes('ls -la'))
  assert.ok(run('script -q /dev/null ls -la').includes('ls -la'))
  assert.ok(run('parallel ls ::: -la').includes('ls -la'))
  assert.ok(run('busybox ls -la').includes('ls -la'))
  assert.ok(run('function f() { ls -la; }; f').includes('ls -la'))
  assert.ok(!run('echo "ls -la" | cat').includes('ls -la'))
  assert.ok(!run('echo ls -la | wc -l').includes('ls -la'))
})

test('embeddedShell reads shell strings out of interpreter code', () => {
  assert.deepStrictEqual(shell.embeddedShell("import os; os.system('ls -la')"), ['ls -la'])
  assert.deepStrictEqual(shell.embeddedShell("subprocess.run(['ls', '-la'], check=True)"), ['ls -la'])
  assert.deepStrictEqual(shell.embeddedShell('require("child_process").execSync("ls -la")'), ['ls -la'])
  assert.deepStrictEqual(shell.embeddedShell("spawn('ls', ['-la'])"), ['ls -la'])
  assert.deepStrictEqual(shell.embeddedShell('system("ls -la")'), ['ls -la'])
  assert.deepStrictEqual(shell.embeddedShell('print("ls -la")'), [])
  assert.deepStrictEqual(shell.embeddedShell('os.system(cmd)'), [])
  // a call that sits inside a string or a comment is text, not a call
  assert.deepStrictEqual(shell.embeddedShell('s = "run os.system(\'ls -la\') here"'), [])
  assert.deepStrictEqual(shell.embeddedShell("s = '''\\nos.system('ls -la')\\n'''"), [])
  assert.deepStrictEqual(shell.embeddedShell("# os.system('ls -la')\nx = 1"), [])
  assert.deepStrictEqual(shell.embeddedShell("const cmd = 'python3 - <<\\\\'E\\\\'\\\\nos.system(\"ls -la\")\\\\nE'"), [])
  assert.deepStrictEqual(shell.embeddedShell("t = open('x').read().replace('a', \"\"\"`ls -la`\"\"\")"), [])
  assert.deepStrictEqual(shell.embeddedShell("os.system('ls -la')  # then\nos.system('ls -lh')"), ['ls -la', 'ls -lh'])
})
