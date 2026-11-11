'use strict'
// bulkhead doctor, "Enforcement": proves the guards would block, not only that files exist.
// What Claude Code does with settings and hooks is taken from its docs:
//   hooks   https://code.claude.com/docs/en/hooks   (exec form, timeouts, exit code 2, async, onFailure)
//   settings https://code.claude.com/docs/en/settings-reference (disableAllHooks, allowManagedHooksOnly, enabledPlugins)
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const config = require('./config')
const { claudeDir } = require('./sessions')
const { shortPath } = require('./cli-util')

const ROOT = path.resolve(__dirname, '..')
const SECTION = 'Enforcement'
const PLUGIN = 'bulkhead'
const INSTALL = '/plugin install bulkhead@bulkhead'
const DOCS = 'https://code.claude.com/docs/en'

const mk = status => (id, summary) => ({ id, status, summary, section: SECTION })
const ok = mk('OK')
const warn = mk('WARN')
const fail = mk('FAIL')

// A harmless command each guard must block. Nothing is executed: the hook only reads the text.
const CANARIES = {
  'kill-guard.js': { guard: 'kill-guard', command: 'pkill node', stderr: /kill-guard/ },
  'wait-guard.js': { guard: 'wait-guard', command: 'sleep 100000', extra: { timeout: 3600000 }, stderr: /wait-guard/ },
  'disk-guard.js': { guard: 'disk-guard', command: 'du -sh /', stderr: /disk-guard/ },
  'basics.js': { guard: 'basics', command: 'rm -rf /', stderr: /basics/, rule: 'basics.rmRoot' },
}
const HOOK_DEFAULT_TIMEOUT_S = 600
const DOCTOR_MAX_TIMEOUT_S = 60

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function managedFile(platform, env) {
  if (env.BULKHEAD_MANAGED_SETTINGS) return env.BULKHEAD_MANAGED_SETTINGS
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json'
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json'
  return '/etc/claude-code/managed-settings.json'
}

// Lowest to highest precedence: user, project, local, managed.
function settingsFiles({ configDir, cwd, platform, env }) {
  return [
    { scope: 'user', file: path.join(configDir, 'settings.json') },
    { scope: 'project', file: path.join(cwd, '.claude', 'settings.json') },
    { scope: 'local', file: path.join(cwd, '.claude', 'settings.local.json') },
    { scope: 'managed', file: managedFile(platform, env) },
  ].map(s => ({ ...s, json: readJson(s.file) })).filter(s => s.json && typeof s.json === 'object')
}

// The last scope that sets a key wins.
function effective(files, key) {
  let found = null
  for (const s of files) if (s.json[key] !== undefined) found = { scope: s.scope, file: s.file, value: s.json[key] }
  return found
}

function enabledEntry(files) {
  let found = null
  for (const s of files) {
    const e = s.json.enabledPlugins
    if (!e || typeof e !== 'object') continue
    for (const [id, v] of Object.entries(e)) if (id.split('@')[0] === PLUGIN) found = { id, value: v, scope: s.scope, file: s.file }
  }
  return found
}

function installs(configDir) {
  const j = readJson(path.join(configDir, 'plugins', 'installed_plugins.json'))
  const out = []
  for (const [id, list] of Object.entries((j && j.plugins) || {})) {
    if (id.split('@')[0] !== PLUGIN) continue
    for (const e of Array.isArray(list) ? list : []) out.push({ id, scope: e.scope, installPath: e.installPath, version: e.version })
  }
  return out
}

function hasMarketplace(configDir) {
  const j = readJson(path.join(configDir, 'plugins', 'known_marketplaces.json'))
  return Object.entries(j || {}).some(([name, v]) => name === PLUGIN || /claude-bulkhead/.test(JSON.stringify(v)))
}

