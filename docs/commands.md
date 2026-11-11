# Commands

`bulkhead` and `bulkhead-slot` are in the plugin's `bin/` directory, which Claude Code puts on the Bash tool's `PATH` while the plugin is enabled. Outside Claude Code, call them by path, for example `node ~/.claude/plugins/cache/bulkhead/bulkhead/<version>/bin/bulkhead status`.

`bulkhead --version` prints the version, `bulkhead <command> --help` and `bulkhead help <command>` print that command's usage, and an unknown command is named in the error. Options that take a number refuse a value they cannot use (`bulkhead-slot run --gb abc`, `--gb=0`, `--gb=999` on a smaller machine, `log -n abc`, `top --interval=abc`) instead of falling back to a default.

Every command that prints a table also takes `--json`. Colors are used only when the output is a terminal and `NO_COLOR` is not set.

| Command | What it does |
|---|---|
| [`bulkhead status`](#bulkhead-status) | Sessions, their memory, ports, heavy jobs and free RAM, once |
| [`bulkhead top`](#bulkhead-top) | The same, live, full screen |
| [`bulkhead scan`](#bulkhead-scan) | Replays your Claude Code transcripts against the guards: what they would have stopped |
| [`bulkhead log`](#bulkhead-log) | What the guards blocked and what orphan-reaper stopped |
| [`bulkhead doctor`](#bulkhead-doctor) | Checks the install, the settings and this machine |
| [`bulkhead config`](#bulkhead-config) | Effective settings and where each one came from; `--preset` switches to fewer or more guards |
| [`bulkhead explain`](#bulkhead-explain) | What every guard would say about a command, against this machine right now, without running it |
| [`bulkhead allow`](#bulkhead-allow) | You allow one blocked command once, from your own terminal |
| [`bulkhead port`](#bulkhead-port) | A port nothing is listening on |
| [`bulkhead worktree`](#bulkhead-worktree) | A worktree in one step (env files, install, stable port), a list of them, and safe cleanup |
| [`bulkhead reap`](#bulkhead-reap) | Stops what sessions that have exited left running, or lists it with `--dry-run` |
| [`bulkhead-slot`](#bulkhead-slot) | Queues heavy commands against a shared RAM budget |
| [`bulkhead remote`](#bulkhead-remote) | Runs a heavy command on another machine over SSH (optional) |

The plugin also adds slash commands that run these and summarize the result: `/bulkhead:scan [30d]`, `/bulkhead:status`, `/bulkhead:log [24h|7d|...]`, `/bulkhead:doctor`, `/bulkhead:reap` (a dry run) and `/bulkhead:remote <command>`.

## bulkhead status

```
bulkhead status [--json]
```

```
SESSION  STATE                STARTED  RSS     BRANCH              PROJECT
18672    working              09:52    1.4 GB  main                ~/src/acme-web
  :3000  node  pid 24632
21888    needs permission 4m  10:05    353 MB  feat/login (wt)     ~/src/acme-web-auth
26448    waiting 3m           11:40    625 MB  feat/checkout (wt)  ~/src/acme-web-checkout
  :3001  node  pid 31020
duplicate MCP: 3 copies of @playwright/mcp, 1.2 GB (sessions 18672, 21888, 26448)

SLOT    GB  PID    AGE     COMMAND
slot-1  4   30112  12 min  npx playwright test

9.9 GB free of 31.8 GB, commit 68%
```

A session is a running `claude` CLI process. RSS is the sum over its process tree. The project comes from the session file Claude Code keeps in `~/.claude/sessions`; for a session without one, from `/proc/<pid>/cwd` on Linux, from one batched `lsof -a -d cwd` on macOS, and `(unknown)` on Windows. The `WAITING` table appears only when `bulkhead-slot run` jobs are queued. On a terminal, the project column shrinks to the terminal width and long paths lose their start (`…/dev/api`), never their end.

- **BRANCH** is the git branch of the session's folder, with `(wt)` when that folder is a linked worktree. It is read from `.git/HEAD` (or the worktree's own gitdir `HEAD`); no git process runs. A detached HEAD shows the short commit.
- **STATE** is `working`, `waiting 3m` (Claude finished its reply and is waiting for you), `needs permission 4m` (a tool is waiting for your approval) or `needs input` (Claude asked you a question). `-` means no state is known: the hooks are not installed, or the session has not fired one yet. See [Session state](#session-state-and-notifications).
- A `duplicate MCP:` line appears when the same MCP server runs in two or more sessions. See [Duplicate MCP servers](#duplicate-mcp-servers).

`--json` adds per-session `children` (processes in the tree besides the session itself), `branch`, `worktree`, `state` (`working`, `waiting`, `permission` or `null`), `stateReason` (`reply`, `idle`, `permission`, `input`), `stateSince`, `mcp` (the session's MCP servers: `name`, `pid`, `rss`), raw byte counts, ISO times, and the queue with each job's reason for waiting. A top-level `mcp` array lists every MCP server group: `name`, `copies`, `sessions`, `rss`, `duplicate`.

### Session state and notifications

Claude Code runs hooks when a session changes what it is doing. bulkhead registers a tiny hook (`src/session-state.js`) for these events, taken from the [hooks reference](https://code.claude.com/docs/en/hooks):

| Event | Sets |
|---|---|
| `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` | working |
| `Stop` | waiting for you (the reply is done) |
| `Notification` with `permission_prompt` | needs permission |
| `Notification` with `elicitation_dialog` or `elicitation_url_dialog` | needs input |
| `Notification` with `idle_prompt` | keeps waiting |
| `SessionStart` (not after `compact`) | waiting |
| `SessionEnd` | removes the state |

Each event writes one small file, `<state dir>/session-state/<session id>.json`, and reads nothing else: no process list, no git. It prints nothing and exits 0 on any error. `PostToolUse` and `PostToolUseFailure` run async, so they never slow a tool call, and they write only when the state changes. A file belongs to a session only while that session's process runs: `status` and `top` join files to live sessions by the session id in `~/.claude/sessions/<pid>.json`, so a file left behind by a crashed session is never shown (and is deleted after two days).

Claude Code sends `permission_prompt` only after the prompt has waited about six seconds, and `idle_prompt` about 60 seconds after a reply. A turn you interrupt with Esc does not fire `Stop`, so that session keeps showing `working` until its next event. `top` lists the sessions that need you first: needs permission, then waiting (longest first), then the rest. The status line shows the count: `3 sessions  2 waiting  1 heavy  9.1 GB free`.

To be told when a session starts waiting, set `notify.command` in the global config file ([configuration.md](configuration.md#notify)). It is off by default. The command runs detached, at most once per `notify.minIntervalSeconds` (default 30) per session, never blocks the hook, and gets three environment variables: `BULKHEAD_SESSION_PROJECT` (the folder), `BULKHEAD_SESSION_STATE` (`waiting` or `permission`) and `BULKHEAD_SESSION_PID` (the Claude process). Examples:

```json
{ "notify": { "command": "osascript -e 'display notification \"'\"$BULKHEAD_SESSION_STATE\"'\" with title \"Claude: '\"$BULKHEAD_SESSION_PROJECT\"'\"'" } }
```

macOS above. On Linux: `"command": "notify-send \"Claude $BULKHEAD_SESSION_STATE\" \"$BULKHEAD_SESSION_PROJECT\""`. On Windows the command runs in `cmd.exe`, so `"command": "msg %USERNAME% /TIME:10 Claude %BULKHEAD_SESSION_STATE% in %BULKHEAD_SESSION_PROJECT%"` works on Pro editions, and a toast works through PowerShell: `"command": "powershell -NoProfile -Command \"[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]; $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02'); $x.GetElementsByTagName('text')[0].AppendChild($x.CreateTextNode('Claude is ' + $env:BULKHEAD_SESSION_STATE)) | Out-Null; $x.GetElementsByTagName('text')[1].AppendChild($x.CreateTextNode($env:BULKHEAD_SESSION_PROJECT)) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('bulkhead').Show([Windows.UI.Notifications.ToastNotification]::new($x))\""`. Write the JSON with the quotes escaped as your shell needs; a short script file that reads the three variables is easier to keep right.

### Duplicate MCP servers

A stdio MCP server is a child process of the session that started it, so five sessions with the Playwright MCP run five copies, each with its own browser. `status` and `top` group each session's child processes, treat an npx, shell and node chain as one server, and flag a server that runs in two or more sessions with the same command line apart from session-specific parts (the session's folder, package versions, numbers, ids, temp paths). The line says how many copies there are and their total RSS, for example `3 copies of @playwright/mcp, 1.2 GB`.

A command line is read as an MCP server by this heuristic, nothing more:

- the program is a launcher (`npx`, `npm`, `pnpm`, `yarn`, `bunx`, `bun`, `uvx`, `uv`, `pipx`, `node`, `deno`, `python`, `tsx`, `docker`, with or without `.exe` or `.cmd`) and one of its arguments names an MCP package or path, or the program's own name contains `mcp` as a word or `mcp-server`;
- an argument names an MCP package when it is `@modelcontextprotocol/...`, or its last two path segments (or the package under `node_modules/`) contain `mcp` as a word (`@playwright/mcp`, `playwright-mcp`, `context7-mcp`, `mcp_server_fetch`) or `mcp-server`;
- options (`--mcp-config`) never count, and neither does a project folder called `mcp-hub` when the script under it is not named like an MCP server.

A server the heuristic misses is simply not grouped; nothing is stopped or blocked because of it. Only processes inside a session's tree count, so servers left behind by an exited session are orphan-reaper's job.

## bulkhead top

```
bulkhead top [--interval=SECONDS] [--once]
```

A full-screen view that refreshes every 2 seconds on Linux and macOS and every 4 seconds on Windows, where one process scan takes 1 to 2 seconds. The scan runs in a worker thread, so the screen and the keys never wait for it; the header shows `scanning` while one is running and the last scan's duration otherwise.

```
bulkhead top  14:30:05                                                          scan 1.4s  every 2s  q quit  r refresh
RAM █████████████████████░░░░░░░░░  9.9 GB free of 31.8 GB  commit 68%

SESSIONS 3  2 waiting for you
PID      STATE                 STARTED       PROJECT               BRANCH                  RSS  PROCS  PORTS
21888    needs permission 4m   10:05         ~/src/acme-web-auth   feat/login (wt)      353 MB      5  -
26448    waiting 3m            11:40         …/acme-web-checkout   feat/checkout (wt)   625 MB      5  :3001
18672    working               09:52         ~/src/acme-web        main                 1.4 GB     12  :3000

DUPLICATE MCP SERVERS
3 copies of @playwright/mcp, 1.2 GB  sessions 18672, 21888, 26448

HEAVY JOBS  1 running, 0 waiting
slot-1  4 GB   30112   12 min  npx playwright test

RECENT BLOCKS
14:29  kill-guard     taskkill-im    ~/src/acme-web-auth      taskkill /F /IM node.exe
```

- The RAM bar shows used memory. It is green above the slot floor, yellow below it, and red below the memory-guard minimum, when a line under it says heavy commands are being blocked. Linux adds swap, Windows adds commit charge.
- RSS bars are relative to the largest session. PROCS counts the processes in the session's tree besides the session itself.
- Keys: `q`, `Esc` or `Ctrl-C` quit, `r` refreshes at once.
- The terminal is restored on every exit path: the view runs in the alternate screen buffer, and quitting, `Ctrl-C`, `SIGTERM` and `SIGHUP` all leave it and show the cursor again.
- Sessions that need you come first: needs permission, then waiting (longest first), then the others. The header counts them (`2 waiting for you`). A `DUPLICATE MCP SERVERS` section appears when the same MCP server runs in several sessions.
- On a narrow terminal, columns are dropped in this order: the RSS bar, the start time, the ports, the process count, the branch, the RSS. Then the state text shortens and the project column shrinks. Project paths lose their start (`…/dev/api`), other long values end in `…`. Lines never wrap. With `NO_COLOR` set, or when the output is not a terminal, there are no colors. When there are more sessions than rows, the list ends in `... N more`.
- When the output is not a terminal (a pipe, a file, the Bash tool), or with `--once`, it prints one snapshot without colors and exits.

## bulkhead scan

```
bulkhead scan [--since 30d|DATE] [--path DIR|FILE] [--project TEXT] [-n N] [--json]
bulkhead scan [30d] --share [--markdown]
bulkhead scan [30d] --explain N
```

Reads the transcripts Claude Code keeps in `~/.claude/projects` (subagent transcripts included), takes every Bash and PowerShell command your sessions ran, and replays each one against the guards. It is the quickest way to see whether bulkhead is worth installing: it answers "how often did my sessions already do this?" with your own history. It only reads; nothing is written and nothing leaves the machine.

```
$ bulkhead scan --since 30d
bulkhead scan  what your past Claude Code sessions would have run into
Found 1,203 shell commands in 211 of your 437 sessions that bulkhead would have stopped.
Most common: 338 foreground sleeps and polling loops past the wait limit; 55 checkout/merge/rebase/stash in a tree another session was using.
Up to 11 Claude Code sessions ran at the same time (Nov 01); on 11 days two or more did.
  read 1,396 transcripts (6.4 GB), 90,855 shell commands in 31.7s, Oct 27 .. Nov 08 (since 30d)

GUARD           RULE                HITS  SESSIONS  STOPPED  LAST
wait-guard      poll-loop            338        56      337  Nov 08
checkout-guard  stage-all             19         8        1  Nov 07
checkout-guard  git-checkout          16         5        -  Nov 01
...
STOPPED: hits a hook already stopped or you declined, as the transcript recorded them. "-" means none recorded: the command ran.

checkout-guard  stage-all  19 times in 8 sessions  another session was active in the same tree at that minute
  $ ...; [git add -A uploads/drafts uploads/done] && git commit -q -m "wip"  ~/src/acme-web  Nov 07  #4
```

- The first three lines say what was found in plain words. Under the table, `-` in **STOPPED** means none recorded: transcripts only show a stop when a hook printed an error or you declined, so a `-` row is a command that ran. When at least half of a rule's hits were already stopped by your own hooks, one line says so, because bulkhead would add less there than the count suggests.
- **HITS** is the number of commands with the shape a guard blocks; **SESSIONS** how many sessions ran them; **STOPPED** how many were already stopped by a PreToolUse hook (any hook, not only bulkhead) or declined by you in the permission prompt.
- Under the table, each rule shows its newest examples (`-n`, default 3, `-n 0` for none) with the project and day, numbered `#1`, `#2`, and so on. Long commands are cut around the part that matched, which is shown in `[brackets]` (bold in a terminal). Secret-looking values (tokens, `-u user:pass`, `*_KEY=`, `Bearer ...`, URLs with a password) are masked before printing.
- **overlap** is the most sessions running at the same time. A session counts as running between two of its events when they are at most 10 minutes apart.
- **What is replayed:** kill-guard, wait-guard (with each call's own timeout; background calls skipped), disk-guard, basics except `discard-changes`, memory-guard's slot-file rule, and checkout-guard. checkout-guard needs to know which sessions were live at that moment, so scan rebuilds it from the transcripts: another session counts as live when it had activity within 10 minutes of the command in the same git tree, and for `git add -A` it assumes that session had edits there.
- **What is not replayed:** port-guard and memory-guard's low-RAM check depend on which ports and how much RAM were in use at that moment, which transcripts do not record.
- A hit means the command had the shape a guard blocks, not that damage was done.

`--since` takes `24h`, `7d`, `2w` or a date, and the same value can be given without the flag (`bulkhead scan 30d`). `--project acme` keeps sessions whose folder contains `acme`. `--path` reads another folder or a single `.jsonl`. `--json` prints every rule with its counts and up to five masked examples.

**`--share`** prints 5 to 8 lines you can paste into a post, an issue or a chat: how many days, sessions and the most at once, and how many commands the guards would have stopped, grouped in plain words. It carries counts only, never a project path, command text or secret, and comes from the same numbers as the report above. `--share --markdown` prints the same as a small table.

```
$ bulkhead scan 14d --share
bulkhead scan, 14 days, 437 sessions, up to 18 at once.
It would have stopped 200 commands in 60 sessions:
  90 foreground sleeps and polling loops past the wait limit
  55 checkout/merge/rebase/stash in a tree another session was using
  29 git add -A while another session was active in the same tree
  11 other risky commands (4 kinds)
(bulkhead scan, github.com/dooly6276/claude-bulkhead)
```

**`--explain N`** shows example `#N` from the report in full: the whole command (masked), the part that matched, the rule, what the rule means, and a link to the guard's page. The match is found from the rule's name, so for an unusual command it can be the whole command. Use the same `-n` you used for the report. On a 2026 MacBook Pro it replays about 140 MB of transcripts a second, so a few GB take under a minute; it shows progress when it runs longer than 3 seconds in a terminal.

Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default), so scan sees at most that much history.

## bulkhead log

```
bulkhead log [-n N] [--since SPAN] [--guard NAME] [--summary] [--json]
```

Every block by kill-guard, wait-guard, memory-guard, port-guard, checkout-guard and basics, and every process orphan-reaper stops, is appended as one JSON line to `events.jsonl` in the state directory (`~/.claude/bulkhead` unless `BULKHEAD_STATE_DIR` is set). See [The event log](#the-event-log) below.

| Option | Meaning |
|---|---|
| `-n N`, `--limit=N` | How many events to list, newest last. Default 20 |
| `--since SPAN` | Only newer events. `30m`, `24h`, `7d`, `2w`, or a date such as `2026-10-01`. Empty means all time |
| `--guard NAME` | Only one guard, such as `kill-guard` |
| `--summary` | Counts per guard and rule, and per project |
| `--json` | The events, or the summary, as JSON |

```
$ bulkhead log -n 5
TIME   GUARD         RULE             SESSION  PROJECT                  COMMAND
06:40  kill-guard    pkill            s-c3     ~/src/acme-web-checkout  pkill -f python
06:40  memory-guard  slot-files       s-b2     ~/src/acme-web-auth      echo {} > ~/.claude/bulkhead/slots/slot-2.json
06:40  basics        force-push-main  s-c3     ~/src/acme-web-checkout  git push --force origin main
06:40  basics        rm-root          s-b2     ~/src/acme-web-auth      rm -rf ~/
06:40  wait-guard    long-sleep       s-a4     ~/src/acme-web           sleep 900
```

```
$ bulkhead log --summary --since 7d
10 blocks in the last 7 days, 3 projects, 4 sessions

GUARD         RULE             COUNT  LAST
wait-guard    poll-loop            3  06:40  ████████████████████████
wait-guard    long-sleep           2  06:40  ████████████████
basics        force-push-main      1  06:40  ████████
basics        rm-root              1  06:40  ████████
kill-guard    pkill                1  06:40  ████████
kill-guard    taskkill-im          1  06:40  ████████
memory-guard  slot-files           1  06:40  ████████

PROJECT                  COUNT
~/src/acme-web               4
~/src/acme-web-auth          3
~/src/acme-web-checkout      3
```

Times are today's `HH:MM`, or `Mon DD HH:MM` for older days.

### The event log

Each line has these fields:

| Field | Meaning |
|---|---|
| `time` | ISO 8601, UTC |
| `guard` | `kill-guard`, `wait-guard`, `memory-guard`, `port-guard`, `checkout-guard`, `basics` or `orphan-reaper` |
| `rule` | What matched, see below |
| `session` | Claude Code session ID. For orphan-reaper, the exited session after `SessionEnd`, else null |
| `project` | `CLAUDE_PROJECT_DIR`, else the tool call's working directory. For orphan-reaper, the exited session's project: from the `SessionEnd` hook, or from its session file when that is still there |
| `command` | The command, on one line, cut to 200 characters. For orphan-reaper, the stopped process's command line |
| `pid` | orphan-reaper only: the process that matched the rule; its whole tree was stopped |
| `trigger` | orphan-reaper only: `session-end`, `startup` or `manual` (`bulkhead reap`) |

Rules per guard:

| Guard | Rules |
|---|---|
| kill-guard | `taskkill-im`, `taskkill-filter`, `stop-process-name`, `get-process-pipe`, `pkill`, `pgrep-kill`, `ps-grep-kill`, `wmic-name`, `win32-process-name` |
| wait-guard | `poll-loop`, `long-sleep` |
| memory-guard | `low-memory`, `slot-files` |
| port-guard | `port-in-use` (starting a server on another session's port), `kill-by-port` |
| checkout-guard | `git-<subcommand>`, such as `git-checkout`, `git-stash`, `git-pull` |
| basics | `rm-root`, `force-push-main`, `discard-changes` |
| orphan-reaper | `test-runner`, `watcher`, `builder`, `headless-browser`, `dev-server`, `extra-name`; see [the rules table](guards/orphan-reaper.md#what-it-stops) |

The file is rotated at 1 MB: the current file becomes `events.jsonl.1` (replacing the previous one) and a new file starts, so the log never takes more than about 2 MB. `bulkhead log` reads both files.

Writing an event is one `stat` and one append, only on the block path, and never throws: an unwritable state directory loses the event, not the block. `BULKHEAD_NO_LOG=1` or `"log": { "enabled": false }` turns it off. `guards.log` in the same directory keeps a one-line text record of each block as before.

## bulkhead doctor

```
bulkhead doctor [--json] [--no-remote]
```

Runs every check and prints one line each, `OK`, `WARN` or `FAIL`. The exit code is 1 when any check fails, the Enforcement checks below included. When remotes are configured, it also connects to each one; `--no-remote` skips that.

| Check | FAIL or WARN when |
|---|---|
| `node` | FAIL below Node 18 |
| `plugin` | FAIL when `hooks/hooks.json` cannot be read or names a script that does not exist |
| `state dir` | FAIL when the state directory cannot be written; slots and the event log need it |
| `config` | WARN for each config problem: invalid JSON, an unknown key, a value of the wrong type |
| one line per guard | Says `on` or `off` and why (`env BULKHEAD_DISABLE`, or the config file that turned it off), plus its main setting. WARN when orphan-reaper is on for a platform it does not support |
| `processes` | FAIL when the process reader fails (no PowerShell, no `/proc`, no `ps`). WARN above 8 seconds. Shows the process, port and session counts and the time taken. Sessions are found from the process list; the line says how many of them have a session file |
| `sessions` | WARN when `~/.claude/sessions` does not exist. Shows how many session files there are; a running session without one is still counted by `processes`, but checkout-guard cannot tell which folder it works in |
| `memory` | WARN when free RAM is below the memory-guard minimum right now. Shows the limits computed for this machine |
| `slots` | WARN when a slot's owner has died; the next `bulkhead-slot run` reclaims it |
| `event log` | Shows its size and event count, or that it is off and why |
| `git` | WARN when git is not on `PATH`; checkout-guard and the git rules of basics then pass everything |
| `remote tools`, `remote <name>` | Only when remotes are configured. FAIL when `ssh`, `tar` or `git` is missing here, or a remote cannot be reached, lacks git or tar, or its folder is not writable |

```
$ bulkhead doctor
OK    node            v24.11.0
OK    plugin          ~/.claude/plugins/cache/bulkhead/bulkhead/0.2.1, hooks: 2 SessionStart, 1 SessionEnd, 6 PreToolUse
OK    state dir       ~/.claude/bulkhead is writable
OK    config          no config files, defaults in use
OK    kill-guard      on
OK    wait-guard      on, limit 180s
OK    memory-guard    on
OK    port-guard      on
OK    checkout-guard  on
OK    disk-guard      on
OK    basics          on, protected branches: main, master
OK    orphan-reaper   on, at session start and after each session ends
OK    processes       356 processes, 21 listening ports, 8 Claude sessions (8 with a session file) in 2.4s
OK    sessions        ~/.claude/sessions (8 session files; a running session without one is still found from the process list, but checkout-guard cannot tell which folder it works in)
OK    memory          12.2 of 31.8 GB free, commit 43%, memory-guard blocks heavy commands below 3 GB, bulkhead-slot keeps 5 GB free for a second job, and waits while commit is above 75%
OK    slots           none held
OK    event log       ~/.claude/bulkhead/events.jsonl, empty so far
OK    git             2.52.0.windows.1


Enforcement
OK    install          bulkhead@bulkhead 0.2.2 at ~/.claude/plugins/cache/bulkhead/bulkhead/0.2.2, enabled in user settings
OK    hooks on         no disableAllHooks or allowManagedHooksOnly in user, project, local or managed settings
OK    hooks.json       installed copy: 7 PreToolUse hooks, all synchronous
OK    hook node        /usr/local/bin/node v24.11.0
OK    hook kill-guard  blocked "pkill node" (exit 2, message shown to Claude) in 52 ms
OK    hook wait-guard  blocked "sleep 100000" (exit 2, message shown to Claude) in 49 ms
OK    hook disk-guard  blocked "du -sh /" (exit 2, message shown to Claude) in 50 ms
OK    hook basics      blocked "rm -rf /" (exit 2, message shown to Claude) in 51 ms

26 OK, 0 WARN, 0 FAIL
```

### Enforcement

A hook that is listed in Claude Code can still fail to block. This section proves the guards block, using only your files and canary commands that are never executed; no live session is needed.

| Check | What it does, and when it is WARN or FAIL |
|---|---|
| `install` | Finds how the plugin reaches Claude Code for this config folder (`CLAUDE_CONFIG_DIR` or `~/.claude`): `plugins/installed_plugins.json`, `enabledPlugins` in user, project (`.claude/settings.json`) and local (`.claude/settings.local.json`) settings, and the marketplace. WARN `not installed in Claude Code; run /plugin install bulkhead@bulkhead` when there is no entry (running from an npx cache does not install the hooks). FAIL when it is turned off, or the installed folder has no `hooks/hooks.json` |
| `duplicates` | WARN when bulkhead hooks are also written into a settings file by hand, or two installed copies exist, so each guard runs twice per call |
| `hooks on`, `hooks off`, `managed hooks` | FAIL when `disableAllHooks` is `true` after settings precedence (a project `false` overrides a user `true`), when managed settings turn the plugin off, or when `allowManagedHooksOnly` is on and the plugin is not force-enabled in managed `enabledPlugins`. The managed file is read from `/Library/Application Support/ClaudeCode/`, `/etc/claude-code/` or `C:\Program Files\ClaudeCode\`. Each message links the documented setting |
| `hooks.json` | Reads `hooks/hooks.json` from the installed copy, the one Claude Code runs. FAIL when it is missing or a PreToolUse hook is `async` (the hooks reference says an async hook cannot block) |
| `hook node` | FAIL when `node` is not on the `PATH` a hook gets, or is older than 18. With no node every hook fails to start, and Claude Code lets the call through |
| `hook <guard>` | Runs the installed hook command as `hooks.json` declares it: exec form (`command` plus `args`, no shell) or shell form, the same `${CLAUDE_PLUGIN_ROOT}` substitution, the same `timeout`, and a synthetic PreToolUse payload for a canary command (`pkill node`, `sleep 100000` with a 1 hour tool timeout, `du -sh /`, `rm -rf /`). It must exit 2 with the guard's message on stderr. FAIL when it exits 0, blocks without a message, cannot start, or times out (a PreToolUse hook that times out does not block the call). The time shown is the measured hook latency, node start included. Guards you turned off in config are skipped |

What the checks rely on: PreToolUse exit code 2 blocks the call and shows stderr to Claude, a timed-out or failed-to-start command hook does not block unless `onFailure: "block"` is set, and an `async` hook cannot block ([hooks reference](https://code.claude.com/docs/en/hooks)); `disableAllHooks`, `allowManagedHooksOnly` and `enabledPlugins` behave as in the [settings reference](https://code.claude.com/docs/en/settings-reference). The checks use the `PATH` of the shell that runs `bulkhead doctor`; a desktop app or IDE can start Claude Code with a different `PATH`.

## bulkhead config

```
bulkhead config [--json]
bulkhead config --preset quiet|normal|strict [--project]
```

Prints which config files were found, the active preset, every setting with its effective value, and where that value came from: `default`, `preset NAME`, a file path, or `env NAME`. Values left at their default are dimmed in a terminal. A limit left on `auto` shows what it works out to on this machine, such as `auto (3 GB on this machine)`. Problems with the files are listed at the end as `WARN` lines. See [configuration.md](configuration.md) for the keys.

```
$ bulkhead config
Files (project wins over global, environment wins over both)
  global   ~/.claude/bulkhead/config.json  loaded
  project  ~/src/acme-web/.claude/bulkhead.json  loaded
  preset   quiet  (from ~/.claude/bulkhead/config.json)

KEY                            VALUE                        FROM
killGuard.enabled              true                         default
killGuard.allowNames           ["ffmpeg"]                   ~/.claude/bulkhead/config.json
waitGuard.enabled              false                        preset quiet
waitGuard.limitSeconds         300                          ~/src/acme-web/.claude/bulkhead.json
memory.minFreeGb               auto (3 GB on this machine)  default
...
```

`--preset` writes `"preset"` into the global config file (`~/.claude/bulkhead/config.json`), or with `--project` into the project's `.claude/bulkhead.json` (created when missing), and keeps every other key in the file. A file that is not valid JSON is never overwritten. `quiet` keeps only the guards that protect one session from another and the two rules that cannot be undone; `normal` is the defaults; `strict` has everything on with tighter limits. Keys you set yourself and environment variables still win over a preset. The exact contents of each preset are in [configuration.md](configuration.md#presets).

```
$ bulkhead config --preset quiet
preset quiet written to ~/.claude/bulkhead/config.json (every project; a project file or BULKHEAD_PRESET can still override it)
```

## bulkhead explain

```
bulkhead explain [--cwd DIR] [--session-id ID|PID] [--timeout MS] [--json] -- <command...>
```

Runs the command through every Bash guard in the order the hooks run them, against the sessions, processes, ports and git tree on this machine right now, and prints what each one would do. Nothing is executed, nothing is written to the event log, and no allow code is created. The command can be given as separate words after `--` or as one quoted string.

For each guard it prints `pass`, `BLOCK` or `off`; for a block, the rule, the evidence (which live session owns the process, port or tree, with its pid and project), the exact message the agent would see, the one-time way out (`bulkhead allow <code>`, see below) and the permanent one (the config key, and the `BULKHEAD_DISABLE` name). The process table is read only when a guard needs it: a command that matches no guard costs about what the hooks cost.

```
$ bulkhead explain -- pkill -f node
command  pkill -f node
folder   ~/src/acme-web
as       a new session (--session-id names one)
verdict  BLOCKED by kill-guard pkill

kill-guard      BLOCK  rule pkill
  evidence   node pid 3941, 3966 runs in the session with pid 2729 (~/src/blog)
  evidence   node pid 5873 runs in the session with pid 3517 (~/src/shop)
  the agent sees:
    [bulkhead] kill-guard: pkill/killall matches every process with that name
    ...
    If the user wants this on purpose, ask them to run `bulkhead allow <code>` in their own terminal (allows it once), or set {"killGuard":{"allowNames":["node"]}} in .claude/bulkhead.json.
  allow once   the user runs `bulkhead allow <code>` in their terminal; the code is in the real block message
  allow always {"killGuard":{"allowNames":["node"]}} in .claude/bulkhead.json
  or           BULKHEAD_DISABLE=kill-guard

wait-guard      pass
memory-guard    pass
port-guard      pass
checkout-guard  pass
disk-guard      pass
basics          pass
```

Which session is "me" decides port-guard and checkout-guard. `--session-id` takes a session id or the pid of a running session and judges the command as that session. Without it, the shell's own session is used when the command runs inside Claude Code (`CLAUDE_PID`), and otherwise the command is judged as a new session that none of the running ones is. `--cwd` sets the working directory (default: the current one) and `--timeout` the tool call's timeout in milliseconds, which wait-guard reads. `--json` prints `{ command, cwd, session, blocked, guards: [{ guard, status, rule, evidence, message, allowOnce, config, disable }] }`. The exit code is 0 whether the command passes or not; 1 means bad arguments.

## bulkhead allow

```
bulkhead allow <code>
bulkhead allow --list [--json]
```

Run this yourself, in your own terminal. Every block message ends with a short code: ``If the user wants this on purpose, ask them to run `bulkhead allow 7F3K` in their own terminal (allows it once), or set {...} in .claude/bulkhead.json.`` After `bulkhead allow 7F3K`, the agent's next identical tool call (the same command text, run from the same folder) passes the guard that blocked it, once. The hook deletes the approval when it uses it, so a second run is blocked again with a new code.

```
$ bulkhead allow 5CNWZ
Allowed once: pkill -f node
  folder /tmp
  guards kill-guard pkill
The agent can run exactly that command now, once, within 10 min.
$ bulkhead allow --list
CODE   STATE    GUARD       RULE   FOLDER  COMMAND        BLOCKED   LEFT
5CNWZ  waiting  kill-guard  pkill  /tmp    pkill -f node  just now  10 min
```

- A code is valid for `allowOnce.ttlMinutes` (default 10) after the block, and an approved command for as long again after you approve it. Expired and unreadable entries are deleted when the state is read.
- When several guards block one command, they share one code, and `bulkhead allow` approves all of them.
- The state is one small JSON file per guard in `~/.claude/bulkhead/allow/` (`$BULKHEAD_STATE_DIR/allow/`), written atomically. A corrupt file is ignored and deleted: the block stays, the hook never fails because of it.
- The agent cannot approve its own blocks. The `basics` rule `self-allow` (on by default) blocks any Bash or PowerShell call that runs `bulkhead allow`, `claude-bulkhead allow`, `bulkhead-cli allow`, `node .../bin/bulkhead allow`, `npx claude-bulkhead allow` and the like, through `bash -c`, `eval`, `env`, `sudo`, subshells and other wrappers, and any call that writes into the allow folder with a redirect, `tee`, `cp`, `mv`, `sed -i`, `touch` or a script. It never offers a code itself, and `bulkhead explain` shows it as not allowable. This is a guardrail against mistakes, not a sandbox: an agent that is determined to run arbitrary code has other ways to write files, which is why the approval has to come from you.
- Run it in a terminal. Claude Code's `!` shell mode is not documented as running `PreToolUse` hooks, so bulkhead does not rely on it: use your own terminal, or the terminal pane in your editor.

## bulkhead port

```
bulkhead port [--near PORT] [--json]
bulkhead port --stable [--name NAME] [--range 3000-3999] [--json]
```

Prints the first port at or above `PORT` (default 3000) that nothing listens on, and nothing else, so it can be used inline:

```
npm run dev -- --port $(bulkhead port --near 3000)
```

A port counts as free only when it can be bound on `127.0.0.1`, `0.0.0.0`, `::1` and `::`; on Windows a server on one of these does not stop a bind on another. Ports that browsers refuse to open (such as 5060, 6000 and 6665 to 6669) are skipped. It tries 1000 ports and exits 1 when none is free. No process scan is needed, so it answers in well under a second.

`--stable` gives each git worktree a port of its own that is the same every time. The start port is taken from the SHA-1 of the worktree's root folder (the first four bytes as a number, modulo the size of the range, plus its start; lower case on Windows), or of `--name` when you give one. If something is listening there, it tries the next port in a fixed order (upward, wrapping inside the range, browser-blocked ports skipped), so the answer only changes while a port is taken. When it skips a port it says on stderr which session holds it:

```
$ bulkhead port --stable
bulkhead port: 3417 is in use by session 18672 in ~/src/acme-web on branch main; using 3418
3418
```

With `--json`: `port`, `preferred` (the first port of the sequence), `range`, `root`, `name` and `skipped` (each with `port`, `pid`, `name` and `session`). Two worktrees of one repository get different ports, so `npm run dev -- --port $(bulkhead port --stable)` in each never collides. It exits 1 when the range is full or `--range` is not `LOW-HIGH` between 1024 and 65535.

port-guard's block messages suggest the current worktree's stable port when the folder is in a git tree (and the next free port otherwise).

## bulkhead worktree

```
bulkhead worktree add <name> [--base REF] [--path DIR] [--install|--no-install] [--json]
bulkhead worktree list [--json]
bulkhead worktree prune [--merged-into REF] [--older-than 7d] [--yes] [--json]
```

checkout-guard suggests a worktree when another live session works in your tree. A bare `git worktree add` leaves you without `.env` files and `node_modules`, and with the same dev server port as the main checkout. `bulkhead worktree` does the setup and the cleanup.

### add

Creates `../<repo>-<name>` (or `--path`) on a new branch `<name>` from `--base` (default: the current HEAD). It refuses when the folder or the branch exists, and then changes nothing. A name like `feat/x` gives the folder `<repo>-feat-x`. Run from a linked worktree it still names the folder after the main checkout. Then, in order:

1. **Copies untracked files.** With a `.worktreeinclude` in the project root, the files it matches. It is the file Claude Code reads for its own worktrees: gitignore syntax, and only files that are also gitignored are copied. Without it, a safe default set from the project root: `.env`, `.env.*` (not `.env.example`, `.sample`, `.template` or `.dist`), `.envrc`, `.tool-versions`, `.nvmrc`, unless they are tracked. Either way it never copies `node_modules`, build output (`dist`, `build`, `.next`, `target` and similar), links, or any file over 5 MB; each file left out is printed with the reason.
2. **Installs dependencies** in the foreground when a lockfile exists and its package manager is on `PATH` (`--install` forces it and makes a missing lockfile or tool an error, `--no-install` skips it). The `packageManager` field of `package.json` decides when several lockfiles exist; otherwise: `bun.lock`/`bun.lockb` runs `bun install --frozen-lockfile`, `pnpm-lock.yaml` runs `pnpm install --frozen-lockfile`, `yarn.lock` runs `yarn install --immutable` (Yarn 2+, found by `.yarnrc.yml`) or `yarn install --frozen-lockfile`, `package-lock.json` runs `npm ci`. Output is summarized to one line, or the last 12 lines when it fails. `node_modules` is never symlinked, because tools resolve real paths and break on links.
3. **Assigns a stable port.** The same worktree path always starts at the same port in 3000 to 3999 (sha1 of the absolute path modulo 1000, then forward to the first port nothing listens on) and `PORT=<n>` is written to the worktree's `.env.local`, only when that file has no `PORT` yet (a copied `.env.local` keeps its own).
4. Prints the next step: `cd <path> && claude`.

```
$ bulkhead worktree add fix-login
created ~/dev/shop-fix-login on new branch fix-login from HEAD
copied .env (default set)
pnpm install --frozen-lockfile: done in 14.2s
wrote PORT=3800 to .env.local
next: cd ~/dev/shop-fix-login && claude
```

`--json` prints `path`, `branch`, `copied`, `skipped`, `install`, `port`, `portWritten` and `next`. The exit code is 1 when the worktree could not be made, or when an install failed (the worktree is kept).

### list

Every worktree of this repository with its branch, the age of its last commit, `clean`, `dirty` or `missing`, commits ahead and behind the default branch (`origin/HEAD`, else `main` or `master`), the live Claude Code session that works in it (a session belongs to the deepest worktree around its working directory) and the `PORT` in its `.env.local`.

```
PATH                  BRANCH       AGE  STATE  VS origin/main  SESSION   PORT
~/dev/shop            main (main)  2h   clean  +0/-0           pid 4181  -
~/dev/shop-fix-login  fix-login    3d   clean  +2/-0           -         3800
```

### prune

Lists the worktrees that are safe to remove, and removes them only with `--yes`. A worktree is safe when all of these hold, and the others are printed with the reason they are kept:

- its branch is merged into `--merged-into` (default: the default branch) and has commits or is older than `--older-than`; a branch nobody has committed to yet is never called merged unless `--older-than` is given and met (`7d`, `12h`, `2w`, `30m`; last commit or last change to the folder, whichever is newer),
- no uncommitted changes, no untracked files besides copied env files, and no ignored files besides rebuildable ones (`node_modules`, build output, caches, logs and the env files); an untracked env file counts only when it is identical to the main checkout's, or is the `PORT=` line this command wrote,
- no live session works in it, and you are not standing in it,
- it is not the main worktree, not locked, not missing, not a detached HEAD.

With `--yes` it runs `git worktree remove <path>` (never `--force`) and then `git branch -d <branch>` (never `-D`); when git refuses, that worktree is reported and kept. Live sessions are read again right before each removal, and if they cannot be read at all nothing is removed. This path does not go through checkout-guard, so it checks sessions itself, the same way checkout-guard's `remove-session-dir` rule does.

## bulkhead reap

```
bulkhead reap [--dry-run] [--json]
```

Runs [orphan-reaper](guards/orphan-reaper.md) now, over every Claude Code session that has exited. It stops their dev servers and anything else listening, test runners and their workers, watchers, builders and automation browsers that were started from a Claude tool shell, and records each stop in the event log with `trigger: "manual"`. It runs even when orphan-reaper is turned off for the hooks.

`--dry-run` stops nothing and prints, for each tree, the process that matched, its rule, why its session counts as exited, and how many processes would go:

```
would stop 30112  test-runner  node ~/src/acme-web/node_modules/vitest/dist/workers/forks.js
  Vitest and its worker pool (tinypool); its session has exited and removed snapshot-bash-1791860359256-ezwkie.sh; 6 processes from 30080
1 tree would be stopped. Run `bulkhead reap` to stop it.
```

`--json` prints `{ supported, dryRun, orphans: [{ pid, name, rule, what, why, owner, top, pids, command }] }`, where `pids` lists every process in the tree. A run inside a live session never touches that session's own processes. Exit code 1 means the process table could not be read or the platform is not supported.

## bulkhead-slot

```
bulkhead-slot run [--gb=N] [--wait=MINUTES] [--label=TEXT] -- <command...>
bulkhead-slot status [--gb=N]
```

`bulkhead slot ...` is the same. `run` waits until the machine has room for a job of N GB (default 3), runs the command, and releases the slot when it exits, fails or is interrupted. The exit code is the command's; 3 means it gave up waiting after `--wait` minutes (default 30). While it waits, the job is listed in `bulkhead status` and `bulkhead top` with the reason.

## bulkhead remote

```
bulkhead remote run [--remote=NAME] [--gb=N] [--wait=MINUTES] [--files=a,b] [--tail=N]
                    [--fetch=PATH,...] [--label=TEXT] [--project=NAME] -- <command...>
bulkhead remote fetch <path> [<local dir>] [--copy=LETTER] [--remote=NAME] [--project=NAME]
bulkhead remote status [--remote=NAME] [--json]
bulkhead remote list [--json]
bulkhead remote add <name> <user@host> [--shell=CMD] [--dir=PATH] [--copies=N] [--max-jobs=N]
                    [--min-free-gb=N] [--ssh-option=KEY=VALUE]... [--default] [--no-check]
bulkhead remote remove <name>
```

Optional. `run` sends the repository's `HEAD` commit and uncommitted changes to another machine, runs the command there in a copy of its own with `BULKHEAD_PORT` and `BULKHEAD_COPY` set, stops what the command left running, and passes its exit code back. 3 means no free copy, job slot or RAM within `--wait` minutes (default 60), 4 a failed transfer or setup, 5 an unreachable remote. `--tail=N` keeps the full output in `<state dir>/remote-logs/` and prints the last N lines.

```
$ bulkhead remote run --tail=20 -- npm test
[bulkhead remote] buildbox: 3f2a1c9 already there, 3 changed files (24 KB), 1 deleted
[bulkhead remote] buildbox  copy a  /home/dev/bulkhead-remote/acme-web-3f9a1c  port 7172
[bulkhead remote] last 20 lines of output; full log: ~/.claude/bulkhead/remote-logs/20261013-141502-acme-web-3f9a1c.log
...
[bulkhead remote] exit 0 after 1m 12s (copy a)
```

Setup, every option, how copies, locks and ports work, Windows remotes and security are in [remote.md](remote.md).
