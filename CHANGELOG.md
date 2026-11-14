# Changelog

## Unreleased

### Fixed

- basics `rm-root` blocks `cmd /c "rmdir /s /q \"D:\path\""` run from PowerShell or cmd. Neither cmd.exe nor PowerShell treats `\"` as an escaped quote, so rd gets a path that starts at `\`, the root of the current drive; the same line from Antigravity wiped drive D (a r/google_antigravity report). `rd /s` and `del /s` targets that start with `\"` (or with `\D:` once PowerShell has ended its string at `\"`) are blocked, and so is `del /s` of `\`. The message suggests `Remove-Item -LiteralPath '<path>' -Recurse` or `cmd /c rmdir /s /q "<path>"` without backslash-escaped quotes. From bash (Git Bash) the escapes are removed before cmd reads the line, so `cmd //c "rmdir /s /q \"D:\work\out\""` gets the whole path and passes; a single quoted `cmd /c` argument from bash or PowerShell is now read as that shell's value, so such a path is checked like any other `rd /s` target.

## 0.5.0 - 2026-11-14

### Added

- Pi coding agent: the npm package is now a Pi package. `pi install npm:claude-bulkhead` loads an extension that runs the guards on Pi's `tool_call` for the `bash` and `powershell` tools and blocks with bulkhead's message; `bulkhead setup pi` writes the same extension to `~/.pi/agent/extensions/bulkhead.js`. Pi sessions show in `bulkhead status`, and `pkill pi` is blocked like other agents.
- `bulkhead setup qwen|kimi|grok|antigravity` and `bulkhead hook --agent qwen|kimi|grok|antigravity`: Qwen Code (`PreToolUse` in `~/.qwen/settings.json`, Qwen Code sessions are recognized), Kimi Code (a `[[hooks]]` table appended to `~/.kimi-code/config.toml`), Grok Build (`~/.grok/hooks/bulkhead.json`) and Antigravity (a `bulkhead` hook group in `~/.gemini/config/hooks.json`, always answering `allow` or `deny` since Antigravity requires a decision).
- basics `rm-xargs-split`: a pipeline where `xargs` without `-0`/`--null` or `-d`/`--delimiter` runs `rm -r`, or runs `dirname` or `basename` whose output an `rm -r` later in the pipeline deletes, is blocked. Without them xargs splits paths at spaces and reads quotes and backslashes, so rm gets shorter paths, and dirname turns a piece such as `~/Library/Application` into `~/Library`: `find ~/Library/Application\ Support/... | xargs -n1 dirname | xargs rm -rf` wiped `~/Library` (from a r/ClaudeCode report). `xargs -I {}` without `-0` is blocked too, since it still splits at newlines and reads quotes and backslashes. `find ... -print0 | xargs -0 rm -rf`, `git ls-files -z | xargs -0 rm -rf`, `xargs rm -f < list` and `echo a b | xargs rm -rf` pass. Turn it off with `basics.rmXargsSplit`.
- basics `rm-through-link`: `git worktree remove --force` on a folder that holds a junction or symbolic link to an existing folder outside it is blocked on every platform, and so is a PowerShell `Remove-Item -Recurse` (or an alias of it) of such a folder on Windows, where Windows PowerShell 5.1 follows junctions. Git Bash's `rm -rf` and cmd's `rd /s` do not follow junctions and pass, so `rm -rf node_modules` in a Windows workspace is not stopped. Two old worktrees with junctions to `D:\...\models` and a `.venv` took about 230 GB of real data with them (from a r/ClaudeAI report). `rm -rf link/`, `link/*` and `link/.` with a symbolic link to a folder are blocked on every platform: the slash makes rm delete the target (on macOS the target folder itself). The walk stops at 2000 entries or 6 levels and lets the command through past that; on a 2000-entry folder it adds about 2 to 5 ms. The message names the link and says to remove it first (`cmd /c rmdir <link>`, `unlink <link>`). Turn it off with `basics.rmThroughLink`.

### Changed

- basics `rm-root` also blocks a whole folder in home that holds app data, documents or keys one level deeper (`~/Library/Application Support`, `~/Library/Containers`, `~/AppData/Roaming`, `~/AppData/Local`, `~/.local/share` and similar), another user's home (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`, `/mnt/c/Users/<name>`) and those folders in it, and `C:\Users` and `C:\Users\<name>` written out on macOS and Linux. Folders deeper inside, such as `~/Library/Caches/x` or `~/.config/<app>`, still pass.
- basics `rm-root`, `rm-empty-var` and `rm-git-dir` read PowerShell deletes with `-Recurse` alone, without `-Force`, in any spelling PowerShell accepts (`-r`, `-rec`, `-Recurse:$true`), through `Remove-Item`, `ri`, `rm`, `del`, `rd` and `rmdir`. A target in parentheses is read too: `Remove-Item -Recurse -Force (Split-Path $home) -ErrorAction SilentlyContinue` deleted under `C:\Users`, because `$home` is PowerShell's read-only automatic variable for the user profile (from anomalyco/opencode#62825). It is blocked with a note on what `$home` is, as are `(Split-Path $env:USERPROFILE)`, `(Split-Path -Qualifier $home)`, `$env:HOMEPATH` and `$env:SystemDrive\`, also inside `powershell -Command` and `pwsh -c`.

### Fixed

- basics `rm-root` fills in a variable the same line sets before judging the path, so `D=/; rm -rf "$D/"`, `D=/; rm -rf $D/`, `D=~; rm -rf "${D:?}"/*`, `D=$HOME; rm -rf "$D"` and `D='C:\'; rm -rf "${D:?}/"` are blocked like `rm -rf /`. A variable set to a path command applied to a drive root, `/` or home, such as `D="$(cygpath -u 'C:\')"`, `D=$(wslpath 'C:\')`, `D=$(realpath /)` or `D=$(readlink -f ~)`, counts as that root when the delete names the variable alone or followed only by `/` or `/*`: `"${D:?}/"` proves the value is not empty, not that it is not the root. `rm -rf "${D:?}/sub"` still passes. `C:\`, `/mnt/c` and `/cygdrive/c` count as drive roots on every platform, and `/mnt/c/<folder>` as a top-level folder of the drive. Reported by foma-agent in anthropics/claude-code#95426.
- basics `rm-empty-var` suggested `rm -rf "${BUILD_DIR:?}/*"` for `rm -rf "$BUILD_DIR"/*`, with the glob inside the quotes, where it never expands. The hint now keeps a trailing `*` or `.*` outside: `rm -rf "${BUILD_DIR:?}"/*`. For a path command that prints a root it suggests naming a folder under it, and for `$env:X` and `%X%` it shows the PowerShell and cmd checks instead of a bash form.

## 0.4.0 - 2026-11-14

### Added

- Bulkhead recognizes Aider CLI sessions in status and session ownership checks.
- basics `rm-empty-var`: `rm -rf $D/`, `rm -rf "$D"/*`, `rm -rf $(cygpath -u "$X")/` and `rsync --delete src/ $D/` are blocked when the variable is not set to something non-empty earlier in the same shell, because an empty or unset variable (or a command that prints nothing) turns the path into `/` (anthropics/claude-code#109735). Deleting the whole output of a path command, such as `rm -rf "$(cygpath -u 'C:\')"`, which prints `/c/`, is blocked too (anthropics/claude-code#95426 lost 600 GB). `"${D:?}/"`, `"$TMPDIR/foo"` and `D=$(mktemp -d) && rm -rf "$D"/` pass. Also `Remove-Item -Recurse -Force $env:X\`, `rd /s /q %X%\`, and the same commands inside `bash -c` and `wsl -- bash -lc`. With `wsl -- bash -lc '...'` an assignment inside the string does not count, because wsl hands the line to a Linux shell that expands the variable first. Applies with a single session. Turn it off with `basics.rmEmptyVar`.
- basics `rm-unquoted-var`: `rm -rf $D` with `D` unquoted is blocked when the value, set earlier on the line or in the environment, has a space or a wildcard, since bash splits it into several paths and deletes each (anthropics/claude-code#107271). Turn it off with `basics.rmUnquotedVar`.
- basics `rm-git-dir`: `rm -rf .git`, `rm -rf path/.git` and `find . -name .git -exec rm -rf {} +` are blocked when that `.git` is an existing folder, since the repository's history goes with it (anthropics/claude-code#107274). A `.git` the same line creates, such as after `git clone`, passes. Turn it off with `basics.rmGitDir`.
- kill-guard `bsd-pkill`: on macOS and the BSDs, `pkill` with a long option (`--signal`, `--full`) or with more than one pattern is blocked, also with a single session. BSD `pkill` has no long options and reads everything after the first pattern as another pattern, so `pkill -f "gcloud.py compute" -u me --signal 0`, meant as an existence check, also matched `0` and sent SIGTERM to about 66 processes, every other Claude Code session among them (anthropics/claude-code#109627). The message suggests `pgrep -f '<pattern>'` for an existence check. Turn it off with `killGuard.bsdPkill`.

### Changed

- `bulkhead scan --share` lists what people fear first, in plain words: kills by name that would have hit other sessions' processes, recursive deletes, `git add -A` of another session's edits, branch switches in a shared tree, port clashes. The rest folds into one line and the foreground waits come last. No rule names appear in the share text any more (before, a rule without a description showed as `basics self-allow`).

### Fixed

- kill-guard reads `pkill` arguments the way the platform's `pkill` does. On Linux, options written after the pattern (`pkill -f x --signal 0`, `pkill -f x -P $$`) are options, as procps reads them, so a signal-0 check or a `-P` scope there passes. On macOS, every extra operand is a pattern, and each gets the same checks as the first.

## 0.3.7 - 2026-11-12

### Changed

- The bulkhead skill now fits every agent that loads it, not only Claude Code. It says that orphan-reaper's cleanup at session end is Claude Code only and that in Copilot CLI and the other agents you stop your own servers before you finish, and it explains how to run `bulkhead` and `bulkhead-slot` with `node` from the plugin folder when a plugin-only install (Copilot CLI) does not put them on `PATH`.

### Fixed

- Codex and Copilot CLI sessions are found when `CODEX_HOME` or `COPILOT_HOME` moves their config folder. Before, a machine with only a moved folder skipped the process scan for that agent, so its servers and folders were not protected from other sessions.

## 0.3.6 - 2026-11-12

### Changed

- Releases are published to npm by GitHub Actions with npm trusted publishing (`.github/workflows/publish.yml`), so each version on npm carries a provenance statement linking it to this repository and the commit it was built from. The same workflow attaches the Gemini CLI extension archive to the release. The guards are unchanged from 0.3.5.

## 0.3.5 - 2026-11-12

### Added

- kill-guard `broad-pattern`: `pkill -f <pattern>` is blocked when the pattern matches a desktop app (a process inside an `.app` bundle) or 8 or more processes outside the session's own tree, also when only one session runs. `pkill -f cat`, meant for one stuck `cat`, matches every app under `/Applications`; on macOS, BSD `pkill` reads `-n`, `-u` and `-P` written after the pattern as more patterns, so they narrow nothing (anthropics/claude-code#100684, #107867). Processes the session started do not count. Turn it off with `killGuard.broadPattern`.

## 0.3.4 - 2026-11-12

### Added

- Gemini CLI extension: `gemini extensions install https://github.com/dooly6276/claude-bulkhead` installs the guards as an extension (`gemini-extension.json`, a `BeforeTool` hook on `run_shell_command`). The extension is the release asset `bulkhead-gemini-extension.tar.gz`, built by `scripts/build-gemini-extension.js`.
- Codex plugin: `codex plugin marketplace add dooly6276/claude-bulkhead`, then `codex plugin add bulkhead@bulkhead` installs the guards as a Codex plugin (`.codex-plugin/plugin.json`, a `PreToolUse` hook on `Bash`). The marketplace entry installs the npm package, which now ships `.codex-plugin/` and `codex/`.

### Fixed

- Windows: `bulkhead worktree prune` and `list` now match a session or the current folder to its worktree when one of the two paths uses an 8.3 short name (`C:\Users\RUNNER~1\...`) and git prints the long one. Before, prune could remove a worktree a live session was working in, or the one it was run from. The Windows CI jobs pass again: the other failures were tests that assumed `/bin/sh`, paths without a drive letter, or the Linux time limit for the 1 MB fuzz case.

## 0.3.3 - 2026-11-12

### Changed

- A guard that throws is still skipped so the other guards run, but the error is now written to the event log with rule `guard-error` and to `guards.log`, so `bulkhead log` and `bulkhead top` show it instead of it looking like a clean pass.

### Fixed

- port-guard reads a very long pipeline (hundreds of thousands of segments) in a fraction of the time: dev-server detection looks a program up by name instead of testing every known tool against every segment. This also keeps the 1 MB fuzz case inside its time limit on slower CI runners.

## 0.3.2 - 2026-11-12

### New

- **Plugin bundles for Copilot CLI, Cursor and opencode.** The repository is now also an Agent Plugins 1.0.0 plugin (`plugin.json` at the root, hooks in `com.github.copilot/hooks/hooks.json`) that Copilot CLI installs with `copilot plugin marketplace add dooly6276/claude-bulkhead` and `copilot plugin install bulkhead@bulkhead`; a Cursor plugin (`.cursor-plugin/plugin.json` with its own `.cursor-plugin/hooks.json`); and an opencode plugin from npm (`"plugin": ["claude-bulkhead"]`, entry `opencode/plugin.mjs`). Each calls `bulkhead hook --agent <name>` from the plugin's own copy, so the guards are the same as with `bulkhead setup <agent>` and nothing is written to the agent's config. The Claude Code plugin and `hooks/hooks.json` are unchanged.

## 0.3.1 - 2026-11-12

### Changed

- **A project file can only make bulkhead stricter.** A repository's `.claude/bulkhead.json` comes with whatever you clone, so it can no longer take names off kill-guard's list, ignore ports, lengthen the wait limit, lower the RAM floor, turn a guard or rule off, turn on auto-queue or add programs for orphan-reaper to stop. Those settings are read from the global file only; in a project file they are ignored with a warning in `bulkhead config`, `bulkhead doctor` and the startup notice. A project can still add shared names, protected branches and secret patterns (added to the global lists, no longer replacing them), tighten limits and turn guards on. A project preset applies only where it is stricter. Block messages now point to the global file.
- **The skill no longer runs `bulkhead remote run` on its own.** It shows the user the remote, the commit and every uncommitted change it would send, any `--files` it would add, and the command, and runs it only after the user says yes to that run, as `/bulkhead:remote` already did. memory-guard's block message says the same.

### Fixed

- `bulkhead worktree prune` counts a branch as merged when every commit on it was cherry-picked or rebased onto the base, not only when it was merged or squash-merged.

## 0.3.0 - 2026-11-12

### New

- **One hook process for every Bash guard.** `src/bash-guards.js` runs the guards in a row, text-only checks first and the ones that read git, memory, processes or ports last, and stops at the first block. A Bash call used to start seven Node processes. With 10 sessions making a tool call at the same moment, each now waits about 89 ms instead of 318 ms (611 ms to 109 ms with 20). `node scripts/bench-hooks.js 9 --sessions 10` measures it on your machine.
- **`bulkhead explain -- <command>`** shows what every guard would say about a command, with the evidence (which session owns the process or port, how much RAM is free) and how to allow it, without running anything.
- **Allow once.** Every block message ends with a code: the user runs `bulkhead allow <code>` in their own terminal and the same command passes once within 10 minutes. The new basics rule `self-allow` blocks the agent from running `bulkhead allow` or writing the allow files itself, in 25 spellings.
- **Presets.** `bulkhead config --preset quiet|normal|strict [--project]`. `quiet` keeps only what protects one session from another and the rules that cannot be undone; `strict` tightens the limits, scaled to the machine's RAM, and turns secrets-guard on.
- **`bulkhead worktree add|list|prune`.** `add` makes `../<repo>-<name>` on a new branch, copies your `.env` files (or what `.worktreeinclude` lists), installs dependencies with the lockfile's package manager and writes a stable `PORT` to `.env.local`. `list` shows branch, age, changes, ahead and behind, live session and port. `prune` removes worktrees that are merged (squash and rebase merges included), clean and idle, never one a live session works in, and is a dry run until `--yes`.
- **`bulkhead port --stable`** gives a worktree the same port every time, and port-guard suggests it first.
- **Auto-queue.** With `{"memoryGuard":{"autoQueue":true}}`, a heavy command is not refused: the hook rewrites it to run through `bulkhead-slot` and it starts when there is room. Waiting jobs are served first in, first out, poll once a second, and print their place in line every 30 seconds.
- **subagent-guard** (opt-in, `memoryGuard.subagents`) stops new subagents while memory pressure is critical.
- **edit-guard** tells the agent, before it edits a file, that another live session edited the same file in the last 30 minutes, in this tree or another worktree of the repository. Advisory by default; `editGuard.mode` can be `ask` or `block`.
- **secrets-guard** (off by default, on in `strict`) blocks showing `.env` files, private keys, cloud and registry credentials, and the whole environment to the model, through the Read and Grep tools or a shell command. `.env.example`, `ls ~/.ssh`, `.pub` files and appending to `.env` pass.
- **Codex, Gemini CLI, Copilot CLI, Cursor, Windsurf, Droid, Devin, Cline, opencode and Amp.** `bulkhead setup <agent> --write` registers the same guards in that agent's hook config, with a backup of the original. Their CLI sessions count as sessions for port-guard, checkout-guard and `bulkhead status`.
- **`bulkhead status` and `top`** show a `STATE` column (working, waiting for you, waiting for a permission) and a `BRANCH` column, the session and project of each queued job, and duplicate MCP servers that several sessions start. A `notify.command` runs when a session starts waiting for you.
- **`bulkhead doctor`** has an Enforcement section: it runs a harmless command through each guard and shows the block and how long it took, and finds settings that switch the hooks off, duplicate installs and a `node` missing from the hooks' `PATH`.
- **`bulkhead scan --share`** prints a short summary with counts only, for a post or a chat. `--explain N` shows one hit in full with the part that matched.
- orphan-reaper keeps processes started with `BULKHEAD_KEEP=1`, SSH tunnels, `cloudflared` and databases, and anything matching `orphanReaper.keepPatterns`. The next session start tells you what it stopped.

### Changed

- On macOS, free RAM comes from `kern.memorystatus_level` and the memory pressure level instead of a `vm_stat` estimate, which counted far too little as free on a Mac with a lot of file cache. memory-guard blocks heavy commands at pressure level 2 or higher. When neither can be read, heavy commands are let through instead of blocked.
- More heavy commands are recognised: `xcodebuild`, `swift build` and `swift test`, `fastlane`, `bundle exec`, `go build` and `go test` with `-race` or `./...`, and `nx run|build|test|e2e`.
- Block messages name the other session by project and branch, and end with the exact config line that would allow the rule.
- `bulkhead --version`, `bulkhead help <command>` and `<command> --help`; unknown commands and options that need a number are rejected with a clear message.
- Inside a hook, reading the process table gives up after 4 seconds (8 on Windows) and lets the call through, instead of waiting up to 15 (60).
- `guards.log` is rotated at 1 MB like `events.jsonl`, and two hooks rotating at the same moment no longer lose the older log.

- port-guard knows many more servers, each on its default port: `serve`, `live-server`, `json-server`, `puma`, `gunicorn`, `hypercorn`, `fastapi dev`, Django `runserver`, Streamlit, Jupyter, `trunk`, Metro and React Native, VuePress, VitePress, Phoenix, Parcel, Ember, MkDocs, Hugo, Hexo, Zola, mdBook, Netlify and Vercel dev, Rspack, Rsbuild, Spring Boot and more. It reads the port from `php -S`, `dotnet run --urls`, `--server.port`, `docker run -p` and the `ports:` of a compose file, through `pnpm`, `yarn`, `npm exec`, `bunx`, `uv run`, workspaces and wrappers such as `timeout`, `caffeinate`, `cross-env` and `(cd web && npm run dev &)`. The free-port suggestion uses each tool's own flag.
- port-guard catches more ways to kill by port: `lsof ... | awk ... | xargs kill` without `-t`, `PID=$(lsof -ti :3000); kill $PID`, loops over `lsof` output, `fkill :3000`, and `netstat`, `ss` and `fuser -n tcp -k` pipelines.

- checkout-guard sees more ways to change a shared tree: `git --no-pager add -A` and other global options in front of the subcommand, `git ls-files -m | xargs git add`, `git add $(git ls-files -m)`, `git add "$PWD"` and `*`, `checkout -f`, `stash -a`, `stash drop` and `clear`, `rm -r` of a folder, `restore` or `checkout --` of a folder with uncommitted changes, `cherry-pick`, `revert`, `am`, `apply`, `reset --merge` and `--keep`, and a mixed `reset` over staged files. `rm -rf ./*`, `rm -rf .git` and `find . -delete` count as removing a folder another session works in. Each `cd` in the command is followed, so `cd /tmp/x && rm -rf ./*` passes.
- New basics rule **`protected-delete`** blocks deleting a protected branch: `git push origin :main`, `git push --delete origin main`, `git branch -D main`. `git branch -d` passes, because git itself refuses to lose unmerged work.
- checkout-guard compares a session file's start time with the process's, so a reused PID no longer counts as a live session.

- kill-guard sees through more indirection: `echo pkill node | sh`, `source <(...)`, `bash <(...)`, `eval "$(...)"`, `xargs pkill`, `busybox`, shell functions and variables (`cmd=pkill; $cmd node`), `tmux`, `screen`, `script`, `parallel`, shell commands that python, node, perl, ruby or php run from a string, and `ssh localhost`. Dev-server and tool names (`next-server`, `uvicorn`, `gunicorn`, `rails`, `expo`, `metro`, `tsc`, `playwright`, Google Chrome and its helpers) are on the shared list, versions included (`node22`, `python3.11`), and so are other coding agents (`codex`, `gemini`, `copilot`, `cursor-agent`).
- While another Claude session is alive, kill-guard also blocks: `kill <pid>`, `taskkill /PID` and `Stop-Process -Id` of a process in another session's tree; `pkill -f <path>` that matches another session's command line; `pkill -u`, `kill -1` and `kill 0`; `docker ... $(docker ps -q)`, `docker system prune`, `pm2 kill` and `docker compose down` in another session's project; `adb kill-server`, `adb emu kill` without a serial and `simctl shutdown all`; quitting shared apps (Slack, Finder, Dock) and stopping shared services (`brew services stop`, `launchctl bootout`, `systemctl stop`). Each rule has its own switch: `killGuard.massKill`, `dockerMass`, `deviceKill`, `appQuit`, `serviceStop` and `ownerCheck`. The process table is read only for these commands.
- kill-guard messages are two lines: who owns what you were about to stop, and the command that stops only yours.

### Fixed

- checkout-guard lets these through: `git add -A src` and other stage-all forms with a path, `git add -n`, `git stash push -- <paths>`, `--help` of any git command, and single-file `restore`. In a sample of 20,000 real commands in a shared, dirty tree, it blocked 1,432 instead of 1,962; the 39 newly blocked ones were all tree-changing commands.
- basics advice for `git clean` no longer suggests `git stash push -u`, which checkout-guard blocks in a shared tree.
- port-guard no longer reads quoted text as a command: `grep -E "next dev|vite"` and `ps | grep -E 'next start|playwright'` pass, as do `vite --version`, `vite build` and any tool run with `--help`. Heredoc bodies fed to python, node or cat are data, not commands. In 160,288 real commands from transcripts, it blocked 12 instead of 28 under the same conditions, and every one of the 12 was a real conflict.
- A heredoc is shell code only when a shell reads it (`bash <<EOF`, `cat <<EOF | sh`, `ssh localhost bash`). Bodies fed to `while read`, `git`, `psql` or a script are data; bodies fed to python or node are read in that language. In 161,188 real commands, kill-guard blocked 4 instead of 14 when no other session ran, and wait-guard blocked 1,009 instead of 1,123 at a 10-minute timeout, with no new blocks.
- wait-guard reads python `time.sleep` and node `sleep`/`setTimeout` waits inside heredocs in their own units, ignores them inside strings and comments, and no longer multiplies a script's waits by an earlier shell loop.
- `pkill -f "ssh -N -L 9333"` and other specific `-f` patterns pass; `pkill -f server` and `pkill -f "next dev"` still block.
- Claude Code sessions started by the macOS desktop app were not seen as sessions.
- `bulkhead doctor` reported the plugin as installed when run through `npx` from an unrelated copy.

## 0.2.2 - 2026-11-11

### Fixed

- `bulkhead scan` no longer crashes with `RangeError: Maximum call stack size exceeded` on a long history (hundreds of thousands of commands). The span is found with a loop, and a list append in the event log reader no longer spreads a whole file into one call.
- `bulkhead scan 30d` now means `--since 30d`. It used to ignore the argument and scan everything. Every subcommand now rejects an option or argument it does not know, with its usage text, instead of ignoring it.
- The status line counted session files whose pid was alive, so a reused pid counted as a session. It now counts Claude Code processes the way `bulkhead status` does, from one `ps` listing (Windows keeps the pid check).
- `git pull` in a tree another session works in gets its own advice (wait for that session to commit or stash, or pull from a clone nobody uses) instead of the worktree advice.

### Added

- `bulkhead scan` reads about twice as fast and prints a progress line on stderr when it runs longer than 3 seconds in a terminal.
- A block message from kill-guard, wait-guard, disk-guard, checkout-guard and basics ends with one line telling the agent to ask the user when the command was meant, and that the user can allow it in `.claude/bulkhead.json`.
- checkout-guard `remove-session-dir` resolves `$PWD`, `${PWD}`, `$(pwd)` and `` `pwd` `` to the current folder, so `rm -rf "$(pwd)"` is caught like `rm -rf .`.
- port-guard checks a `PORT=3000` set in the command for `npm start`, `npm run dev` and similar scripts, and for `node server.js`, `tsx`, `nodemon`, `bun` and `deno` running a file.
- kill-guard also blocks killing by name Electron, Simulator, Xcode, postgres, Docker Desktop, Code Helper and Cursor.
- The package can be run without the plugin: `npx claude-bulkhead status`, `top`, `scan`, `doctor`. It installs a `claude-bulkhead` command next to `bulkhead`. With `npm install -g claude-bulkhead`, the status line command no longer contains the plugin version.
- The README opens with a real Claude Code recording of kill-guard blocking `pkill node` (`docs/demo.gif`, re-recorded with `docs/demo.tape`), and the install steps come first.

## 0.2.1 - 2026-11-11

- `/bulkhead:remote` now shows what a run will upload (the current commit and every uncommitted change, deletions included) and the remote it goes to, and waits for your yes before anything is sent.
- The README says that a project's `.claude/bulkhead.json` can relax the guards for that repository, so read it in a repository you clone, and that `bulkhead config` shows where each setting came from.

## 0.2.0 - 2026-11-08

### New

- **`bulkhead scan`** replays the shell commands in your Claude Code transcripts (`~/.claude/projects`, subagents included) against the guards and prints what they would have stopped: hits per guard and rule, in how many sessions, how many a hook or you already stopped, the newest examples with secrets masked, and the most sessions that ran at once. checkout-guard is rebuilt from which sessions were active in the same git tree at that minute. Read-only, about 200 MB of transcripts a second. `--since`, `--project`, `--path`, `-n`, `--json`, and `/bulkhead:scan`.
- **disk-guard** blocks scans that walk the whole drive or home folder (`du -sh ~`, `du -sh ~/*`, `ncdu /`, `Get-ChildItem C:\ -Recurse`, `dir /s C:\`), `find /` and `find ~` without `-maxdepth`, and disk scans run in parallel (`xargs -P`, GNU `parallel`, `&` in a loop, `ForEach-Object -Parallel`). The disk is shared by every session, and these stall all of them for minutes.
- **checkout-guard `stage-all`** blocks `git add -A`, `git add .`, `git add -u` and `git commit -a` in a tree with changes when another live session works in it: the other session's half-finished edits would go into your commit. Named files pass.
- **checkout-guard `remove-session-dir`** blocks `rm -rf`, `Remove-Item -Recurse -Force`, `rd /s` and `git worktree remove` of the folder another live session works in, or a folder above it.
- **checkout-guard `worktree-force-links`** (Windows) blocks `git worktree remove --force` on a worktree with junctions or symlinks in its first two levels, which git has followed into the main checkout's `node_modules`.
- **basics `agent-author`** blocks commits authored as Claude or Anthropic: `--author`, `git config user.name/user.email`, `git -c user.name=`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. A `Co-Authored-By` trailer passes.
- **basics `rm-root`** also covers a folder directly in the home directory (`~/Documents`, `~/Desktop`; caches such as `~/.cache`, `~/.npm` and `~/tmp` pass) and top-level folders of the drive (`/srv`, `/usr`).
- New config keys `diskGuard.enabled`, `checkoutGuard.stageAll`, `checkoutGuard.removeSessionDir` and `basics.agentAuthor`, and `BULKHEAD_DISABLE` names `disk-guard`, `stage-all`, `remove-session-dir` and `agent-author`. `bulkhead doctor` lists rules turned off in any guard.
- The skill covers committing by file name, not deleting another session's folder, the git identity, and the disk.

### Changed

- The repository moved to `dooly6276/claude-bulkhead`; the old address redirects. Install with `/plugin marketplace add dooly6276/claude-bulkhead`.
- New README hero and `bulkhead scan` animations, light and dark.

## 0.1.1 - 2026-10-13

- `/bulkhead:remote` printed nothing when no remote was configured, and `/bulkhead:doctor` printed nothing when a check failed: Claude Code drops a slash command whose shell step exits non-zero. Both now show the output.
- Each slash command pre-approves only the one `bulkhead` command it runs instead of any `node` command.
- The repository no longer ships `package-lock.json`. Claude Code installs a plugin's packages when it finds a lockfile in the plugin root, so the lint tools could be installed with the plugin. The runtime still has no dependencies.
- `PRIVACY.md` lists what bulkhead reads, stores and sends, and `plugin.json` carries the listing links.

## 0.1.0 - 2026-10-13

First public release.

### Guards

- **kill-guard** blocks kills by program name that would hit other sessions' processes: `pkill`, `killall`, `taskkill /IM` and `/FI`, `Stop-Process -Name`, `Get-Process ... | Stop-Process`, `wmic ... delete`, name lookups fed to `kill` through `$(...)`, `xargs`, loops or variables, wildcards and several names at once. Kills scoped to a PID, a command line, a path or a script pass.
- **wait-guard** blocks foreground waits that can hold a session longer than 180 seconds: sleep loops, inline `python -c` or `node -e` sleeps, `timeout /t`, `ping -n`, `[Threading.Thread]::Sleep`, and following a log with `tail -f`, `docker logs -f`, `journalctl -f` or `Get-Content -Wait`. Sleeps in a background job pass.
- **memory-guard** blocks heavy commands (test suites, builds, browser automation, container builds) when free RAM is below 3 GB or 15% of RAM, and points to `bulkhead-slot` or, when one is configured, `bulkhead remote`.
- **port-guard** blocks starting a dev server on a port another live session is listening on and suggests a free one. It also blocks kills by port aimed at another session's server (`npx kill-port`, `fuser -k`, `lsof -t -i:N | xargs kill`, `Get-NetTCPConnection` with `Stop-Process`, `netstat` with `taskkill`).
- **checkout-guard** blocks `git checkout`, `switch`, `stash`, `reset --hard`, `clean -f`, `rebase`, `merge` and a dirty `pull` when another live session works in the same working tree, and suggests `git worktree add`.
- **basics** blocks `rm -rf` at roots, the home directory and folders above the repository, force-pushes to protected branches, and `git reset --hard` or `git clean -fd` that would lose uncommitted work. Each rule can be turned off.
- **orphan-reaper** stops what a finished session left running: dev servers, test runners and their workers (Vitest, Jest, Mocha, AVA, `node --test`, Playwright, pytest and pytest-xdist, `cargo test`, `go test`, `dotnet test`), watchers, builders and automation browsers. It runs within seconds of a session exiting (a detached waiter started by the `SessionEnd` hook) and again at session start. Only processes started from that session's Claude tool shells are touched; editors, terminals, shared build daemons and machine services are never stopped, nor anything under them. Windows, macOS and Linux.

All guards read commands through one shared parser for Bash, PowerShell and cmd that opens wrappers (`bash -c`, `powershell -Command`, `-EncodedCommand`, `cmd /c`, `eval`, `sudo`, `env`, `timeout`, `xargs` and more) up to three levels deep. Commit, tag, pull request and release text never triggers a guard. Commands sent to another machine or container are left to that machine.

### Commands

- `bulkhead status` and `bulkhead top`: sessions with their project, memory, child processes and ports, slot jobs and the queue, free RAM, and the latest blocks. `top` is a live full-screen view.
- `bulkhead-slot run --gb=N -- <command>` (also `bulkhead slot`): queues heavy commands against a RAM budget shared by every session on the machine.
- `bulkhead remote` (optional): runs a heavy command on another machine over SSH. It sends the commit as an incremental git bundle plus uncommitted changes, runs it in one of up to 8 copies of the repository with its own port in `BULKHEAD_PORT`, returns the exit code, and stops everything the command started when it ends or the connection drops. `--tail=N` keeps the full output in a file and prints only the end. Also `fetch`, `status`, `list`, `add` and `remove`. The remote needs only an SSH server, bash, git and tar. See `docs/remote.md`.
- `bulkhead reap [--dry-run]`: runs orphan-reaper by hand; the dry run lists what it would stop and why.
- `bulkhead log`: what the guards blocked and what orphan-reaper stopped, with `--since`, `--guard`, `--summary` and `--json`.
- `bulkhead doctor`: checks the install, the settings, each guard, the process reader, RAM limits, slots, the event log, git and configured remotes.
- `bulkhead config`: every setting, its effective value and where it came from.
- `bulkhead port [--near N]`: a port nothing listens on.
- `bulkhead-statusline`: live sessions, held slots and free RAM for the Claude Code status line.
- Slash commands `/bulkhead:status`, `/bulkhead:log`, `/bulkhead:doctor`, `/bulkhead:remote` and `/bulkhead:reap`, and a `bulkhead` skill that tells Claude how to work on a machine shared with other sessions.

### Configuration

- `~/.claude/bulkhead/config.json` and a per-project `.claude/bulkhead.json`, merged in that order, with environment variables winning. Every guard can be turned off, and the common false positives have their own keys. A broken file is ignored and reported once at session start. Remotes can be set in the global file only. See `config.example.json` and `docs/configuration.md`.
- Every block and every stopped process is appended to `events.jsonl` in the state directory; `BULKHEAD_NO_LOG=1` turns it off.

### Quality

- More than 2,400 tests on Linux, macOS and Windows with Node 18, 22 and 24, including a corpus of more than 900 real command lines run through the actual hooks, a fuzz test that checks every guard stays linear on 1 MB inputs, and an end-to-end `bulkhead remote` run against a real SSH server.
- No dependencies. Each guard adds about 40 to 50 ms to a tool call.
