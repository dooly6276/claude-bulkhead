'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { load, isEnabled, PRESETS, presetValues } = require('../src/config')
const configCli = require('../src/config-cli')
const { runScript, tempDir } = require('./helpers')

function setup(globalCfg, projectCfg) {
  const state = tempDir()
  const repo = tempDir()
  fs.mkdirSync(path.join(repo, '.git'))
  if (globalCfg !== undefined) fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(globalCfg))
  if (projectCfg !== undefined) {
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'bulkhead.json'), JSON.stringify(projectCfg))
  }
  return { state, repo, env: { BULKHEAD_STATE_DIR: state } }
}
const cfgOf = (s, extra = {}, totalGb = 32) => load({ env: { ...s.env, ...extra }, cwd: s.repo, totalGb })

test('normal is the plain defaults, and is the default', () => {
  const s = setup()
  const cfg = cfgOf(s)
  assert.strictEqual(cfg.preset, 'normal')
  assert.strictEqual(cfg.presetFrom, 'default')
  for (const k of Object.keys(cfg.values)) assert.strictEqual(cfg.sources[k], 'default', k)
  assert.deepStrictEqual(PRESETS.normal, {})
})

test('quiet keeps the cross-session guards and the dangerous rules, turns the rest off', () => {
  const cfg = cfgOf(setup({ preset: 'quiet' }))
  for (const on of ['kill-guard', 'port-guard', 'checkout-guard', 'memory-guard', 'orphan-reaper', 'basics', 'rm-root', 'force-push-main', 'self-allow']) {
    assert.ok(isEnabled(on, cfg), on)
  }
  for (const off of ['wait-guard', 'disk-guard', 'discard-changes', 'agent-author']) assert.ok(!isEnabled(off, cfg), off)
  assert.strictEqual(cfg.sources['waitGuard.enabled'], 'preset quiet')
  assert.strictEqual(cfg.presetFrom, cfg.files.global)
})

test('strict tightens the thresholds, scaled to the RAM of the machine', () => {
  const s = setup({ preset: 'strict' })
  const big = cfgOf(s, {}, 32)
  assert.strictEqual(big.values['waitGuard.limitSeconds'], 60)
  assert.strictEqual(big.values['memory.minFreeGb'], 5)
  assert.strictEqual(big.values['memory.slotFloorGb'], 8)
  assert.strictEqual(big.values['memory.maxCommitPct'], 65)
  assert.deepStrictEqual(big.values['basics.protectedBranches'], ['main', 'master', 'develop', 'release', 'production'])
  const small = cfgOf(s, {}, 8)
  assert.strictEqual(small.values['memory.minFreeGb'], 1.6)
  assert.strictEqual(small.values['memory.slotFloorGb'], 2.8)
  for (const key of Object.keys(big.values).filter(k => k.endsWith('.enabled'))) assert.strictEqual(big.values[key], true, key)
  assert.strictEqual(presetValues('strict', 16)['memory.minFreeGb'], 3.2)
})

test('explicit keys win over the preset: global, then project, then environment', () => {
  const s = setup(
    { preset: 'quiet', waitGuard: { enabled: true, limitSeconds: 500 } },
    { preset: 'strict', waitGuard: { limitSeconds: 120 }, diskGuard: { enabled: false } },
  )
  const cfg = cfgOf(s)
  assert.strictEqual(cfg.preset, 'strict', 'the project preset beats the global one')
  assert.strictEqual(cfg.values['waitGuard.enabled'], true, 'a global key beats a project preset')
  assert.strictEqual(cfg.values['waitGuard.limitSeconds'], 120, 'a project key beats the preset and the global key')
  assert.strictEqual(cfg.values['diskGuard.enabled'], false)
  assert.strictEqual(cfg.values['memory.maxCommitPct'], 65, 'untouched keys take the preset')
  const env = cfgOf(s, { BULKHEAD_WAIT_MAX_SEC: '30', BULKHEAD_MAX_COMMIT_PCT: '90', BULKHEAD_DISABLE: 'kill-guard' })
  assert.strictEqual(env.values['waitGuard.limitSeconds'], 30)
  assert.strictEqual(env.values['memory.maxCommitPct'], 90)
  assert.ok(!isEnabled('kill-guard', env))
})

