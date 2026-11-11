# basics

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Five narrow rules for mistakes that cannot be undone, on by default.

## rm-root

Blocks `rm -rf`, `Remove-Item -Recurse -Force` and `rd /s` aimed at a filesystem or drive root, a top-level folder of the drive (`/srv`, `/usr`, `/opt`), the home directory or a folder above it, a folder directly in the home directory (`~/Documents`, `~/Desktop`, `~/archive`), or a folder above the current repository, including `*` at those.

Folders directly in home that are only caches pass: `~/.cache`, `~/.npm`, `~/.pnpm-store`, `~/.yarn`, `~/.gradle`, `~/.m2`, `~/.cargo`, `~/tmp`, `~/.Trash` and similar.

```
rm -rf /                 rm -rf ~                 rm -rf ~/*
rm -rf ..                Remove-Item -Recurse -Force C:\
rd /s /q C:\
rm -Rf /                 rm -r -f /               rm --recursive --force /
rm -rf -- /              sudo rm -rf /            bash -c "rm -rf ~"
rm -rf ~/Documents       rm -rf "$HOME/Desktop"   rm -rf /srv
```

Why folders directly in home: they are where people keep things that are not in any repository, such as exports, archives and originals another project still reads. An agent deleting one "because there is a cloud copy" can stop that other project for hours.

Git options before the subcommand (`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager`, `-p` ...) do not hide a push or a reset from the rules, and a `--git-dir` or `--work-tree` is passed on to the `git status` the discard check runs. Wrappers (`bash -c`, `cmd /c`, `sudo`, `env` and the others listed in [kill-guard](kill-guard.md)) are opened for all five rules. Commands run on another machine with `ssh` pass.

Passes: `rm -rf node_modules`, `rm -rf ./dist`, `rm -rf ~/Documents/old-export`, and paths with variables it cannot expand.

## force-push-main

Blocks `git push --force`, `-f` or a `+` refspec to a protected branch: `main` and `master` unless `basics.protectedBranches` says otherwise.

```
git push --force origin main
git push -f origin master
git push origin +main
```

Passes: `--force-with-lease`, and force-pushes to other branches.

## protected-delete

Blocks deleting a protected branch (`main` and `master` unless `basics.protectedBranches` says otherwise), on the remote or locally.

```
git push origin :main
git push origin --delete main      git push origin -d master
git push origin :refs/heads/main
git branch -D main                 git branch --delete --force master
```

Passes: deleting any other branch, and `git branch -d main`, which git itself refuses while the branch has unmerged work.

## discard-changes

Blocks `git reset --hard` when tracked files have uncommitted changes, and `git clean -fd` or `-fdx` when there are untracked files. Both pass on a clean tree. It runs `git status --porcelain` only for these two commands.

```
[bulkhead] basics: `git reset --hard origin/main` would throw away 2 uncommitted changes (src/app.js, src/db.js).
Commit them, or move the files somewhere else, first. `git clean -n` and `git status` show what would go.
```

## agent-author

Blocks commits authored as the agent instead of the person: Claude Code sometimes "fixes" a missing git identity by setting itself as the author, and every commit after that counts as someone else's work on GitHub (contribution graph, achievements) and in `git blame`.

```
git commit -m "fix" --author="Claude <noreply@anthropic.com>"
git config user.name "Claude"              git config --global user.email noreply@anthropic.com
git -c user.name=Claude commit -m x        GIT_AUTHOR_NAME=Claude git commit -m x
$env:GIT_AUTHOR_NAME = "Claude"            git merge --author="Claude <noreply@anthropic.com>" feature
```

```
[bulkhead] basics: `--author Claude <noreply@anthropic.com>` makes the agent the author of the commit.
Commits authored as Claude or Anthropic do not count as the user's work on GitHub (contribution graph, achievements), and later blame points at a bot.
Commit with the git identity already configured: leave user.name and user.email alone and drop --author. A Co-Authored-By line in the message is fine.
```

Passes: a `Co-Authored-By: Claude` trailer in the message, `git log --author=claude`, any other name, and text inside a heredoc handed to a script.

## Turn off or tune

- `BULKHEAD_DISABLE=basics` turns all five off.
- `BULKHEAD_DISABLE=rm-root`, `force-push-main`, `protected-delete`, `discard-changes` or `agent-author` turns off one rule.
- In a config file: `basics.enabled`, `basics.rmRoot`, `basics.forcePushMain`, `basics.protectedDelete`, `basics.discardChanges`, `basics.agentAuthor`, and `basics.protectedBranches`, for example `["main", "master", "release"]`. See [configuration](../configuration.md).

## Limits

That is all it covers. For broad coverage of destructive commands, see [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) or [cc-safety-net](https://github.com/kenryu42/claude-code-safety-net). bulkhead is about machines shared by many sessions.
