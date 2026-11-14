'use strict'
// Plain-words views of a scan result: the shareable summary, the matched part of a command, and
// --explain. Everything here reads the same r.summary.rules the normal report prints.
const REPO = 'https://github.com/dooly6276/claude-bulkhead'
const DAY_MS = 86400000

// What each rule means, in words a person who has never seen the guard names understands.
// A group is one line of the share text; rules in the same group are added together. The order
// is the share order: first what people fear most (another session's processes killed, files
// deleted, edits committed or a tree moved under someone), the waiting last.
const SHARED_KILL = new Set(['mass-kill', 'docker-mass', 'device-kill', 'app-quit', 'service-stop'])
const DELETES = new Set(['rm-root', 'rm-empty-var', 'rm-unquoted-var', 'rm-git-dir'])
const GROUPS = [
  { key: 'kill', match: (g, r) => (g === 'kill-guard' && !SHARED_KILL.has(r)) || (g === 'port-guard' && r === 'kill-by-port'), text: 'kills by name (pkill, killall, taskkill) that would also have hit other sessions\' processes' },
  { key: 'delete', match: (g, r) => (g === 'basics' && DELETES.has(r)) || (g === 'checkout-guard' && r === 'remove-session-dir'), text: 'recursive deletes (rm -rf) of a drive root, home, .git, an empty $VAR/ or another session\'s folder' },
  { key: 'stage-all', match: (g, r) => g === 'checkout-guard' && r === 'stage-all', text: 'git add -A or commits that would have taken another session\'s edits' },
  { key: 'git', match: (g, r) => g === 'checkout-guard' && r.startsWith('git-'), text: 'branch switches, merges, rebases or stashes in a tree another session was using' },
  { key: 'port', match: g => g === 'port-guard', text: 'servers started on a port another session already held' },
  { key: 'shared-kill', match: (g, r) => g === 'kill-guard' && SHARED_KILL.has(r), text: 'stops of every container, emulator, app or service, other sessions\' included' },
  { key: 'memory', match: (g, r) => g === 'memory-guard' && r !== 'slot-files', text: 'heavy builds or tests started with RAM nearly gone' },
  { key: 'force-push', match: (g, r) => g === 'basics' && (r === 'force-push-main' || r === 'protected-delete'), text: 'force-pushes to main or deletes of main' },
  { key: 'discard', match: (g, r) => g === 'basics' && r === 'discard-changes', text: 'reset --hard or clean -f that would have lost uncommitted work' },
  { key: 'edit', match: g => g === 'edit-guard', text: 'edits over a file another session had just changed' },
  { key: 'secrets', match: g => g === 'secrets-guard', text: 'reads of secret files such as .env and keys' },
  { key: 'author', match: (g, r) => g === 'basics' && r === 'agent-author', text: 'commits authored as Claude instead of you' },
  { key: 'self-allow', match: (g, r) => g === 'basics' && r === 'self-allow', text: 'attempts by the agent to approve its own blocks' },
  { key: 'disk', match: g => g === 'disk-guard', text: 'whole-disk or parallel disk scans' },
  { key: 'slots', match: g => g === 'memory-guard', text: 'hand-edited slot files' },
  { key: 'wait', match: g => g === 'wait-guard', text: 'long foreground sleeps and polling loops' },
]
const OTHER = { key: 'other', text: 'other risky commands' }
const rankOf = key => { const i = GROUPS.findIndex(g => g.key === key); return i < 0 ? GROUPS.length : i }

function describe(guard, rule) {
  const g = GROUPS.find(x => x.match(guard, rule))
  return g ? g.text : `${guard} ${rule}`
}

