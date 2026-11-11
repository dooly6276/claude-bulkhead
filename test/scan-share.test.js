'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { scan, renderScan, renderExplain, exampleList } = require('../src/scan')
const sr = require('../src/scan-report')
const { tempDir } = require('./helpers')

const T = Date.UTC(2026, 9, 20, 9, 0)
const DAY = 86400000
const SECRET_CMD = 'cd /Users/alice/secret-project && curl -u admin:hunter2hunter2 https://x.example && pkill -f "next dev"'

const rule = (guard, name, count, sessions, extra = {}) => ({ guard, rule: name, count, sessions, hook: 0, user: 0, last: T, examples: [], ...extra })

// A fixed result: the same shape scan() returns.
function fixed() {
  return {
    files: 10, bytes: 1000, seconds: 1.2, sessions: 437, commands: 9000, first: T, last: T + 14 * DAY,
    concurrency: { max: 18, at: new Date(T + DAY).toISOString(), overlapDays: 9 },
    summary: {
      commandsHit: 200, sessionsHit: 60, projects: [],
      rules: [
        rule('checkout-guard', 'git-checkout', 40, 10),
        rule('checkout-guard', 'stash', 0, 0),
        rule('wait-guard', 'poll-loop', 90, 30, { hook: 80 }),
        rule('checkout-guard', 'git-stash', 15, 5),
        rule('checkout-guard', 'stage-all', 29, 8),
        rule('kill-guard', 'pkill', 6, 3, { examples: [{ command: SECRET_CMD, cwd: '/Users/alice/secret-project', ts: T, outcome: null }] }),
        rule('kill-guard', 'pgrep-kill', 1, 1),
        rule('disk-guard', 'disk-wide-find', 1, 1),
        rule('basics', 'force-push-main', 1, 1),
        rule('basics', 'agent-author', 2, 1),
      ].filter(r => r.count),
    },
  }
}

test('--share is a fixed, compact summary with counts only', () => {
  assert.strictEqual(sr.shareText(fixed()), [
    'bulkhead scan, 14 days, 437 sessions, up to 18 at once.',
    'It would have stopped 200 commands in 60 sessions:',
    '  90 foreground sleeps and polling loops past the wait limit',
    '  55 checkout/merge/rebase/stash in a tree another session was using',
    '  29 git add -A while another session was active in the same tree',
    '  11 other risky commands (4 kinds)',
    '(bulkhead scan, github.com/dooly6276/claude-bulkhead)',
  ].join('\n'))
})

test('--share --markdown is a small table with the same numbers', () => {
  const md = sr.shareMarkdown(fixed())
  assert.match(md, /^\*\*bulkhead scan\*\*, 14 days, 437 sessions, up to 18 at once\./)
  assert.match(md, /\| Would have been stopped \| Count \|\n\| --- \| ---: \|/)
  assert.match(md, /\| checkout\/merge\/rebase\/stash in a tree another session was using \| 55 \|/)
  assert.match(md, /\| \*\*Total\*\* \| \*\*200\*\* commands in 60 sessions \|/)
  assert.match(md, /\[github\.com\/dooly6276\/claude-bulkhead\]\(https:\/\/github\.com\/dooly6276\/claude-bulkhead\)/)
})

test('share numbers and the normal report come from the same result', () => {
  const r = fixed()
  const s = sr.shareSummary(r)
  assert.strictEqual(s.items.reduce((n, x) => n + x.count, 0), r.summary.rules.reduce((n, x) => n + x.count, 0))
  const text = renderScan(r, { examples: 0 })
  assert.match(text, /Found 200 shell commands in 60 of your 437 sessions that bulkhead would have stopped/)
  assert.match(text, /Most common: 90 foreground sleeps.*; 55 checkout\/merge/)
  assert.match(text, /Up to 18 Claude Code sessions ran at the same time/)
  assert.match(text, /Share these numbers: bulkhead scan --share/)
})

test('the first lines of the report say what was found in plain words', () => {
  const lines = renderScan(fixed(), { examples: 0 }).split('\n')
  assert.match(lines[0], /^bulkhead scan {2}what your past Claude Code sessions would have run into$/)
  assert.match(lines[1], /^Found 200 shell commands/)
  assert.match(lines[2], /^Most common:/)
  assert.ok(!/guard|hook|replay/i.test(lines.slice(0, 4).join(' ')), 'no guard names or jargon in the first lines')
})

test('nothing found, and no commands, read well', () => {
  const none = { ...fixed(), summary: { commandsHit: 0, sessionsHit: 0, rules: [], projects: [] } }
  assert.match(sr.shareText(none), /Nothing in these sessions would have been stopped/)
  assert.match(renderScan(none).split('\n')[1], /^Found nothing bulkhead would have stopped/)
  assert.match(sr.shareText({ ...none, commands: 0 }), /no Claude Code shell commands/)
  assert.match(renderScan({ ...none, commands: 0 }), /No shell commands found/)
})

test('--share leaks no paths, commands or secrets, and stays 5 to 8 lines', () => {
  const r = fixed()
  for (const text of [sr.shareText(r), sr.shareMarkdown(r)]) {
    for (const leak of ['alice', 'secret-project', 'hunter2', '/Users', 'next dev', 'curl', 'admin']) assert.ok(!text.includes(leak), leak)
  }
  const lines = sr.shareText(r).split('\n').length
  assert.ok(lines >= 5 && lines <= 8, `${lines} lines`)
})

