'use strict'
// How to let one blocked rule through for good: the exact config snippet and the
// BULKHEAD_DISABLE name. Shown in block messages (one line) and by `bulkhead explain`.

const RULE_KEYS = {
  'rm-root': ['basics', 'rmRoot'],
  'rm-empty-var': ['basics', 'rmEmptyVar'],
  'rm-unquoted-var': ['basics', 'rmUnquotedVar'],
  'rm-git-dir': ['basics', 'rmGitDir'],
  'force-push-main': ['basics', 'forcePushMain'],
  'protected-delete': ['basics', 'protectedDelete'],
  'discard-changes': ['basics', 'discardChanges'],
  'agent-author': ['basics', 'agentAuthor'],
  'stage-all': ['checkoutGuard', 'stageAll'],
  'remove-session-dir': ['checkoutGuard', 'removeSessionDir'],
  'mass-kill': ['killGuard', 'massKill'],
  'docker-mass': ['killGuard', 'dockerMass'],
  'device-kill': ['killGuard', 'deviceKill'],
  'app-quit': ['killGuard', 'appQuit'],
  'service-stop': ['killGuard', 'serviceStop'],
  'other-session-pid': ['killGuard', 'ownerCheck', 'owner-check'],
  'broad-pattern': ['killGuard', 'broadPattern'],
  'bsd-pkill': ['killGuard', 'bsdPkill'],
}
const SECTION = {
  'kill-guard': 'killGuard', 'wait-guard': 'waitGuard', 'memory-guard': 'memoryGuard', 'port-guard': 'portGuard',
  'checkout-guard': 'checkoutGuard', 'disk-guard': 'diskGuard', basics: 'basics', 'orphan-reaper': 'orphanReaper', 'secrets-guard': 'secretsGuard', 'edit-guard': 'editGuard',
}

// The shared program name a kill command aims at, to put in allowNames.
function killName(command) {
  try {
    const kill = require('./kill-guard')
    const shell = require('./shell')
    const names = kill.nameList()
    const words = shell.unwrap(shell.prepare(String(command || ''), 'sh'), 'sh').split(/[^\w.*?-]+/)
    return words.map(w => w.toLowerCase().replace(/\.exe$/, '')).find(w => w && kill.nameHits(w, names)) || null
  } catch {
    return null
  }
}

// { json, disable } for a guard and rule; json is null when the rule cannot be allowed.
function allowHint(guard, rule, { command = '', message = '' } = {}) {
  const j = o => JSON.stringify(o)
  if (rule === 'self-allow') return { json: null, disable: null }
  const key = RULE_KEYS[rule]
  if (key) return { json: j({ [key[0]]: { [key[1]]: false } }), disable: key[2] || rule }
  const section = SECTION[guard]
  if (!section) return { json: null, disable: guard }
  const off = { json: j({ [section]: { enabled: false } }), disable: guard }
  if (guard === 'kill-guard') return { json: j({ killGuard: { allowNames: [killName(command) || '<name>'] } }), disable: guard }
  if (guard === 'port-guard') {
    const port = /\bport (\d{2,5})\b/.exec(message)
    return port ? { json: j({ portGuard: { ignorePorts: [Number(port[1])] } }), disable: guard } : off
  }
  if (guard === 'secrets-guard') {
    const file = /\(([^()\n]+)\) to the model/.exec(message)
    return { json: j({ secretsGuard: { allow: [file && !/\s/.test(file[1]) ? file[1] : '<file>'] } }), disable: guard }
  }
  if (guard === 'edit-guard') return { json: j({ editGuard: { mode: 'warn' } }), disable: guard }
  if (guard === 'wait-guard') return { json: j({ waitGuard: { limitSeconds: 600 } }), disable: guard }
  if (guard === 'memory-guard' && rule === 'low-memory') return { json: j({ memory: { minFreeGb: 1 } }), disable: guard }
  return off
}

module.exports = { allowHint, killName }