// Counts per group, largest first. Hits are commands, so the same command can count in two groups.
function groups(r) {
  const by = new Map()
  for (const x of r.summary.rules) {
    const g = GROUPS.find(y => y.match(x.guard, x.rule)) || OTHER
    const cur = by.get(g.key) || { key: g.key, text: g.text, count: 0 }
    cur.count += x.count
    by.set(g.key, cur)
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
}

// The same groups in share order: what hurts other sessions and loses work first, waiting last.
const byFear = items => [...items].sort((a, b) => rankOf(a.key) - rankOf(b.key) || b.count - a.count)

const num = n => n.toLocaleString('en-US')
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? '' : 's'}`

function days(r) {
  if (!r.first || !r.last) return 0
  return Math.max(1, Math.ceil((r.last - r.first) / DAY_MS))
}

// The numbers the share text carries. Nothing else leaves this function: no paths, no commands.
function shareSummary(r) {
  return {
    days: days(r),
    sessions: r.sessions,
    maxAtOnce: r.concurrency.max,
    commandsHit: r.summary.commandsHit,
    sessionsHit: r.summary.sessionsHit,
    items: byFear(groups(r)),
  }
}

const SHOWN = 5

function headline(s) {
  const parts = []
  if (s.days) parts.push(plural(s.days, 'day'))
  parts.push(plural(s.sessions, 'session'))
  if (s.maxAtOnce >= 2) parts.push(`up to ${s.maxAtOnce} at once`)
  return parts.join(', ')
}

// Folds the groups beyond the shown ones into one "other" line.
function shownItems(s) {
  if (s.items.length <= SHOWN) return s.items
  // the waiting keeps its own last line; the middle of the list folds
  const wait = s.items.find(x => x.key === 'wait')
  const rest = s.items.filter(x => x !== wait)
  const keep = SHOWN - 1 - (wait ? 1 : 0)
  const folded = rest.slice(keep)
  const other = { text: `${OTHER.text} (${plural(folded.length, 'kind')})`, count: folded.reduce((n, x) => n + x.count, 0) }
  return [...rest.slice(0, keep), other, ...(wait ? [wait] : [])]
}

function shareText(r) {
  const s = shareSummary(r)
  if (!r.commands) return 'bulkhead scan found no Claude Code shell commands to replay.'
  const out = [`bulkhead scan, ${headline(s)}.`]
  if (!s.items.length) out.push('Nothing in these sessions would have been stopped.')
  else {
    out.push(`It would have stopped ${plural(s.commandsHit, 'command')} in ${plural(s.sessionsHit, 'session')}:`)
    for (const x of shownItems(s)) out.push(`  ${num(x.count)} ${x.text}`)
  }
  out.push(`(bulkhead scan, ${REPO.replace('https://', '')})`)
  return out.join('\n')
}

function shareMarkdown(r) {
  const s = shareSummary(r)
  if (!r.commands) return 'bulkhead scan found no Claude Code shell commands to replay.'
  const out = [`**bulkhead scan**, ${headline(s)}.`, '']
  if (!s.items.length) out.push('Nothing in these sessions would have been stopped.')
  else {
    out.push('| Would have been stopped | Count |', '| --- | ---: |')
    for (const x of shownItems(s)) out.push(`| ${x.text} | ${num(x.count)} |`)
    out.push(`| **Total** | **${num(s.commandsHit)}** commands in ${plural(s.sessionsHit, 'session')} |`)
  }
  out.push('', `_bulkhead scan, [${REPO.replace('https://', '')}](${REPO})_`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------
// The part of a command a rule matched. A best guess from the rule's name: the guards decide on a
// parsed command, scan only has the text, so this finds the clause a person would point at.

// One shell clause: up to ; & | or a newline, but `2>&1` stays inside it.
const CLAUSE = '(?:[^\\n;&|]|(?<=>)&)*'
const MATCHERS = {
  'kill-guard': /\b(?:pkill|killall|Stop-Process|taskkill|wmic|Get-Process|xargs\s+kill|kill)\b[^\n;&|]*/,
  'wait-guard': /\b(?:sleep|Start-Sleep|timeout|Wait-Process|tail\s+-\w*f)\b[^\n;&|]*/i,
  'disk-guard': /\b(?:du|ncdu|dust|find|tree|xargs|parallel|ForEach-Object|Get-ChildItem|dir|ls\s+-\w*R)\b[^\n;&|]*/,
  'memory-guard': /\S*slots?\S*/,
  'basics:rm-root': /\brm\s[^\n;&|]*/,
  'basics:rm-empty-var': /\b(?:rm|rsync|Remove-Item|rd|rmdir)\s[^\n;&|]*/,
  'basics:rm-unquoted-var': /\brm\s[^\n;&|]*/,
  'basics:rm-git-dir': /\b(?:rm|find|Remove-Item)\s[^\n;&|]*/,
  'basics:force-push-main': /\bgit\s[^\n;&|]*?\bpush\b[^\n;&|]*/,
  'basics:discard-changes': /\bgit\s[^\n;&|]*?\b(?:reset|clean|checkout|restore)\b[^\n;&|]*/,
  'basics:agent-author': /--author\S*(?:\s*=?\s*(?:"[^"]*"|'[^']*'|\S+))?|git\s[^\n;&|]*user\.\w+[^\n;&|]*|GIT_(?:AUTHOR|COMMITTER)_\w+=\S+/,
  'checkout-guard:stage-all': /\bgit\s[^\n;&|]*?\b(?:add|commit)\b[^\n;&|]*/,
  'checkout-guard:remove-session-dir': /\b(?:rm\s[^\n;&|]*|git\s[^\n;&|]*?worktree\s+remove[^\n;&|]*)/,
}

const widen = re => new RegExp(re.source.split('[^\\n;&|]*').join(CLAUSE), re.flags)

function matcherFor(guard, rule) {
  const given = MATCHERS[`${guard}:${rule}`]
  if (given) return widen(given)
  if (guard === 'checkout-guard' && rule.startsWith('git-')) return new RegExp(`\\bgit\\s[^\\n;&|]*?\\b${rule.slice(4).replace(/[^\w-]/g, '')}\\b${CLAUSE}`)
  return MATCHERS[guard] ? widen(MATCHERS[guard]) : null
}

// { start, end } of the matched clause in the command, or null.
function findMatch(guard, rule, command) {
  const re = matcherFor(guard, rule)
  const m = re ? re.exec(command) : null
  if (!m || !m[0].trim()) return null
  const text = m[0].replace(/\s+$/, '')
  return { start: m.index, end: m.index + text.length }
}

// A command cut to `width` characters around the match. The match is wrapped by `mark`.
function clipAround(command, match, width, mark) {
  const flat = command.replace(/\s*\n\s*/g, ' ⏎ ')
  // newline collapsing moves offsets, so find the match again in the flat text
  let m = null
  if (match) {
    const raw = command.slice(match.start, match.end).replace(/\s*\n\s*/g, ' ⏎ ')
    const at = flat.indexOf(raw)
    if (at >= 0) m = { start: at, end: at + raw.length }
  }
  if (!m) return flat.length > width ? flat.slice(0, Math.max(0, width - 1)) + '…' : flat
  if (flat.length <= width) return flat.slice(0, m.start) + mark(flat.slice(m.start, m.end)) + flat.slice(m.end)
  const len = Math.min(m.end - m.start, Math.max(10, width - 8))
  const room = Math.max(0, width - len)
  let from = Math.max(0, m.start - Math.floor(room * 0.4))
  if (from + width > flat.length) from = Math.max(0, flat.length - width)
  const to = Math.min(flat.length, from + width)
  const mEnd = Math.min(m.start + len, to)
  const body = flat.slice(from, m.start) + mark(flat.slice(m.start, mEnd)) + flat.slice(mEnd, to)
  return (from > 0 ? '…' : '') + body + (to < flat.length ? '…' : '')
}

const docsLink = guard => `${REPO}/blob/main/docs/guards/${guard}.md`

module.exports = { GROUPS, describe, groups, shareSummary, shareText, shareMarkdown, findMatch, clipAround, docsLink, days, REPO }
