'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check, classify, message } = require('../src/kill-guard')
const { makeContext } = require('../src/kill-owners')
const { runScript } = require('./helpers')

const blocked = [
  'taskkill /F /IM node.exe',
  'taskkill //F //IM node.exe',
  'taskkill /IM "python.exe" /F',
  'taskkill //F //IM python.exe',
  'cd app && taskkill /F /IM chrome.exe /T',
  'taskkill /F /FI "IMAGENAME eq node.exe"',
  'Stop-Process -Name node -Force',
  'Get-Process node | Stop-Process -Force',
  'gps chrome | kill',
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Invoke-CimMethod -MethodName Terminate",
  "Get-CimInstance Win32_Process | ? { $_.Name -eq 'node.exe' } | % { Stop-Process -Id $_.ProcessId }",
  'wmic process where name="node.exe" delete',
  'pkill node',
  'pkill -f next',
  'pkill -9 -f "next dev"',
  'killall -9 node',
  'kill $(pgrep node)',
  'kill -9 $(pgrep -f vite)',
  'pgrep -f python | xargs kill',
  "ps aux | grep node | awk '{print $2}' | xargs kill -9",
  'npm run build; pkill node',
  'bash -c "pkill node"',
  'pkill Electron',
  'killall Electron',
  'killall Simulator',
  'killall Xcode',
  'pkill postgres',
  'killall "Docker Desktop"',
  'killall "Code Helper"',
  'killall Cursor',
  'taskkill /F /IM Cursor.exe',
]

const allowed = [
  'xcrun simctl shutdown all',
  'electron-builder --mac',
  'pkill -f ./node_modules/electron/dist/electron',
  'git log --grep=Simulator',
  'taskkill /PID 4312 /T /F',
  'taskkill //PID 4312 //T //F',
  'taskkill /F /FI "PID eq 4312"',
  'taskkill /IM qemu-system-x86_64.exe /F',
  'Stop-Process -Id 4312 -Force',
  "Get-CimInstance Win32_Process | ? { $_.CommandLine -like '*C:\\work\\shop*' } | % { Stop-Process -Id $_.ProcessId }",
  'Get-Process node | Where-Object { $_.Id -eq 4312 } | Stop-Process',
  'lsof -ti :3000 | xargs kill',
  'kill $(lsof -ti :5173)',
  'kill -- -4312',
  "pkill -f '/home/dev/src/acme-web/server.js'",
  'pkill -f node_modules/.bin/vite',
  'pgrep -af node',
  'fuser -k 3000/tcp',
  'git commit -m "stop using pkill node in scripts"',
  'grep -rn "taskkill /IM node.exe" docs/',
  'echo "never run killall node"',
  'npm test',
  // commands people run every day that must not be blocked
  'pkill -f ./scripts/worker.py',
  'pkill -f "python scripts/worker.py"',
  'killall -0 node',
  'kill %1',
  'tail -f log & sleep 3; kill %1',
  'kill $(cat server.pid)',
  'kill -TERM $SERVER_PID',
  'docker stop web',
  'docker kill web',
  'npx kill-port 3000',
  'adb kill-server',
  'git log --grep=killall',
  'grep -r taskkill .',
  "printf 'killall node\\n'",
  "cat > notes.md <<'EOF'\nnever run pkill node here\nEOF",
  'Get-Process node | Select-Object Id, CPU',
  'ps aux | grep node',
]

test('blocks name and filter based kills', () => {
  for (const cmd of blocked) assert.ok(check(cmd), `should block: ${cmd}`)
})

test('allows PID, port and path scoped kills', () => {
  for (const cmd of allowed) assert.strictEqual(check(cmd), null, `should allow: ${cmd}`)
})

test('message says what to do instead, on each platform', () => {
  assert.match(message('x', 'win32'), /taskkill \/PID <your own pid>/)
  assert.match(message('x', 'win32'), /netstat -ano/)
  assert.match(message('x', 'linux'), /lsof -ti/)
  assert.match(message('x', 'darwin'), /kill <your own pid>/)
  assert.match(message('x', 'darwin'), /pkill -f '<your project dir>'/)
  assert.match(message('docker', 'darwin', 'docker-mass'), /docker stop <your container>/)
})

test('the first line is a whole sentence and the message stays short', () => {
  const lines = message('pkill/killall matches every process with that name', 'darwin').split('\n')
  assert.strictEqual(lines.length, 2)
  assert.match(lines[0], /with that name\.$/)
  for (const cmd of ['pkill node', 'taskkill /F /IM node.exe', 'Get-Process node | Stop-Process']) assert.match(check(cmd), /\.$/, cmd)
})

