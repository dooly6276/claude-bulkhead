'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { check, classify, changesTree, linksIn, liveSession, gitCall } = require('../src/checkout-guard')
const { runScript, tempDir } = require('./helpers')

const repo = path.resolve('/work/shop')
const nested = path.join(repo, 'vendor', 'lib')

// git answers from a table: toplevel per directory, porcelain status per repo.
function fakeGit({ status = '' } = {}) {
  return (all, cwd) => {
    // --git-dir and --work-tree come first, as the guard passes them on
    const args = all.filter(a => !/^--(?:git-dir|work-tree)=/.test(a))
    if (args[0] === 'rev-parse') {
      if (cwd.startsWith(nested)) return nested
      if (cwd.startsWith(repo)) return repo
      throw new Error('not a git repository')
    }
    if (args[0] === 'status') return status
    throw new Error('unexpected git ' + args.join(' '))
  }
}

const sessions = new Map([
  [100, { cwd: repo, startedAt: new Date(2026, 9, 13, 9, 5).getTime(), sessionId: 'me' }],
  [200, { cwd: path.join(repo, 'web'), startedAt: new Date(2026, 9, 13, 10, 40).getTime(), sessionId: 'other' }],
  [300, { cwd: path.resolve('/work/blog'), startedAt: 0, sessionId: 'third' }],
  [400, { cwd: nested, startedAt: 0, sessionId: 'fourth' }],
  [500, { cwd: repo, startedAt: 0, sessionId: 'dead' }],
])
const ctx = (over = {}) => ({
  cwd: repo, sessionId: 'me', files: () => sessions, isAlive: pid => pid !== 500, run: fakeGit(), isDir: p => /[\\/](?:src|web|docs|lib)$/.test(p), folderExists: () => true, ...over,
})

test('blocks commands that move a tree another session is in', () => {
  for (const cmd of ['git checkout main', 'git checkout -b fix/login', 'git checkout -', 'git switch -c feature', 'git stash',
    'git stash pop', 'git stash push -u', 'git reset --hard HEAD~1', 'git clean -fd', 'git rebase main', 'git merge feature',
    'git restore .', 'git checkout -- .', 'cd web && git checkout main', 'git -C web switch main']) {
    const msg = check(cmd, ctx())
    assert.ok(msg, cmd)
    assert.match(msg, /pid 200, started 2026-10-13 10:40/, cmd)
  }
  assert.match(check('git checkout main', ctx()), /git worktree add \.\.\/shop-<task> -b <branch>/)
})

test('pull is blocked only with uncommitted changes', () => {
  assert.strictEqual(check('git pull', ctx()), null)
  assert.match(check('git pull --rebase', ctx({ run: fakeGit({ status: ' M src/app.js' }) })), /uncommitted changes/)
})

test('passes when nobody else is in the tree', () => {
  const alone = ctx({ files: () => new Map([[100, sessions.get(100)], [300, sessions.get(300)]]) })
  for (const cmd of ['git checkout main', 'git stash', 'git reset --hard']) assert.strictEqual(check(cmd, alone), null, cmd)
  // a session inside a nested repository does not share this tree
  assert.strictEqual(check('git checkout main', ctx({ files: () => new Map([[400, sessions.get(400)]]) })), null)
  // dead sessions do not count
  assert.strictEqual(check('git checkout main', ctx({ files: () => new Map([[500, sessions.get(500)]]) })), null)
})

test('commands that leave the tree alone pass', () => {
  for (const cmd of ['git status', 'git log --oneline', 'git diff', 'git commit -m "checkout main later"', 'git stash list',
    'git stash show -p', 'git checkout -- src/app.js', 'git restore src/app.js', 'git rebase --continue', 'git merge --abort',
    'git fetch', 'git branch -d old', 'git restore --staged .', 'git restore -S -- .', 'git clean -fdn', 'git worktree add ../shop-fix -b fix', 'echo git checkout main']) {
    assert.strictEqual(check(cmd, ctx()), null, cmd)
  }
  assert.strictEqual(changesTree({ sub: 'checkout', args: ['src/app.js'], dir: repo }, () => true), null)
  assert.strictEqual(changesTree({ sub: 'checkout', args: ['main'], dir: repo }, () => false), 'switches the branch')
})

