'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { checkEnforcement } = require('../src/doctor-enforcement')
const d = require('../src/doctor')
const { tempDir } = require('./helpers')

const posix = process.platform !== 'win32'

// A plugin copy whose guard is a small script: blocks, passes, or hangs.
function fakePlugin(behaviour, { timeout = 5, async = false } = {}) {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'hooks'))
  fs.mkdirSync(path.join(root, 'src'))
  const body = {
    block: "process.stderr.write('[bulkhead] kill-guard: no\\n'); process.exit(2)",
    mute: 'process.exit(2)',
    pass: 'process.exit(0)',
    hang: 'setTimeout(() => {}, 60000)',
  }[behaviour]
  fs.writeFileSync(path.join(root, 'src', 'kill-guard.js'), `process.stdin.resume()\n${body}\n`)
  const hook = { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/src/kill-guard.js'], timeout }
  if (async) hook.async = true
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [hook] }] } }))
  return root
}

// A PATH holding only `node`, so tests control what hooks can find.
function nodeOnlyPath() {
  const bin = tempDir()
  if (posix) fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  return bin
}

function setup({ root, installed = true, settings = {}, project = {}, extraInstall = [] } = {}) {
  const configDir = tempDir()
  const cwd = tempDir()
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true })
  if (installed) {
    const plugins = { 'bulkhead@bulkhead': [{ scope: 'user', installPath: root, version: '9.9.9' }, ...extraInstall] }
    fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }))
  }
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify(settings))
  fs.mkdirSync(path.join(cwd, '.claude'))
  fs.writeFileSync(path.join(cwd, '.claude', 'settings.json'), JSON.stringify(project))
  return { configDir, cwd }
}

const run = (o, env = {}) => checkEnforcement({
  root: o.root, configDir: o.configDir, cwd: o.cwd, platform: process.platform, cfg: o.cfg,
  env: { PATH: nodeOnlyPath(), BULKHEAD_MANAGED_SETTINGS: path.join(tempDir(), 'none.json'), ...env },
})
const by = (list, id) => list.find(c => c.id === id)
const ON = { enabledPlugins: { 'bulkhead@bulkhead': true } }

test('a blocking hook is proven: exit 2, message, latency', { skip: !posix }, () => {
  const root = fakePlugin('block')
  const out = run({ root, ...setup({ root, settings: ON }) })
  assert.strictEqual(by(out, 'install').status, 'OK')
  assert.match(by(out, 'install').summary, /9\.9\.9.*enabled in user settings/)
  assert.strictEqual(by(out, 'hooks.json').status, 'OK')
  assert.strictEqual(by(out, 'hook node').status, 'OK')
  const k = by(out, 'hook kill-guard')
  assert.strictEqual(k.status, 'OK', k.summary)
  assert.match(k.summary, /blocked "pkill node" \(exit 2.* in \d+ ms/)
  assert.ok(out.every(c => c.section === 'Enforcement'))
  assert.strictEqual(by(out, 'hooks on').status, 'OK')
})

test('a hook that does not block, blocks without a message, or hangs is a FAIL', { skip: !posix }, () => {
  const pass = fakePlugin('pass')
  assert.match(by(run({ root: pass, ...setup({ root: pass, settings: ON }) }), 'hook kill-guard').summary, /did not block.*exit 0.*reinstall/)
  const mute = fakePlugin('mute')
  const m = by(run({ root: mute, ...setup({ root: mute, settings: ON }) }), 'hook kill-guard')
  assert.strictEqual(m.status, 'FAIL')
  assert.match(m.summary, /message is missing/)
  const hang = fakePlugin('hang', { timeout: 1 })
  const t0 = Date.now()
  const h = by(run({ root: hang, ...setup({ root: hang, settings: ON }) }), 'hook kill-guard')
  assert.strictEqual(h.status, 'FAIL')
  assert.match(h.summary, /timed out after 1s.*lets the call through/)
  assert.ok(Date.now() - t0 < 10000)
})

test('node missing from the hook PATH fails loudly', { skip: !posix }, () => {
  const root = fakePlugin('block')
  const out = run({ root, ...setup({ root, settings: ON }) }, { PATH: tempDir() })
  assert.strictEqual(by(out, 'hook node').status, 'FAIL')
  assert.match(by(out, 'hook node').summary, /not on the PATH hooks get/)
  assert.match(by(out, 'hook kill-guard').summary, /could not start "node"/)
})

test('an async PreToolUse hook is reported, because it cannot block', { skip: !posix }, () => {
  const root = fakePlugin('block', { async: true })
  const c = by(run({ root, ...setup({ root, settings: ON }) }), 'hooks.json')
  assert.strictEqual(c.status, 'FAIL')
  assert.match(c.summary, /async.*cannot block/)
})

test('not installed, turned off, and installed without a folder', { skip: !posix }, () => {
  const root = fakePlugin('block')
  const none = run({ root, ...setup({ root, installed: false }) })
  assert.strictEqual(by(none, 'install').status, 'WARN')
  assert.match(by(none, 'install').summary, /not installed in Claude Code; run .*\/plugin install bulkhead@bulkhead/)
  assert.match(by(none, 'hooks.json').summary, /not installed/)
  const off = run({ root, ...setup({ root, settings: ON, project: { enabledPlugins: { 'bulkhead@bulkhead': false } } }) })
  assert.strictEqual(by(off, 'install').status, 'FAIL')
  assert.match(by(off, 'install').summary, /turned off in project settings.*\/plugin enable/)
  const missing = path.join(root, 'nope')
  assert.strictEqual(by(run({ root: missing, ...setup({ root: missing, settings: ON }) }), 'install').status, 'FAIL')
})

test('duplicate installs: hooks also in settings, or two installed copies', { skip: !posix }, () => {
  const root = fakePlugin('block')
  const manual = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['/x/claude-bulkhead/src/kill-guard.js'] }] }] } }
  const dup = run({ root, ...setup({ root, settings: { ...ON, ...manual } }) })
  assert.strictEqual(by(dup, 'duplicates').status, 'WARN')
  assert.match(by(dup, 'duplicates').summary, /twice/)
  const second = fakePlugin('block')
  const two = run({ root, ...setup({ root, settings: ON, extraInstall: [{ scope: 'project', installPath: second }] }) })
  assert.match(by(two, 'duplicates').summary, /2 installed copies/)
  assert.strictEqual(by(run({ root, ...setup({ root, settings: ON }) }), 'duplicates'), undefined)
})