test('hook exits 2 on a block and 0 otherwise', () => {
  const hit = runScript('kill-guard', { tool_name: 'Bash', tool_input: { command: 'taskkill /F /IM node.exe' } })
  assert.strictEqual(hit.status, 2)
  assert.match(hit.stderr, /kill-guard/)
  assert.match(hit.stderr, /If the user wants this on purpose, ask them/)
  assert.doesNotMatch(hit.stderr, /BULKHEAD_DISABLE/)
  assert.strictEqual(runScript('kill-guard', { tool_name: 'Bash', tool_input: { command: 'ls' } }).status, 0)
  assert.strictEqual(runScript('kill-guard', 'not json').status, 0)
})

test('BULKHEAD_DISABLE turns it off', () => {
  const r = runScript('kill-guard', { tool_input: { command: 'pkill node' } }, { BULKHEAD_DISABLE: 'kill-guard' })
  assert.strictEqual(r.status, 0)
})

// ---- names, apps, indirection -------------------------------------------------------------

const nameBlocked = [
  'pkill -f next-server', 'pkill next-server', 'pkill next-router-worker', 'pkill uvicorn', 'pkill gunicorn', 'pkill -f gunicorn',
  'pkill -f "rails s"', 'pkill -f "flask run"', 'pkill expo', 'pkill -f metro', 'pkill storybook', 'pkill turbo', 'pkill tsc',
  'pkill qemu', 'pkill emulator', 'pkill -f "node.*next"', 'pkill nodemon', 'pkill nodejs', 'pkill node22', 'pkill python3.11',
  'pkill chrome-headless-shell', 'pkill headless_shell', "pkill 'ode'", 'pkill -f dev', 'pkill -f server', 'pkill -f "http.server"',
  'pkill -f playwright', 'pkill -f puppeteer', 'pkill -f ms-playwright', 'pkill "Google Chrome"', 'killall "Google Chrome"',
  'pkill -x "Google Chrome"', 'pkill -f "Google Chrome"', 'killall "Google Chrome Helper"', 'pkill -f "next dev|playwright"',
]

test('blocks dev server names, versioned names and Chrome by its app name', () => {
  for (const cmd of nameBlocked) assert.ok(check(cmd), `should block: ${cmd}`)
})

test('a specific -f pattern passes the name check, a bare name does not', () => {
  for (const cmd of ['pkill -f "ssh -N -L 9333"', 'pkill -f "python scripts/worker.py"', 'pkill -f "node --inspect=9229 app"', 'pkill -f "my-bot --profile alpha"', 'pkill my-private-daemon']) {
    assert.strictEqual(check(cmd), null, cmd)
  }
  for (const cmd of ['pkill -f "next dev"', 'pkill -f "node server"', 'pkill -f vite', 'pkill -f "ssh"']) assert.ok(check(cmd), cmd)
})

test('a name the user took off the list is not found inside other names', () => {
  assert.strictEqual(classify('pkill node', { allowNames: ['node'] }), null)
  assert.strictEqual(classify('pkill -f node', { allowNames: ['node'] }), null)
})

const indirect = [
  'echo "pkill node" | sh', 'echo "pkill node" | bash', 'echo "pkill node" | zsh', "printf 'pkill node' | sh",
  'source <(echo "pkill node")', 'bash <(echo "pkill node")', '. <(echo "pkill node")', 'echo node | xargs pkill', 'xargs -n1 pkill <<< node',
  'busybox pkill node', 'function k() { pkill node; }; k', 'k() { pkill node; }; k', "tmux new -d 'pkill node'", "tmux new-session -d -s x 'pkill node'",
  "tmux send-keys -t x 'pkill node' Enter", 'screen -dmS x pkill node', 'script -q /dev/null pkill node', 'script -qc "pkill node" /dev/null',
  'parallel pkill ::: node', 'parallel pkill {} ::: node python', 'cmd=pkill; $cmd node', 'cmd="pkill -f"; ${cmd} node',
  `python3 -c "import os; os.system('pkill node')"`, `python3 -c "import subprocess; subprocess.run(['pkill', 'node'])"`,
  `python3 -c "import os; os.popen('killall node')"`, `node -e "require('child_process').execSync('pkill node')"`,
  `node -e "require('child_process').spawn('pkill', ['node'])"`, `perl -e 'system("pkill node")'`, `ruby -e 'system("pkill", "node")'`,
  `php -r 'shell_exec("pkill node");'`, "python3 - <<'PY'\nimport os\nos.system('pkill node')\nPY", "node - <<'JS'\nrequire('child_process').execSync('pkill node')\nJS",
  "ssh localhost 'pkill node'", 'ssh user@127.0.0.1 "pkill -9 node"', "ssh -p 22 ::1 'pkill node'", 'eval "$(echo pkill node)"',
  "bash <<'E'\npkill node\nE", "cat <<'E' | sh\npkill node\nE", "cat <<'E' | ssh localhost bash\npkill node\nE", "sudo bash <<'E'\npkill node\nE",
]

