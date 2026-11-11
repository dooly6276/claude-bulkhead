# kill-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Runs before every Bash and PowerShell call. It stops an agent from killing a program by name when other sessions, subagents or you are running the same program.

## Why

On a machine with several sessions, `node`, `python` and `chrome` belong to many owners at once. An agent asked to restart its own dev server often reaches for the shortest command, and the shortest command kills everyone's. See [#13941](https://github.com/anthropics/claude-code/issues/13941), [#34754](https://github.com/anthropics/claude-code/issues/34754), [#43225](https://github.com/anthropics/claude-code/issues/43225) and [#53229](https://github.com/anthropics/claude-code/issues/53229).

## Blocked

Commands that kill a shared program by name or by filter:

```
taskkill /F /IM node.exe
taskkill /F /FI "IMAGENAME eq python.exe"
Stop-Process -Name node -Force
Get-Process node | Stop-Process
pkill node
pkill -9 -f python
killall chrome
kill $(pgrep node)
ps aux | grep node | xargs kill
wmic process where name="node.exe" delete
```

These are blocked too:

```
pkill -s KILL -u $USER node                          # options that take a value are skipped
killall node python                                  # every name is checked
for pid in $(pgrep node); do kill $pid; done         # a name lookup that feeds a kill
ps aux | grep [n]ode | awk '{print $2}' | xargs kill
taskkill /F /IM node* /IM python.exe                 # wildcards and several /IM
Stop-Process -Name node,python
Get-Process node* | Stop-Process
(Get-Process node).Kill()
Get-Process | Where-Object { $_.Name -eq 'node' } | Stop-Process
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Invoke-CimMethod -MethodName Terminate
```

Wrappers are opened up to three levels deep: `bash -c`, `sh -c`, `zsh -c`, `powershell -Command`, `pwsh -c`, `powershell -EncodedCommand`, `cmd /c`, `eval`, `trap`, `watch`, `su -c`, `Start-Process`, and prefixes such as `env VAR=x`, `VAR=value`, `sudo`, `nohup`, `time`, `nice`, `timeout N` and `xargs`. So `sudo pkill node` and `cmd /c "taskkill /F /IM node.exe"` are blocked as well.

Shared programs include (besides those below) `node`, `python`, `python3`, `py`, `ruby`, `java`, `dotnet`, `chrome`, `chromium`, `msedge`, `firefox`, `bash`, `sh`, `zsh`, `powershell`, `pwsh`, `cmd`, `git`, `ssh`, `code`, `claude`, `npm`, `npx`, `pnpm`, `yarn`, `deno`, `bun`, `tsx`, `gradle`, `adb`, `ffmpeg`, `docker`, `Docker Desktop`, `electron`, `Code Helper`, `cursor`, `Cursor Helper`, `Simulator`, `Xcode`, `postgres`, `vitest`, `jest`, `next`, `vite`, `esbuild` and `webpack`, with or without `.exe`.

Dev servers, tools and browsers are on the shared list by the names they show in `ps` and Activity Monitor, so `pkill next-server`, `pkill -f next-router-worker`, `pkill uvicorn`, `pkill gunicorn`, `pkill -f "rails s"`, `pkill -f "flask run"`, `pkill expo`, `pkill -f metro`, `pkill tsc`, `pkill -f playwright`, `pkill "Google Chrome"` and `pkill -f "node.*next"` are blocked. A version counts as the same name (`node22`, `nodejs`, `python3.11`), and a part of a name reaches it the way pkill's regular expression does (`pkill ode`, `pkill -f dev`, `pkill -f server`). `pkill -f "next dev|playwright"` is read alternative by alternative.

Kills hidden behind another shell are read too:

```
echo "pkill node" | sh                 # also printf, bash, zsh, source <(...), bash <(...), eval "$(echo ...)"
echo node | xargs pkill                # the name comes from the pipe; also xargs -n1 pkill <<< node
busybox pkill node
function k() { pkill node; }; k        # a function body is read where it is defined
tmux new -d 'pkill node'               # also tmux run-shell, tmux send-keys, screen -dmS x ..., script -q /dev/null ...
parallel pkill ::: node
cmd=pkill; $cmd node                   # a variable that holds the program
python3 -c "import os; os.system('pkill node')"   # string literals handed to a shell by python, node, perl, ruby, php
ssh localhost 'pkill node'             # localhost, 127.0.0.1 and ::1 are this machine
```

A heredoc is read as shell code only when a shell reads it (`bash <<E`, `cat <<E | sh`, `ssh localhost bash <<E`). A heredoc that `cat`, `wc`, a loop, `node test.js` or another program reads is data, so `while read c; do echo "$c"; done <<'E'` over a body of `pkill node` passes. A body that python or node reads is code in their language: only the string literals it hands to a shell are read. The same rule applies to every guard.

## Only while another session is alive

These are blocked only when another Claude Code session is running on the machine, so a person working with one session is never asked. Each has its own switch (see below).

