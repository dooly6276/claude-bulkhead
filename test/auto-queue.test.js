'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { autoQueue, queueOutput } = require('../src/memory-guard')
const { wrap, quoters, backgrounded, wrapped, estimateGb, labelFor, slotScript, which } = require('../src/auto-queue')
const { runScript, tempDir, posixShell } = require('./helpers')

const SCRIPT = '/opt/bulkhead/bin/bulkhead-slot'
const opts = { script: SCRIPT, node: '/usr/bin/node', wait: 10 }
const bash = command => ({ tool_name: 'Bash', tool_input: { command } })
const ps = command => ({ tool_name: 'PowerShell', tool_input: { command } })

test('wrap decision table', () => {
  const wrapsAs = (input, label, gb) => {
    const q = autoQueue(input, opts)
    assert.ok(q, JSON.stringify(input))
    assert.strictEqual(q.label, label)
    assert.strictEqual(q.gb, gb)
  }
  wrapsAs(bash('npm test'), 'npm test', 3)
  wrapsAs(bash('cd web && npx vitest run'), 'vitest run', 3)
  wrapsAs(bash('cargo build --release'), 'cargo build', 4)
  wrapsAs(bash('./gradlew assembleDebug'), 'gradlew assembleDebug', 4)
  wrapsAs(bash('xcodebuild -scheme App build'), 'xcodebuild App', 6)
  wrapsAs(bash('docker build -t app .'), 'docker build', 3)
  wrapsAs(bash('node -e "require(\'playwright\').chromium.launch()"'), 'browser', 3)
  wrapsAs(ps('npx playwright test'), 'playwright test', 4)

  const left = [
    bash('ls -la'), bash('git commit -m "run npm test"'), bash('grep -rn vitest src'),
    bash('npm run dev'), bash(''),
    { tool_name: 'Bash', tool_input: { command: 'npm test', run_in_background: true } },
    bash('npm test &'), bash('nohup npm run build > out.log 2>&1 &'), bash('npm test & wait'),
    bash('ssh build-host npm test'), bash('npm test && ssh box ls'),
    bash('bulkhead-slot run --gb=3 -- npm test'), bash('bulkhead slot run -- npm test'),
    bash('next dev'), bash('emulator -avd Pixel_7'), bash('docker compose up'),
    ps('Start-Process npm -ArgumentList test'), { tool_name: 'Bash', tool_input: {} },
  ]
  for (const i of left) assert.strictEqual(autoQueue(i, opts), null, JSON.stringify(i))
  // detached compose returns at once, so it is queued; 2>&1 and && are not backgrounding
  assert.ok(autoQueue(bash('docker compose up -d'), opts))
  assert.ok(autoQueue(bash('npm test 2>&1 | tail -5'), opts))
  assert.ok(autoQueue(bash('npm ci && npm test 2>&1'), opts))
})

test('the estimate table is configurable', () => {
  assert.strictEqual(estimateGb('gradle'), 4)
  assert.strictEqual(estimateGb('gradle', { gradle: 8 }), 8)
  assert.strictEqual(estimateGb('gradle', { gradle: -1 }), 4)
  assert.strictEqual(estimateGb('unknown-tool'), 3)
  assert.strictEqual(autoQueue(bash('cargo build'), { ...opts, estimates: { cargo: 9 } }).gb, 9)
  assert.match(autoQueue(bash('cargo build'), { ...opts, estimates: { cargo: 9 } }).command, /--gb=9 /)
})

test('labels never carry quote characters', () => {
  assert.strictEqual(labelFor(['npm', 'test']), 'npm test')
  assert.strictEqual(labelFor(['npm', '--silent', "te'st\"$x"]), 'npm te_st__x')
})

const HOSTILE = [`echo "it's $HOME"`, 'echo `date`', 'a\nb', "it's", 'say "hi" && echo $(id)', 'C:\\Program Files\\x', '']