test('reads kills hidden behind shells, pipes, terminals, functions, variables and interpreter code', () => {
  for (const cmd of indirect) assert.ok(check(cmd), `should block: ${cmd}`)
})

test('data that only mentions a kill passes', () => {
  for (const cmd of [
    "while read c; do echo \"$c\"; done <<'E'\npkill node\nE", "node test.js <<'E'\npkill node\nE", "cat <<E | wc -l\npkill node\nE",
    "cat <<'E' | ssh host bash\npkill node\nE", "ssh host bash <<'E'\npkill node\nE", "cat <<'E' | ssh prod sh\nkillall -9 node\nE",
    "python3 - <<'E'\nprint('pkill node')\nE", "node - <<'E'\nconsole.log('pkill node')\nE", "python3 -c \"print('pkill node')\"",
    'echo "pkill node" | tee stop.sh', 'echo "pkill node" | wc -l', 'echo pkill node > notes.txt', "ssh prod 'pkill node'", 'cmd=ls; $cmd node',
    "cat <<'E' > stop.sh\npkill node\nE", "git commit -F - <<'E'\npkill node\nE",
  ]) assert.strictEqual(check(cmd), null, `should allow: ${cmd}`)
})

// ---- what another live session owns --------------------------------------------------------

const T0 = Date.UTC(2026, 0, 5, 8)
const proc = (pid, ppid, name, cmd, start) => ({ pid, ppid, name, cmd, start, rss: 0, claudePid: null })

// Sessions 900100 (cwd /srv/other-project, with a dev server) and 900200 (this one, with a child).
function machine({ solo = false, reads = { n: 0 }, fail = false, cwd = '/work/mine', off = [] } = {}) {
  const procs = [
    proc(900200, 1, 'claude', 'claude', T0 + 60e3),
    proc(900210, 900200, 'node', 'node my-server.js', T0 + 70e3),
  ]
  if (!solo) {
    procs.push(
      proc(900100, 1, 'claude', 'claude', T0),
      proc(900110, 900100, 'bash', 'bash -c "npm run dev"', T0 + 10e3),
      proc(900111, 900110, 'node', 'node /srv/other/server.js', T0 + 11e3),
    )
  }
  const files = new Map(solo ? [] : [[900100, { cwd: '/srv/other-project', startedAt: 0 }]])
  files.set(900200, { cwd, startedAt: 0 })
  return makeContext({
    cwd,
    off,
    snapshot: () => { reads.n++; if (fail) throw new Error('ps failed'); return { procs, ports: [] } },
    files: () => files,
    self: () => 900200,
  })
}

const rule = (cmd, ctx, mode = 'sh', platform = process.platform) => (classify(cmd, {}, mode, ctx, platform) || {}).rule || null

