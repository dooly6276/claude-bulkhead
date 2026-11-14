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

// The repository at the fake cwd has a .git folder; nothing else exists.
const gitHere = p => /[\\/]shop[\\/]web[\\/]\.git$|[\\/]shop[\\/]\.git$/.test(p)
const opts = (extra = {}) => ({ ...linux(), env: {}, isDir: gitHere, ...extra })
const ruleFor = (cmd, o = opts()) => { const m = check(cmd, o); return m && ruleOf(m) }

test('rm-empty-var: a variable or command output followed by / becomes / when it is empty', () => {
  for (const cmd of ['rm -rf $D/', 'rm -rf ${D}/', 'rm -rf "$D"/', 'rm -rf "$D/"', 'rm -rf "$BUILD_DIR"/*', 'rm -rf $X/*',
    'rm -rf $1/', 'rm -rf $(cygpath -u "$X")/', 'rm -rf `dirname $F`/', 'rm -rf "$(git rev-parse --show-toplevel)"/*',
    'sudo rm -rf $OUT/', 'bash -c \'rm -rf $R/\'', 'R=/x; bash -c \'rm -rf $R/\'', 'D=; rm -rf $D/', 'D=$OTHER; rm -rf $D/',
    'D=$(git rev-parse --show-toplevel); rm -rf "$D"/']) {
    assert.strictEqual(ruleFor(cmd), 'rm-empty-var', cmd)
  }
  const m = check('rm -rf "$D"/', opts())
  assert.match(m, /if D is empty or unset, \$D\/ becomes \/, the whole drive/)
  assert.match(m, /rm -rf "\$\{D:\?\}\/"/)
})

test('rm-empty-var: a path command\'s output deleted as a whole (anthropics/claude-code#95426)', () => {
  for (const cmd of ['rm -rf "$(cygpath -u \'C:\\\')" 2>/dev/null', 'rm -rf "$(cygpath -u \'C:\\\')"Users', 'rm -rf $(wslpath C:/)',
    'rm -rf "$(mktemp -d)"', 'rm -rf "$(pwd)"', 'rm -rf $(dirname "$0")']) {
    assert.strictEqual(ruleFor(cmd), 'rm-empty-var', cmd)
  }
  assert.match(check('rm -rf "$(cygpath -u \'C:\\\')"', opts()), /prints a drive or filesystem root/)
})

test('rm-empty-var: rsync --delete into an empty destination (anthropics/claude-code#109735)', () => {
  for (const cmd of ['rsync -a --delete src/ $R/', 'rsync -a --delete-after src/ "${R}"/', 'rsync -av --delete src/ dst/ $R',
    'rsync -a --del ./ $(cygpath -u "$X")/',
    'wsl -d Ubuntu-24.04 -- bash -lc \'set -u; mkdir -p $R; rsync -a --delete --exclude node_modules /mnt/d/p/ $R/\'',
    'wsl -d Ubuntu-24.04 -- bash -lc \'rm -rf $R/\'', 'wsl -- rm -rf $R/']) {
    assert.strictEqual(ruleFor(cmd), 'rm-empty-var', cmd)
  }
  assert.match(check('rsync -a --delete src/ $R/', opts()), /--delete then deletes everything there/)
  // the incident itself: wsl -- hands the line to a Linux shell that expands $R before bash -lc sets it
  assert.strictEqual(ruleFor('wsl -d Ubuntu-24.04 -- bash -lc \'set -u; R=~/some-dir; mkdir -p $R; rsync -a --delete --exclude x /mnt/d/p/ $R/\''), 'rm-empty-var')
  for (const cmd of ['rsync -a --delete src/ dist/', 'rsync -a src/ $R/', 'rsync -a --delete src/ "$TMPDIR/out/"', 'rsync -a --delete src/ "${R:?}/"',
    'wsl -d Ubuntu-24.04 --exec bash -lc \'set -u; R=~/some-dir; mkdir -p $R; rsync -a --delete --exclude x /mnt/d/p/ $R/\'',
    'bash -lc \'set -u; R=~/some-dir; mkdir -p $R; rsync -a --delete --exclude x /mnt/d/p/ $R/\'',
    'wsl -d Ubuntu-24.04 -- bash -lc \'rsync -a --delete /mnt/d/p/ "${R:?}"/\'']) {
    assert.strictEqual(check(cmd, opts()), null, cmd)
  }
})

