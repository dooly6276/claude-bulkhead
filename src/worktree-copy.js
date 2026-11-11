'use strict'
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// Which untracked files a new worktree needs from the checkout it was made from.
// .worktreeinclude is the same file Claude Code reads (https://code.claude.com/docs/en/worktrees):
// gitignore syntax, and only files that are also gitignored are copied. git does the matching.

const MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_NAME = /^(?:\.env|\.env\..+|\.envrc|\.tool-versions|\.nvmrc)$/
const TEMPLATE = /^\.env(?:\..+)?\.(?:example|sample|template|dist)$/
// never copied, whatever the include file says
const NEVER = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'target', '.venv', 'venv', '__pycache__'])
// ignored folders and files a worktree can lose without losing work
const REBUILDABLE = new Set([...NEVER, '.parcel-cache', '.vite', '.svelte-kit', '.pytest_cache', '.DS_Store', '.eslintcache'])

function git(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function lines(s) {
  return s.split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean)
}

function isDefaultName(name) {
  return DEFAULT_NAME.test(name) && !TEMPLATE.test(name)
}

function inNeverDir(rel) {
  return rel.split('/').some(seg => NEVER.has(seg))
}

// Relative (forward slash) paths of the files to copy, plus what was left out and why.
function selectFiles(root, run = git) {
  const include = path.join(root, '.worktreeinclude')
  const skipped = []
  let rels
  let source
  if (fs.existsSync(include)) {
    source = '.worktreeinclude'
    const r = run(['ls-files', '-z', '-o', '-i', '--exclude-from=.worktreeinclude', '--', '.', ':(exclude)node_modules', ':(exclude)**/node_modules'], root)
    rels = r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []
    if (rels.length) {
      const ign = run(['check-ignore', '-z', '--stdin'], root, rels.join('\0') + '\0')
      const set = new Set(ign.stdout.split('\0').filter(Boolean))
      for (const rel of rels) if (!set.has(rel)) skipped.push({ path: rel, why: 'not gitignored' })
      rels = rels.filter(rel => set.has(rel))
    }
  } else {
    source = 'default'
    let names = []
    try { names = fs.readdirSync(root).filter(isDefaultName) } catch {}
    const tracked = new Set(lines(run(['ls-files', '--', ...names], root).stdout))
    rels = names.filter(n => !tracked.has(n))
  }
  const files = []
  for (const rel of rels) {
    if (inNeverDir(rel)) { skipped.push({ path: rel, why: 'dependency or build folder' }); continue }
    let st
    try { st = fs.lstatSync(path.join(root, rel)) } catch { continue }
    if (!st.isFile()) { skipped.push({ path: rel, why: 'not a regular file' }); continue }
    if (st.size > MAX_BYTES) { skipped.push({ path: rel, why: 'over 5 MB' }); continue }
    files.push(rel)
  }
  return { source, files, skipped }
}

function copyFiles(from, to, rels) {
  const copied = []
  for (const rel of rels) {
    const dest = path.join(to, rel)
    if (fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(from, rel), dest)
    copied.push(rel)
  }
  return copied
}

module.exports = { selectFiles, copyFiles, isDefaultName, inNeverDir, REBUILDABLE, MAX_BYTES, git }
