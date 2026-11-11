'use strict'
const { runHook, enabled } = require('./hook')

// Every Bash and PowerShell guard in one process. Seven separate hooks meant seven Node starts
// per tool call, which adds up when ten sessions share a machine. The guards run in order of
// cost, text-only checks first and the ones that read git, memory, processes or ports last, and
// the first block stops the rest. A guard that throws is skipped, so one bug never silences the
// others; the whole hook still fails open on anything unexpected.
const ORDER = [
  ['secrets-guard', './secrets-guard'],
  ['wait-guard', './wait-guard'],
  ['disk-guard', './disk-guard'],
  ['kill-guard', './kill-guard'],
  ['basics', './basics'],
  ['checkout-guard', './checkout-guard'],
  ['memory-guard', './memory-guard'],
  ['port-guard', './port-guard'],
]

// { block } from the first guard that blocks, else the first non-blocking output (memory-guard's
// queued rewrite), else nothing. `rewrite: false` drops rewrites for callers that cannot use them.
async function judge(input, { rewrite = true, order = ORDER } = {}) {
  let output = null
  for (const [name, file] of order) {
    if (!enabled(name)) continue
    let result = null
    try { result = await (typeof file === 'string' ? require(file) : file).handle(input) } catch {}
    if (result && result.block) return { block: result.block }
    if (rewrite && result && result.output && !output) output = result.output
  }
  return output ? { output } : null
}

if (require.main === module) runHook('bash-guards', input => judge(input))

module.exports = { judge, ORDER }
