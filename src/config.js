'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathKey } = require('./paths')

// Settings come from three places, later ones winning:
//   1. defaults below, then the preset ("preset" in a config file or BULKHEAD_PRESET) over them
//   2. <state dir>/config.json                      (global, usually ~/.claude/bulkhead/config.json)
//   3. <project>/.claude/bulkhead.json              (project, merged over global)
//   4. environment variables                        (always win)
// A file that is not valid JSON is ignored as a whole, so the guards keep their defaults.

const GUARDS = {
  'kill-guard': 'killGuard',
  'wait-guard': 'waitGuard',
  'memory-guard': 'memoryGuard',
  'port-guard': 'portGuard',
  'checkout-guard': 'checkoutGuard',
  'disk-guard': 'diskGuard',
  basics: 'basics',
  'edit-guard': 'editGuard',
  'secrets-guard': 'secretsGuard',
  'orphan-reaper': 'orphanReaper',
  'session-state': 'sessionState',
}
// rules that can be turned off one at a time, inside a guard that stays on
const RULES = {
  'rm-root': 'basics.rmRoot',
  'force-push-main': 'basics.forcePushMain',
  'discard-changes': 'basics.discardChanges',
  'agent-author': 'basics.agentAuthor',
  'self-allow': 'basics.selfAllow',
  'stage-all': 'checkoutGuard.stageAll',
  'remove-session-dir': 'checkoutGuard.removeSessionDir',
}

