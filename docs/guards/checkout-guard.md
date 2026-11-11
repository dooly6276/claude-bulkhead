# checkout-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Two sessions in one checkout share one branch and one set of files. When one of them runs `git checkout other-branch` or `git stash`, the other one's edits vanish or land on the wrong branch, and it usually does not notice. When one of them runs `git add -A`, the other one's half-finished edits go into its commit. checkout-guard blocks git commands that move or sweep up the working tree when another live Claude session (or another agent's CLI, see [Codex, Gemini and other agents](../other-agents.md)) works in the same tree, and deleting a folder another live session works in.

## Blocked

When another live session works in the same tree:

```
git checkout main
git switch -c feature
git stash            git stash pop        git stash apply
git reset --hard
git clean -f
git rebase main
git merge feature
git restore .
git checkout -- .
git pull             # only when there are uncommitted changes
```

Also blocked in a shared tree, because they rewrite the files or the branch under the other session:

```
git checkout -f                      git cherry-pick abc123   git revert HEAD
git stash -a   git stash -q          git apply fix.patch      git am x.patch
git stash drop git stash clear       git checkout-index -af   git read-tree -u --reset
git rm -rf src git rm -r .           git submodule update --force
git reset --merge   git reset --keep
git restore src    git checkout -- src      # a folder or glob that covers uncommitted changes
git reset          git reset .      git reset HEAD~1   # only while something is staged
```

Passes: `git <command> --help` and `-h`, `git cherry-pick --abort`, `git apply --check`, `--cached` and `--stat`, `git am --abort`, `git reset --soft`, a `git reset -- <file>` or `git restore <file>` of single files, and `git stash push -- <paths>`, which moves only the files you name.

How the blocks are decided:

- A restore (`git restore`, `git checkout -- <paths>`) of a single file passes, because nothing tells whose edits are in it. A folder, a glob or `:/` is blocked only when `git status` shows uncommitted changes under it.
- An index-only reset (`git reset`, `git reset .`, `git reset HEAD~1`, without `--hard`) unstages whatever the other session has staged. It is blocked only when `git diff --cached` shows staged files, and passes with a clean index. Path-limited resets and `--soft` pass.
- `git <command> --help` and `-h` print usage and pass.
- Git options before the subcommand are read properly: `-C <dir>`, `-c k=v`, `--git-dir`, `--work-tree` (the tree they name is the one checked), `--namespace`, `--no-pager`, `-p`, `--paginate`, `--bare`, `--literal-pathspecs` and the rest. `GIT_WORK_TREE=... git ...` is read as well. Short flags are read letter by letter, so `-Af`, `-vA`, `-uv` and `-qam` count.

### Staging every change (`stage-all`, new in 0.2.0)

When another live session works in the same tree and the tree has changes:

```
git add -A           git add .            git add --all        git add -u
git commit -a -m x   git commit -am "wip" git commit --all
```

Also caught: `git add *`, `"*"`, `./*`, `.*`, `:/`, `":(top)"`, `"$PWD"`, `$(pwd)`, `"$(git rev-parse --show-toplevel)"`, `git add $(git ls-files -m)` and `git ls-files -m | xargs git add` (likewise `git diff --name-only` and `git status --porcelain` as the list), and a path such as `/work/acme-web` that is the tree itself. An exclusion alone (`git add -A ':!web'`) still stages the rest of the tree.

Naming the files passes: `git add src/a.ts src/b.ts`, `git add -A src/` (a pathspec limits `-A`, `-u` and `--all` to it), `git commit -m "..." -- src/a.ts`, `git add -p`, and a dry run (`git add -n .`, `git add --dry-run -A`, `git add -An`).

```
[bulkhead] checkout-guard: `git add -A` stages every change in /home/me/src/acme-web (7 files), and another Claude session works in the same tree (pid 18672, started 2026-10-13 10:40).
Some of those changes are probably its half-finished work, and they would go into your commit.
Stage only the files you changed, by name: git add src/a.ts src/b.ts, or commit them directly with git commit -m "..." -- src/a.ts src/b.ts.
```

### Deleting another session's folder (`remove-session-dir`, new in 0.2.0)

`rm -rf <dir>`, `Remove-Item -Recurse -Force <dir>`, `rd /s <dir>` and `git worktree remove [--force] <dir>` are blocked when `<dir>` is the folder another live session works in, or a folder above it. `$PWD`, `${PWD}` and `$(pwd)` are resolved to the current folder first. This is the usual way a "clean up the worktrees" task deletes a worktree that a second session is still using. The same goes for deleting a tree from the inside: `rm -rf *`, `rm -rf ./*`, `rm -rf .git` (the folder stops being a repository), `rm -rf .claude/worktrees` or `.claude/worktrees/*` when a session works in a worktree there, and `find . -delete` or `find . -exec rm -rf {} +` that no `-name`, `-path`, `-mtime`, `-empty` or similar narrows down. `rm -rf dist/*` and `find . -name "*.log" -delete` pass.

```
[bulkhead] checkout-guard: `git worktree remove ../acme-web-auth` removes /home/me/src/acme-web-auth, and another Claude session works in it (pid 21888, started 2026-10-13 10:52, in /home/me/src/acme-web-auth).
Its files, its dev server and its next commit would disappear under it.
Leave this folder to that session. If it is really finished, wait until it exits (`bulkhead status` lists the live sessions), then remove it.
```

### Force-removing a worktree that holds links, on Windows (`worktree-force-links`, new in 0.2.0)

On Windows, `git worktree remove --force` has followed a junction inside the worktree (typically `node_modules` linked to the main checkout) and deleted what it pointed to. When the worktree has a symlink or junction in its first two levels, `--force` is blocked and Claude is told to remove the links first (`rmdir <link>` removes a junction, not its target). This rule needs no other session. On Linux and macOS git does not follow links here, so it does not apply.

## Allowed

```
git checkout -- src/app.js     # restoring single files
git restore --staged .
git rebase --abort             git merge --continue
```

Anything in a tree no other session uses passes. git runs only when a command matches and another session is alive.

## What Claude sees

```
[bulkhead] checkout-guard: `git checkout main` switches the branch in /home/me/src/acme-web, and another Claude session works in the same tree (pid 18672, started 2026-10-13 10:40).
Its files and branch would change under it. Work in your own worktree instead:
  git worktree add ../acme-web-<task> -b <branch>
```

## How it finds other sessions

Other sessions come from the session files Claude Code keeps in `~/.claude/sessions`, which record each session's PID, ID, start time and project directory. A session counts when its PID is alive, its ID is not the current session's, and its project directory is inside the same `git rev-parse --show-toplevel` (compared without case on Windows). A session file left behind by a session that died can name a PID another program now uses, so for the few sessions in the tree at hand the process start time is compared with the file's start time (two minutes of slack, the same check `bulkhead status` makes); a process that started at another time is not a session. The lookup is one `ps` call (PowerShell on Windows) and only runs when a command is about to be blocked. Subagents share their parent's session ID, so they never block each other.

## Turn off or tune

- `BULKHEAD_DISABLE=checkout-guard`, or `"checkoutGuard": { "enabled": false }` in a config file, turns it off. See [configuration](../configuration.md).
- `BULKHEAD_DISABLE=stage-all` or `remove-session-dir`, or `checkoutGuard.stageAll` / `checkoutGuard.removeSessionDir` set to `false`, turns off one rule.

## Limits

- A session that started in another directory and later `cd`'d into this tree is not seen.
- Wrappers such as `bash -c "git checkout main"` and prefixes such as `GIT_TRACE=1` are opened. Git commands sent over `ssh` pass.