test('rm-empty-var: the safe forms and variables set on the same line pass', () => {
  for (const cmd of ['rm -rf "${D:?}/"', 'rm -rf "${D:?}"/*', 'rm -rf "${D:?missing}"/', 'rm -rf "$TMPDIR/foo"', 'rm -rf $D/build',
    'rm -rf "$D"', 'rm -rf "$(git rev-parse --show-toplevel)/dist"', 'rm -rf $(find . -name "*.pyc")', 'rm -rf $(git ls-files -o)',
    'D=$(mktemp -d) && rm -rf $D/', 'D=/some/literal; rm -rf "$D"/', 'export D="$TMPDIR/x"; rm -rf "$D"/', 'local D=${1:?}; rm -rf $D/*',
    'for d in a b; do rm -rf $d/; done', 'rm -rf $PWD/', 'git commit -m "never rm -rf $D/ again"', 'echo "rm -rf $D/"',
    "grep -n 'rm -rf $D/' notes.md", 'git rm -r --cached x']) {
    assert.strictEqual(check(cmd, opts()), null, cmd)
  }
  process.env.BULKHEAD_DISABLE = 'rm-empty-var'
  try { assert.strictEqual(check('rm -rf $D/', opts()), null) } finally { delete process.env.BULKHEAD_DISABLE }
})

test('rm-empty-var: PowerShell and cmd forms', () => {
  assert.strictEqual(ruleOf(check('Remove-Item -Recurse -Force $env:X\\', { ...win(), env: {}, mode: 'ps' })), 'rm-empty-var')
  assert.strictEqual(ruleOf(check('rd /s /q %X%\\', { ...win(), env: {} })), 'rm-empty-var')
  assert.strictEqual(check('$env:X = "C:\\tmp\\x"; Remove-Item -Recurse -Force $env:X\\', { ...win(), env: {}, mode: 'ps' }), null)
  assert.strictEqual(check('Remove-Item -Recurse -Force "$env:TEMP\\scratch"', { ...win(), env: {}, mode: 'ps' }), null)
})

test('rm-empty-var: the hint keeps a glob outside the quotes', () => {
  const hint = cmd => check(cmd, opts()).split('\n')[1]
  assert.strictEqual(hint('rm -rf "$BUILD_DIR"/*'), 'Use `rm -rf "${BUILD_DIR:?}"/*` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rm -rf $D/'), 'Use `rm -rf "${D:?}/"` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rm -rf "$D"/.*'), 'Use `rm -rf "${D:?}"/.*` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rm -rf $(cygpath -u "$X")/'), 'Use `D=$(...) first, check it, then rm -rf "${D:?}/"` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rm -rf $(cygpath -u "$X")/*'), 'Use `D=$(...) first, check it, then rm -rf "${D:?}"/*` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rm -rf "$(mktemp -d)"'), 'Use `D=$(...) first, check it, then rm -rf "${D:?}"` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rm -rf "$(cygpath -u \'C:\\\')"'), 'Name the folder under that root: `D=$(...); rm -rf "${D:?}/<folder>"`, or write the path out.')
  assert.strictEqual(hint('rsync -a --delete src/ $R/'), 'Use `rsync --delete <source>/ "${R:?}/"` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(hint('rsync -av --delete src/ dst/ $R'), 'Use `rsync --delete <source>/ "${R:?}"` (the shell stops when the variable is empty), or write the path out.')
  assert.strictEqual(check('Remove-Item -Recurse -Force $env:X\\', { ...win(), env: {}, mode: 'ps' }).split('\n')[1],
    'Check that X is set before deleting (PowerShell: `if (-not $env:X) { throw \'X is empty\' }`, cmd: `if not defined X exit /b 1`), or write the path out.')
  // the hints themselves pass
  for (const cmd of ['rm -rf "${BUILD_DIR:?}"/*', 'rm -rf "${D:?}/"', 'rm -rf "${D:?}"/.*', 'rsync -a --delete src/ "${R:?}/"']) assert.strictEqual(check(cmd, opts()), null, cmd)
})