test('fails open without a session id or outside git', () => {
  assert.strictEqual(check('git checkout main', ctx({ sessionId: null })), null)
  assert.strictEqual(check('git checkout main', ctx({ cwd: path.resolve('/tmp') })), null)
})

test('does not run git when no other session is alive', () => {
  const run = () => assert.fail('git should not run')
  assert.strictEqual(check('git checkout main', ctx({ run, isAlive: () => false })), null)
})

test('a session that entered the tree through a link still shares it', () => {
  // git reports the real path; the other session's directory is a symlink (a junction on
  // Windows, which needs no admin rights) to the same tree.
  const real = tempDir()
  execFileSync('git', ['init', '-q'], { cwd: real, stdio: 'ignore' })
  const link = path.join(tempDir(), 'shop')
  fs.symlinkSync(real, link, 'junction')
  const files = () => new Map([[200, { cwd: link, startedAt: 0, sessionId: 'other' }]])
  assert.match(check('git checkout main', { cwd: real, sessionId: 'me', files, isAlive: () => true }), /pid 200/)
})

test('hook fails open', () => {
  const env = { CLAUDE_CONFIG_DIR: tempDir() }
  assert.strictEqual(runScript('checkout-guard', { session_id: 'x', cwd: process.cwd(), tool_input: { command: 'git checkout main' } }, env).status, 0)
  assert.strictEqual(runScript('checkout-guard', 'not json').status, 0)
})

test('stage-all is blocked when another session shares a dirty tree', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js\n?? web/new.ts' }) })
  for (const cmd of ['git add -A', 'git add .', 'git add --all', 'git add -u', 'git commit -am "wip"', 'git commit -a -m wip', 'git commit --all -m x',
    'cd web && git add .']) {
    const msg = check(cmd, dirty)
    assert.ok(msg, cmd)
    assert.match(msg, /stages every change .* \(2 files\)/, cmd)
    assert.match(msg, /git add src\/a.ts/, cmd)
  }
  assert.strictEqual(classify('git add -A', dirty).rule, 'stage-all')
})

test('stage-all passes for named files, a clean tree, or a tree nobody else is in', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  for (const cmd of ['git add src/app.js', 'git add -p', 'git commit -m "add all the things"', 'git commit --amend --no-edit', 'git add -- src/app.js']) {
    assert.strictEqual(check(cmd, dirty), null, cmd)
  }
  assert.strictEqual(check('git add -A', ctx()), null)
  assert.strictEqual(check('git add -A', { ...dirty, files: () => new Map([[300, sessions.get(300)]]) }), null)
  assert.strictEqual(check('git add -A', { ...dirty, stageRule: () => false }), null)
})

test('deleting a folder another live session works in is blocked', () => {
  for (const cmd of ['rm -rf web', 'rm -rf /work/shop', 'git worktree remove /work/shop/web', 'git worktree remove --force web', 'rm -rf ../shop', 'rm -rf .', 'rm -rf ./', 'rm -rf $PWD', 'rm -rf "$PWD"', 'rm -rf ${PWD}', 'rm -rf "$(pwd)"', 'rm -rf `pwd`', 'rm -fr $PWD']) {
    const hit = classify(cmd, ctx())
    assert.ok(hit, cmd)
    assert.strictEqual(hit.rule, 'remove-session-dir', cmd)
    assert.match(hit.why, /pid 200/, cmd)
  }
  // the blog session is in /work/blog
  assert.strictEqual(classify('rm -rf /work/blog/dist', ctx()), null)
  assert.strictEqual(classify('rm -rf /work/blog', ctx()).rule, 'remove-session-dir')
  // dead sessions, deeper folders and other folders pass
  for (const cmd of ['rm -rf web/dist', 'rm -rf /work/other', 'git worktree remove ../shop-fix', 'rm -rf "$TARGET"', 'rm -rf $PWD/web/dist', 'rm -rf $(pwd)/web/dist']) assert.strictEqual(classify(cmd, ctx()), null, cmd)
  assert.strictEqual(classify('rm -rf web', ctx({ removeRule: () => false })), null)
})

test('a pull gets its own advice, not the worktree one', () => {
  const hit = classify('git pull --rebase', ctx({ run: fakeGit({ status: ' M src/app.js' }) }))
  assert.strictEqual(hit.rule, 'git-pull')
  assert.match(hit.why, /pull/)
  assert.doesNotMatch(hit.why, /git worktree add/)
  assert.match(hit.why, /committed or stashed/)
})

