'use strict'
const allowOnce = require('./allow-once')
const { rejectArgs, useColor, paint, table, shortPath } = require('./cli-util')

const USAGE = `usage: bulkhead allow <code>
       bulkhead allow --list [--json]

Run this yourself, in your own terminal, when a guard blocked a command you want to go ahead.
<code> is the short code in the block message. The agent can then run that exact command, from
the same folder, once, within allowOnce.ttlMinutes (default 10). --list shows the codes waiting.
The agent cannot run this command: bulkhead blocks it.`

function ago(ms, now) {
  const m = Math.max(0, Math.round((now - ms) / 60000))
  return m < 1 ? 'just now' : `${m} min ago`
}

function left(ms, now) {
  return `${Math.max(1, Math.ceil((ms - now) / 60000))} min`
}

function renderList(entries, { now = Date.now(), color = false } = {}) {
  if (!entries.length) return 'no codes waiting. A code appears in the message when a guard blocks a command.'
  const rows = [['CODE', 'STATE', 'GUARD', 'RULE', 'FOLDER', 'COMMAND', 'BLOCKED', 'LEFT']]
  for (const e of entries) {
    rows.push([e.code, e.approved ? 'allowed' : 'waiting', e.guard, e.rule, shortPath(e.cwd), e.cmd.slice(0, 50), ago(e.created, now), left(e.expires, now)])
  }
  const lines = table(rows)
  return [paint(color, 'bold', lines[0]), ...lines.slice(1)].join('\n')
}

function main(args, { stdout = process.stdout, stderr = process.stderr, env = process.env, now = Date.now(), base } = {}) {
  if (args.includes('--help') || args.includes('-h')) return stdout.write(USAGE + '\n')
  if (args.includes('--list')) {
    if (rejectArgs('allow', args, { flags: ['list', 'json'], valued: [] }, stderr, USAGE)) return
    const entries = allowOnce.list({ base, now })
    if (args.includes('--json')) return stdout.write(JSON.stringify(entries, null, 2) + '\n')
    return stdout.write(renderList(entries, { now, color: useColor(stdout, env) }) + '\n')
  }
  const codes = args.filter(a => !a.startsWith('-'))
  if (codes.length !== 1 || args.some(a => a.startsWith('-'))) {
    stderr.write(USAGE + '\n')
    process.exitCode = 1
    return
  }
  const res = allowOnce.approve(codes[0], { base, now })
  if (!res.ok) {
    const why = {
      unknown: `no waiting code ${codes[0].toUpperCase()}. It may have expired (codes last ${Math.round(allowOnce.ttlMs() / 60000)} minutes); run the blocked command again for a new one, or \`bulkhead allow --list\`.`,
      used: `code ${codes[0].toUpperCase()} is already allowed and waiting for the agent to retry the command.`,
      'no-code': 'give the code from the block message, for example: bulkhead allow 7F3K',
      unwritable: 'could not write the allow state; check that the bulkhead state directory is writable.',
      unreadable: 'could not read the allow state; check the bulkhead state directory.',
    }[res.reason]
    stderr.write(`bulkhead allow: ${why}\n`)
    process.exitCode = 1
    return
  }
  const e = res.entries[0]
  const guards = res.entries.map(x => `${x.guard} ${x.rule}`).join(', ')
  stdout.write(`Allowed once: ${e.cmd}\n  folder ${e.cwd || '?'}\n  guards ${guards}\n` +
    `The agent can run exactly that command now, once, within ${left(e.expires, now)}.\n`)
}

module.exports = { main, renderList, USAGE }
