'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { check, ruleOf } = require('../src/basics')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { runScript, tempDir } = require('./helpers')

// A fake git: the repo is /home/dev/work/shop, on branch `branch`, with `status` as porcelain output.
function fakeGit({ branch = 'feature', status = '' } = {}) {
  const calls = []
  const run = args => {
    calls.push(args.join(' '))
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/home/dev/work/shop'
    if (args[0] === 'rev-parse') return branch
    if (args[0] === 'status') return status
    throw new Error('unexpected git ' + args.join(' '))
  }
  return { run, calls }
}

const linux = (git = fakeGit()) => ({ cwd: '/home/dev/work/shop/web', home: '/home/dev', platform: 'linux', run: git.run })
const win = (git = fakeGit()) => ({ cwd: 'C:\\work\\shop', home: 'C:\\Users\\dev', platform: 'win32', run: git.run })

test('rm -rf at a root, home, or above the repo is blocked', () => {
  for (const cmd of ['rm -rf /', 'rm -rf /*', 'sudo rm -rf / --no-preserve-root', 'rm -rf ~', 'rm -fr ~/', 'rm -rf $HOME/*',
    'rm -rf "${HOME}"', 'rm -r -f /home', 'rm -rf ../..', 'cd /tmp && rm -rf /home/dev', 'rm --recursive --force ../../*']) {
    assert.ok(check(cmd, linux()), cmd)
  }
  for (const cmd of ['Remove-Item -Recurse -Force C:\\', 'Remove-Item $env:USERPROFILE -Recurse -Force', 'rd /s /q C:\\Users',
    'rmdir /s /q %USERPROFILE%', 'rm -rf /c/', 'rm -rf /c/Users/dev', 'rm -rf ..']) {
    assert.ok(check(cmd, win({ run: () => 'C:/work/shop' })), cmd)
  }
})

test('a cwd spelled another way than git spells the repository still protects what is above it', () => {
  // git prints the real path; the session entered through a link (a junction on Windows, which
  // needs no admin rights). GitHub's Windows runners do the same with a short name, C:\Users\RUNNER~1.
  const base = tempDir()
  const shop = path.join(base, 'real', 'shop')
  fs.mkdirSync(shop, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: shop, stdio: 'ignore' })
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'), 'junction')
  const cwd = path.join(base, 'link', 'shop')
  const home = path.join(tempDir(), 'home')
  for (const cmd of ['rm -rf ..', 'rm -rf ../*', 'rm -rf ../..']) assert.ok(check(cmd, { cwd, home }), cmd)
  for (const cmd of ['rm -rf dist', 'rm -rf ./not-made-yet/x', 'rm -rf ../shop/dist']) assert.strictEqual(check(cmd, { cwd, home }), null, cmd)
})

test('everyday deletes pass', () => {
  for (const cmd of ['rm -rf node_modules', 'rm -rf ./dist', 'rm -rf build/ coverage/', 'rm -rf ~/.cache/pw-test', 'rm -rf /tmp/x',
    'rm -rf ../api/dist', 'rm -rf "$BUILD_DIR"', 'rm -r ~', 'rm -f ~/notes.txt', 'echo rm -rf /', 'git rm -rf --cached .',
    "cat > clean.sh <<'EOF'\nrm -rf ~\nEOF"]) {
    assert.strictEqual(check(cmd, linux()), null, cmd)
  }
  assert.strictEqual(check('Remove-Item -Recurse -Force .\\dist', win()), null)
  assert.strictEqual(check('rd /s /q node_modules', win()), null)
})

test('rm inside the current directory does not ask git', () => {
  const git = fakeGit()
  check('rm -rf node_modules dist', linux(git))
  assert.deepStrictEqual(git.calls, [])
})

test('force-push to main or master is blocked', () => {
  for (const cmd of ['git push --force origin main', 'git push -f origin master', 'git push origin +main', 'git push -uf origin HEAD:main',
    'git push --force origin feature:refs/heads/main', 'git -C ../app push -f origin main']) {
    assert.ok(check(cmd, linux()), cmd)
  }
  assert.ok(check('git push --force', linux(fakeGit({ branch: 'main' }))))
  assert.ok(check('git push -f origin HEAD', linux(fakeGit({ branch: 'master' }))))
})

