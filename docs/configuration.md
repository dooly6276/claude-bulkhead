# Configuration

Every guard works without configuration. When one gets in the way of a project, change that one setting for that project instead of turning the guard off everywhere.

## Where settings come from

From lowest to highest priority:

1. Built-in defaults, with the [preset](#presets) layered over them (`"preset"` in a file, or `BULKHEAD_PRESET`).
2. The global file, `~/.claude/bulkhead/config.json` (`$BULKHEAD_STATE_DIR/config.json` when that variable is set).
3. The project file, `.claude/bulkhead.json` in the project. It is looked up from the project directory (`CLAUDE_PROJECT_DIR`, else the working directory) upward, and the search stops at the first folder that contains `.git` or at the home directory. A key set here replaces the same key from the global file; lists are replaced, not merged.
4. Environment variables. They always win. Set them in the `env` block of `~/.claude/settings.json` to apply them to every session.

`bulkhead config` prints the value of every key and which of these it came from.

Both files are plain JSON (no comments) with one object per section. [`config.example.json`](../config.example.json) at the repository root sets every key:

```json
{
  "killGuard": { "allowNames": ["ffmpeg"], "extraSharedNames": ["postgres"] },
  "portGuard": { "ignorePorts": [9229] },
  "basics": { "protectedBranches": ["main", "master", "release"] }
}
```

## Presets

A preset changes the defaults of many keys at once. It sits between the built-in defaults and the files, so any key you set yourself, in either file or in an environment variable, still wins.

```
bulkhead config --preset quiet            # for every project
bulkhead config --preset strict --project # for this project only
```

This writes `"preset": "quiet"` (or `"normal"`, `"strict"`) at the top level of the global file, or with `--project` of `.claude/bulkhead.json`, and keeps every other key. A project preset wins over the global one, and `BULKHEAD_PRESET` wins over both. `bulkhead config` and `bulkhead doctor` show the active preset, and `bulkhead config` marks every value that comes from it as `preset NAME`.

| Preset | What it sets |
|---|---|
| `normal` | The defaults below. Nothing changes. |
| `quiet` | Only the guards that protect one session from another, and the rules that cannot be undone. Stays on: kill-guard, port-guard, checkout-guard, memory-guard, orphan-reaper, and in basics `rmRoot`, `forcePushMain` and `selfAllow`. Turned off: `waitGuard.enabled`, `diskGuard.enabled`, `basics.discardChanges`, `basics.agentAuthor`. |
| `strict` | Everything on, with tighter limits: `waitGuard.limitSeconds` 60 (default 180); `memory.minFreeGb` 20% of RAM, at most 5 GB (default 15%, at most 3 GB); `memory.slotFloorGb` 35% of RAM, at most 8 GB (default 25%, at most 5 GB); `memory.maxCommitPct` 65 (default 75, Windows); `basics.protectedBranches` `["main", "master", "develop", "release", "production"]`; `secretsGuard.enabled` true (default false). |

The limits scale with the RAM of the machine, so a small laptop is not locked out of every build. To keep one strict value and relax another, set the key: `{ "preset": "strict", "waitGuard": { "limitSeconds": 120 } }`.

## Broken files

A file that is not valid JSON is ignored as a whole, and every guard keeps the values it would have without that file. Nothing is blocked because of a typo, and nothing is turned off either. At the start of each session, Claude Code shows one notice:

```
[bulkhead] config problem, defaults are used where it applies:
  ~/.claude/bulkhead/config.json is not valid JSON (Expected double-quoted property name in JSON at position 41); it is ignored until fixed
Run `bulkhead config` or `bulkhead doctor` to check.
```

An unknown key, or a value of the wrong type, is dropped on its own with a warning; the rest of the file still applies. `bulkhead config` and `bulkhead doctor` list every warning.

## Keys

### killGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns kill-guard on or off |
| `allowNames` | list of names | `[]` | Names taken off the shared list, so killing them by name passes. `ffmpeg` and `ffmpeg.exe` are the same name |
| `extraSharedNames` | list of names | `[]` | More names that must not be killed by name, such as `postgres` or `redis-server` |

The built-in shared list is: node, python, python3, py, pythonw, ruby, java, javaw, dotnet, chrome, chromium, chrome-headless-shell, msedge, firefox, bash, sh, zsh, powershell, pwsh, cmd, conhost, git, ssh, sshd, code, claude, npm, npx, pnpm, yarn, deno, bun, tsx, ts-node, gradle, adb, ffmpeg, docker, vitest, jest, next, vite, esbuild, webpack.

### waitGuard

| Key | Type | Default | Environment | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | `true` | | Turns wait-guard on or off |
| `limitSeconds` | number | `180` | `BULKHEAD_WAIT_MAX_SEC` | Longest foreground wait allowed |

### memoryGuard and memory

| Key | Type | Default | Environment | Meaning |
|---|---|---|---|---|
| `memoryGuard.enabled` | boolean | `true` | | Turns memory-guard on or off |
| `memoryGuard.autoQueue` | boolean | `false` | | Instead of blocking a heavy command, rewrite it to run through `bulkhead-slot` so every session waits in one line. See [auto-queue](commands.md#auto-queue) |
| `memoryGuard.estimatesGb` | object | built in | | RAM in GB assumed per program when auto-queueing, for example `{ "gradle": 6, "cargo": 8 }` |
| `memoryGuard.waitMinutes` | number | `10` | | How long an auto-queued command waits for room before it gives up (exit code 3) |
| `memoryGuard.subagents` | boolean | `false` | | Block starting a new subagent (the `Agent` tool) while memory pressure is critical |
| `memory.minFreeGb` | number | 3, or 15% of RAM if less | `BULKHEAD_MIN_FREE_GB` | Free RAM below which memory-guard blocks heavy commands, and the first bulkhead-slot job waits |
| `memory.slotFloorGb` | number | 5, or 25% of RAM if less | `BULKHEAD_SLOT_FLOOR_GB` | RAM bulkhead-slot keeps free when it starts a second job |
| `memory.maxCommitPct` | number | `75` | `BULKHEAD_MAX_COMMIT_PCT` | Windows only: commit charge above which bulkhead-slot holds a second job |

`bulkhead doctor` shows the values computed for the machine it runs on.

Critical memory pressure for `memoryGuard.subagents` means macOS `kern.memorystatus_vm_pressure_level` 4, Linux `/proc/pressure/memory` with `full avg10` at 10 or more (or `some avg10` at 50 or more), or Windows with less than 8% of physical memory free. The reading is cached for 5 seconds.

### portGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns port-guard on or off |
| `ignorePorts` | list of port numbers | `[]` | Ports port-guard never checks, for starting a server or for a kill by port. Useful for a port every session shares on purpose, such as a debugger on 9229 |

### checkoutGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns checkout-guard on or off |
| `stageAll` | boolean | `true` | `git add -A`, `git add .` and `git commit -a` in a tree another live session works in |
| `removeSessionDir` | boolean | `true` | `rm -rf` and `git worktree remove` on a folder another live session works in |

### diskGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns disk-guard on or off |

### basics

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns all the rules on or off |
| `protectedBranches` | list of branch names | `["main", "master"]` | Branches the force-push rule protects |
| `rmRoot` | boolean | `true` | `rm -rf` and its PowerShell and cmd forms at a root, a top-level folder such as `/srv`, the home directory, a folder directly in it (caches excepted), or a folder above the repository |
| `forcePushMain` | boolean | `true` | `git push --force` to a protected branch. `--force-with-lease` always passes |
| `discardChanges` | boolean | `true` | `git reset --hard` or `git clean -fd` that would lose uncommitted work |
| `agentAuthor` | boolean | `true` | Commits authored as Claude or Anthropic: `--author`, `git config user.name/user.email`, `GIT_AUTHOR_*` |
| `selfAllow` | boolean | `true` | The agent running `bulkhead allow` or writing the allow state files, which would let it approve its own blocks. Leave it on: [allow once](commands.md#bulkhead-allow) is only worth anything while the user is the one who approves |

### allowOnce

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ttlMinutes` | number | `10` | Minutes a code from a block message stays valid, and how long an approved command can still be run once after `bulkhead allow <code>` |

### editGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns edit-guard on or off |
| `mode` | `"warn"`, `"ask"` or `"block"` | `"warn"` | What happens when another live session edited the file lately. `warn` lets the edit through and tells the agent, `ask` shows the note to you in the permission prompt, `block` stops the edit |
| `windowMinutes` | number | `30` | How recent the other session's edit must be |

### secretsGuard

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Turns secrets-guard on. It is off by default; the `strict` preset turns it on |
| `extraPatterns` | list of patterns | `[]` | More files to keep out of the conversation: a file name (`*.token`) or a path pattern (`~/vault/**`, `config/prod/*`) |
| `allow` | list of patterns | `[]` | Files to let through although they look secret, by the same patterns (`.env.test`, `fixtures/*.pem`) |

### orphanReaper

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns orphan-reaper on or off |
| `onSessionEnd` | boolean | `true` | Also reap right after a session exits. `false` leaves only the pass when a session starts |
| `extraNames` | list of program names | `[]` | More programs to stop once the session that started them has exited, such as `["my-server"]`. Matched without `.exe`, ignoring case |
| `keepNames` | list of program names | `[]` | Programs never to stop, nor anything they started, such as `["mongod"]` |
| `keepPatterns` | list of text | `[]` | Text that keeps a process when it appears in its command line, such as `["my-tunnel.sh"]`, case ignored. A project file applies to the passes run by that project's sessions; `BULKHEAD_KEEP=1` on the command works for any project |

The built-in rules and keep list are in [guards/orphan-reaper.md](guards/orphan-reaper.md#what-it-stops).

### sessionState

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Turns the session state hooks off. `status` and `top` then show `-` in the STATE column |

### notify

| Key | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | none (off) | A command run when a session starts waiting for you or needs a permission. Global config file only; a project file cannot set it, so a repository cannot make your machine run a command |
| `minIntervalSeconds` | number | `30` | The least time between two notifications for the same session |

The command runs through the shell, detached, with output discarded, so it never blocks Claude Code. It gets `BULKHEAD_SESSION_PROJECT`, `BULKHEAD_SESSION_STATE` (`waiting` or `permission`) and `BULKHEAD_SESSION_PID`. Examples for macOS, Linux and Windows are in [commands.md](commands.md#session-state-and-notifications).

### log

| Key | Type | Default | Environment | Meaning |
|---|---|---|---|---|
| `enabled` | boolean | `true` | `BULKHEAD_NO_LOG=1` turns it off | Writes each block to `events.jsonl` for `bulkhead log` |

### remote and remotes

Global file only. A project's `.claude/bulkhead.json` that sets either of these is ignored with a warning, because a repository you clone must not be able to make you connect to a machine or pass ssh options. Edit them with `bulkhead remote add` and `bulkhead remote remove`, or by hand.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `remote.default` | remote name | none | The remote `bulkhead remote run` uses when several are configured and `--remote` is not given |
| `remotes` | object | `{}` | One entry per machine, by name (letters, digits, `.`, `_`, `-`) |

Each entry in `remotes`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | required | `user@host`, or a host alias from `~/.ssh/config`. May not start with `-` |
| `shell` | string | `"bash"` | The program that runs bulkhead's script there, fed on stdin with `-s`. A Windows remote with Git Bash: `"C:\Program Files\Git\bin\bash.exe"` |
| `dir` | string | `"~/bulkhead-remote"` | Folder for the copies, locks and port blocks. On Windows, `"C:/bulkhead-remote"` |
| `copies` | whole number, 1 to 8 | `4` | Copies of each project, so at most this many jobs of one project at once |
| `maxJobs` | whole number, 1 to 64 | `4` | Jobs at once on that machine, across all projects |
| `minFreeGb` | number | `0` | Free RAM to keep there. A job waits while its `--gb` would take free RAM below this |
| `sshOptions` | list of strings | `[]` | `ssh -o` options, each `Key=value`: `"IdentityFile=~/.ssh/buildbox"`, `"Port=2222"`, `"HostKeyAlias=buildbox"` |

```json
{
  "remotes": {
    "buildbox": { "host": "dev@192.168.1.20", "sshOptions": ["IdentityFile=~/.ssh/buildbox"], "minFreeGb": 2 },
    "winbox": { "host": "dev@192.168.1.30", "shell": "C:\Program Files\Git\bin\bash.exe", "dir": "C:/bulkhead-remote" }
  },
  "remote": { "default": "buildbox" }
}
```

An entry with a problem (a missing `host`, an unknown key, a value of the wrong type) is dropped as a whole with a warning, so a typo never means connecting with the wrong key. See [remote.md](remote.md).

## Environment variables

| Variable | Same as |
|---|---|
| `BULKHEAD_DISABLE` | Comma-separated names to turn off: `kill-guard`, `wait-guard`, `memory-guard`, `port-guard`, `checkout-guard`, `disk-guard`, `basics`, `edit-guard`, `secrets-guard`, `orphan-reaper`, `session-state`, the basics rules `rm-root`, `force-push-main`, `discard-changes`, `agent-author`, `self-allow`, or `all`. A name listed here is off whatever the files say |
| `BULKHEAD_PRESET` | The preset: `quiet`, `normal` or `strict`. Wins over the `preset` key in the files |
| `BULKHEAD_WAIT_MAX_SEC` | `waitGuard.limitSeconds` |
| `BULKHEAD_MIN_FREE_GB` | `memory.minFreeGb` |
| `BULKHEAD_SLOT_FLOOR_GB` | `memory.slotFloorGb` |
| `BULKHEAD_MAX_COMMIT_PCT` | `memory.maxCommitPct` |
| `BULKHEAD_NO_LOG` | `log.enabled: false` when set to `1`, `true` or `yes` |
| `BULKHEAD_STATE_DIR` | Where slots, the event log, `guards.log`, `remote-logs/` and the global config file live. Default `~/.claude/bulkhead` |
| `BULKHEAD_SSH` | The command `bulkhead remote` runs instead of `ssh`, as a JSON array such as `["ssh", "-F", "/path/to/config"]`. The tests point it at `test/fake-ssh.js` |

## Examples

A project that encodes video and kills its own stuck ffmpeg runs by name, and deploys from a `release` branch:

```json
{
  "killGuard": { "allowNames": ["ffmpeg"] },
  "basics": { "protectedBranches": ["main", "release"] }
}
```

A machine with 64 GB that should keep more headroom before a second heavy job:

```json
{
  "memory": { "minFreeGb": 6, "slotFloorGb": 12 }
}
```

A project whose integration tests legitimately wait up to five minutes in the foreground:

```json
{
  "waitGuard": { "limitSeconds": 300 }
}
```