test('bash quoting round-trips through a real shell', () => {
  for (const text of HOSTILE) {
    const out = spawnSync(posixShell(), ['-c', `printf %s ${quoters.sh(text)}`], { encoding: 'utf8' })
    assert.strictEqual(out.stdout, text, JSON.stringify(text))
  }
  assert.strictEqual(quoters.sh('plain-word_1.2/x'), 'plain-word_1.2/x')
})

test('the whole bash wrapper hands the original command to bash -c unchanged', () => {
  for (const text of ['npm test', ...HOSTILE.slice(0, 5).map(t => `npm test -- ${t}`)]) {
    const line = wrap(text, { shell: 'sh', script: SCRIPT, node: '/usr/bin/node', gb: 3, label: 'npm test', wait: 10 })
    assert.ok(line.startsWith("/usr/bin/node /opt/bulkhead/bin/bulkhead-slot run --gb=3 '--label=npm test' --wait=10 -- bash -c "), line)
    // let a shell parse the tail and print the argv it would pass on
    const argv = spawnSync(posixShell(), ['-c', `set -- ${line.slice(line.indexOf('-- ') + 3)}; printf '%s\\0' "$@"`], { encoding: 'utf8' }).stdout.split('\0').slice(0, -1)
    assert.deepStrictEqual(argv, ['bash', '-c', text])
  }
})

test('PowerShell wrapper carries the command as an encoded script', () => {
  const text = `Write-Host "it's $env:HOME" ; \`n 'x'\nnpm test`
  const exists = f => f.endsWith('pwsh')
  const line = wrap(text, { shell: 'ps', script: 'C:\\p\\bin\\bulkhead-slot', node: 'C:\\Program Files\\nodejs\\node.exe', gb: 4, label: "it's", env: { PATH: '/usr/bin' }, exists, platform: 'linux' })
  assert.ok(line.startsWith("& 'C:\\Program Files\\nodejs\\node.exe' C:\\p\\bin\\bulkhead-slot run --gb=4 '--label=it''s' -- pwsh -NoProfile -EncodedCommand "), line)
  const b64 = line.split(' ').pop()
  assert.strictEqual(Buffer.from(b64, 'base64').toString('utf16le'), text)
  assert.match(b64, /^[A-Za-z0-9+/=]+$/)
  // without pwsh on PATH it is Windows PowerShell
  assert.match(wrap('npm test', { shell: 'ps', script: 'S', node: 'N', gb: 3, label: 'x', env: { PATH: '' }, exists: () => false, platform: 'win32' }), /-- powershell -NoProfile/)
  assert.strictEqual(which('pwsh', { PATH: 'C:\\a;C:\\b' }, f => f === path.join('C:\\b', 'pwsh.exe'), 'win32'), 'pwsh')
})

test('cmd wrapper doubles inner quotes and refuses newlines', () => {
  const line = wrap('npm test -- --grep "a b" & echo %X%', { shell: 'cmd', script: 'S', node: 'N', gb: 3, label: 'npm test' })
  assert.strictEqual(line, 'N S run --gb=3 "--label=npm test" -- "npm test -- --grep ""a b"" & echo %X%"')
  assert.strictEqual(quoters.cmd('plain'), 'plain')
  assert.strictEqual(wrap('npm test\nnpm ci', { shell: 'cmd', script: 'S', node: 'N', gb: 3, label: 'x' }), null)
  assert.strictEqual(wrap('npm test', { shell: 'fish', script: 'S', gb: 3, label: 'x' }), null)
})

test('idempotent: a wrapped command is never wrapped again', () => {
  const first = autoQueue(bash('npm test'), opts)
  assert.ok(wrapped(first.command))
  assert.strictEqual(autoQueue(bash(first.command), opts), null)
  const p = autoQueue(ps('npm test'), opts)
  assert.strictEqual(autoQueue(ps(p.command), opts), null)
})