const withOthers = {
  'mass-kill': ['pkill -u $USER', 'killall -u kms', 'killall -9 -u $USER', 'kill -9 -1', 'kill -9 0', 'kill 0', 'kill -KILL -1'],
  'docker-mass': [
    'docker rm -f $(docker ps -aq)', 'docker stop $(docker ps -q)', 'docker kill $(docker ps -q)', 'docker container rm -f $(docker container ls -aq)',
    'docker ps -q | xargs docker stop', 'docker system prune -af', 'docker volume prune -f', 'podman rm -f $(podman ps -aq)', 'pm2 kill', 'pm2 delete all', 'pm2 stop all',
  ],
  'device-kill': ['adb kill-server', 'adb emu kill', 'xcrun simctl shutdown all', 'xcrun simctl erase all', 'xcrun simctl shutdown booted'],
  'app-quit': [
    `osascript -e 'quit app "Safari"'`, `osascript -e 'tell application "Slack" to quit'`, 'pkill Slack', 'killall Finder', 'killall Dock', 'pkill -f CoreSimulator',
    'pkill -f simctl', 'pkill tmux', 'pkill Terminal', 'killall iTerm2', 'pkill Spotify', 'pkill Figma', 'pkill Notion', 'pkill Discord', 'pkill zoom', 'pkill -f WebKit',
    'pkill -f "Visual Studio Code"',
  ],
  'service-stop': [
    'brew services stop postgresql@16', 'brew services restart redis', 'brew services stop --all', 'launchctl bootout gui/501/homebrew.mxcl.redis',
    'launchctl unload ~/Library/LaunchAgents/homebrew.mxcl.postgresql.plist', 'launchctl kickstart -k gui/501/homebrew.mxcl.redis', 'launchctl bootout gui/501',
    'sudo systemctl stop postgresql', 'pkill redis-server', 'pkill mongod', 'pkill mysqld', 'pkill nginx', 'pkill caddy', 'pkill ngrok', 'pkill cloudflared',
  ],
}

test('mass kills, containers, devices, apps and services are blocked only while another session is alive', () => {
  for (const [name, list] of Object.entries(withOthers)) {
    for (const cmd of list) {
      assert.strictEqual(rule(cmd, machine()), name, `${name}: ${cmd}`)
      assert.strictEqual(rule(cmd, machine({ solo: true })), null, `alone: ${cmd}`)
      assert.strictEqual(rule(cmd, null), null, `no process table: ${cmd}`)
    }
  }
})

test('each of those rules has its own switch', () => {
  for (const [name, list] of Object.entries(withOthers)) {
    assert.strictEqual(rule(list[0], machine({ off: [name] })), null, name)
  }
  assert.strictEqual(rule('pkill Slack', machine({ off: ['mass-kill', 'docker-mass', 'device-kill', 'service-stop'] })), 'app-quit')
})

test('the owner and the safe alternative are in the answer', () => {
  const hit = classify('docker rm -f $(docker ps -aq)', {}, 'sh', machine())
  assert.match(hit.why, /\/srv\/other-project \(pid 900100\)/)
  assert.match(message(hit.why, 'darwin', hit.rule), /docker stop <your container>/)
})

test('scoped commands pass while another session is alive', () => {
  for (const cmd of [
    'kill 4242', 'kill -0 900111', 'kill -s 0 900111', 'kill -l', 'kill 900210', 'kill -9 900210', 'pkill -f ./scripts/worker.py', 'pkill -f "ssh -N -L 9333"', 'pkill my-private-daemon',
    'docker stop web', 'docker rm -f web', 'docker ps', 'docker ps -q', 'docker stop $(docker ps -q --filter name=shop-)', 'docker compose up -d', 'docker compose down',
    'docker system df', 'adb -s emulator-5554 emu kill', 'adb devices', 'xcrun simctl shutdown 1A2B', 'osascript -e \'display dialog "done"\'',
    `osascript -e 'quit app "My Own Tool"'`, 'brew services list', 'brew services stop my-own-thing', 'launchctl list', 'launchctl bootout gui/501/com.example.mine',
    'pm2 list', 'pm2 restart my-api', 'docker ps -q | grep web | xargs docker stop', 'export ANDROID_SERIAL=emulator-5554; adb emu kill', 'ANDROID_SERIAL=emulator-5554 adb emu kill',
  ]) assert.strictEqual(rule(cmd, machine()), null, cmd)
})

test('kill with a literal PID asks who owns it', () => {
  for (const cmd of ['kill 900111', 'kill -9 900111', 'kill -TERM 900110 900111', 'kill -- -900111', 'kill -9 900100', 'kill -s KILL 900111', 'taskkill /PID 900111 /F', 'taskkill //PID 900111 //F']) {
    assert.strictEqual(rule(cmd, machine()), 'other-session-pid', cmd)
  }
  assert.strictEqual(rule('Stop-Process -Id 900111 -Force', machine(), 'ps'), 'other-session-pid')
  assert.match(classify('kill 900111', {}, 'sh', machine()).why, /node\) belongs to the Claude session \/srv\/other-project \(pid 900100\)/)
  assert.match(classify('kill -9 900200', {}, 'sh', machine()).why, /your own Claude session/)
  assert.strictEqual(rule('kill 900111', machine({ solo: true })), null)
})

