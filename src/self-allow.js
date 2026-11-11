'use strict'
const path = require('path')
const shell = require('./shell')

// The agent must not approve its own blocks. `bulkhead allow <code>` is for the user, in their
// own terminal, so a Bash tool call that runs it, or that writes the allow state files by hand,
// is blocked (basics, rule self-allow).

const NAMES = /^(?:bulkhead|claude-bulkhead|bulkhead-cli)(?:\.(?:js|cjs|mjs|cmd|ps1|exe))?$/i
const SCRIPT = /(?:^|[\\/])(?:bin[\\/](?:bulkhead|claude-bulkhead|bulkhead-cli)|src[\\/](?:cli|allow-cli|allow-once)\.js)$/i
const NODE = /^(?:node|nodejs|bun|deno|tsx|ts-node)$/i
const RUNNER = /^(?:npx|bunx|pnpx|pnpm|npm|yarn|bun|dlx|exec|x)$/i

const base = a => path.basename(String(a).replace(/\\/g, '/')).replace(/@[\w.^~-]+$/, '')
const isAllow = a => /^allow$/i.test(a)

// Whether one simple command is a run of `bulkhead allow`.
function runsAllow(argv) {
  if (!argv.length) return false
  const b = shell.bin(argv[0])
  const rest = argv.slice(1)
  if (NAMES.test(b)) return rest.slice(0, 4).some(isAllow)
  if (NODE.test(b)) {
    const i = rest.findIndex(a => SCRIPT.test(String(a).replace(/\\/g, '/')) || NAMES.test(base(a)))
    return i >= 0 && rest.slice(i + 1, i + 4).some(isAllow)
  }
  if (RUNNER.test(b)) {
    const i = rest.findIndex(a => NAMES.test(base(a)) || /^claude-bulkhead(?:@|$)/i.test(a))
    return i >= 0 && rest.slice(i + 1, i + 4).some(isAllow)
  }
  // $BULKHEAD allow 7F3K, `which bulkhead` allow: a name that is only known at run time
  return /^[$`]|^\$\(/.test(argv[0]) && rest.some(isAllow)
}

const READERS = /^(?:cat|ls|dir|type|head|tail|less|more|grep|egrep|rg|wc|stat|file|find|test|\[|get-content|gc|get-childitem|select-string|echo|printf)$/i
const REDIRECT = />/

// The folders that hold the allow state: the default one and the one BULKHEAD_STATE_DIR names.
function stateRe(stateDir) {
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\\/]+/g, '[\\\\/]+')
  const parts = ['bulkhead[\\\\/]+allow(?:[\\\\/]|\\b)']
  if (stateDir) parts.push(`${esc(stateDir)}[\\\\/]+allow(?:[\\\\/]|\\b)`)
  return new RegExp(parts.join('|'), 'i')
}

// Whether the text writes into (or runs anything but a plain read on) the allow state folder.
function touchesAllowState(src, mode, stateDir) {
  const re = stateRe(stateDir)
  if (!re.test(src)) return false
  const text = shell.prepare(src, mode)
  for (const seg of text.split(/\n|;|&&|\|\|/)) {
    if (!re.test(seg)) continue
    const cmds = shell.commands(seg, mode)
    const reads = cmds.length > 0 && cmds.every(c => READERS.test(shell.bin(c.argv[0])))
    if (!reads || REDIRECT.test(seg.replace(/\d?>&\d|\d?>\s*(?:\/dev\/null|\$null|nul)\b/gi, ' '))) return true
  }
  return false
}

// A message when the command approves a block itself, or null.
function check(cmd, { mode = 'sh', stateDir = process.env.BULKHEAD_STATE_DIR } = {}) {
  const src = String(cmd || '')
  if (!/allow/i.test(src)) return null
  const prepared = shell.prepare(src, mode)
  const hit = shell.commands(prepared, mode).find(c => runsAllow(c.argv))
  if (hit || touchesAllowState(src, mode, stateDir)) {
    return '[bulkhead] basics: the agent cannot approve its own blocks. `bulkhead allow <code>` and the allow state files are for the user.\n' +
      'Do not run it or edit the files. Tell the user what was blocked and the code from the block message; they run `bulkhead allow <code>` in their own terminal, then you retry the same command.'
  }
  return null
}

module.exports = { check, runsAllow, touchesAllowState }
