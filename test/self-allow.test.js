'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check, runsAllow } = require('../src/self-allow')
const basics = require('../src/basics')
const { runScript } = require('./helpers')

const blockedCmds = [
  'bulkhead allow 7F3K',
  'claude-bulkhead allow 7F3K',
  'bulkhead-cli allow 7F3K',
  '/usr/local/bin/bulkhead allow 7F3K',
  'bulkhead.cmd allow 7F3K',
  'node /home/u/.claude/plugins/claude-bulkhead/bin/bulkhead allow 7F3K',
  'node ./src/cli.js allow 7F3K',
  'node src/allow-cli.js 7F3K allow',
  'npx claude-bulkhead allow 7F3K',
  'npx -y claude-bulkhead@latest allow 7F3K',
  'pnpm dlx claude-bulkhead allow 7F3K',
  'bunx claude-bulkhead allow 7F3K',
  'bash -c "bulkhead allow 7F3K"',
  'sh -c \'cd /tmp && bulkhead allow 7F3K\'',
  'bash -lc "bash -c \\"bulkhead allow 7F3K\\""',
  'eval "bulkhead allow 7F3K"',
  'env FOO=1 bulkhead allow 7F3K',
  'sudo -u me bulkhead allow 7F3K',
  'echo ok && bulkhead allow 7F3K',
  '(bulkhead allow 7F3K)',
  'x=$(bulkhead allow 7F3K)',
  'timeout 5 bulkhead allow --list',
  'time bulkhead allow 7F3K',
  'cd /tmp; BULKHEAD_STATE_DIR=/x bulkhead allow 7F3K',
  '$BULKHEAD allow 7F3K',
]

test('the agent cannot run bulkhead allow, however it is wrapped', () => {
  for (const cmd of blockedCmds) {
    const why = check(cmd)
    assert.ok(why, `should block: ${cmd}`)
    assert.match(why, /cannot approve its own blocks/)
    assert.strictEqual(basics.ruleOf(why), 'self-allow')
  }
})

test('writing the allow state files by hand is blocked, reading them is not', () => {
  const writes = [
    'echo \'{"approved":1}\' > ~/.claude/bulkhead/allow/ABCDE-kill-guard-pkill.json',
    'tee ~/.claude/bulkhead/allow/x.json < /tmp/a',
    'cp /tmp/a.json ~/.claude/bulkhead/allow/ABCDE-kill-guard-pkill.json',
    'mv /tmp/a.json "$HOME/.claude/bulkhead/allow/"',
    'sed -i s/null/1/ ~/.claude/bulkhead/allow/ABCDE-kill-guard-pkill.json',
    'node -e "require(\'fs\').writeFileSync(\'/home/u/.claude/bulkhead/allow/a.json\', \'{}\')"',
    'touch C:\\Users\\me\\.claude\\bulkhead\\allow\\a.json',
    'bash -c "echo x > ~/.claude/bulkhead/allow/a.json"',
  ]
  for (const cmd of writes) assert.ok(check(cmd), `should block: ${cmd}`)
  assert.ok(check('echo x > /var/tmp/state/allow/a.json', { stateDir: '/var/tmp/state' }), 'a custom state dir counts too')
  assert.strictEqual(check('ls ~/.claude/bulkhead/allow'), null)
  assert.strictEqual(check('cat ~/.claude/bulkhead/allow/ABCDE-kill-guard-pkill.json'), null)
  assert.strictEqual(check('ls ~/.claude/bulkhead/allow 2>/dev/null'), null)
})

test('commands that only mention allow are fine', () => {
  const fine = [
    'bulkhead status',
    'bulkhead explain -- git status',
    'bulkhead config --preset quiet',
    'echo "run bulkhead allow 7F3K"',
    'git commit -m "document bulkhead allow"',
    'grep -rn "bulkhead allow" docs',
    'cat > notes.md <<EOF\nbulkhead allow 7F3K\nEOF',
    'npx eslint --allow-empty src',
    'npm run allow-list',
    'node scripts/build.js allow',
    'ls ~/.claude/bulkhead',
    'cp a.txt ~/.claude/bulkhead/config.json.bak',
  ]
  for (const cmd of fine) assert.strictEqual(check(cmd), null, `should pass: ${cmd}`)
  assert.strictEqual(runsAllow([]), false)
})

test('the rule is on by default and BULKHEAD_DISABLE=self-allow turns it off', () => {
  const input = { cwd: '/tmp', tool_input: { command: 'bulkhead allow 7F3K' } }
  const on = runScript('basics', input)
  assert.strictEqual(on.status, 2)
  assert.match(on.stderr, /cannot approve its own blocks/)
  assert.ok(!/bulkhead allow [A-Z2-9]{5}`/.test(on.stderr.replace('<code>', '')), 'no allow code for this rule')
  assert.strictEqual(runScript('basics', input, { BULKHEAD_DISABLE: 'self-allow' }).status, 0)
})