test('pkill with a specific pattern asks whether it reaches another session', () => {
  for (const cmd of ['pkill -f server.js', 'pkill -f /srv/other/server.js', 'pkill -fx "node /srv/other/server.js"', 'pkill -f "node /srv/other"', 'pkill -f "[s]erver.js"']) {
    assert.strictEqual(rule(cmd, machine()), 'other-session-match', cmd)
    assert.strictEqual(rule(cmd, machine({ solo: true })), null, `alone: ${cmd}`)
  }
  assert.strictEqual(rule('pkill -f my-server.js', machine()), null)
  assert.strictEqual(rule('pkill -f ./node_modules/electron/dist/electron', machine()), null)
  assert.strictEqual(rule('killall other-name', machine()), null)
})

test('docker compose down is blocked in a folder another session works in', () => {
  const t = machine({ cwd: '/srv/other-project' })
  assert.strictEqual(rule('docker compose down', t), 'docker-mass')
  assert.strictEqual(rule('docker-compose stop', t), 'docker-mass')
  assert.strictEqual(rule('docker compose up -d', t), null)
  assert.strictEqual(rule('docker compose down', machine({ cwd: '/srv/other-project/web' })), 'docker-mass')
  assert.strictEqual(rule('docker compose down', machine({ cwd: '/work/mine' })), null)
})

test('the process table is read once, and only when a kill needs it', () => {
  const reads = { n: 0 }
  for (const cmd of ['ls -la', 'pkill node', 'kill $PID', 'kill -9 $(cat app.pid)', 'npm test', 'docker ps', 'docker stop web', 'taskkill /F /IM node.exe']) {
    classify(cmd, {}, 'sh', machine({ reads }))
  }
  assert.strictEqual(reads.n, 0)
  classify('kill 900111; kill 900110; pkill -f server.js', {}, 'sh', machine({ reads }))
  assert.strictEqual(reads.n, 1)
  const again = machine({ reads })
  classify('kill 1', {}, 'sh', again)
  classify('docker system prune -af', {}, 'sh', again)
  assert.strictEqual(reads.n, 2)
})

test('an unreadable process table lets the command through', () => {
  assert.strictEqual(rule('kill 900111', machine({ fail: true })), null)
  assert.strictEqual(rule('docker system prune -af', machine({ fail: true })), null)
  assert.strictEqual(rule('pkill -f server.js', machine({ fail: true })), null)
})

test('without knowing which session is this one, no session counts as another', () => {
  const ctx = makeContext({ snapshot: () => ({ procs: [proc(900100, 1, 'claude', 'claude', T0), proc(900111, 900100, 'node', 'node x.js', T0 + 1)], ports: [] }), files: () => new Map(), self: () => null })
  assert.strictEqual(rule('docker system prune -af', ctx), null)
  assert.strictEqual(rule('kill 900111', ctx), null)
})

// One session alone, its own `cat`, and the desktop apps every path under /Applications carries.
function lone(extra, off = []) {
  return makeContext({
    cwd: '/work/mine',
    off,
    snapshot: () => ({ procs: [proc(900200, 1, 'claude', 'claude', T0), proc(900210, 900200, 'cat', 'cat', T0 + 1), ...extra], ports: [] }),
    files: () => new Map([[900200, { cwd: '/work/mine', startedAt: 0 }]]),
    self: () => 900200,
  })
}
const apps = [
  proc(500, 1, 'Safari', '/Applications/Safari.app/Contents/MacOS/Safari', T0),
  proc(501, 1, 'Shottr', '/Applications/Shottr.app/Contents/MacOS/Shottr', T0),
]