test('git worktree remove --force on Windows checks for links first', () => {
  const links = () => ['C:\\work\\shop-fix\\node_modules']
  const win = { cwd: 'C:\\work\\shop', platform: 'win32', links, sessionId: null }
  const hit = classify('git worktree remove --force ../shop-fix', win)
  assert.strictEqual(hit.rule, 'worktree-force-links')
  assert.match(hit.why, /node_modules/)
  assert.strictEqual(classify('git worktree remove ../shop-fix', win), null)
  assert.strictEqual(classify('git worktree remove --force ../shop-fix', { ...win, links: () => [] }), null)
  assert.strictEqual(classify('git worktree remove --force ../shop-fix', { ...win, platform: 'linux' }), null)
})

test('linksIn finds links two levels down', () => {
  const dir = tempDir()
  fs.mkdirSync(path.join(dir, 'pkg'))
  fs.symlinkSync(tempDir(), path.join(dir, 'pkg', 'node_modules'), 'junction')
  const found = linksIn(dir)
  assert.strictEqual(found.length, 1)
  assert.match(found[0], /node_modules$/)
})

// fakeGit that also answers git diff --cached --name-only
const withStaged = (staged, status = ' M src/app.js\n M src/db.js') => {
  const base = fakeGit({ status })
  return (args, cwd) => (args[0] === 'diff' ? staged : base(args, cwd))
}

test('a pathspec narrows stage-all: git add -A src passes', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js\n?? web/new.ts' }) })
  for (const cmd of ['git add -A src', 'git add -u src/app.js', 'git add --all web', 'git add -A -- src', 'git add -A src web',
    "git add -A ':!web'  src", 'git add -n .', 'git add --dry-run -A', 'git add -An', 'git add -nA', 'git add -Anv', 'git add --dry-run .']) {
    assert.strictEqual(check(cmd, dirty), null, cmd)
  }
  // an exclusion alone narrows nothing; the whole tree still goes in
  for (const cmd of ["git add -A ':!web'", "git add . ':(exclude)web'", 'git add -A -- .']) assert.ok(check(cmd, dirty), cmd)
})

test('short-flag clusters are read letter by letter', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  for (const cmd of ['git add -Af', 'git add -Av', 'git add -uv', 'git add -fA', 'git add -vA', 'git add -fu', 'git add --upd', 'git add --upda', 'git commit -qam x', 'git commit -sa -m x']) {
    assert.strictEqual(classify(cmd, dirty).rule, 'stage-all', cmd)
  }
  // -m takes the rest of the cluster as its message
  assert.strictEqual(check('git commit -ma', dirty), null)
  assert.strictEqual(check('git commit -m "-a"', dirty), null)
  assert.strictEqual(check('git commit -a --dry-run -m x', dirty), null)
})

test('git global options hide neither the subcommand nor the tree', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  for (const cmd of ['git --no-pager add -A', 'git -p add -A', 'git --paginate add .', 'git --no-pager -c color.ui=never -C web add -A', 'git --git-dir=.git --work-tree=. add -A',
    'git --git-dir .git --work-tree . add -A', 'git --literal-pathspecs add -A', 'git --namespace=x checkout main', 'git -c a=b -c c=d checkout main',
    '/usr/bin/git --no-pager stash', 'GIT_WORK_TREE=. git checkout main']) {
    assert.ok(check(cmd, dirty), cmd)
  }
  const call = gitCall(['git', '-C', 'web', '--git-dir=g', '--work-tree', '/work/shop', '-p', 'add', '-A'], repo)
  assert.strictEqual(call.sub, 'add')
  assert.deepStrictEqual(call.args, ['-A'])
  assert.strictEqual(call.dir, path.join(repo, 'web'))
  assert.strictEqual(call.workTree, path.resolve('/work/shop'))
  assert.strictEqual(call.gitDir, path.join(repo, 'web', 'g'))
})

