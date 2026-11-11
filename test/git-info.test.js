'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { gitInfo, parseHead, parseGitFile } = require('../src/git-info')
const { tempDir } = require('./helpers')

// a fake file system: { path: text } for files, a trailing-slash key for directories
function fakeIo(entries) {
  const norm = p => p.replace(/\\/g, '/')
  return {
    read: p => (norm(p) in entries ? entries[norm(p)] : null),
    isDir: p => `${norm(p)}/` in entries,
    isFile: p => norm(p) in entries,
  }
}

test('HEAD: a branch, a nested branch, a detached commit, junk', () => {
  assert.deepStrictEqual(parseHead('ref: refs/heads/main\n'), { branch: 'main', detached: false })
  assert.deepStrictEqual(parseHead('ref: refs/heads/feat/status-waiting\n'), { branch: 'feat/status-waiting', detached: false })
  assert.deepStrictEqual(parseHead('9fceb02d0ae598e95dc970b74767f19372d61af8\n'), { branch: '9fceb02', detached: true })
  assert.strictEqual(parseHead('garbage'), null)
  assert.strictEqual(parseHead(null), null)
})

test('.git file: the gitdir line', () => {
  assert.strictEqual(parseGitFile('gitdir: /repo/.git/worktrees/api\n'), '/repo/.git/worktrees/api')
  assert.strictEqual(parseGitFile('nothing here'), null)
})

test('a normal checkout reads .git/HEAD', () => {
  const io = fakeIo({ '/work/shop/.git/': '', '/work/shop/.git/HEAD': 'ref: refs/heads/main\n' })
  assert.deepStrictEqual(gitInfo('/work/shop/web/src', io), { root: path.resolve('/work/shop'), worktree: false, branch: 'main', detached: false })
})

test('a linked worktree is marked and reads the HEAD in its own gitdir', () => {
  const io = fakeIo({
    '/work/shop-api/.git': 'gitdir: /work/shop/.git/worktrees/shop-api\n',
    '/work/shop/.git/worktrees/shop-api/HEAD': 'ref: refs/heads/feat/api\n',
  })
  const g = gitInfo('/work/shop-api', io)
  assert.strictEqual(g.worktree, true)
  assert.strictEqual(g.branch, 'feat/api')
})

test('a relative gitdir and Windows separators work; a submodule is not a worktree', () => {
  const rel = fakeIo({
    '/work/wt/.git': 'gitdir: ../main/.git/worktrees/wt\n',
    '/work/main/.git/worktrees/wt/HEAD': 'ref: refs/heads/x\n',
  })
  assert.deepStrictEqual([gitInfo('/work/wt', rel).worktree, gitInfo('/work/wt', rel).branch], [true, 'x'])
  const win = fakeIo({ '/c:/dev/app/.git': 'gitdir: C:/dev/main/.git/worktrees/app\n' })
  assert.strictEqual(gitInfo('/c:/dev/app', win).worktree, true)
  const winBack = fakeIo({ '/work/a/.git': 'gitdir: C:\\dev\\main\\.git\\worktrees\\a\n' })
  assert.strictEqual(gitInfo('/work/a', winBack).worktree, true)
  const sub = fakeIo({ '/work/main/lib/.git': 'gitdir: ../.git/modules/lib\n', '/work/main/.git/modules/lib/HEAD': 'ref: refs/heads/dev\n' })
  const g = gitInfo('/work/main/lib', sub)
  assert.deepStrictEqual([g.worktree, g.branch], [false, 'dev'])
})

test('detached HEAD, unreadable HEAD, no repository', () => {
  const det = fakeIo({ '/r/.git/': '', '/r/.git/HEAD': '9fceb02d0ae598e95dc970b74767f19372d61af8\n' })
  assert.deepStrictEqual([gitInfo('/r', det).branch, gitInfo('/r', det).detached], ['9fceb02', true])
  assert.strictEqual(gitInfo('/r', fakeIo({ '/r/.git/': '' })).branch, null)
  assert.strictEqual(gitInfo('/nowhere', fakeIo({})), null)
  assert.strictEqual(gitInfo(null), null)
})

test('real files: a repository and a worktree made by hand', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'main', '.git', 'worktrees', 'wt'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'main', '.git', 'HEAD'), 'ref: refs/heads/trunk\n')
  fs.writeFileSync(path.join(dir, 'main', '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/side\n')
  fs.mkdirSync(path.join(dir, 'wt'))
  fs.writeFileSync(path.join(dir, 'wt', '.git'), `gitdir: ${path.join(dir, 'main', '.git', 'worktrees', 'wt')}\n`)
  assert.deepStrictEqual([gitInfo(path.join(dir, 'main')).branch, gitInfo(path.join(dir, 'main')).worktree], ['trunk', false])
  assert.deepStrictEqual([gitInfo(path.join(dir, 'wt')).branch, gitInfo(path.join(dir, 'wt')).worktree], ['side', true])
})