test('rm-root: a variable the same line sets to a root, home or a drive (anthropics/claude-code#95426)', () => {
  const values = ['/', '~', '$HOME', '"$HOME"', '/c/', '\'C:\\\'', '/mnt/c', '/cygdrive/c/', '"/"', '/home/dev/work']
  const uses = ['$D', '"$D"', '$D/', '"$D/"', '"$D"/', '"${D}"/*', '"${D:?}"', '"${D:?}/"', '"${D:?}"/*', '${D?}/']
  for (const value of values) {
    for (const use of uses) {
      const cmd = `D=${value}; rm -rf ${use}`
      assert.strictEqual(ruleFor(cmd), 'rm-root', cmd)
    }
  }
  assert.match(check('D=/; rm -rf "$D/"', opts()), /deletes a filesystem root \(\$D\/ is \/, set earlier on the line\)/)
  for (const cmd of ['export D=/; rm -rf "$D"/*', 'D=/; echo "$D"; rm -rf "${D:?}/"', 'D=/ && sudo rm -rf $D/', 'bash -c \'D=/; rm -rf "$D"/\'']) {
    assert.strictEqual(ruleFor(cmd), 'rm-root', cmd)
  }
  assert.strictEqual(ruleOf(check('$D = \'C:\\\'; Remove-Item -Recurse -Force $D', { ...win(), env: {}, mode: 'ps' })), 'rm-root')
  assert.strictEqual(ruleOf(check('set D=C:\\ && rd /s /q %D%', { ...win(), env: {}, mode: 'cmd' })), 'rm-root')
  // written out, the same paths are blocked without a variable
  for (const cmd of ['rm -rf /mnt/c', 'rm -rf /mnt/c/*', 'rm -rf /mnt/d/Users', 'rm -rf /cygdrive/c', 'rm -rf \'C:\\\'', 'rm -rf C:/*']) {
    assert.strictEqual(ruleFor(cmd), 'rm-root', cmd)
  }
})

test('rm-root: a variable set to a path command applied to a root (anthropics/claude-code#95426)', () => {
  for (const value of ['"$(cygpath -u \'C:\\\')"', '$(cygpath -u C:/)', '"$(wslpath \'C:\\\')"', '$(realpath /)', '$(readlink -f ~)',
    '$(realpath "$HOME")', '$(dirname /)', '$(dirname /tmp)', '`cygpath -u C:/`']) {
    for (const use of ['"${D:?}"', '"${D:?}/"', '"${D:?}"/*', '$D', '"$D"/']) {
      const cmd = `D=${value}; echo "$D"; rm -rf ${use}`
      assert.strictEqual(ruleFor(cmd), 'rm-root', cmd)
    }
  }
  const m = check('D="$(cygpath -u \'C:\\\')"; rm -rf "${D:?}/"', opts())
  assert.match(m, /prints a drive or filesystem root/)
  assert.match(m, /rm -rf "\$\{D:\?\}\/<folder>"/)
})