test('other pushes pass', () => {
  for (const cmd of ['git push origin main', 'git push --force-with-lease origin main', 'git push --force-if-includes --force-with-lease',
    'git push -f origin feature', 'git push --force', 'git push -u origin HEAD', 'git commit -m "never git push -f origin main"']) {
    assert.strictEqual(check(cmd, linux()), null, cmd)
  }
})

test('reset --hard and clean -fdx are blocked only when they would lose work', () => {
  const dirty = fakeGit({ status: ' M src/app.js\n?? notes.md\n' })
  assert.match(check('git reset --hard', linux(dirty)), /1 uncommitted change \(src\/app\.js\)/)
  assert.match(check('git reset --hard origin/main', linux(dirty)), /git clean -n/)
  assert.match(check('git clean -fdx', linux(dirty)), /1 untracked file \(notes\.md\)/)
  const untrackedOnly = fakeGit({ status: '?? notes.md\n' })
  assert.strictEqual(check('git reset --hard', linux(untrackedOnly)), null)
  assert.strictEqual(check('git reset --hard', linux(fakeGit())), null)
  assert.strictEqual(check('git clean -fdx', linux(fakeGit({ status: ' M a.js\n' }))), null)
  assert.strictEqual(check('git clean -n', linux(dirty)), null)
  assert.strictEqual(check('git reset --soft HEAD~1', linux(dirty)), null)
  // not a repository: allowed
  assert.strictEqual(check('git reset --hard', linux({ run: () => { throw new Error('not a git repository') } })), null)
})

test('each rule can be turned off', () => {
  const saved = process.env.BULKHEAD_DISABLE
  try {
    process.env.BULKHEAD_DISABLE = 'rm-root,force-push-main'
    assert.strictEqual(check('rm -rf ~', linux()), null)
    assert.strictEqual(check('git push -f origin main', linux()), null)
    assert.ok(check('git reset --hard', linux(fakeGit({ status: ' M a.js' }))))
  } finally {
    process.env.BULKHEAD_DISABLE = saved
  }
})

