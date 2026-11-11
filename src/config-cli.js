'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { load, KEYS, PRESETS, globalFile, projectFile } = require('./config')
const { useColor, paint, shortPath, table, rejectArgs, option } = require('./cli-util')

function fileState(file, warnings) {
  if (!file) return 'none found'
  if (!fs.existsSync(file)) return 'not found'
  return warnings.some(w => w.startsWith(file) && /not valid JSON/.test(w)) ? 'INVALID, ignored' : 'loaded'
}

const USAGE = `usage: bulkhead config [--json]
       bulkhead config --preset quiet|normal|strict [--project]

Without options, prints every setting, its value and where the value came from.
--preset writes "preset" into the global config file, or with --project into this project's
.claude/bulkhead.json, keeping every other key. quiet: only the cross-session guards and the
rules that cannot be undone. normal: the defaults. strict: everything on, with tighter limits.
Keys you set yourself and environment variables still win over a preset.`

// The two RAM limits left on auto, as the number they work out to on this machine.
function autoValue(key, totalGb) {
  const { autoLimits } = require('./slots')
  const a = autoLimits(totalGb)
  const gb = key === 'memory.minFreeGb' ? a.minFreeGb : key === 'memory.slotFloorGb' ? a.floorGb : null
  return gb == null ? 'auto' : `auto (${gb} GB on this machine)`
}

// The remotes map is long; the table shows the names and `bulkhead remote list` the rest.
const show = (v, key, totalGb) => (v === null ? autoValue(key, totalGb) : key === 'remotes' ? Object.keys(v).join(', ') || 'none' : JSON.stringify(v))

function render(cfg, { color = false, home, totalGb = os.totalmem() / 2 ** 30 } = {}) {
  const out = []
  out.push(paint(color, 'bold', 'Files (project wins over global, environment wins over both)'))
  out.push(`  global   ${shortPath(cfg.files.global, home)}  ${fileState(cfg.files.global, cfg.warnings)}`)
  out.push(`  project  ${cfg.files.project ? shortPath(cfg.files.project, home) : '<repo>/.claude/bulkhead.json'}  ${fileState(cfg.files.project, cfg.warnings)}`)
  out.push(`  preset   ${cfg.preset || 'normal'}  ${cfg.presetFrom && cfg.presetFrom !== 'default' ? `(from ${cfg.presetFrom.startsWith('env ') ? cfg.presetFrom : shortPath(cfg.presetFrom, home)})` : '(default)'}`)
  out.push('')
  const rows = [['KEY', 'VALUE', 'FROM']]
  for (const key of Object.keys(KEYS)) {
    const src = cfg.sources[key]
    rows.push([key, show(cfg.values[key], key, totalGb), src === 'default' || src.startsWith('env ') || src.startsWith('preset ') ? src : shortPath(src, home)])
  }
  const lines = table(rows)
  out.push(paint(color, 'bold', lines[0]))
  lines.slice(1).forEach((l, i) => {
    const key = rows[i + 1][0]
    out.push(cfg.sources[key] === 'default' ? paint(color, 'gray', l) : l)
  })
  if (cfg.warnings.length) {
    out.push('')
    for (const w of cfg.warnings) out.push(paint(color, 'yellow', `WARN ${w}`))
  }
  return out.join('\n')
}

// Sets "preset" in one config file and leaves every other key alone. A file that is not valid
// JSON is never overwritten.
function writePreset(file, name) {
  let obj = {}
  let text = null
  try { text = fs.readFileSync(file, 'utf8') } catch {}
  if (text !== null) {
    try { obj = JSON.parse(text.replace(/^\uFEFF/, '')) } catch (e) { return { error: `${file} is not valid JSON (${e.message}); fix it first` } }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: `${file} should hold a JSON object` }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, preset: name }, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return { file }
}

function setPreset(args, { env, stdout, stderr, cwd }) {
  const value = option(args, 'preset')
  const name = String(value)
  if (!PRESETS[name]) {
    const list = Object.keys(PRESETS).join(', ')
    stderr.write(value === true ? `bulkhead config: --preset needs a name: ${list}\n` : `bulkhead config: unknown preset ${name}; use ${list}\n`)
    process.exitCode = 1
    return
  }
  const project = args.includes('--project')
  const file = project ? projectFile(cwd) || path.join(path.resolve(cwd), '.claude', 'bulkhead.json') : globalFile(env)
  let res
  try { res = writePreset(file, name) } catch (e) { res = { error: `could not write ${file}: ${e.message}` } }
  if (res.error) {
    stderr.write(`bulkhead config: ${res.error}\n`)
    process.exitCode = 1
    return
  }
  stdout.write(`preset ${name} written to ${shortPath(file)}${project ? '' : ' (every project; a project file or BULKHEAD_PRESET can still override it)'}\n`)
}

function main(args, { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = env.CLAUDE_PROJECT_DIR || process.cwd() } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  if (rejectArgs('config', args, { flags: ['json', 'project'], valued: ['preset'] }, stderr, USAGE)) return
  if (option(args, 'preset') !== undefined) return setPreset(args, { env, stdout, stderr, cwd })
  if (args.includes('--project')) {
    stderr.write('bulkhead config: --project goes with --preset\n')
    process.exitCode = 1
    return
  }
  const cfg = load({ env, cwd })
  if (args.includes('--json')) {
    const settings = {}
    for (const key of Object.keys(KEYS)) settings[key] = { value: cfg.values[key], from: cfg.sources[key] }
    stdout.write(JSON.stringify({ preset: cfg.preset, files: cfg.files, settings, warnings: cfg.warnings }, null, 2) + '\n')
    return
  }
  stdout.write(render(cfg, { color: useColor(stdout, env) }) + '\n')
}

module.exports = { main, render, writePreset, USAGE }
