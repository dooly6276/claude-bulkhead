'use strict'
const fs = require('fs')
const path = require('path')

// Branch and worktree of a folder, from the files in .git. No git process: this runs for every
// session on every `bulkhead status` / `top` refresh.

const realIo = {
  read: p => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  isDir: p => { try { return fs.statSync(p).isDirectory() } catch { return false } },
  isFile: p => { try { return fs.statSync(p).isFile() } catch { return false } },
}

// "ref: refs/heads/feat/x" is a branch; anything else is a detached commit.
function parseHead(text) {
  const t = String(text || '').trim()
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(t)
  if (m) return { branch: m[1], detached: false }
  if (/^ref:/.test(t)) return { branch: t.replace(/^ref:\s*/, ''), detached: false }
  return /^[0-9a-f]{7,64}$/i.test(t) ? { branch: t.slice(0, 7), detached: true } : null
}

function parseGitFile(text) {
  const m = /^gitdir:\s*(.+)$/m.exec(String(text || ''))
  return m ? m[1].trim() : null
}

// A linked worktree's gitdir is <repo>/.git/worktrees/<name>; a submodule's is .../modules/<name>.
const LINKED = /\/worktrees\/[^/]+\/?$/

function head(file, io) {
  return parseHead(io.read(file)) || { branch: null, detached: false }
}

// { root, branch, detached, worktree } for the nearest repository at or above `dir`, or null.
function gitInfo(dir, io = realIo) {
  if (!dir) return null
  let cur = path.resolve(dir)
  for (let i = 0; i < 40; i++) {
    const dot = path.join(cur, '.git')
    if (io.isDir(dot)) return { root: cur, worktree: false, ...head(path.join(dot, 'HEAD'), io) }
    if (io.isFile(dot)) {
      const gitdir = parseGitFile(io.read(dot))
      if (!gitdir) return { root: cur, worktree: false, branch: null, detached: false }
      const abs = path.resolve(cur, gitdir)
      return { root: cur, worktree: LINKED.test(gitdir.replace(/\\/g, '/')), ...head(path.join(abs, 'HEAD'), io) }
    }
    const up = path.dirname(cur)
    if (up === cur) return null
    cur = up
  }
  return null
}

module.exports = { gitInfo, parseHead, parseGitFile }