test('hook exits 2 on a block and fails open', () => {
  assert.strictEqual(runScript('basics', { tool_name: 'Bash', cwd: process.cwd(), tool_input: { command: 'rm -rf ~' } }).status, 2)
  assert.strictEqual(runScript('basics', { tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules' } }).status, 0)
  assert.strictEqual(runScript('basics', 'not json').status, 0)
  assert.strictEqual(runScript('basics', { tool_input: { command: 'rm -rf ~' } }, { BULKHEAD_DISABLE: 'basics' }).status, 0)
})

test('rm -rf of a folder directly in home, or a top-level folder, is blocked', () => {
  for (const cmd of ['rm -rf ~/Documents', 'rm -rf ~/backups', 'rm -rf "$HOME/Desktop"', 'rm -rf /home/dev/photos', 'rm -rf /srv', 'rm -rf /usr',
    'rm -rf /opt/', 'cd /tmp && rm -rf ~/archive']) {
    assert.ok(check(cmd, linux()), cmd)
  }
  assert.ok(check('Remove-Item -Recurse -Force $env:USERPROFILE\\Documents', win()))
  assert.match(check('rm -rf ~/Documents', linux()), /directly in your home directory/)
  assert.match(check('rm -rf /srv', linux()), /top-level folder/)
})

test('caches in home and deeper folders still pass', () => {
  for (const cmd of ['rm -rf ~/.cache', 'rm -rf ~/.npm', 'rm -rf ~/.pnpm-store', 'rm -rf ~/.gradle', 'rm -rf ~/tmp', 'rm -rf ~/.Trash',
    'rm -rf ~/Documents/old-export', 'rm -rf ~/dev/shop-old', 'rm -rf /tmp/x', 'rm -f ~/notes.txt']) {
    assert.strictEqual(check(cmd, linux()), null, cmd)
  }
})

test('agent-author blocks commits authored as the agent', () => {
  for (const cmd of ['git commit -m "fix" --author="Claude <noreply@anthropic.com>"', 'git commit --author "Claude Code <c@x>" -m x',
    'git config user.name "Claude"', 'git config --global user.email noreply@anthropic.com', 'git -c user.name=Claude commit -m x',
    'GIT_AUTHOR_NAME=Claude git commit -m x', 'export GIT_COMMITTER_EMAIL=noreply@anthropic.com && git commit -m x',
    'git merge --author="Claude <noreply@anthropic.com>" feature']) {
    const msg = check(cmd, linux())
    assert.ok(msg, cmd)
    assert.match(msg, /makes the agent the author/, cmd)
  }
  assert.match(check('$env:GIT_AUTHOR_NAME = "Claude"; git commit -m x', { ...win(), mode: 'ps' }), /agent the author/)
})

test('agent-author lets ordinary commits and messages through', () => {
  for (const cmd of ['git commit -m "Co-Authored-By: Claude <noreply@anthropic.com>"', 'git config user.name "Dana Kim"', 'git config user.name',
    'git log --author=claude', 'git commit -m "teach claude to commit"', 'echo GIT_AUTHOR_NAME=Claude', 'git commit --author="Dana <d@x>" -m x',
    "git commit -F - <<'EOF'\nfix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF"]) {
    assert.strictEqual(check(cmd, linux()), null, cmd)
  }
})

test('agent-author can be turned off alone', () => {
  const r = runScript('basics', { tool_input: { command: 'git config user.name Claude' } }, { BULKHEAD_DISABLE: 'agent-author' })
  assert.strictEqual(r.status, 0)
  assert.strictEqual(runScript('basics', { tool_input: { command: 'git config user.name Claude' } }).status, 2)
})

test('deleting a protected branch is blocked', () => {
  for (const cmd of ['git push origin :main', 'git push origin :master', 'git push origin :refs/heads/main', 'git push origin --delete main', 'git push --delete origin main',
    'git push origin -d main', 'git push -d origin master', 'git push origin --del main', 'git push origin feature :main', 'git branch -D main', 'git branch -D master',
    'git branch --delete --force main', 'git branch -d -f main', 'git branch -df main', 'git branch -fd master', 'git branch -D old main', 'git -C ../app push origin :main',
    'git --no-pager push origin --delete main', 'git push origin --delete refs/heads/main']) {
    const why = check(cmd, linux())
    assert.ok(why, cmd)
    assert.match(why, /deletes the protected branch \(main, master\)/, cmd)
    assert.strictEqual(ruleOf(why), 'protected-delete', cmd)
  }
  for (const cmd of ['git push origin :feature', 'git push origin --delete feature', 'git push origin -d fix/main', 'git branch -D feature', 'git branch -d main', 'git branch -D main-old',
    'git branch -m main old', 'git branch main', 'git push origin main', 'git push origin feature:main-x', 'git branch -D', 'git push -o ci.skip origin feature']) {
    assert.strictEqual(check(cmd, linux()), null, cmd)
  }
  assert.ok(check('git push origin :release', { ...linux(), protectedBranches: ['release'] }))
  assert.strictEqual(check('git push origin :main', { ...linux(), protectedBranches: ['release'] }), null)
})

test('the protected-delete rule can be turned off alone', () => {
  const saved = process.env.BULKHEAD_DISABLE
  try {
    process.env.BULKHEAD_DISABLE = 'protected-delete'
    assert.strictEqual(check('git push origin :main', linux()), null)
    assert.ok(check('git push --force origin main', linux()))
  } finally {
    if (saved === undefined) delete process.env.BULKHEAD_DISABLE
    else process.env.BULKHEAD_DISABLE = saved
  }
})

test('git global options do not hide force-pushes, resets or the repository', () => {
  for (const cmd of ['git --no-pager push --force origin main', 'git -p push -f origin master', 'git --paginate push origin +main', 'git -c push.default=simple push -f origin main',
    'git --git-dir=.git --work-tree=. push -f origin main', 'git --literal-pathspecs push --force origin main']) {
    assert.match(check(cmd, linux()), /force-pushing/, cmd)
  }
  const dirty = fakeGit({ status: ' M src/app.js\n' })
  assert.match(check('git --no-pager reset --hard', linux(dirty)), /1 uncommitted change/)
  assert.match(check('git -c core.pager=cat -C . reset --hard', linux(dirty)), /1 uncommitted change/)
  // the git run sees the same --git-dir and --work-tree the command names
  const seen = []
  const run = args => { seen.push(args.join(' ')); return args.includes('status') ? ' M a.js\n' : '' }
  check('git --git-dir=/srv/repo.git --work-tree=/srv/site reset --hard', { ...linux(), run })
  const want = `--git-dir=${path.resolve('/srv/repo.git')} --work-tree=${path.resolve('/srv/site')} status --porcelain`
  assert.ok(seen.some(a => a === want), seen.join(' | '))
})