test('rm-root: a folder under the variable, and values that are not roots, pass', () => {
  for (const cmd of ['D="$(cygpath -u \'C:\\\')"; rm -rf "${D:?}/sub"', 'D="$(cygpath -u \'C:\\\')"; rm -rf "${D:?}"/sub/*',
    'D=$(mktemp -d) && rm -rf $D/', 'rm -rf "${D:?}/"', 'rm -rf node_modules dist', 'rm -rf "$TMPDIR/foo"', 'D=build; rm -rf "$D/"',
    'D=./out; rm -rf $D/*', 'git commit -m "D=/; rm -rf $D/"', 'rsync -a --delete src/ dist/', 'D=/tmp/bulkhead-x; rm -rf "$D"/',
    'D=~/.cache/pw; rm -rf "${D:?}"/*', 'D=$(realpath ./dist); rm -rf "${D:?}"', 'D=$(cygpath -u "$X"); rm -rf "${D:?}/"',
    'D=/; rm -rf "$D/sub/x"', 'D=/mnt/c/work/shop; rm -rf "$D"/dist', 'D=/; D=build; rm -rf "$D/"', 'D=/; echo \'rm -rf $D/\'']) {
    assert.strictEqual(check(cmd, opts()), null, cmd)
  }
})

test('rm-unquoted-var: an unquoted variable whose value has a space is split (anthropics/claude-code#107271)', () => {
  assert.strictEqual(ruleFor('D="My Project/build"; rm -rf $D'), 'rm-unquoted-var')
  assert.strictEqual(ruleFor('rm -rf $OUT', opts({ env: { OUT: '/home/dev/My Files/out' } })), 'rm-unquoted-var')
  assert.strictEqual(ruleFor('rm -rf $OUT/cache', opts({ env: { OUT: '/home/dev/My Files' } })), 'rm-unquoted-var')
  assert.match(check('D="a b"; rm -rf $D', opts()), /Quote it: rm -rf "\$D"/)
  for (const cmd of ['rm -rf $D', 'D=dist; rm -rf $D', 'D="a b"; rm -rf "$D"', 'D=$(pwd); rm -rf $D/x']) assert.strictEqual(check(cmd, opts()), null, cmd)
  assert.strictEqual(check('rm -rf $OUT', opts({ env: { OUT: '/tmp/out' } })), null)
})

