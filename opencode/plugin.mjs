// bulkhead for opencode, loaded with "plugin": ["claude-bulkhead"] in opencode.json.
// Before each bash tool call it pipes { command, cwd, session_id } to `bulkhead hook --agent opencode`,
// which runs the same guards as the Claude Code hook; exit code 2 rejects the call.
// The body below is the same as the plugin `bulkhead setup opencode` writes (test/plugins.test.js).
import { spawnSync } from 'node:child_process'
import { URL, fileURLToPath } from 'node:url'

const HOOK = ['node', fileURLToPath(new URL('../bin/bulkhead', import.meta.url)), 'hook', '--agent', 'opencode']

export const BulkheadPlugin = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'bash') return
    const command = output.args && output.args.command
    if (typeof command !== 'string' || !command) return
    const cwd = (output.args && output.args.workdir) || directory
    const r = spawnSync(HOOK[0], HOOK.slice(1), {
      input: JSON.stringify({ command, cwd, session_id: input.sessionID }), encoding: 'utf8', timeout: 25000, windowsHide: true,
    })
    if (r.status === 2) throw new Error((r.stderr || 'blocked by bulkhead').trim())
  },
})