// Hooks written by hand into a settings file: not the plugin's own.
function manualHooks(files) {
  const out = []
  for (const s of files) {
    for (const groups of Object.values(s.json.hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of g.hooks || []) {
          if (/bulkhead|(kill|wait|port|checkout|disk|memory)-guard\.js/.test([h.command, ...(h.args || [])].join(' '))) out.push(s)
        }
      }
    }
  }
  return [...new Set(out)]
}

function checkInstall(ctx) {
  const { files, configDir } = ctx
  const list = installs(configDir)
  const entry = enabledEntry(files)
  const manual = manualHooks(files)
  const out = []
  const live = list.filter(i => i.installPath && fs.existsSync(path.join(i.installPath, 'hooks', 'hooks.json')))
  if (!list.length && !(entry && entry.value === true)) {
    if (manual.length) out.push(ok('install', `by hand: bulkhead hooks in ${manual.map(m => shortPath(m.file)).join(', ')}`))
    else out.push(warn('install', `not installed in Claude Code; run ${hasMarketplace(configDir) ? '' : '/plugin marketplace add dooly6276/claude-bulkhead, then '}${INSTALL}`))
    return { checks: out, installed: null }
  }
  if (entry && entry.value === false) {
    out.push(fail('install', `${entry.id} is turned off in ${entry.scope} settings (${shortPath(entry.file)}); run /plugin enable ${entry.id}`))
    return { checks: out, installed: live[0] || null }
  }
  if (!live.length) {
    out.push(fail('install', `${list[0] ? `${shortPath(list[0].installPath || '?')} has no hooks/hooks.json` : `${entry.id} is enabled but not installed`}; reinstall with ${INSTALL}`))
    return { checks: out, installed: null }
  }
  const i = live[0]
  const state = entry ? `enabled in ${entry.scope} settings` : 'no enabledPlugins entry, so Claude Code uses the plugin default'
  const text = `${i.id}${i.version ? ` ${i.version}` : ''} at ${shortPath(i.installPath)}, ${state}`
  out.push(entry ? ok('install', text) : warn('install', `${text}; run /plugin enable ${i.id}`))
  const roots = [...new Set(live.map(l => l.installPath))]
  if (roots.length > 1) out.push(warn('duplicates', `${roots.length} installed copies (${live.map(l => l.scope || '?').join(', ')}); every guard may run once per copy. Keep one: /plugin uninstall for the extra scope`))
  if (manual.length) out.push(warn('duplicates', `bulkhead hooks are in ${manual.map(m => shortPath(m.file)).join(', ')} and in the plugin, so each call runs the guards twice; delete the hooks from the settings file`))
  return { checks: out, installed: i }
}

// Settings that make Claude Code skip hooks, as the settings reference documents them.
function checkSettings(ctx) {
  const { files, installed } = ctx
  const out = []
  const off = effective(files, 'disableAllHooks')
  if (off && off.value === true) {
    out.push(off.scope === 'managed'
      ? fail('hooks off', `disableAllHooks is true in managed settings (${shortPath(off.file)}); no hook runs. Ask your administrator (${DOCS}/settings-reference#disableallhooks)`)
      : fail('hooks off', `disableAllHooks is true in ${off.scope} settings (${shortPath(off.file)}): Claude Code turns off plugin hooks. Remove it or set it to false (${DOCS}/settings-reference#disableallhooks)`))
  }
  const managed = effective(files, 'allowManagedHooksOnly')
  if (managed && managed.scope === 'managed' && managed.value === true) {
    const forced = files.some(s => s.scope === 'managed' && s.json.enabledPlugins && Object.entries(s.json.enabledPlugins).some(([id, v]) => id.split('@')[0] === PLUGIN && v === true))
    out.push(forced
      ? ok('managed hooks', 'allowManagedHooksOnly is on, and managed settings force-enable the plugin')
      : fail('managed hooks', `allowManagedHooksOnly is true in managed settings, so plugin hooks do not run unless managed enabledPlugins force-enables ${PLUGIN}@... (${DOCS}/settings-reference#what-runs-under-allowmanagedhooksonly)`))
  }
  const blocked = files.find(s => s.scope === 'managed' && s.json.enabledPlugins && Object.entries(s.json.enabledPlugins).some(([id, v]) => id.split('@')[0] === PLUGIN && v === false))
  if (blocked) out.push(fail('managed plugin', `managed settings turn ${PLUGIN} off and block its installation (${DOCS}/settings-reference#enabledplugins)`))
  if (!out.length && installed) out.push(ok('hooks on', 'no disableAllHooks or allowManagedHooksOnly in user, project, local or managed settings'))
  return out
}

