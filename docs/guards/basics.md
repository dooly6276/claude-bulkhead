# basics

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Eight narrow rules for mistakes that cannot be undone, on by default.

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

Git options before the subcommand (`-C`, `-c`, `--git-dir`, `--work-tree`, `--no-pager`, `-p` ...) do not hide a push or a reset from the rules, and a `--git-dir` or `--work-tree` is passed on to the `git status` the discard check runs. Wrappers (`bash -c`, `cmd /c`, `sudo`, `env` and the others listed in [kill-guard](kill-guard.md)) are opened for all the rules, and so is `wsl ... -- bash -c '...'`. Commands run on another machine with `ssh` pass.

Passes: `rm -rf node_modules`, `rm -rf ./dist`, `rm -rf ~/Documents/old-export`, and paths with variables it cannot expand.

## rm-empty-var

Blocks a recursive delete whose path is a variable or a command's output directly followed by `/` or `/*`. When the variable is empty or unset, or the command prints nothing, `rm -rf $D/` is `rm -rf /`. Also blocks `rsync --delete` (and `--delete-after`, `--del` and the other `--delete-*` forms) into such a destination or into a bare `$D`, and deleting the whole output of a path command such as `"$(cygpath -u 'C:\')"`, which prints `/c/` (anthropics/claude-code#95426 lost 600 GB this way). `Remove-Item -Recurse -Force $env:X\` and `rd /s /q %X%\` count too.

```
rm -rf $D/               rm -rf "$D"/             rm -rf "${BUILD_DIR}"/*
rm -rf $(cygpath -u "$X")/                        rm -rf "$(cygpath -u 'C:\')"
rsync -a --delete src/ $R/                        bash -c 'rm -rf $R/'
wsl -d Ubuntu -- bash -lc 'rsync -a --delete /mnt/d/app/ $R/'
```

Passes:

- `rm -rf "${D:?}/"` and `rm -rf "${D:?}"/*`: the shell stops when `D` is empty. This is the form the block message suggests.
- A variable followed by a path segment: `rm -rf "$TMPDIR/foo"`, `rm -rf "$(git rev-parse --show-toplevel)/dist"`. With an empty variable that is a path at the top of the drive, which rm-root judges like any other path.
- A variable the same shell sets earlier on the line to something that cannot be empty: `D=$(mktemp -d) && rm -rf "$D"/`, `D=./out; rm -rf $D/*`, `for d in a b; do rm -rf $d/; done`. An assignment counts only for commands in the same shell: `R=/x; bash -c 'rm -rf $R/'` is blocked, because the inner bash does not see a variable that was not exported. `D=$(some command)` does not count, since the command can print nothing.
- An unquoted `$(find ...)`, `$(git ls-files -o)` and other lists: an empty list deletes nothing. A quoted `"$(...)"` stands for one path and is blocked unless a path segment follows it.
- `$HOME` and `$PWD`, which the shell always sets; rm-root judges `$HOME`.

## rm-unquoted-var

Blocks `rm -rf $D` (or `$D/sub`) with the variable unquoted when its value has a space or a wildcard: bash and sh split it into several paths and delete each one (anthropics/claude-code#107271). The value comes from an assignment earlier on the line, or from the environment when the line does not set it. A value that comes from `$(...)` is not known, so it passes, and so does any variable whose value has no space: blocking every unquoted variable would stop many harmless commands. zsh does not split unquoted variables, so there the block is a warning about a command that breaks under bash.

```
D="My Project/build"; rm -rf $D
```

## rm-git-dir

Blocks `rm -rf .git`, `rm -rf ./.git`, `rm -rf path/to/.git` and `find . -name .git -exec rm -rf {} +` when that `.git` is a folder: the history goes with it, including every commit that was not pushed (anthropics/claude-code#107274 lost twelve months of history). To remove a checkout, use `git worktree remove <path>` or move the folder to the trash.

Passes: a `.git` that does not exist yet or is a worktree's `.git` file (`git clone url /tmp/x && rm -rf /tmp/x/.git` is checked before the clone runs, so it passes), a `.git` under a folder the same line creates (`D=$(mktemp -d)`), `find vendor -name .git ...` that starts below the project, `.github`, `.gitignore`, `build/.git-cache`, and `git rm -r --cached`. A `.git` path with a variable the hook cannot resolve is blocked.

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

## self-allow

Blocks a Bash call that runs `bulkhead allow <code>` (any spelling: `claude-bulkhead`, `bulkhead-cli`, `node .../bin/bulkhead`, `npx claude-bulkhead`, inside `bash -c`, `eval`, `env`, `sudo` or a subshell) or that writes into the allow state folder with a redirect, `tee`, `cp`, `mv`, `sed -i` or a script. Otherwise the agent could approve its own blocks and [allow once](../commands.md#bulkhead-allow) would mean nothing. Reading the folder is fine, and so is text that only mentions the command (`echo`, `grep`, a commit message). This rule never gets an allow code.

## Turn off or tune

- `BULKHEAD_DISABLE=basics` turns all the rules off.
- `BULKHEAD_DISABLE=rm-root`, `rm-empty-var`, `rm-unquoted-var`, `rm-git-dir`, `force-push-main`, `protected-delete`, `discard-changes`, `agent-author` or `self-allow` turns off one rule.
- In a config file: `basics.enabled`, `basics.rmRoot`, `basics.rmEmptyVar`, `basics.rmUnquotedVar`, `basics.rmGitDir`, `basics.forcePushMain`, `basics.protectedDelete`, `basics.discardChanges`, `basics.agentAuthor`, `basics.selfAllow`, and `basics.protectedBranches`, for example `["main", "master", "release"]`. See [configuration](../configuration.md).

## Limits

That is all it covers. For broad coverage of destructive commands, see [dcg](https://github.com/Dicklesworthstone/destructive_command_guard) or [cc-safety-net](https://github.com/kenryu42/claude-code-safety-net). bulkhead is about machines shared by many sessions.