test('--work-tree and GIT_WORK_TREE decide which tree is meant', () => {
  const dirty = ctx({ cwd: path.resolve('/tmp'), run: fakeGit({ status: ' M src/app.js' }) })
  assert.ok(check(`git --work-tree=${repo} --git-dir=${repo}/.git add -A`, dirty))
  assert.ok(check(`GIT_WORK_TREE=${repo} GIT_DIR=${repo}/.git git checkout main`, dirty))
  assert.strictEqual(check('git --work-tree=/work/elsewhere --git-dir=/work/elsewhere/.git add -A', dirty), null)
  assert.ok(check('git -C /work/shop add -A', dirty))
})

test('stage-all through pipes and substitutions', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  for (const cmd of ['git ls-files -m | xargs git add', 'git diff --name-only | xargs git add', "git status --porcelain | awk '{print $2}' | xargs git add",
    'git ls-files -mo --exclude-standard | xargs git add', 'git diff --name-status | cut -f2 | xargs -n1 git add', 'git add $(git ls-files -m)', 'git add "$(git ls-files -m)"',
    'git add `git ls-files -m`', 'git add "$(git diff --name-only)"', 'git add "$PWD"', 'git add ${PWD}', 'git add $(pwd)', 'git add "$(git rev-parse --show-toplevel)"',
    'git add "*"', 'git add *', 'git add ./*', 'git add .*', 'git add ":(top)"', 'git add :/', 'git add :', 'git add /work/shop', 'git add ../shop', 'git add -- .', 'git add ./']) {
    assert.strictEqual(classify(cmd, dirty).rule, 'stage-all', cmd)
  }
  for (const cmd of ['echo src/app.js | xargs git add', 'git ls-files -m src | xargs git add', 'git diff --name-only -- src | xargs git add', 'git add $(git ls-files -m -- src)',
    'git add /work/shop/src/app.js', 'git add ../shop/src', 'git add "$PWD/src"', 'ls | xargs git add']) {
    assert.strictEqual(check(cmd, dirty), null, cmd)
  }
})

test('git checkout -f, stash variants, restore and rm of a folder are blocked', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js\n?? notes.txt' }) })
  for (const cmd of ['git checkout -f', 'git checkout --force', 'git stash -a', 'git stash --all', 'git stash -q', 'git stash --quiet', 'git stash drop', 'git stash drop stash@{1}',
    'git stash clear', 'git stash branch fix', 'git stash push', 'git stash push -m wip', 'git stash -m wip', 'git stash save wip', 'git rm -rf .', 'git rm -rf src', 'git rm -r web', 'git rm -r src/lib/',
    'git restore :/', 'git restore src', 'git restore src/', "git restore 'src/*'", 'git checkout -- src', 'git checkout HEAD -- src', 'git restore --source=HEAD~1 src',
    'git restore -W src', 'git restore --worktree --staged src']) {
    assert.ok(check(cmd, dirty), cmd)
  }
  // single files, folders with no uncommitted changes, index-only restores, usage output
  for (const cmd of ['git restore src/app.js', 'git checkout -- src/app.js', 'git checkout -- docs', 'git restore --staged src', 'git restore -S src', 'git rm src/app.js', 'git rm -f src/app.js',
    'git rm --cached -r src', 'git rm -rn src', "git rm 'public/sample-*.jpg'", 'git rm -rq src/a.ts src/b.ts', 'git rm -r src/old.ts', 'git reset -q $FILES', 'git stash list', 'git stash show', 'git stash create', 'git switch --help', 'git rebase --help', 'git merge -h', 'git checkout -h', 'git stash --help']) {
    assert.strictEqual(check(cmd, dirty), null, cmd)
  }
})

test('git stash push with a pathspec moves only those files and passes', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  for (const cmd of ['git stash push -- src/app.js', 'git stash push -m wip -- src/app.js', 'git stash push src/app.js', 'git stash -- src/app.js', 'git stash push -u -- notes.txt', 'git stash push --pathspec-from-file=list.txt']) {
    assert.strictEqual(check(cmd, dirty), null, cmd)
  }
  assert.ok(check('git stash push -u', dirty))
  assert.ok(check('git stash push -m "-- src"', dirty))
})