const bool = (def, doc) => ({ type: 'boolean', default: def, doc })
const on = g => bool(true, `Turn ${g} on or off.`)
// In display order: each section's keys together.
const KEYS = {
  'killGuard.enabled': on('kill-guard'),
  'killGuard.allowNames': { type: 'string[]', default: [], doc: 'Program names to take off the shared list, so killing them by name passes.' },
  'killGuard.extraSharedNames': { type: 'string[]', default: [], doc: 'More program names that must not be killed by name.' },
  'waitGuard.enabled': on('wait-guard'),
  'waitGuard.limitSeconds': { type: 'number', default: 180, env: 'BULKHEAD_WAIT_MAX_SEC', doc: 'Longest foreground wait allowed, in seconds.' },
  'memoryGuard.enabled': on('memory-guard'),
  'memoryGuard.autoQueue': bool(false, 'Instead of blocking a heavy command, run it through bulkhead-slot so every session waits in one line.'),
  'memoryGuard.estimatesGb': { type: 'numbers', default: null, doc: 'RAM in GB bulkhead assumes per tool when auto-queueing, by program name: { "gradle": 6 }.' },
  'memoryGuard.waitMinutes': { type: 'number', default: 10, doc: 'How long an auto-queued command waits for room before giving up (bulkhead-slot --wait).' },
  'memoryGuard.subagents': bool(false, 'Block starting a new subagent while memory pressure is critical.'),
  'memory.minFreeGb': { type: 'number', default: null, env: 'BULKHEAD_MIN_FREE_GB', doc: 'Free RAM below which memory-guard blocks heavy commands. Default: 3, or 15% of RAM if less.' },
  'memory.slotFloorGb': { type: 'number', default: null, env: 'BULKHEAD_SLOT_FLOOR_GB', doc: 'RAM bulkhead-slot keeps free when it starts a second job. Default: 5, or 25% of RAM if less.' },
  'memory.maxCommitPct': { type: 'number', default: 75, env: 'BULKHEAD_MAX_COMMIT_PCT', doc: 'Windows commit charge above which bulkhead-slot holds a second job.' },
  'portGuard.enabled': on('port-guard'),
  'portGuard.ignorePorts': { type: 'number[]', default: [], doc: 'Ports port-guard never checks, for starting servers or for kills by port.' },
  'checkoutGuard.enabled': on('checkout-guard'),
  'checkoutGuard.stageAll': bool(true, 'Block git add -A, git add . and git commit -a when another live session works in the same tree.'),
  'checkoutGuard.removeSessionDir': bool(true, 'Block rm -rf and git worktree remove on a folder another live session works in.'),
  'diskGuard.enabled': on('disk-guard'),
  'basics.enabled': on('basics'),
  'basics.protectedBranches': { type: 'string[]', default: ['main', 'master'], doc: 'Branches force-push-main protects.' },
  'basics.rmRoot': bool(true, 'Block rm -rf at roots, top-level system folders, the home directory, folders directly in it (caches excepted) and folders above the repository.'),
  'basics.forcePushMain': bool(true, 'Block force-pushes to the protected branches.'),
  'basics.discardChanges': bool(true, 'Block git reset --hard and git clean -fd that would lose work.'),
  'basics.agentAuthor': bool(true, 'Block commits authored as Claude or Anthropic (--author, git config user.*, GIT_AUTHOR_*), so the work counts as yours.'),
  'basics.selfAllow': bool(true, 'Block the agent running bulkhead allow or writing the allow state files, so only the user approves a block.'),
  'allowOnce.ttlMinutes': { type: 'number', default: 10, doc: 'Minutes an allow-once code stays valid, and how long an approved command can still be run once.' },
  'editGuard.enabled': on('edit-guard'),
  'editGuard.mode': { type: 'string', default: 'warn', doc: 'What edit-guard does when another live session edited the same file lately: "warn" tells the agent, "ask" asks you, "block" stops the edit.' },
  'editGuard.windowMinutes': { type: 'number', default: 30, doc: 'How recent the other session\'s edit must be, in minutes.' },
  'secretsGuard.enabled': bool(false, 'Turn secrets-guard on or off. Off by default; on in the strict preset.'),
  'secretsGuard.extraPatterns': { type: 'string[]', default: [], doc: 'More files secrets-guard keeps out of the conversation: a file name (*.token) or a path pattern (~/vault/**).' },
  'secretsGuard.allow': { type: 'string[]', default: [], doc: 'Files secrets-guard lets through even though they look secret, by the same patterns.' },
  'orphanReaper.enabled': on('orphan-reaper'),
  'orphanReaper.onSessionEnd': bool(true, 'Also reap right after a session exits, not only when the next session starts.'),
  'orphanReaper.extraNames': { type: 'string[]', default: [], doc: 'More program names orphan-reaper stops once the session that started them has exited.' },
  'orphanReaper.keepNames': { type: 'string[]', default: [], doc: 'Program names orphan-reaper never stops, nor anything they started.' },
  'orphanReaper.keepPatterns': { type: 'string[]', default: [], doc: 'Text that keeps a process when it appears in its command line, such as "ssh -L" or "my-tunnel.sh". Case is ignored.' },
  'sessionState.enabled': on('session-state'),
  'notify.command': { type: 'string', default: null, globalOnly: true, doc: 'Command run (detached) when a session starts waiting for you. Gets BULKHEAD_SESSION_PROJECT, BULKHEAD_SESSION_STATE and BULKHEAD_SESSION_PID. Off by default; global config file only.' },
  'notify.minIntervalSeconds': { type: 'number', default: 30, doc: 'Least seconds between two notifications for the same session.' },
  'log.enabled': bool(true, 'Write blocks to events.jsonl. BULKHEAD_NO_LOG=1 turns it off.'),
  // Global file only (see src/remotes.js for why).
  'remote.default': { type: 'string', default: null, globalOnly: true, doc: 'The remote bulkhead remote uses when several are configured and --remote is not given.' },
  remotes: { type: 'remotes', default: {}, globalOnly: true, doc: 'Machines bulkhead remote can run jobs on: { name: { host, shell, dir, copies, maxJobs, minFreeGb, sshOptions } }.' },
}

// Layered defaults: a preset only changes the default of the keys it names, so any key a config
// file sets, and any environment variable, still wins. normal is the plain defaults. A value
// that is a function gets the machine's RAM in GB, so a threshold scales on small machines.
const round1 = n => Math.round(n * 10) / 10
const PRESETS = {
  normal: {},
  // only what protects one session from another, plus the two rules that cannot be undone
  quiet: {
    'waitGuard.enabled': false,
    'diskGuard.enabled': false,
    'basics.discardChanges': false,
    'basics.agentAuthor': false,
  },
  // everything on, with tighter limits: waits over a minute, less free RAM tolerated, more protected branches
  strict: {
    'waitGuard.limitSeconds': 60,
    'memory.minFreeGb': gb => Math.min(5, round1(gb * 0.2)),
    'memory.slotFloorGb': gb => Math.min(8, round1(gb * 0.35)),
    'memory.maxCommitPct': 65,
    'basics.protectedBranches': ['main', 'master', 'develop', 'release', 'production'],
    'secretsGuard.enabled': true,
  },
}

