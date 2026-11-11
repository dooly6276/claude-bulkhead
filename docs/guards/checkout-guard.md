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

### Staging every change (`stage-all`, new in 0.2.0)

When another live session works in the same tree and the tree has changes:

```
git add -A           git add .            git add --all        git add -u
git commit -a -m x   git commit -am "wip" git commit --all
```

Naming the files passes: `git add src/a.ts src/b.ts`, `git commit -m "..." -- src/a.ts`, `git add -p`.

```
[bulkhead] checkout-guard: `git add -A` stages every change in /home/me/src/acme-web (7 files), and another Claude session works in the same tree (pid 18672, started 2026-10-13 10:40).
Some of those changes are probably its half-finished work, and they would go into your commit.
Stage only the files you changed, by name: git add src/a.ts src/b.ts, or commit them directly with git commit -m "..." -- src/a.ts src/b.ts.
```

### Deleting another session's folder (`remove-session-dir`, new in 0.2.0)

`rm -rf <dir>`, `Remove-Item -Recurse -Force <dir>`, `rd /s <dir>` and `git worktree remove [--force] <dir>` are blocked when `<dir>` is the folder another live session works in, or a folder above it. `$PWD`, `${PWD}` and `$(pwd)` are resolved to the current folder first. This is the usual way a "clean up the worktrees" task deletes a worktree that a second session is still using.

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

Other sessions come from the session files Claude Code keeps in `~/.claude/sessions`, which record each session's PID, ID and project directory. A session counts when its PID is alive, its ID is not the current session's, and its project directory is inside the same `git rev-parse --show-toplevel` (compared without case on Windows). Subagents share their parent's session ID, so they never block each other.

## Turn off or tune

- `BULKHEAD_DISABLE=checkout-guard`, or `"checkoutGuard": { "enabled": false }` in a config file, turns it off. See [configuration](../configuration.md).
- `BULKHEAD_DISABLE=stage-all` or `remove-session-dir`, or `checkoutGuard.stageAll` / `checkoutGuard.removeSessionDir` set to `false`, turns off one rule.

## Limits

- A session that started in another directory and later `cd`'d into this tree is not seen.
- Wrappers such as `bash -c "git checkout main"` and prefixes such as `GIT_TRACE=1` are opened. Git commands sent over `ssh` pass.