test('BULKHEAD_PRESET beats the files; an unknown name is a warning and normal', () => {
  const s = setup({ preset: 'strict' })
  const cfg = cfgOf(s, { BULKHEAD_PRESET: 'quiet' })
  assert.strictEqual(cfg.preset, 'quiet')
  assert.strictEqual(cfg.presetFrom, 'env BULKHEAD_PRESET')
  const bad = cfgOf(setup({ preset: 'loud' }))
  assert.strictEqual(bad.preset, 'normal')
  assert.match(bad.warnings.join('\n'), /"preset" should be one of normal, quiet, strict|"preset" should be one of quiet, normal, strict/)
})

test('bulkhead config --preset writes the global file and keeps the other keys', () => {
  const s = setup({ waitGuard: { limitSeconds: 99 }, '//': 'note' })
  let out = ''
  configCli.main(['--preset', 'quiet'], { env: s.env, stdout: { write: x => (out += x) }, stderr: { write() {} }, cwd: s.repo })
  assert.match(out, /preset quiet written to/)
  const saved = JSON.parse(fs.readFileSync(path.join(s.state, 'config.json'), 'utf8'))
  assert.deepStrictEqual(saved, { waitGuard: { limitSeconds: 99 }, '//': 'note', preset: 'quiet' })
  assert.strictEqual(cfgOf(s).preset, 'quiet')
  configCli.main(['--preset=strict'], { env: s.env, stdout: { write() {} }, stderr: { write() {} }, cwd: s.repo })
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.state, 'config.json'), 'utf8')).preset, 'strict')
})

test('--project writes the project file, creating it when needed', () => {
  const s = setup({ preset: 'quiet' })
  configCli.main(['--preset', 'strict', '--project'], { env: s.env, stdout: { write() {} }, stderr: { write() {} }, cwd: s.repo })
  const file = path.join(s.repo, '.claude', 'bulkhead.json')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { preset: 'strict' })
  assert.strictEqual(cfgOf(s).preset, 'strict')
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.state, 'config.json'), 'utf8')).preset, 'quiet', 'global untouched')
})

test('a broken config file is never overwritten; an unknown preset is refused', () => {
  const s = setup()
  fs.writeFileSync(path.join(s.state, 'config.json'), '{ nope')
  let err = ''
  const io = { env: s.env, stdout: { write() {} }, stderr: { write: x => (err += x) }, cwd: s.repo }
  const old = process.exitCode
  configCli.main(['--preset', 'quiet'], io)
  assert.match(err, /not valid JSON/)
  assert.strictEqual(fs.readFileSync(path.join(s.state, 'config.json'), 'utf8'), '{ nope')
  err = ''
  configCli.main(['--preset', 'loud'], io)
  assert.match(err, /unknown preset loud; use normal, quiet, strict/)
  process.exitCode = old
})

test('bulkhead config shows the active preset and what auto resolves to', () => {
  const s = setup({ preset: 'quiet' })
  const text = configCli.render(cfgOf(s), { totalGb: 32 })
  assert.match(text, /preset {3}quiet {2}\(from /)
  assert.match(text, /waitGuard\.enabled\s+false\s+preset quiet/)
  assert.match(text, /memory\.minFreeGb\s+auto \(3 GB on this machine\)/)
  assert.match(text, /memory\.slotFloorGb\s+auto \(5 GB on this machine\)/)
  assert.match(configCli.render(cfgOf(setup()), { totalGb: 8 }), /memory\.minFreeGb\s+auto \(1\.2 GB on this machine\)/)
})

test('the hooks follow the preset: quiet lets a long sleep through, normal blocks it', () => {
  const s = setup({ preset: 'quiet' })
  const input = { cwd: s.repo, tool_input: { command: 'sleep 200', timeout: 600000 } }
  assert.strictEqual(runScript('wait-guard', input, { BULKHEAD_STATE_DIR: s.state }).status, 0)
  assert.strictEqual(runScript('wait-guard', input, { BULKHEAD_STATE_DIR: s.state, BULKHEAD_PRESET: 'normal' }).status, 2)
})