function presetValues(name, totalGb = os.totalmem() / 2 ** 30) {
  const out = {}
  for (const [k, v] of Object.entries(PRESETS[name] || {})) out[k] = typeof v === 'function' ? v(totalGb) : v
  return out
}

function stateDir(env = process.env) {
  return env.BULKHEAD_STATE_DIR || path.join(os.homedir(), '.claude', 'bulkhead')
}

function globalFile(env = process.env) {
  return path.join(stateDir(env), 'config.json')
}

// <dir>/.claude/bulkhead.json in the project or the nearest folder above it, stopping at the
// repository root (a .git entry) or the home directory.
function projectFile(start, { exists = fs.existsSync, home = os.homedir() } = {}) {
  if (!start) return null
  let dir = path.resolve(start)
  // the cwd and the home directory may be spelled differently (a link, C:\Users\RUNNER~1); any case, as before
  const stop = pathKey(home, 'win32')
  for (let i = 0; i < 40; i++) {
    const f = path.join(dir, '.claude', 'bulkhead.json')
    if (exists(f)) return f
    if (exists(path.join(dir, '.git')) || pathKey(dir, 'win32') === stop) return null
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}

function typeOk(type, v) {
  if (type === 'boolean') return typeof v === 'boolean'
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (type === 'string') return typeof v === 'string'
  if (type === 'string[]') return Array.isArray(v) && v.every(x => typeof x === 'string')
  if (type === 'number[]') return Array.isArray(v) && v.every(x => Number.isInteger(x) && x > 0 && x < 65536)
  if (type === 'numbers') return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'number' && x > 0)
  return false
}

// Flat { 'section.key': value } from one parsed file, with a warning for every key we do not know
// or whose value has the wrong type. Bad keys are dropped, good ones kept. `remotes` is a map
// of its own, checked entry by entry, and kept whole under the key 'remotes'.
function flatten(obj, file, warnings, scope = 'global') {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    warnings.push(`${file}: expected a JSON object`)
    return out
  }
  for (const [section, body] of Object.entries(obj)) {
    if (section === '$schema' || section === '//') continue
    if (section === 'remotes') {
      if (scope !== 'global') {
        warnings.push(`${file}: "remotes" can only be set in the global config file; ignored here`)
        continue
      }
      const { remotes, problems } = require('./remotes').normalizeAll(body)
      for (const p of problems) warnings.push(`${file}: ${p}`)
      out.remotes = remotes
      continue
    }
    if (section === 'preset') {
      if (PRESETS[body]) out.preset = body
      else warnings.push(`${file}: "preset" should be one of ${Object.keys(PRESETS).join(', ')}`)
      continue
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      warnings.push(`${file}: "${section}" should be an object`)
      continue
    }
    for (const [k, v] of Object.entries(body)) {
      const key = `${section}.${k}`
      const spec = KEYS[key]
      if (!spec) warnings.push(`${file}: unknown key "${key}"`)
      else if (spec.globalOnly && scope !== 'global') warnings.push(`${file}: "${key}" can only be set in the global config file; ignored here`)
      else if (!typeOk(spec.type, v)) warnings.push(`${file}: "${key}" should be ${spec.type}`)
      else out[key] = v
    }
  }
  return out
}

function readFile(file, warnings, read = f => fs.readFileSync(f, 'utf8'), scope = 'global') {
  let text
  try { text = read(file) } catch { return null }
  try {
    return flatten(JSON.parse(text.replace(/^\uFEFF/, '')), file, warnings, scope)
  } catch (e) {
    warnings.push(`${file} is not valid JSON (${e.message}); it is ignored until fixed`)
    return {}
  }
}

function envValue(spec, env) {
  const raw = env[spec.env]
  if (raw === undefined || raw === '') return undefined
  if (spec.type === 'number') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : undefined
  }
  return raw
}

