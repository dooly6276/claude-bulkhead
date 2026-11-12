'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')

// The coding agents other than Claude Code that bulkhead recognizes as live sessions. Each entry
// matches the agent's CLI process. The patterns come from the published `bin` entries of the
// packages and the agents' install scripts (see docs/other-agents.md); an entry is only used for
// matching, so a pattern that misses just leaves that agent out of the session list.
const RUNTIME = /^(?:node|bun)(?:\.exe)?$/i
const PYTHON = /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i
const AIDER = /^aider(?:\.exe)?$/i
const COMMAND_WORD = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/
const nameIs = (p, re) => re.test(p.name || '') || re.test(basename(p.cmd))

function basename(cmd) {
  const first = COMMAND_WORD.exec(cmd || '')
  const prog = first ? first[1] || first[2] || first[3] : ''
  return prog.split(/[\\/]/).pop()
}

// `node .../bin/<name>` or `node .../<name>.js`: a script launched through its runtime.
const script = base => new RegExp(`[\\\\/]${base}(?:\\.[cm]?js)?(?=["']?(?:\\s|$))`, 'i')

const AGENTS = {
  codex: {
    label: 'Codex',
    // the npm package starts a native codex binary from node; the outer node process is the root
    match: p => nameIs(p, /^codex(?:\.exe)?$/i) || (RUNTIME.test(p.name) && /@openai[\\/]codex[\\/]bin[\\/]codex\.js/.test(p.cmd)),
    dirs: ['.codex'],
    homeEnv: 'CODEX_HOME',
  },
  gemini: {
    label: 'Gemini',
    // gemini relaunches itself as a child with more heap; the outer process is the root
    match: p => nameIs(p, /^gemini(?:\.exe)?$/i) || (RUNTIME.test(p.name) && (/@google[\\/]gemini-cli[\\/]/.test(p.cmd) || script('gemini').test(p.cmd))),
    dirs: ['.gemini'],
  },
  copilot: {
    label: 'Copilot',
    match: p => nameIs(p, /^copilot(?:\.exe)?$/i) || (RUNTIME.test(p.name) && (/@github[\\/]copilot[\\/]/.test(p.cmd) || script('copilot').test(p.cmd))),
    dirs: ['.copilot'],
    homeEnv: 'COPILOT_HOME',
  },
  cursor: {
    label: 'Cursor',
    // the cursor-agent CLI (also installed as `agent`); the Cursor editor itself is not matched
    match: p => nameIs(p, /^cursor-agent(?:\.exe)?$/i) || /[\\/]cursor-agent[\\/]versions[\\/]/.test(p.cmd),
    dirs: ['.cursor'],
  },
  opencode: {
    label: 'opencode',
    match: p => nameIs(p, /^opencode(?:\.exe)?$/i) || (RUNTIME.test(p.name) && script('opencode').test(p.cmd)),
    dirs: ['.config/opencode', '.local/share/opencode'],
  },
  amp: {
    label: 'Amp',
    match: p => nameIs(p, /^amp(?:\.exe)?$/i) || /@ampcode[\\/]cli[\\/]/.test(p.cmd),
    dirs: ['.config/amp'],
  },
  cline: {
    label: 'Cline',
    match: p => nameIs(p, /^cline(?:\.exe)?$/i) || (RUNTIME.test(p.name) && script('cline').test(p.cmd)),
    dirs: ['.cline'],
  },
  droid: {
    label: 'Droid',
    match: p => nameIs(p, /^droid(?:\.exe)?$/i) || (RUNTIME.test(p.name) && script('droid').test(p.cmd)),
    dirs: ['.factory'],
  },
  aider: {
    label: 'Aider',
    // Python console scripts show the interpreter first on some platforms.
    match(p) {
      if (nameIs(p, AIDER)) return true
      if (!PYTHON.test(p.name || '')) return false
      const args = (p.cmd || '').replace(COMMAND_WORD, '')
      // flag-only interpreter options may come first: python3 -u -m aider, python -X utf8 -m aider
      return AIDER.test(basename(args)) || /^\s*(?:(?:-[bBdEiIOqsSuv]+|-X\s+\S+|-W\s+\S+)\s+)*-m\s+(?:aider|"aider"|'aider')(?=\s|$)/.test(args)
    },
    dirs: ['.aider', '.aider.conf.yml', '.local/bin/aider', '.local/bin/aider.exe'],
  },
}

// Names of the agents other than Claude Code (and of the ones that only have a hook, no CLI).
const NAMES = Object.keys(AGENTS)

// The agent a process is the CLI of, or null. Claude Code is decided by sessions.isClaudeCli.
function agentOf(p) {
  if (!p) return null
  for (const name of NAMES) if (AGENTS[name].match(p)) return name
  return null
}

function agentLabel(agent) {
  return !agent || agent === 'claude' ? 'Claude' : (AGENTS[agent] && AGENTS[agent].label) || agent
}

// Installation markers let the guard skip the process scan when no other agents are installed.
function installedAgents(home = os.homedir(), exists = fs.existsSync, env = process.env) {
  const xdg = env.XDG_CONFIG_HOME
  return NAMES.filter(name => {
    const a = AGENTS[name]
    // CODEX_HOME and COPILOT_HOME move the whole config folder somewhere else
    if (a.homeEnv && env[a.homeEnv] && exists(env[a.homeEnv])) return true
    return a.dirs.some(d => exists(path.join(home, d)) || (xdg && d.startsWith('.config/') && exists(path.join(xdg, d.slice(8)))))
  })
}

module.exports = { AGENTS, NAMES, agentOf, agentLabel, installedAgents }