test('a pkill -f pattern that reaches a desktop app is blocked even with one session', () => {
  for (const cmd of ['pkill -f "cat" -n 2>/dev/null; git diff --stat', "pkill -f 'cat' -n -u 501 2>/dev/null", 'pkill -f cat']) {
    assert.strictEqual(rule(cmd, lone(apps), 'sh', 'linux'), 'broad-pattern', cmd)
  }
  // GNU pkill reads -P after the pattern as an option: only the shell's own children
  assert.strictEqual(rule("pkill -f 'cat' -P $$", lone(apps), 'sh', 'linux'), null)
  // BSD pkill reads everything after the pattern as more patterns (anthropics/claude-code#100684)
  for (const cmd of ['pkill -f "cat" -n 2>/dev/null; git diff --stat', "pkill -f 'cat' -P $$", "pkill -f 'cat' -n -u 501 2>/dev/null"]) {
    assert.strictEqual(rule(cmd, lone(apps), 'sh', 'darwin'), 'bsd-pkill', cmd)
  }
  assert.strictEqual(rule('pkill -f cat', lone(apps), 'sh', 'darwin'), 'broad-pattern')
  const hit = classify('pkill -f cat', {}, 'sh', lone(apps))
  assert.match(hit.why, /PID 500 \(Safari\), a desktop app and 1 more process outside this session/)
  assert.match(message(hit.why, 'darwin', hit.rule), /pgrep -fl '<pattern>'.*narrow nothing/s)
  assert.strictEqual(rule('pkill -f cat', lone([])), null, 'only its own cat')
  assert.strictEqual(rule('pkill -n -f cat', lone(apps)), 'broad-pattern', 'the newest match can be an app')
  assert.strictEqual(rule('pkill cat', lone(apps)), null, 'the name alone')
  assert.strictEqual(rule('pkill -f cat', lone(apps, ['broad-pattern'])), null, 'switched off')
})

test('bsd-pkill: on macOS, a long option or a second pattern is blocked (anthropics/claude-code#109627)', () => {
  const cmd = 'pkill -f "gcloud.py compute" -u kms --signal 0'
  assert.strictEqual(rule(cmd, lone([]), 'sh', 'darwin'), 'bsd-pkill')
  assert.strictEqual(rule(cmd, null, 'sh', 'darwin'), 'bsd-pkill', 'no process table needed')
  assert.strictEqual(rule(cmd, null, 'sh', 'freebsd'), 'bsd-pkill')
  const hit = classify(cmd, {}, 'sh', null, 'darwin')
  assert.match(hit.why, /"-u", "kms", "--signal", "0" after it are more patterns/)
  assert.match(message(hit.why, 'darwin', hit.rule), /pgrep -f '<pattern>', which only lists/)
  for (const c of ['pkill --signal 0 -f gcloud', 'pkill --full gcloud', 'pkill -f a b', 'pkill -9 node 0', 'sudo pkill -f x -n']) {
    assert.strictEqual(rule(c, null, 'sh', 'darwin'), 'bsd-pkill', c)
  }
  // GNU pkill: --signal 0 after the pattern is an option, and signal 0 sends nothing
  assert.strictEqual(rule(cmd, lone([]), 'sh', 'linux'), null)
  assert.strictEqual(rule('pkill -f gcloud.py --signal 0', lone([]), 'sh', 'linux'), null)
  assert.strictEqual(rule('pkill -f gcloud.py -- --signal', null, 'sh', 'linux'), null)
  // pgrep only lists, and one pattern with options before it is what BSD pkill expects
  for (const c of ['pgrep -f "gcloud.py compute" -u kms', 'pgrep -f gcloud.py', 'pkill -u kms -f "gcloud.py compute"', 'pkill -0 -f gcloud.py']) {
    assert.strictEqual(rule(c, lone([]), 'sh', 'darwin'), null, c)
  }
  assert.strictEqual(rule(cmd, lone([], ['bsd-pkill']), 'sh', 'darwin'), null, 'switched off')
})

test('BSD pkill: each extra pattern is checked like the first', () => {
  const many = Array.from({ length: 8 }, (_, i) => proc(600 + i, 1, 'python3', `python3 worker.py --id ${i}`, T0))
  assert.strictEqual(rule('pkill -f gcloud.py worker.py', lone(many, ['bsd-pkill']), 'sh', 'darwin'), 'broad-pattern')
  assert.strictEqual(rule('pkill -f gcloud.py worker.py', lone(many, ['bsd-pkill']), 'sh', 'linux'), null, 'GNU reads only the first')
  assert.strictEqual(rule('pkill gcloud node', lone([], ['bsd-pkill']), 'sh', 'darwin'), 'pkill', 'a shared name in the second place')
})

test('a pkill -f pattern that reaches many processes outside the session is blocked', () => {
  const many = Array.from({ length: 8 }, (_, i) => proc(600 + i, 1, 'python3', `python3 worker.py --id ${i}`, T0))
  assert.strictEqual(rule('pkill -f worker.py', lone(many)), 'broad-pattern')
  assert.match(classify('pkill -f worker.py', {}, 'sh', lone(many)).why, /matches 8 processes outside this session, such as PID 600 \(python3\)/)
  assert.strictEqual(rule('pkill -f worker.py', lone(many.slice(0, 7))), null)
})
