'use strict'
// The docs stay in step with the code: every command, flag, config key, hook script and guard
// the code has is documented where a user would look for it.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const commandsDoc = read('docs/commands.md')
const configDoc = read('docs/configuration.md')
const readme = read('README.md')

// The text of the "## bulkhead <cmd>" section (or "## bulkhead-slot"), up to the next "## ".
function section(doc, heading) {
  const start = doc.indexOf(`\n## ${heading}\n`)
  if (start < 0) return null
  const end = doc.indexOf('\n## ', start + 4)
  return doc.slice(start, end < 0 ? undefined : end)
}

test('every CLI command has its own section in docs/commands.md and is named in the README', () => {
  const { COMMANDS } = require('../src/cli')
  for (const cmd of Object.keys(COMMANDS)) {
    const heading = cmd === 'slot' ? 'bulkhead-slot' : `bulkhead ${cmd}`
    assert.ok(section(commandsDoc, heading), `docs/commands.md has no "## ${heading}"`)
    assert.ok(readme.includes(`bulkhead ${cmd}`) || readme.includes(heading), `README.md never mentions ${heading}`)
  }
})

test('every flag in the CLI usage is explained in that command\'s section', () => {
  const { USAGE, COMMANDS } = require('../src/cli')
  let cmd = null
  const missing = []
  for (const line of USAGE.split('\n').slice(1)) {
    const m = /^ {2}bulkhead (\S+)/.exec(line)
    if (m) cmd = m[1].split('|')[0]
    if (!cmd || !COMMANDS[cmd]) continue
    const doc = section(commandsDoc, cmd === 'slot' ? 'bulkhead-slot' : `bulkhead ${cmd}`) || ''
    for (const [flag] of line.matchAll(/--[a-z][a-z-]*/g)) if (flag !== '--help' && !doc.includes(flag)) missing.push(`${cmd} ${flag}`)
  }
  assert.deepStrictEqual(missing, [])
})

test('every config key is documented in docs/configuration.md', () => {
  const { KEYS } = require('../src/config')
  const missing = Object.keys(KEYS).filter(key => {
    const leaf = key.split('.').pop()
    return !configDoc.includes(`\`${key}\``) && !configDoc.includes(`\`${leaf}\``)
  })
  assert.deepStrictEqual(missing, [])
})

test('every hook script exists, and every guard has a page and a disable name in the docs', () => {
  const hooks = require('../hooks/hooks.json').hooks
  for (const groups of Object.values(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        for (const a of h.args || []) {
          const file = a.replace('${CLAUDE_PLUGIN_ROOT}', root)
          if (/\.js$/.test(file)) assert.ok(fs.existsSync(file), `hooks.json runs a missing ${a}`)
        }
      }
    }
  }
  const { GUARDS } = require('../src/config')
  const disable = configDoc.split('\n').find(l => l.startsWith('| `BULKHEAD_DISABLE`')) || ''
  for (const guard of Object.keys(GUARDS)) {
    assert.ok(disable.includes(`\`${guard}\``), `BULKHEAD_DISABLE row does not list ${guard}`)
    if (guard === 'session-state') continue
    assert.ok(fs.existsSync(path.join(root, 'docs/guards', `${guard}.md`)), `docs/guards/${guard}.md is missing`)
  }
})
