'use strict'
// SessionStart, one message for the user: the first-run line (once ever), what orphan-reaper stopped
// since the last message, and a broken config file. The guards ignore a broken file and run on
// their defaults, so without this nobody would notice a typo.
const { load } = require('./config')
const { shortPath } = require('./cli-util')
const { stateDir } = require('./hook')
const notices = require('./notices')

function notice(cfg) {
  if (!cfg.warnings.length) return null
  const lines = cfg.warnings.slice(0, 3).map(w => `  ${w.replace(/^\S+/, m => shortPath(m))}`)
  if (cfg.warnings.length > 3) lines.push(`  and ${cfg.warnings.length - 3} more`)
  return `[bulkhead] config problem, defaults are used where it applies:\n${lines.join('\n')}\nRun \`bulkhead config\` or \`bulkhead doctor\` to check.`
}

function part(f) {
  try { return f() } catch { return null }
}

// Each part fails on its own, so a broken one never hides the others.
function message(input, dir = stateDir()) {
  const parts = [
    part(() => notices.firstRun(dir)),
    part(() => notices.format(notices.claim(dir))),
    part(() => notice(load({ cwd: process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd() }))),
  ].filter(Boolean)
  return parts.length ? parts.join('\n') : null
}

if (require.main === module) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', d => (raw += d))
  process.stdin.on('end', () => {
    try {
      let input = {}
      try { input = JSON.parse(raw || '{}') } catch {}
      const msg = message(input)
      if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg }))
    } catch {}
    process.exit(0)
  })
}

module.exports = { notice, message }