| Rule | Blocked |
|---|---|
| `mass-kill` | `pkill -u $USER`, `killall -u kms`, `kill -9 -1`, `kill -9 0` |
| `docker-mass` | `docker rm -f $(docker ps -aq)`, `docker stop $(docker ps -q)`, `docker ps -q \| xargs docker stop`, `docker system prune -af`, `docker volume prune`, `pm2 kill`, `pm2 delete all`, `docker compose down` in a folder another session works in |
| `device-kill` | `adb kill-server`, `adb emu kill` (without `-s`), `xcrun simctl shutdown all`, `simctl erase all` |
| `app-quit` | `osascript -e 'quit app "Safari"'`, `pkill Slack`, `killall Finder`, `killall Dock`, `pkill tmux`, `pkill -f CoreSimulator`, Terminal, iTerm2, Spotify, Figma, Notion, Discord, zoom, WebKit, Visual Studio Code |
| `service-stop` | `brew services stop postgresql@16`, `launchctl bootout gui/501/homebrew.mxcl.redis`, `launchctl kickstart -k ...`, `systemctl stop postgresql`, `pkill redis-server`, `pkill mongod`, `pkill nginx`, `pkill caddy`, `pkill ngrok` |

`docker stop web`, `docker ps -q --filter name=shop-`, `adb -s emulator-5554 emu kill`, `xcrun simctl shutdown <UDID>`, `brew services stop my-own-thing` and `pm2 restart my-api` name one thing and pass.

## Another session's PID or pattern

`kill 83185`, `kill -9 83185`, `taskkill /PID 83185` and `Stop-Process -Id 83185` are checked when the PID is a literal: if it belongs to another live session (its dev server, a build in its tree, or its own claude process), the command is blocked and names the owner. Your own session's processes pass; killing your own claude PID does not.

`pkill -f <pattern>` with a specific pattern (a name followed by a flag, a number, a path or a host, such as `pkill -f "ssh -N -L 9333"` or `pkill -f server.js`) passes the name check, then is matched against the command lines of other sessions' processes. It is blocked only if it would reach one. `pkill -fx "node /srv/app/server.js"` is matched whole.

The process table is read once per call, only for these commands, and never for `ls`, `npm test` or `kill $PID`. If it cannot be read, the command passes.

## Allowed

```
kill 24632
taskkill /PID 24632 /T /F
Stop-Process -Id 24632
lsof -ti :3000 | xargs kill            # by port, unless another session owns it (port-guard)
fuser -k 3000/tcp
pkill -f ~/src/acme-web/server.js      # by project path or script file
taskkill /IM qemu-system-x86_64.exe    # a name nobody else shares
kill -0 24632                          # signal 0 only checks
pkill -f "ssh -N -L 9333"               # a specific pattern that no other session's process matches
pgrep -f "$PWD/server.js" | xargs kill # a lookup scoped to your own script path
Get-Process node | Where-Object { $_.Path -like '*\acme-web\*' } | Stop-Process   # filter by Id, CommandLine or Path
ssh build-host "pkill node"            # runs on another machine
docker exec web pkill node             # runs inside a container (also kubectl, podman exec)
```

Kill commands inside `echo`, `grep`, `git` or `cat` text, inside a heredoc written to a file, and inside commit, pull request and release text (`-m`, `--message`, `--title`, `--body`, `--notes`, `-F` with a heredoc) are not executed and pass.

## What Claude sees

Two lines: what was blocked, and the exact alternative. When a live session is involved, it is named by project folder and PID.

```
[bulkhead] kill-guard: pkill/killall matches every process with that name.
Stop only what you started: kill <your own pid> (lsof -ti :<port> or pgrep -af '<your project dir>' finds it), or pkill -f '<your project dir>'.
```

```
[bulkhead] kill-guard: PID 83185 (node) belongs to the Claude session ~/dev/shop (pid 700).
Stop only what you started: kill <your own pid> (lsof -ti :<port> or pgrep -af '<your project dir>' finds it), or pkill -f '<your project dir>'.
```

On Windows the second line is `taskkill /PID <your own pid> /T /F`, with `netstat -ano | findstr :<port>` and `Get-CimInstance Win32_Process` to find it. Docker, device, app and service blocks name their own alternative, such as `docker stop <your container>` or `adb -s <your device> emu kill`.

## Turn off or tune

- `BULKHEAD_DISABLE=kill-guard`, or `"killGuard": { "enabled": false }` in a config file, turns it off.
- `killGuard.allowNames` takes names off the shared list, so killing them by name passes, for example `["ffmpeg"]`.
- `killGuard.extraSharedNames` adds names that must not be killed by name, for example `["redis-server", "mysqld"]`.
- `killGuard.massKill`, `dockerMass`, `deviceKill`, `appQuit`, `serviceStop` and `ownerCheck` turn the rules of the two sections above off one by one. `BULKHEAD_DISABLE=mass-kill,docker-mass` works too.

See [configuration](../configuration.md).

## Limits

- A program missing from the shared list is not protected. Add it with `killGuard.extraSharedNames`.
- It reads command text. A kill inside a script file or an alias is not seen, and `npm run stop` or `make kill` whose script runs a kill by name is not opened. Only string literals that python, node, perl, ruby or php hand to a shell are read. Wrappers nested more than three levels deep are not opened.
- Whether a session is another session comes from the process table and `~/.claude/sessions`: a kill of a process that no live session started (yours, the system's, a daemon) is never called another session's.