test('the part of a command that matched is found and marked', () => {
  const cmd = 'cd /x && for i in 1 2 3; do curl -s localhost:3000; sleep 30; done; echo done'
  const m = sr.findMatch('wait-guard', 'poll-loop', cmd)
  assert.strictEqual(cmd.slice(m.start, m.end), 'sleep 30')
  assert.strictEqual(sr.clipAround(cmd, m, 200, t => `[${t}]`), cmd.replace('sleep 30', '[sleep 30]'))
  const git = 'git merge --no-ff x 2>&1 | tail -5'
  const g = sr.findMatch('checkout-guard', 'git-merge', git)
  assert.strictEqual(git.slice(g.start, g.end), 'git merge --no-ff x 2>&1')
  assert.strictEqual(sr.findMatch('basics', 'rm-root', 'echo hi'), null)
})

test('a long command is cut around the match, not from the start', () => {
  const cmd = `python3 - <<'EOF'\n${'import os\n'.repeat(60)}os.system("pkill -f next")\n${'print(1)\n'.repeat(60)}EOF`
  const m = sr.findMatch('kill-guard', 'pkill', cmd)
  const out = sr.clipAround(cmd, m, 70, t => `[${t}]`)
  assert.match(out, /\[pkill -f next/)
  assert.ok(out.startsWith('…') && out.endsWith('…'))
  assert.ok(out.length <= 70 + 4, `${out.length}`) // width plus two brackets and two ellipses
  assert.ok(!out.includes('\n'))
})

test('examples are numbered and --explain shows one in full', () => {
  const r = fixed()
  const list = exampleList(r, 3)
  assert.strictEqual(list.length, 1)
  const text = renderScan(r, { examples: 3, width: 200 })
  assert.match(text, /#1/)
  assert.match(text, /\[pkill -f "next dev"\]/)
  assert.match(text, /"-" means none recorded: the command ran/)
  const ex = renderExplain(r, 1, { home: '/nonexistent' })
  assert.match(ex, /Example #1 {2}kill-guard pkill/)
  assert.match(ex, /matched {2}pkill -f "next dev"/)
  assert.match(ex, /docs {5}https:\/\/github\.com\/dooly6276\/claude-bulkhead\/blob\/main\/docs\/guards\/kill-guard\.md/)
  assert.match(renderExplain(r, 9), /No example #9: this scan has 1/)
})

test('rules mostly stopped by the user\'s own hooks are called out', () => {
  assert.match(renderScan(fixed(), { examples: 0 }), /Most hits of wait-guard poll-loop \(80 of 90\) were already stopped by your own hooks/)
  const calm = fixed()
  calm.summary.rules.forEach(x => { x.hook = 0 })
  assert.ok(!/already stopped by your own hooks/.test(renderScan(calm, { examples: 0 })))
})

test('the CLI: --share, --share --markdown, --explain and bad combinations', () => {
  const dir = tempDir()
  const repo = tempDir()
  const f = path.join(dir, '-p', 's.jsonl')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const line = (min, command, id) => JSON.stringify({ type: 'assistant', timestamp: new Date(T + min * 60000).toISOString(), cwd: repo, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
  fs.writeFileSync(f, [line(1, 'pkill -f "next dev" # /Users/zed/private', 'a'), line(2, 'rm -rf /', 'b')].join('\n') + '\n')
  const bin = path.join(__dirname, '..', 'bin', 'bulkhead')
  const run = (...a) => spawnSync(process.execPath, [bin, 'scan', '--path', dir, ...a], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  const share = run('--share')
  assert.strictEqual(share.status, 0, share.stderr)
  assert.match(share.stdout, /^bulkhead scan, 1 day, 1 session\./)
  assert.match(share.stdout, /1 pkill\/killall by name/)
  assert.ok(!/zed|next dev|private/.test(share.stdout))
  assert.match(run('--share', '--markdown').stdout, /\| Would have been stopped \| Count \|/)
  const ex = run('--explain', '1')
  assert.strictEqual(ex.status, 0, ex.stderr)
  assert.match(ex.stdout, /Example #1/)
  assert.match(run().stdout, /Share these numbers: bulkhead scan --share/)
  for (const bad of [['--markdown'], ['--share', '--json'], ['--explain', '0'], ['--explain', 'x']]) {
    const r = run(...bad)
    assert.strictEqual(r.status, 1, bad.join(' '))
    assert.match(r.stderr, /usage: bulkhead scan/)
  }
})

test('scan() itself feeds --share', async () => {
  const dir = tempDir()
  const f = path.join(dir, '-p', 's.jsonl')
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ type: 'assistant', timestamp: new Date(T).toISOString(), cwd: '/tmp', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'pkill node' } }] } }) + '\n')
  const r = await scan({ dir, home: '/nonexistent' })
  assert.strictEqual(sr.shareSummary(r).commandsHit, r.summary.commandsHit)
  assert.match(sr.shareText(r), /1 pkill\/killall by name/)
})