test('settings that turn hooks off are reported with the docs', { skip: !posix }, () => {
  const root = fakePlugin('block')
  const off = by(run({ root, ...setup({ root, settings: { ...ON, disableAllHooks: true } }) }), 'hooks off')
  assert.strictEqual(off.status, 'FAIL')
  assert.match(off.summary, /disableAllHooks is true in user settings.*settings-reference#disableallhooks/)
  const undone = run({ root, ...setup({ root, settings: { ...ON, disableAllHooks: true }, project: { disableAllHooks: false } }) })
  assert.strictEqual(by(undone, 'hooks off'), undefined, 'a project false overrides a user true')
  const managed = path.join(tempDir(), 'managed-settings.json')
  fs.writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true }))
  const only = by(run({ root, ...setup({ root, settings: ON }) }, { BULKHEAD_MANAGED_SETTINGS: managed }), 'managed hooks')
  assert.strictEqual(only.status, 'FAIL')
  fs.writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true, enabledPlugins: { 'bulkhead@bulkhead': true } }))
  assert.strictEqual(by(run({ root, ...setup({ root, settings: ON }) }, { BULKHEAD_MANAGED_SETTINGS: managed }), 'managed hooks').status, 'OK')
})

test('guards turned off in config are not run', { skip: !posix }, () => {
  const root = fakePlugin('pass')
  const cfg = { values: { 'killGuard.enabled': false }, sources: {}, warnings: [] }
  const c = by(run({ root, ...setup({ root, settings: ON }), cfg }), 'hook kill-guard')
  assert.strictEqual(c.status, 'OK')
  assert.match(c.summary, /off in your config/)
})

test('the real hooks block their canaries from this checkout', { skip: !posix }, () => {
  const root = path.join(__dirname, '..')
  const out = run({ root, ...setup({ root, settings: ON }) })
  for (const g of ['kill-guard', 'wait-guard', 'disk-guard', 'basics']) assert.strictEqual(by(out, `hook ${g}`).status, 'OK', JSON.stringify(by(out, `hook ${g}`)))
})

test('doctor renders the section and exits non-zero when enforcement fails', () => {
  const text = d.render([{ id: 'node', status: 'OK', summary: 'v20' }, { id: 'install', status: 'FAIL', summary: 'x', section: 'Enforcement' }])
  assert.match(text, /\n\nEnforcement\nFAIL {2}install/)
  let out = ''
  const saved = process.exitCode
  d.main(['--json'], { stdout: { write: s => (out += s) }, env: {}, checks: () => [{ id: 'hook kill-guard', status: 'FAIL', summary: 'x', section: 'Enforcement' }] })
  const code = process.exitCode
  process.exitCode = saved
  assert.strictEqual(code, 1)
  assert.strictEqual(JSON.parse(out).checks[0].section, 'Enforcement')
})