function substitute(text, vars) {
  return String(text).replace(/\$\{(CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_DATA)\}/g, (_, k) => vars[k])
}

function hookDeclarations(root) {
  const file = path.join(root, 'hooks', 'hooks.json')
  let json
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return { file, error: e.code === 'ENOENT' ? 'is missing' : `cannot be read (${e.message})` } }
  const list = []
  for (const g of (json.hooks && json.hooks.PreToolUse) || []) for (const h of g.hooks || []) list.push({ matcher: g.matcher || '', ...h })
  return { file, list }
}

function findOnPath(name, env, platform) {
  const sep = platform === 'win32' ? ';' : ':'
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD').split(';')] : ['']
  for (const dir of String(env.PATH || env.Path || '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext)
      try { if (fs.statSync(p).isFile()) return p } catch {}
    }
  }
  return null
}

// Starts the hook the way Claude Code does: exec form (args present) spawns command directly on PATH,
// shell form goes through bash, or PowerShell when the hook asks for it. Same placeholders, same timeout.
function runHook(h, vars, { env, platform, spawn, input, timeoutS }) {
  const hookEnv = { ...env, CLAUDE_PLUGIN_ROOT: vars.CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR: vars.CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_DATA: vars.CLAUDE_PLUGIN_DATA }
  const opts = { input, encoding: 'utf8', timeout: timeoutS * 1000, env: hookEnv, windowsHide: true, killSignal: 'SIGKILL' }
  if (Array.isArray(h.args)) return spawn(substitute(h.command, vars), h.args.map(a => substitute(a, vars)), opts)
  const cmd = substitute(h.command, vars)
  if (h.shell === 'powershell') return spawn('powershell', ['-NoProfile', '-Command', cmd], opts)
  const bash = platform === 'win32' ? findOnPath('bash', env, platform) : '/bin/bash'
  return bash ? spawn(bash, ['-c', cmd], opts) : spawn('powershell', ['-NoProfile', '-Command', cmd], opts)
}

function canaryOf(h) {
  const script = [h.command, ...(h.args || [])].map(String).find(a => /\.js$/.test(a))
  return script ? CANARIES[path.basename(script)] || null : null
}

