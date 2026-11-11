'use strict'
const { runHook, blocked, setting, stateDir } = require('./hook')
const pressure = require('./pressure')

// With memoryGuard.subagents on, a new subagent is not started while memory pressure is critical:
// every subagent is a whole Claude process plus the commands it runs. Runs on the Agent tool
// (Task in older Claude Code versions).
function check(input, read = () => pressure.current({ stateDir: stateDir() })) {
  const p = read()
  if (!p || !p.critical) return null
  return `[bulkhead] subagent-guard: memory pressure is critical (${p.detail}). Do not start another subagent now.\n` +
    'Finish the work you have, or wait for the running subagents to return, then try again in a minute. `bulkhead status` shows free RAM.'
}

if (require.main === module) {
  runHook('memory-guard', input => {
    if (setting('memoryGuard.subagents', false) !== true) return
    const why = check(input)
    if (!why) return
    return blocked('subagent-guard', 'subagent-pressure', input, why, input.tool_input && input.tool_input.description)
  })
}

module.exports = { check }