test('commands that rewrite the shared tree: cherry-pick, revert, apply, am and friends', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  for (const cmd of ['git cherry-pick abc123', 'git cherry-pick -n abc123', 'git revert HEAD', 'git revert --no-edit abc', 'git apply fix.patch', 'git apply --index fix.patch', 'git apply -3 fix.patch',
    'git am x.patch', 'git am --3way x.patch', 'git checkout-index -af', 'git checkout-index -a -f', 'git checkout-index --all --force', 'git read-tree -u --reset HEAD', 'git read-tree -m -u HEAD',
    'git submodule update --force', 'git submodule update --init -f', 'git submodule update --init --recursive --force', 'git reset --merge', 'git reset --keep HEAD~1']) {
    assert.ok(check(cmd, dirty), cmd)
  }
  for (const cmd of ['git cherry-pick --abort', 'git cherry-pick --continue', 'git revert --skip', 'git am --abort', 'git am --show-current-patch', 'git apply --check fix.patch',
    'git apply --cached fix.patch', 'git apply --stat fix.patch', 'git apply --numstat fix.patch', 'git apply --summary fix.patch', 'git checkout-index file.txt', 'git checkout-index -a',
    'git read-tree HEAD', 'git submodule update --init', 'git submodule status', 'git reset --soft HEAD~1']) {
    assert.strictEqual(check(cmd, dirty), null, cmd)
  }
})

test('an index-only reset is blocked only while the other session has staged work', () => {
  for (const cmd of ['git reset', 'git reset .', 'git reset HEAD', 'git reset HEAD~1', 'git reset --mixed HEAD~2', 'git reset -q', 'git reset HEAD .']) {
    const hit = classify(cmd, ctx({ run: withStaged('src/app.js\nsrc/db.js') }))
    assert.ok(hit, cmd)
    assert.strictEqual(hit.rule, 'git-reset', cmd)
    assert.match(hit.why, /unstages 2 files .*src\/app.js, src\/db.js/, cmd)
    assert.strictEqual(check(cmd, ctx({ run: withStaged('') })), null, cmd)
  }
  const staged = ctx({ run: withStaged('src/app.js') })
  for (const cmd of ['git reset -- src/app.js', 'git reset HEAD -- src/app.js', 'git reset HEAD src/app.js', 'git reset -p', 'git reset --soft HEAD~1']) {
    assert.strictEqual(check(cmd, staged), null, cmd)
  }
  // git that cannot answer lets it through
  assert.strictEqual(check('git reset', ctx({ run: fakeGit() })), null)
})

test('a restore of a folder or glob is blocked only where uncommitted changes lie', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js\n?? web/new.ts' }) })
  const hit = classify('git restore src', dirty)
  assert.strictEqual(hit.rule, 'git-restore')
  assert.match(hit.why, /overwrites 1 file with uncommitted changes .*src\/app.js/)
  assert.ok(check('git checkout -- web', dirty))
  assert.strictEqual(check('git restore docs', dirty), null)
  assert.strictEqual(check('git restore src/lib/', dirty), null)
  assert.ok(check("git restore 'src/*.js'", dirty))
  assert.strictEqual(check("git restore 'docs/*.md'", dirty), null)
})

test('removing .git, everything in a folder, or a find -delete is blocked while a session works there', () => {
  for (const cmd of ['rm -rf .git', 'rm -rf ./.git', 'rm -rf .git/', 'rm -rf *', 'rm -rf ./*', 'rm -rf .*', 'rm -rf ./.*', 'rm -rf /work/shop/*', 'rm -rf -- *',
    'find . -delete', 'find . -mindepth 1 -delete', 'find . -type f -delete', 'find /work/shop -exec rm -rf {} +', 'find . -depth -exec rm -rf {} \\;', 'find web -delete']) {
    const hit = classify(cmd, ctx({ cwd: repo }))
    assert.ok(hit, cmd)
    assert.strictEqual(hit.rule, 'remove-session-dir', cmd)
  }
  assert.match(classify('rm -rf .git', ctx()).why, /removes the git data of .*shop,/)
  assert.match(classify('rm -rf *', ctx()).why, /removes everything in .*shop,/)
  for (const cmd of ['rm -rf dist/*', 'rm -rf web/dist/*', 'rm -rf *.log', 'rm -rf .cache', 'find . -name "*.log" -delete', 'find . -path ./node_modules -prune -o -name x -delete', 'find . -mtime +30 -delete',
    'find . -type d -empty -delete', 'find node_modules -delete', 'find . -name "*.tmp"', 'find . -type f', 'find web/dist -delete']) {
    assert.strictEqual(classify(cmd, ctx()), null, cmd)
  }
})