function checkHooks(ctx) {
  const { root, installed, env, platform, spawn, cfg } = ctx
  const out = []
  const where = installed ? 'installed copy' : 'this copy (not installed)'
  const decl = hookDeclarations(root)
  if (decl.error) return [fail('hooks.json', `${shortPath(decl.file)} ${decl.error}; reinstall with ${INSTALL}`)]
  const asyncHooks = decl.list.filter(h => h.async === true || h.asyncRewake === true)
  if (asyncHooks.length) out.push(fail('hooks.json', `${asyncHooks.length} PreToolUse hook${asyncHooks.length === 1 ? ' is' : 's are'} async, and an async hook cannot block (${DOCS}/hooks#run-hooks-in-the-background)`))
  else out.push(ok('hooks.json', `${where}: ${decl.list.length} PreToolUse hooks, all synchronous`))

  // node must resolve on the PATH the hook gets
  const first = decl.list.find(h => Array.isArray(h.args))
  if (first) {
    const resolved = findOnPath(first.command, env, platform)
    if (!resolved) out.push(fail('hook node', `"${first.command}" is not on the PATH hooks get, so every hook fails to start and Claude Code lets the call through; put Node 18+ on PATH for the shell that starts Claude Code`))
    else {
      const v = spawn(resolved, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 10000, windowsHide: true })
      const ver = String(v.stdout || '').trim()
      const major = Number(ver.split('.')[0])
      out.push(major >= 18 ? ok('hook node', `${shortPath(resolved)} v${ver}`) : fail('hook node', `${shortPath(resolved)} ${ver ? `is v${ver}` : 'does not run'}; hooks need Node 18 or later first on PATH`))
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulkhead-doctor-'))
  const vars = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: tmp, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data') }
  try {
    for (const h of decl.list) {
      const canary = canaryOf(h)
      if (!canary) continue
      const rule = canary.rule
      if (cfg && (cfg.values[`${config.GUARDS[canary.guard]}.enabled`] === false || (rule && cfg.values[rule] === false))) {
        out.push(ok(`hook ${canary.guard}`, 'off in your config, not run'))
        continue
      }
      if (h.matcher && !new RegExp(`^(?:${h.matcher})$`).test('Bash')) {
        out.push(fail(`hook ${canary.guard}`, `its matcher "${h.matcher}" does not match the Bash tool`))
        continue
      }
      const timeoutS = Math.min(h.timeout || HOOK_DEFAULT_TIMEOUT_S, DOCTOR_MAX_TIMEOUT_S)
      const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: canary.command, ...canary.extra }, session_id: 'bulkhead-doctor', cwd: tmp, permission_mode: 'default' })
      const t0 = Date.now()
      const r = runHook(h, vars, {
        env: { ...env, BULKHEAD_STATE_DIR: tmp, BULKHEAD_DISABLE: '', BULKHEAD_NO_LOG: '1' }, platform, spawn, input, timeoutS,
      })
      const ms = Date.now() - t0
      const id = `hook ${canary.guard}`
      if (r.error && r.error.code === 'ENOENT') out.push(fail(id, `could not start "${h.command}" (not found); no call is blocked. Put Node 18+ on PATH`))
      else if (r.error && (r.error.code === 'ETIMEDOUT' || r.signal)) out.push(fail(id, `timed out after ${timeoutS}s; Claude Code lets the call through when a PreToolUse hook times out (${DOCS}/hooks#timeouts). Run bulkhead doctor again, then report it`))
      else if (r.status === 2 && canary.stderr.test(r.stderr || '')) out.push(ok(id, `blocked "${canary.command}" (exit 2, message shown to Claude) in ${ms} ms`))
      else if (r.status === 2) out.push(fail(id, `exit 2 but the message is missing, Claude would not see why: ${String(r.stderr || '').trim().slice(0, 80) || '(empty)'}`))
      else out.push(fail(id, `did not block "${canary.command}" (exit ${r.status}${r.stderr ? `: ${String(r.stderr).trim().split('\n')[0].slice(0, 80)}` : ''}); reinstall with ${INSTALL}`))
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
  return out
}

function checkEnforcement({
  root = ROOT, env = process.env, cwd = process.cwd(), platform = process.platform, spawn = spawnSync, cfg = null,
  configDir = env.CLAUDE_CONFIG_DIR || claudeDir(),
} = {}) {
  const files = settingsFiles({ configDir, cwd, platform, env })
  const ctx = { root, env, platform, spawn, cfg, files, configDir, cwd }
  let inst
  try { inst = checkInstall(ctx) } catch (e) { return [fail('install', `could not read the Claude Code install: ${e.message}`)] }
  // the hooks.json Claude Code runs is the installed copy's; without an install, test this copy
  const runRoot = inst.installed && inst.installed.installPath ? inst.installed.installPath : root
  const out = [...inst.checks, ...checkSettings({ files, installed: inst.installed })]
  out.push(...checkHooks({ ...ctx, root: runRoot, installed: inst.installed && inst.installed.installPath ? inst.installed : null }))
  return out
}

module.exports = { checkEnforcement, SECTION, CANARIES, findOnPath, managedFile }
