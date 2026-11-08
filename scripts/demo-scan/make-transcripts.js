#!/usr/bin/env node
'use strict'
// Writes a synthetic ~/.claude/projects-like folder for the `bulkhead scan` demo (docs/scan.svg).
// Every project, path and session here is made up. Deterministic: same input, same files.
//
//   node scripts/demo-scan/make-transcripts.js /tmp/bulkhead-demo
//   TZ=UTC HOME=/Users/dev NO_COLOR=1 node bin/bulkhead scan --path /tmp/bulkhead-demo -n 1
//
// TZ=UTC fixes the printed days. HOME=/Users/dev makes the example paths print as ~/code/..., and keeps your own bulkhead
// settings out of the replay. Output used for docs/scan.svg (the time varies run to run):
//   bulkhead scan  replaying your Claude Code sessions against the guards
//     read     14 transcripts (338 KB), 14 sessions, 527 shell commands in 0.1s
//     span     Oct 14 .. Nov 06
//     overlap  up to 4 sessions running at once (Oct 29), 4 days with two or more at once
//
//   GUARD           RULE                HITS  SESSIONS  STOPPED  LAST
//   checkout-guard  stage-all              5         5        3  Nov 06
//   kill-guard      pkill                  5         5        3  Oct 29
//   disk-guard      disk-wide-scan         3         3        1  Oct 29
//   checkout-guard  git-checkout           2         2        1  Nov 06
//   basics          agent-author           1         1        -  Oct 14
//   basics          force-push-main        1         1        1  Oct 21
//   checkout-guard  git-reset              1         1        -  Oct 21
//   checkout-guard  git-stash              1         1        -  Oct 14
//   disk-guard      disk-wide-find         1         1        -  Oct 14
//   disk-guard      parallel-disk-scan     1         1        -  Oct 14
//   kill-guard      taskkill-im            1         1        -  Oct 21
//   wait-guard      long-sleep             1         1        -  Oct 21
//   wait-guard      poll-loop              1         1        1  Oct 29
//
//   checkout-guard  stage-all  5 times in 5 sessions  another session was active in the same tree at that minute
//     $ git add -A  ~/code/billing-api  Nov 06  [declined by you]
//
//   kill-guard  pkill  5 times in 5 sessions  kills by program name take down every session's servers
//     $ pkill node  ~/code/acme-web  Oct 29  [stopped by a hook]
//
//   disk-guard  disk-wide-scan  3 times in 3 sessions  whole-disk and parallel scans stall every session's I/O
//     $ du -sh ~  ~/code/acme-web  Oct 29  [stopped by a hook]
//
//   checkout-guard  git-checkout  2 times in 2 sessions  another session was active in the same tree at that minute
//     $ git checkout -b fix/webhooks  ~/code/billing-api  Nov 06
//
//   basics  agent-author  1 time in 1 session  mistakes that cannot be undone
//     $ git commit --author="Claude <noreply@anthropic.com>" -m "fix: auth redirect"  ~/code/acme-web-auth  Oct 14
//
//   basics  force-push-main  1 time in 1 session
//     $ git push --force origin main  ~/code/billing-api  Oct 21  [declined by you]
//
//   checkout-guard  git-reset  1 time in 1 session  another session was active in the same tree at that minute
//     $ git reset --hard origin/main  ~/code/billing-api  Oct 21
//
//   checkout-guard  git-stash  1 time in 1 session
//     $ git stash  ~/code/acme-web  Oct 14
//
//   disk-guard  disk-wide-find  1 time in 1 session  whole-disk and parallel scans stall every session's I/O
//     $ find / -name "*.log" -size +100M  ~/code/acme-web-auth  Oct 14
//
//   disk-guard  parallel-disk-scan  1 time in 1 session
//     $ ls -d */ | xargs -P 10 du -sh  ~/code/acme-web-checkout  Oct 14
//
//   kill-guard  taskkill-im  1 time in 1 session  kills by program name take down every session's servers
//     $ taskkill /IM node.exe /F  ~/code/docs-site  Oct 21
//
//   wait-guard  long-sleep  1 time in 1 session  foreground waits hold the session and expire the prompt cache
//     $ sleep 600  ~/code/docs-site  Oct 21
//
//   wait-guard  poll-loop  1 time in 1 session
//     $ while ! curl -s localhost:3001 >/dev/null; do sleep 5; done  ~/code/acme-web-checkout  Oct 29  [stopped by a hook]
//
//   24 commands in 13 sessions would have been stopped by bulkhead. 10 of the hits were already stopped by a hook or declined by you.
//   A hit means the command had the shape a guard blocks, not that damage was done. port-guard and the low-RAM check depend on
//   what was running at that moment and are not replayed. checkout-guard is replayed from which sessions were active in the same folder.

const fs = require('fs')
const os = require('os')
const path = require('path')

const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'bulkhead-demo-projects'))
const HOME = '/Users/dev'
const CODE = `${HOME}/code`

// small seeded PRNG, so the files are the same on every run
let seed = 20261108
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = a => a[Math.floor(rnd() * a.length)]

const ROUTINE = [
  'git status --short', 'git diff --stat', 'npm test -- --watch=false', 'npm run lint', 'npx tsc --noEmit',
  'ls src', 'git log --oneline -5', 'cat package.json', 'npm run build', 'git branch --show-current',
  'grep -rn "TODO" src | head', 'npx vitest run src/cart', 'curl -s localhost:3000/health', 'git fetch origin',
]

