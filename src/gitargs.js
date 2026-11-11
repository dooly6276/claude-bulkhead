'use strict'
const path = require('path')
const shell = require('./shell')

// Options that go before the git subcommand and take a value in the next word.
const GLOBAL_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix', '--exec-path'])

// git [global options] <sub> args. Takes the words of one command; returns null for anything that
// is not git. dir is where git runs (-C applied); workTree and gitDir are set by --work-tree and
// --git-dir (or GIT_WORK_TREE and GIT_DIR written in front of the command, see `env`); opts are
// those two as absolute options to hand to a git run that must see the same repository.
function gitCall(t, cwd, env = {}) {
  if (shell.bin(t[0] || '') !== 'git') return null
  let dir = cwd
  let workTree = env.GIT_WORK_TREE ? path.resolve(cwd, env.GIT_WORK_TREE) : null
  let gitDir = env.GIT_DIR ? path.resolve(cwd, env.GIT_DIR) : null
  let bare = false
  let i = 1
  for (; i < t.length && t[i].startsWith('-') && t[i] !== '-'; i++) {
    const a = t[i]
    const eq = a.indexOf('=')
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    const inline = a.startsWith('--') && eq > 0
    const value = () => (inline ? a.slice(eq + 1) : t[++i])
    const v = GLOBAL_VALUED.has(name) && (inline || name !== '--exec-path') ? value() : null
    if (name === '-C' && v) dir = path.resolve(dir, v)
    else if (name === '--git-dir' && v) gitDir = path.resolve(dir, v)
    else if (name === '--work-tree' && v) workTree = path.resolve(dir, v)
    else if (name === '--bare') bare = true
  }
  const opts = []
  if (gitDir) opts.push(`--git-dir=${gitDir}`)
  if (workTree) opts.push(`--work-tree=${workTree}`)
  return { dir, sub: t[i], args: t.slice(i + 1), workTree, gitDir, bare, opts }
}

// The working tree a call acts on: the one --work-tree names, the folder git runs in when only
// --git-dir is given (git takes the current directory as the tree then), else git rev-parse.
function treeOf(call, run) {
  if (call.bare) throw new Error('bare repository')
  if (call.workTree) return call.workTree
  if (call.gitDir) return call.dir
  return run(['rev-parse', '--show-toplevel'], call.dir)
}

// Short-flag clusters and long options of one git subcommand. valuedShort lists the single letters
// that take a value (the rest of the cluster, or the next word); valuedLong the long names that
// take one in the next word. Returns { short: Set of letters, long: Set of names without --,
// pos: words that are not options (everything after -- included), after: the words after -- }.
function parseArgs(args, { valuedShort = '', valuedLong = [] } = {}) {
  const short = new Set()
  const long = new Set()
  const pos = []
  const after = []
  const valued = new Set(valuedLong)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--') { after.push(...args.slice(i + 1)); pos.push(...args.slice(i + 1)); break }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2)
      long.add(name)
      if (eq < 0 && valued.has(name)) i++
    } else if (a.length > 1 && a[0] === '-') {
      for (let k = 1; k < a.length; k++) {
        short.add(a[k])
        if (valuedShort.includes(a[k])) { if (k === a.length - 1) i++; break }
      }
    } else pos.push(a)
  }
  return { short, long, pos, after }
}

// GIT_WORK_TREE=/x GIT_DIR=/x/.git git ...: the assignments are dropped from the words of a
// command, so they are read from its text.
function gitEnv(text) {
  const env = {}
  for (const m of String(text).matchAll(/(?:^|[\s;&|(])GIT_(WORK_TREE|DIR)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) env[`GIT_${m[1]}`] = m[2].replace(/^["']|["']$/g, '')
  return env
}

module.exports = { gitCall, gitEnv, treeOf, parseArgs }