test('backgrounding is told apart from && and redirects', () => {
  assert.ok(backgrounded('npm test &'))
  assert.ok(backgrounded('npm test & sleep 1'))
  assert.ok(backgrounded('setsid npm test'))
  assert.ok(!backgrounded('npm ci && npm test'))
  assert.ok(!backgrounded('npm test 2>&1 | tee out'))
  assert.ok(!backgrounded('npm test &> out'))
  assert.ok(!backgrounded('npm test -- --grep "a & b"'))
  assert.ok(backgrounded('Start-Job { npm test }', 'ps'))
  assert.ok(!backgrounded('npm test', 'ps'))
})

test('fails open when the slot script is missing', () => {
  assert.strictEqual(autoQueue(bash('npm test'), { ...opts, script: null }), null)
  assert.strictEqual(slotScript({ env: {}, exists: () => false }), null)
  assert.strictEqual(slotScript({ env: { CLAUDE_PLUGIN_ROOT: '/plugin' }, exists: f => f === path.join('/plugin', 'bin', 'bulkhead-slot') }), path.join('/plugin', 'bin', 'bulkhead-slot'))
  // no plugin root: the package's own bin
  assert.ok(slotScript({ env: {} }).endsWith(path.join('bin', 'bulkhead-slot')))
})

test('output uses updatedInput and leaves the permission decision to the user', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests', timeout: 60000 } }
  const out = queueOutput(input, autoQueue(input, opts)).hookSpecificOutput
  assert.strictEqual(out.hookEventName, 'PreToolUse')
  assert.ok(!('permissionDecision' in out))
  assert.strictEqual(out.updatedInput.description, 'run tests')
  assert.strictEqual(out.updatedInput.timeout, 60000)
  assert.match(out.updatedInput.command, /bulkhead-slot run --gb=3 '--label=npm test' --wait=10 -- bash -c 'npm test'$/)
})

function hook(config, input, env = {}) {
  const state = tempDir()
  if (config) fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config))
  return runScript('memory-guard', input, { BULKHEAD_STATE_DIR: state, BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 60, totalGb: 64 }), ...env })
}

test('opt-in: off leaves the output unchanged, on rewrites whatever the free RAM is', () => {
  const input = bash('npm test')
  for (const config of [null, { memoryGuard: { autoQueue: false } }]) {
    const r = hook(config, input)
    assert.strictEqual(r.status, 0)
    assert.strictEqual(r.stdout, '')
  }
  const on = hook({ memoryGuard: { autoQueue: true, waitMinutes: 5, estimatesGb: { npm: 7 } } }, input)
  assert.strictEqual(on.status, 0, on.stderr)
  const out = JSON.parse(on.stdout).hookSpecificOutput
  assert.match(out.updatedInput.command, /run --gb=7 '--label=npm test' --wait=5 -- bash -c 'npm test'$/)
  // low RAM: with autoQueue the command is queued instead of blocked; without it, blocked as before
  const low = { BULKHEAD_TEST_MEMORY: JSON.stringify({ freeGb: 0.5, totalGb: 16 }) }
  assert.strictEqual(hook({ memoryGuard: { autoQueue: true } }, input, low).status, 0)
  assert.strictEqual(hook(null, input, low).status, 2)
  // a long-running heavy command keeps the old block-when-low behaviour
  assert.strictEqual(hook({ memoryGuard: { autoQueue: true } }, bash('next dev'), low).status, 2)
  // memory-guard off: nothing happens
  assert.strictEqual(hook({ memoryGuard: { autoQueue: true } }, input, { BULKHEAD_DISABLE: 'memory-guard' }).stdout, '')
})

test('garbage input fails open', () => {
  assert.strictEqual(hook({ memoryGuard: { autoQueue: true } }, 'not json').status, 0)
  assert.strictEqual(hook({ memoryGuard: { autoQueue: true } }, { tool_name: 'Bash', tool_input: { command: 42 } }).stdout, '')
})