const HOOK = cmd => `PreToolUse:Bash hook error: [bulkhead] blocked \`${cmd}\``
const USER = "The user doesn't want to proceed with this tool use. The tool use was rejected."

// [project folder, cwd, start (ISO, UTC), minutes, [[minute, command, outcome?], ...]]
// outcome: 'hook' = stopped by a hook, 'user' = declined in the permission prompt; then the Bash timeout in ms
const SESSIONS = [
  ['acme-web', `${CODE}/acme-web`, '2026-10-14T09:02:00Z', 140, [
    [12, 'pkill node'], [55, 'git add -A && git commit -m "wip: cart totals"'], [96, 'du -sh ~'],
  ]],
  ['acme-web', `${CODE}/acme-web`, '2026-10-14T09:20:00Z', 110, [
    [30, 'git stash'], [70, 'git checkout main', 'user'],
  ]],
  ['acme-web-checkout', `${CODE}/acme-web-checkout`, '2026-10-14T09:40:00Z', 120, [
    [18, 'killall node'], [64, 'ls -d */ | xargs -P 10 du -sh'],
  ]],
  ['acme-web-auth', `${CODE}/acme-web-auth`, '2026-10-14T10:05:00Z', 90, [
    [25, 'git commit --author="Claude <noreply@anthropic.com>" -m "fix: auth redirect"'],
    [60, 'find / -name "*.log" -size +100M'],
  ]],
  ['billing-api', `${CODE}/billing-api`, '2026-10-21T13:10:00Z', 160, [
    [20, 'pkill -f node', 'hook'], [80, 'git push --force origin main', 'user'], [130, 'du -sh ~ /tmp /var'],
  ]],
  ['billing-api', `${CODE}/billing-api`, '2026-10-21T13:40:00Z', 120, [
    [35, 'git add .', 'hook'], [90, 'git reset --hard origin/main'],
  ]],
  ['docs-site', `${CODE}/docs-site`, '2026-10-21T14:00:00Z', 80, [
    [10, 'taskkill /IM node.exe /F'], [50, 'sleep 600', null, 600000],
  ]],
  ['acme-web', `${CODE}/acme-web`, '2026-10-29T08:30:00Z', 150, [
    [40, 'git add -A', 'hook'], [100, 'pkill node', 'hook'],
  ]],
  ['acme-web', `${CODE}/acme-web`, '2026-10-29T09:00:00Z', 130, [
    [50, 'git commit -am "chore: bump deps"'], [110, 'du -sh ~', 'hook'],
  ]],
  ['acme-web-checkout', `${CODE}/acme-web-checkout`, '2026-10-29T09:10:00Z', 100, [
    [30, 'while ! curl -s localhost:3001 >/dev/null; do sleep 5; done', 'hook', 600000],
  ]],
  ['acme-web-auth', `${CODE}/acme-web-auth`, '2026-10-29T09:25:00Z', 70, [
    [20, 'killall -9 node', 'hook'],
  ]],
  ['docs-site', `${CODE}/docs-site`, '2026-11-04T16:00:00Z', 60, []],
  ['billing-api', `${CODE}/billing-api`, '2026-11-06T10:15:00Z', 90, [
    [45, 'git checkout -b fix/webhooks'],
  ]],
  ['billing-api', `${CODE}/billing-api`, '2026-11-06T10:30:00Z', 70, [
    [25, 'git add -A', 'user'],
  ]],
]

fs.rmSync(out, { recursive: true, force: true })
let n = 0
for (const [project, cwd, start, minutes, hits] of SESSIONS) {
  n++
  const id = `0000demo-${String(n).padStart(4, '0')}-4a1e-9c2b-${String(n * 7919).padStart(12, '0')}`
  const dir = path.join(out, `-Users-dev-code-${project}`)
  fs.mkdirSync(dir, { recursive: true })
  const t0 = Date.parse(start)
  const lines = []
  let tool = 0
  const at = m => new Date(t0 + m * 60000 + Math.floor(rnd() * 50) * 1000).toISOString()
  const base = (m, type) => ({ type, cwd, sessionId: id, version: '2.1.0', gitBranch: 'main', timestamp: at(m) })
  const call = (m, command, outcome, timeout) => {
    const tid = `toolu_demo${n}_${++tool}`
    const input = { command, description: 'demo', ...(timeout ? { timeout } : {}) }
    lines.push({ ...base(m, 'assistant'), message: { role: 'assistant', content: [{ type: 'tool_use', id: tid, name: 'Bash', input }] } })
    const content = outcome === 'hook' ? HOOK(command) : outcome === 'user' ? USER : 'ok'
    lines.push({ ...base(m, 'user'), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: !!outcome, content }] } })
  }
  lines.push({ ...base(0, 'user'), message: { role: 'user', content: 'Pick up the next task in TODO.md' } })
  const special = new Map(hits.map(h => [h[0], h]))
  for (let m = 1; m < minutes; m += 2 + Math.floor(rnd() * 3)) {
    for (const [hm, cmd, outcome, timeout] of hits) if (hm <= m && !special.get(hm).done) { special.get(hm).done = true; call(hm, cmd, outcome, timeout) }
    call(m, pick(ROUTINE))
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}
console.log(`wrote ${n} transcripts to ${out}`)