// Defaults, then the preset, then both files merged over them. Read once per process.
function fileLayer({ env = process.env, cwd = env.CLAUDE_PROJECT_DIR || process.cwd(), read, totalGb } = {}) {
  const warnings = []
  const values = {}
  const sources = {}
  for (const [k, spec] of Object.entries(KEYS)) {
    values[k] = spec.default
    sources[k] = 'default'
  }
  const files = { global: globalFile(env), project: projectFile(cwd) }
  const parsed = []
  for (const [scope, file] of [['global', files.global], ['project', files.project]]) {
    if (!file) continue
    const got = readFile(file, warnings, read, scope)
    if (got) parsed.push({ file, got })
  }
  // the project file's preset wins over the global one; BULKHEAD_PRESET wins over both
  let preset = 'normal'
  let presetFrom = 'default'
  for (const { file, got } of parsed) if (got.preset) [preset, presetFrom] = [got.preset, file]
  if (PRESETS[String(env.BULKHEAD_PRESET || '').trim()]) [preset, presetFrom] = [env.BULKHEAD_PRESET.trim(), 'env BULKHEAD_PRESET']
  for (const [k, v] of Object.entries(presetValues(preset, totalGb))) {
    values[k] = v
    sources[k] = `preset ${preset}`
  }
  for (const { file, got } of parsed) {
    for (const [k, v] of Object.entries(got)) {
      if (k === 'preset') continue
      values[k] = v
      sources[k] = file
    }
  }
  return { values, sources, files, warnings, preset, presetFrom }
}

// { values, sources, files, warnings }. sources[key] is 'default', a file path or 'env NAME'.
function load(opts = {}) {
  return withEnv(fileLayer(opts), opts.env || process.env)
}

// Environment variables win over both files. Applied on every call, since tests and the
// slot CLI change them while running.
function withEnv(layer, env) {
  const values = { ...layer.values }
  const sources = { ...layer.sources }
  for (const [k, spec] of Object.entries(KEYS)) {
    const v = spec.env && envValue(spec, env)
    if (v !== undefined) {
      values[k] = v
      sources[k] = `env ${spec.env}`
    }
  }
  if (/^(?:1|true|yes)$/i.test(String(env.BULKHEAD_NO_LOG || '').trim())) {
    values['log.enabled'] = false
    sources['log.enabled'] = 'env BULKHEAD_NO_LOG'
  }
  const off = (env.BULKHEAD_DISABLE || '').split(/[\s,]+/).filter(Boolean)
  for (const name of off) {
    const key = GUARDS[name] ? `${GUARDS[name]}.enabled` : RULES[name]
    const keys = name === 'all' ? Object.values(GUARDS).map(s => `${s}.enabled`) : key ? [key] : []
    for (const k of keys) {
      values[k] = false
      sources[k] = 'env BULKHEAD_DISABLE'
    }
  }
  return { values, sources, files: layer.files, warnings: layer.warnings, preset: layer.preset, presetFrom: layer.presetFrom }
}

// A hook asks for many settings per call; the files are read once and the environment layer is
// rebuilt only when one of the variables it reads has changed.
let cached = null
let withEnvCache = null
let envNames = null
function envKey(env) {
  if (!envNames) envNames = [...new Set(Object.values(KEYS).map(s => s.env).filter(Boolean)), 'BULKHEAD_NO_LOG', 'BULKHEAD_DISABLE']
  return envNames.map(n => (env[n] === undefined ? '\u0000' : env[n])).join('\u0001')
}
function current() {
  if (!cached) {
    cached = fileLayer()
    withEnvCache = null
  }
  const key = envKey(process.env)
  if (!withEnvCache || withEnvCache.key !== key) withEnvCache = { key, cfg: withEnv(cached, process.env) }
  return withEnvCache.cfg
}
function reset() {
  cached = null
  withEnvCache = null
}

function get(key, cfg = current()) {
  return cfg.values[key]
}

// Whether a guard or a basics rule is on.
function isEnabled(name, cfg = current()) {
  const key = GUARDS[name] ? `${GUARDS[name]}.enabled` : RULES[name]
  return key ? cfg.values[key] !== false : true
}

module.exports = { load, current, reset, get, isEnabled, projectFile, globalFile, KEYS, GUARDS, RULES, PRESETS, presetValues, flatten }