test('rm -rf .claude/worktrees is blocked when a session works in a worktree under it', () => {
  const files = () => new Map([[700, { cwd: path.join(repo, '.claude', 'worktrees', 'agent-x'), startedAt: 0, sessionId: 'other' }]])
  for (const cmd of ['rm -rf .claude/worktrees', 'rm -rf .claude/worktrees/*', 'rm -rf .claude/worktrees/agent-x']) {
    assert.strictEqual(classify(cmd, ctx({ files })).rule, 'remove-session-dir', cmd)
  }
  assert.strictEqual(classify('rm -rf .claude/worktrees/agent-y', ctx({ files })), null)
})

test('liveSession compares the process start with the session file', () => {
  const file = { startedAt: Date.UTC(2026, 9, 13, 9, 5) }
  const pid = process.pid
  assert.strictEqual(liveSession(pid, file, true, () => file.startedAt + 5000), true)
  assert.strictEqual(liveSession(pid, file, true, () => file.startedAt + 60 * 60 * 1000), false, 'a pid another program reused')
  assert.strictEqual(liveSession(pid, file, true, () => 0), true, 'an unreadable start counts as the same process')
  assert.strictEqual(liveSession(pid, { startedAt: 0 }, true, () => 1), true, 'no recorded start, nothing to compare')
  assert.strictEqual(liveSession(pid, file, false, () => 1), true, 'the cheap check does not look up the start')
  assert.strictEqual(liveSession(2 ** 30, file, true, () => file.startedAt), false)
  // the real lookup finds this very process
  assert.strictEqual(liveSession(pid, { startedAt: Date.now() - process.uptime() * 1000 }, true), true)
})

test('a stale session file whose pid was reused is not a sharer', () => {
  const isAlive = (pid, f, deep) => !deep || f.sessionId !== 'stale'
  const files = () => new Map([[200, { cwd: repo, startedAt: 1, sessionId: 'stale' }]])
  assert.strictEqual(check('git checkout main', ctx({ files, isAlive })), null)
  assert.strictEqual(classify('rm -rf /work/shop', ctx({ files, isAlive })), null)
  assert.ok(check('git checkout main', ctx({ files: () => new Map([[200, { cwd: repo, startedAt: 1, sessionId: 'live' }]]), isAlive })))
})

test('a cd moves the folder that relative paths and git are read from', () => {
  // the hook's folder is the repo, but the command works somewhere else
  for (const cmd of ['cd /tmp/scratch && rm -rf ./*', 'cd /tmp/scratch && rm -rf *', 'cd ~/out; find . -delete', 'cd /tmp/x && git checkout main', 'cd "$D" && rm -rf ./*', 'cd - && rm -rf *', '(cd "$D" && rm -rf ./*)']) {
    assert.strictEqual(classify(cmd, ctx({ run: fakeGit({ status: ' M a' }) })), null, cmd)
  }
  assert.strictEqual(classify('cd web && rm -rf *', ctx()).rule, 'remove-session-dir')
  assert.strictEqual(classify('cd /work/shop && rm -rf ./*', ctx({ cwd: path.resolve('/tmp') })).rule, 'remove-session-dir')
  assert.strictEqual(classify('cd "$D" && rm -rf /work/shop/*', ctx()).rule, 'remove-session-dir')
  assert.strictEqual(classify('cd /tmp/x && cd /work/shop && git checkout main', ctx({ cwd: path.resolve('/tmp') })).rule, 'git-checkout')
})

test('a cd to a folder that does not exist leaves the command to be read from the hook folder', () => {
  const hit = classify('cd /not/there && git checkout main', ctx({ folderExists: () => false }))
  assert.strictEqual(hit.rule, 'git-checkout')
  assert.strictEqual(classify('cd /not/there && rm -rf ./*', ctx({ folderExists: () => false })), null)
})

test('git checkout-index with a --prefix writes the copy elsewhere and passes', () => {
  const dirty = ctx({ run: fakeGit({ status: ' M src/app.js' }) })
  assert.strictEqual(check('git checkout-index -a -f --prefix=/tmp/idx/', dirty), null)
  assert.ok(check('git checkout-index -a -f', dirty))
})
