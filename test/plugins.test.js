'use strict'
// The plugin bundles for other hosts: Agent Plugins / Copilot CLI (plugin.json at the root and
// com.github.copilot/hooks/hooks.json), Cursor (.cursor-plugin/) and opencode (opencode/plugin.mjs,
// the npm entry). They must parse, carry the package version, and call `bulkhead hook` with the
// right --agent through a file that exists.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { pathToFileURL } = require('url')
const { OPENCODE_PLUGIN, pluginSource } = require('../src/agent-setup')

const root = path.join(__dirname, '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const json = f => JSON.parse(read(f))
const pkg = json('package.json')

test('every plugin manifest carries the package version', () => {
  for (const f of ['plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json']) {
    assert.strictEqual(json(f).version, pkg.version, f)
  }
})

test('root plugin.json follows Agent Plugins 1.0.0, the format awesome-copilot checks', () => {
  const m = json('plugin.json')
  assert.strictEqual(m.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
  const allowed = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']
  for (const k of Object.keys(m)) assert.ok(allowed.includes(k), `field ${k} is not in Agent Plugins 1.0.0`)
  assert.match(m.name, /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  assert.strictEqual(m.name, json('.claude-plugin/plugin.json').name)
  for (const k of Object.keys(m.author)) assert.ok(['name', 'email', 'url'].includes(k), `author.${k}`)
  assert.ok(m.description && m.license)
})

test('the Copilot hook runs bin/bulkhead from the plugin root with --agent copilot', () => {
  const h = json('com.github.copilot/hooks/hooks.json')
  assert.strictEqual(h.version, 1)
  const [hook, ...rest] = h.hooks.preToolUse
  assert.strictEqual(rest.length, 0)
  assert.strictEqual(hook.type, 'command')
  assert.deepStrictEqual(hook.env, { BULKHEAD_PLUGIN_ROOT: '${PLUGIN_ROOT}' })
  assert.match(hook.bash, /^node "\$BULKHEAD_PLUGIN_ROOT\/bin\/bulkhead" hook --agent copilot$/)
  assert.match(hook.powershell, /\$env:BULKHEAD_PLUGIN_ROOT 'bin\/bulkhead'\) hook --agent copilot$/)
  assert.ok(hook.timeoutSec > 0)
  assert.ok(fs.existsSync(path.join(root, 'bin', 'bulkhead')))
})

test('the Cursor manifest points to its own hooks file, not the Claude Code one', () => {
  const m = json('.cursor-plugin/plugin.json')
  assert.strictEqual(m.name, 'bulkhead')
  assert.notStrictEqual(m.hooks, 'hooks/hooks.json')
  for (const f of [m.hooks, m.logo, m.skills]) {
    assert.ok(!path.isAbsolute(f) && !f.split('/').includes('..'), f)
    assert.ok(fs.existsSync(path.join(root, f)), f)
  }
  const h = json(m.hooks)
  assert.strictEqual(h.version, 1)
  const [hook, ...rest] = h.hooks.beforeShellExecution
  assert.strictEqual(rest.length, 0)
  // Cursor runs plugin hooks from the plugin's install directory
  assert.strictEqual(hook.command, 'node ./bin/bulkhead hook --agent cursor')
})

test('the Claude Code hooks file is still where Claude Code reads it', () => {
  const h = json('hooks/hooks.json')
  assert.ok(h.hooks.PreToolUse.some(g => g.hooks.some(x => x.args && x.args[0] === '${CLAUDE_PLUGIN_ROOT}/src/bash-guards.js')))
})

test('the hook commands block and allow through the real CLI', () => {
  const env = { ...process.env, BULKHEAD_PLUGIN_ROOT: root }
  const sh = (cmd, input) => spawnSync('sh', ['-c', cmd], { cwd: root, env, input, encoding: 'utf8' })
  const copilot = json('com.github.copilot/hooks/hooks.json').hooks.preToolUse[0].bash
  const kill = 'pk' + 'ill node'
  let r = sh(copilot, JSON.stringify({ toolName: 'bash', toolArgs: JSON.stringify({ command: kill }), cwd: root }))
  assert.strictEqual(r.status, 0)
  assert.strictEqual(JSON.parse(r.stdout).permissionDecision, 'deny')
  r = sh(copilot, JSON.stringify({ toolName: 'bash', toolArgs: JSON.stringify({ command: 'ls' }), cwd: root }))
  assert.strictEqual(r.stdout, '')
  const cursor = json('.cursor-plugin/hooks.json').hooks.beforeShellExecution[0].command
  r = sh(cursor, JSON.stringify({ command: kill, cwd: root }))
  assert.strictEqual(JSON.parse(r.stdout).permission, 'deny')
  r = sh(cursor, JSON.stringify({ command: 'ls', cwd: root }))
  assert.strictEqual(JSON.parse(r.stdout).permission, 'allow')
})

test('opencode loads the package entry, which is the same plugin `bulkhead setup opencode` writes', async () => {
  // opencode 1.x resolves an npm plugin through exports["./server"], else main
  assert.strictEqual(pkg.exports['./server'], './opencode/plugin.mjs')
  assert.strictEqual(pkg.main, 'opencode/plugin.mjs')
  assert.ok(pkg.files.includes('opencode'))
  assert.strictEqual(pkg.exports['./*'], './*', 'deep paths stay importable')
  const src = read('opencode/plugin.mjs')
  assert.ok(src.endsWith(OPENCODE_PLUGIN))
  assert.ok(pluginSource('opencode', ['node', 'x']).endsWith(OPENCODE_PLUGIN))
  assert.match(src, /new URL\('\.\.\/bin\/bulkhead', import\.meta\.url\)/)

  const mod = await import(pathToFileURL(path.join(root, 'opencode', 'plugin.mjs')).href)
  assert.deepStrictEqual(Object.keys(mod), ['BulkheadPlugin'])
  const before = (await mod.BulkheadPlugin({ directory: root }))['tool.execute.before']
  await assert.rejects(before({ tool: 'bash', sessionID: 's' }, { args: { command: 'pk' + 'ill node' } }), /kill-guard/)
  await before({ tool: 'bash', sessionID: 's' }, { args: { command: 'ls' } })
  await before({ tool: 'read', sessionID: 's' }, { args: {} })
})