test('rm-git-dir: deleting a repository\'s .git folder is blocked (anthropics/claude-code#107274)', () => {
  const at = p => p.replace(/\\/g, '/')
  const isDir = p => ['/home/dev/work/shop/web/.git', '/home/dev/work/shop/.git'].includes(at(p))
  for (const cmd of ['rm -rf .git', 'rm -rf ./.git', 'rm -rf .git/', 'rm -rf ../.git', 'rm -rf /home/dev/work/shop/.git', 'rm -rf "$REPO/.git"',
    'rm -rf */.git', 'find . -name .git -exec rm -rf {} +', "find -name '.git' -type d -exec rm -rf {} \\;"]) {
    assert.strictEqual(ruleFor(cmd, opts({ isDir })), 'rm-git-dir', cmd)
  }
  assert.match(check('rm -rf .git', opts({ isDir })), /git worktree remove/)
  for (const cmd of ['rm -rf build/.git-cache', 'rm -rf .github', 'rm -rf vendor/x/.git', 'rm -rf .gitignore', 'git rm -r --cached .git',
    'git clone https://example.com/x.git /tmp/x && rm -rf /tmp/x/.git', 'D=$(mktemp -d) && git clone u "$D" && rm -rf "$D/.git"',
    'find vendor -name .git -exec rm -rf {} +', 'echo rm -rf .git']) {
    assert.strictEqual(check(cmd, opts({ isDir })), null, cmd)
  }
  assert.strictEqual(check('rm -rf "$REPO/.git"', opts({ isDir, env: { REPO: '/tmp/fresh' } })), null)
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
  assert.match(check('rm -rf ~/backups', linux()), /directly in your home directory/)
  assert.match(check('rm -rf ~/Documents', linux()), /holds your apps' data, documents or keys/)
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

test('rm-root: folders that hold app data, documents or keys, and other users\' homes (a r/ClaudeCode report)', () => {
  for (const cmd of ['rm -rf ~/Library', 'rm -rf ~/Library/Application\\ Support', 'rm -rf "$HOME/Library/Application Support/"',
    'rm -rf ~/Documents', 'rm -rf ~/Desktop', 'rm -rf ~/Downloads', 'rm -rf ~/Pictures', 'rm -rf ~/Movies', 'rm -rf ~/Music',
    'rm -rf ~/.ssh', 'rm -rf ~/.config', 'rm -rf ~/.local', 'rm -rf ~/.local/share', 'rm -rf ~/.gnupg', 'rm -rf ~/AppData',
    'rm -rf ~/AppData/Roaming', 'rm -rf ${HOME}/Library/Containers', 'rm -rf /home/other', 'rm -rf /Users/other', 'rm -rf /home/other/.ssh',
    'rm -rf /Users/other/Library/Application\\ Support', "rm -rf 'C:\\Users'", "rm -rf 'C:\\Users\\other'", 'rm -rf C:/Users/other/AppData/Roaming',
    'rm -rf /mnt/c/Users/other', 'rm -rf /home']) {
    assert.strictEqual(ruleFor(cmd), 'rm-root', cmd)
  }
  for (const cmd of ['rd /s /q %USERPROFILE%', 'rd /s /q "%USERPROFILE%\\AppData"', 'Remove-Item -Recurse -Force $env:USERPROFILE\\Documents',
    'rm -rf C:/Users', 'rm -rf C:/Users/other', 'Remove-Item -Recurse -Force C:\\Users\\other\\AppData\\Local', 'rm -rf /c/Users/dev/AppData']) {
    assert.ok(check(cmd, win()), cmd)
  }
  assert.match(check('rm -rf ~/Library/Application\\ Support', opts()), /holds your apps' data/)
  for (const cmd of ['rm -rf ~/Library/Caches/foo', 'rm -rf ~/Library/Caches', 'rm -rf ~/.cache/foo', 'rm -rf ~/.cache',
    'rm -rf ~/Library/Application\\ Support/Foo/cache', 'rm -rf ~/.config/foo', 'rm -rf ~/AppData/Local/Temp/foo', 'rm -rf ~/.local/share/foo',
    'rm -rf /home/other/work/shop/dist', 'rm -rf /Users/other/dev/x', 'rm -r ~/Library']) {
    assert.strictEqual(check(cmd, opts()), null, cmd)
  }
  assert.strictEqual(check('Remove-Item -Recurse -Force "$env:USERPROFILE\\AppData\\Local\\Temp\\foo"', win()), null)
})

test('rm-root: PowerShell -Recurse in any spelling through $home, its parent and the drive (anomalyco/opencode#62825)', () => {
  const w = win()
  for (const cmd of ['Remove-Item -Recurse -Force (Split-Path $home) -ErrorAction SilentlyContinue', 'Remove-Item -Recurse $HOME',
    'Remove-Item -rec $env:USERPROFILE', 'Remove-Item -r -fo $home', 'Remove-Item -Recurse:$true $home', 'ri -Recurse $env:HOMEPATH',
    'del -Recurse (Split-Path $env:USERPROFILE)', 'rmdir -Recurse -Force (Split-Path -Parent $home)', 'rd -r C:\\', 'rm -Recurse $home',
    'Remove-Item -Path (Split-Path -Path $home) -Recurse', 'Remove-Item -Recurse -Force (Split-Path (Split-Path $home))',
    'Remove-Item -Recurse -Force (Split-Path -Qualifier $home)', 'Remove-Item -Recurse -Force $env:SystemDrive\\', 'Remove-Item -LiteralPath "$home" -Recurse',
    'powershell -Command "Remove-Item -Recurse -Force (Split-Path $home)"', "pwsh -c 'Remove-Item -Recurse -Force (Split-Path $home)'",
    'powershell -NoProfile -Command "Remove-Item -Recurse -Force $env:USERPROFILE"']) {
    assert.strictEqual(ruleFor(cmd, { ...w, env: {} }), 'rm-root', cmd)
  }
  // the PowerShell tool reads rm -r as Remove-Item -Recurse
  assert.strictEqual(ruleFor('rm -r $home', { ...w, env: {}, mode: 'ps' }), 'rm-root')
  const msg = check('Remove-Item -Recurse -Force (Split-Path $home) -ErrorAction SilentlyContinue', w)
  assert.match(msg, /\(Split-Path \$home\) is C:\\Users\)/)
  assert.match(msg, /automatic variable/)
  // the same delete on a Mac or Linux names the folder above home there
  assert.match(check('Remove-Item -Recurse -Force (Split-Path $home)', opts()), /is \/home\)/)
  for (const cmd of ['Remove-Item -Recurse -Force $home\\proj\\dist', 'Remove-Item -Recurse -Force "$env:USERPROFILE\\AppData\\Local\\Temp\\foo"',
    'Remove-Item $home\\foo.txt', 'Split-Path $home', 'Remove-Item -Recurse -Force (Split-Path $home -Leaf)', 'Remove-Item -Recurse -Force (Join-Path $home x)',
    'Remove-Item -Recurse -Force .\\dist -ErrorAction SilentlyContinue', 'Remove-Item -Recurse -Filter *.log -Path .\\logs',
    'Get-ChildItem (Split-Path $home) | Remove-Item -Recurse -WhatIf:$false .\\x']) {
    assert.strictEqual(check(cmd, w), null, cmd)
  }
})

test('rm-xargs-split: xargs splits paths at spaces before a recursive rm (a r/ClaudeCode report)', () => {
  for (const cmd of ["find ~/Library/Application\\ Support/Foo -name '*.log' | xargs -n1 dirname | xargs rm -rf",
    'find . -name node_modules | xargs rm -rf', 'find . -type d -name build | xargs rm -r', 'ls | xargs -n1 basename | xargs rm -rf',
    "find . -name '*.tmp' | xargs -I {} rm -rf {}", 'find . -name x | xargs rm --recursive', 'xargs rm -rf < list', 'xargs -a list rm -rf',
    'find . -name x | sudo xargs rm -rf', 'find . -name x 2>/dev/null | xargs -r rm -rf', "bash -c 'find . | xargs rm -rf'",
    'find . -print0 | xargs -0 -n1 dirname | xargs -0 rm -rf', 'find . -name x | xargs -L1 rm -Rf', 'find . -name x | xargs -n10 rm -rf']) {
    assert.strictEqual(ruleFor(cmd), 'rm-xargs-split', cmd)
  }
  assert.match(check("find ~/x\\ y | xargs -n1 dirname | xargs rm -rf", opts()), /runs dirname/)
  assert.match(check('find . | xargs -I{} rm -rf {}', opts()), /-I still splits/)
  for (const cmd of ["find . -name '*.pyc' -print0 | xargs -0 rm -f", 'xargs rm -f < list', 'git ls-files -z | xargs -0 rm -rf',
    'find . -name node_modules -print0 | xargs -0 rm -rf --', 'find . -name x -print0 | xargs --null rm -rf', "cat list | xargs -d '\\n' rm -rf",
    'cat list | xargs --delimiter=\\\\n rm -rf', 'find . -name x -print0 | xargs -r0 rm -rf', "find . -name '*.pyc' | xargs rm -f", 'find . -name x -delete',
    'find . -print0 | xargs -0 -n1 dirname | sort -u', 'echo dist build | xargs rm -rf', 'find . -name x | xargs echo rm -rf',
    'find . -print0 | xargs -0 dirname -z | xargs -0 rm -rf', 'find . -name x; xargs rm -f < list', 'find . -name x -exec rm -rf {} +']) {
    assert.strictEqual(check(cmd, opts()), null, cmd)
  }
})

test('rm-through-link: a delete that can follow a junction or symbolic link out of the folder (a r/ClaudeAI report)', () => {
  const base = fs.realpathSync(tempDir())
  const wt = path.join(base, 'wt')
  const data = path.join(base, 'models')
  fs.mkdirSync(path.join(wt, 'src', 'deep'), { recursive: true })
  fs.mkdirSync(data)
  fs.writeFileSync(path.join(data, 'weights.bin'), 'x')
  fs.symlinkSync(data, path.join(wt, 'src', 'models'), 'junction')
  fs.symlinkSync(path.join(wt, 'src', 'deep'), path.join(wt, 'inside'), 'junction') // stays inside: fine
  const clean = path.join(base, 'clean')
  fs.mkdirSync(path.join(clean, 'a'), { recursive: true })
  fs.symlinkSync(path.join(clean, 'a'), path.join(clean, 'b'), 'junction')
  fs.symlinkSync(path.join(base, 'gone'), path.join(clean, 'dangling'), 'junction')
  const at = { cwd: base, home: path.join(base, 'home'), platform: process.platform, run: () => { throw new Error('no repo') }, env: {} }
  const winAt = { ...at, platform: 'win32' }

  // git worktree remove --force: every platform
  for (const cmd of ['git worktree remove --force wt', 'git worktree remove -f wt', `git worktree remove --force ${wt}`, 'git -C wt/.. worktree remove -f -f wt']) {
    assert.strictEqual(ruleFor(cmd, at), 'rm-through-link', cmd)
  }
  const msg = check('git worktree remove --force wt', at)
  assert.ok(msg.includes(path.join(wt, 'src', 'models')) && msg.includes(data), msg)
  assert.match(check('git worktree remove --force wt', winAt), /cmd \/c rmdir "/)
  // a PowerShell recursive delete on Windows, where Windows PowerShell 5.1 follows junctions
  for (const cmd of ['Remove-Item -Recurse -Force wt', 'Remove-Item -rec wt', 'rm -Recurse wt', `Remove-Item -Recurse -Force ${wt}/*`,
    'powershell -Command "Remove-Item -Recurse -Force wt"']) {
    assert.strictEqual(ruleFor(cmd, winAt), 'rm-through-link', cmd)
    assert.strictEqual(check(cmd, at), null, cmd)
  }
  assert.strictEqual(ruleFor('rm -r wt', { ...winAt, mode: 'ps' }), 'rm-through-link')
  // Git Bash rm and cmd's rd /s delete a junction without following it
  for (const cmd of ['rm -rf wt', 'rd /s /q wt']) assert.strictEqual(check(cmd, winAt), null, cmd)
  for (const cmd of ['git worktree remove wt', 'git worktree remove --force clean', 'git worktree remove --force models', 'git worktree remove --force nowhere']) {
    assert.strictEqual(check(cmd, at), null, cmd)
  }
  assert.strictEqual(check('Remove-Item -Recurse -Force clean', winAt), null)
  // rm -rf link/ deletes the folder the link points at, on every platform
  for (const cmd of ['rm -rf wt/src/models/', 'rm -rf wt/src/models/*']) assert.strictEqual(ruleFor(cmd, at), 'rm-through-link', cmd)
  assert.match(check('rm -rf wt/src/models/', at), /leave out the slash/)
  assert.strictEqual(check('rm -rf wt/src/models', at), null)
  // the walk stops at its budget and lets the command through
  const { outwardLink } = require('../src/basics')
  assert.ok(outwardLink(wt))
  assert.strictEqual(outwardLink(wt, { entries: 2, depth: 6 }), null)
  assert.strictEqual(outwardLink(wt, { entries: 2000, depth: 1 }), null)
  // turned off
  const prev = process.env.BULKHEAD_DISABLE
  process.env.BULKHEAD_DISABLE = 'rm-through-link'
  try { assert.strictEqual(check('git worktree remove --force wt', at), null) } finally {
    if (prev === undefined) delete process.env.BULKHEAD_DISABLE
    else process.env.BULKHEAD_DISABLE = prev
  }
})
