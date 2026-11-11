# Changelog

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

### Fixed

- port-guard no longer reads quoted text as a command: `grep -E "next dev|vite"` and `ps | grep -E 'next start|playwright'` pass, as do `vite --version`, `vite build` and any tool run with `--help`. Heredoc bodies fed to python, node or cat are data, not commands. In 160,288 real commands from transcripts, it blocked 12 instead of 28 under the same conditions, and every one of the 12 was a real conflict.
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
