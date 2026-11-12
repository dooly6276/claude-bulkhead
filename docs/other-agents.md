# Codex, Gemini and other agents

[Back to README](../README.md)

The cross-session problems bulkhead guards against (one agent killing another's dev server, two agents in one checkout, a heavy build while another is running) do not depend on which agent you use. If you run Codex, Gemini CLI, Copilot CLI, Cursor, opencode, Amp, Cline, Droid, Windsurf or Devin next to Claude Code on one machine, bulkhead can guard their shell commands with the same guards, and it counts their sessions when it decides who owns a process, a port or a folder.

Two pieces:

- `bulkhead hook --agent <name>` is the guard entry for one agent. The agent calls it before each shell command; it maps that agent's payload to the shape the guards read, runs the same guards as the Claude Code hook, in the same order ([kill-guard](guards/kill-guard.md), [wait-guard](guards/wait-guard.md), [memory-guard](guards/memory-guard.md), [port-guard](guards/port-guard.md), [checkout-guard](guards/checkout-guard.md), [disk-guard](guards/disk-guard.md), [basics](guards/basics.md), and [secrets-guard](guards/secrets-guard.md) when it is on), and answers in that agent's block format. Any error lets the command through. One process runs them all.
- `bulkhead setup <agent>` prints, or with `--write` merges, the config that registers it.

```
$ bulkhead setup codex
# /home/me/.codex/hooks.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/node /home/me/.claude/plugins/cache/bulkhead/bulkhead/0.3.0/bin/bulkhead hook --agent codex",
            "timeout": 30,
            "statusMessage": "bulkhead guards"
          }
        ]
      }
    ]
  }
}
# Codex asks you to review a new hook once: open /hooks in Codex and trust it.

$ bulkhead setup codex --write
updated /home/me/.codex/hooks.json
backup of the original: /home/me/.codex/hooks.json.bulkhead-backup
```

`--write` copies the original to `<file>.bulkhead-backup` first, keeps everything else in the file, and does nothing when bulkhead is already there, so it is safe to run again (run it again after you change your Node install, because the command holds the absolute path of the `node` that ran the setup). A config file that is not plain JSON (for example with comments) is never rewritten: setup prints the snippet and tells you to add it by hand. A file bulkhead does not own, such as an existing Cline `PreToolUse.sh`, is never replaced.

## As a plugin: Copilot CLI, Cursor, opencode, Gemini CLI, Codex

These five can load bulkhead as a plugin instead. The plugin calls the same `bulkhead hook --agent <name>` from its own copy of the package, so nothing is written to your config files and `npm install -g` is not needed. Node 18 or later must be on the agent's `PATH`; if `node` cannot be found the hook does not run (Copilot CLI turns a hook that fails to start into a denial, so it would refuse shell commands until `node` is found).

| Agent | Install | Files in this repository |
|---|---|---|
| Copilot CLI | `copilot plugin marketplace add dooly6276/claude-bulkhead`, then `copilot plugin install bulkhead@bulkhead` | `plugin.json` (Agent Plugins 1.0.0 manifest), `com.github.copilot/hooks/hooks.json` (`preToolUse`, `bash` and `powershell`, root from `${PLUGIN_ROOT}`) |
| Cursor | `git clone https://github.com/dooly6276/claude-bulkhead ~/.cursor/plugins/local/bulkhead`, then **Developer: Reload Window** | `.cursor-plugin/plugin.json`, whose `hooks` field points to `.cursor-plugin/hooks.json` (`beforeShellExecution`; Cursor runs plugin hooks from the plugin folder) |
| opencode | add `"plugin": ["claude-bulkhead"]` to `opencode.json` | `opencode/plugin.mjs`, the package's `main` and `./server` export: the same plugin `bulkhead setup opencode` writes, with the path to `bin/bulkhead` taken from the package |
| Gemini CLI | `gemini extensions install https://github.com/dooly6276/claude-bulkhead` | `gemini-extension.json` and `gemini/hooks.json` (`BeforeTool`, matcher `run_shell_command`, root from `${extensionPath}`). The install takes the release asset `bulkhead-gemini-extension.tar.gz`, built by `node scripts/build-gemini-extension.js`, which holds `gemini/hooks.json` as `hooks/hooks.json`; the skill in `skills/` loads too |
| Codex | `codex plugin marketplace add dooly6276/claude-bulkhead`, then `codex plugin add bulkhead@bulkhead`, then approve the hook in `/hooks` | `.agents/plugins/marketplace.json` (installs the npm package), `.codex-plugin/plugin.json`, whose `hooks` field points to `codex/hooks.json` (`PreToolUse`, matcher `^Bash$`, root from `$PLUGIN_ROOT`) |

A recorded Copilot CLI run with two sessions, one blocked from stopping the other's server and allowed to stop its own: [copilot-live-run.md](copilot-live-run.md).

`hooks/hooks.json` is the Claude Code file. Copilot CLI reads a plugin with a root `plugin.json` as an Agent Plugins plugin and takes its hooks only from `com.github.copilot/`, and Cursor reads only the file its manifest names, so neither picks up the Claude Code file. Copilot CLI ignores the `/bulkhead:` slash commands in `commands/` for the same reason; the skill in `skills/` loads in Copilot CLI and Cursor.

Gemini CLI loads `hooks/hooks.json` from every extension, so a plain checkout of this repository would load the Claude Code file there (the hook entries would run `node` with no script and fail at session start). That is why the Gemini extension is a release archive with its own `hooks/hooks.json`. Codex ignores hooks in a plugin whose root has an Agent Plugins `plugin.json`, which this repository has for Copilot CLI, so the Codex marketplace entry points to the npm package, which carries `.codex-plugin/plugin.json` and no root `plugin.json`. Codex asks you to approve a plugin hook once (`/hooks`) before it runs; a changed plugin needs a new approval.

Use the plugin or `bulkhead setup`, not both: with both, every command is checked twice.

## Which agents, and where

Each row was checked against the agent's own documentation or source (links below the table). "Sessions" says how `bulkhead status` and the guards recognize its live CLI process.

| Agent | Config bulkhead writes | Hook event, shell tool | Blocks with | Sessions (process) |
|---|---|---|---|---|
| Codex CLI (`codex`) | `~/.codex/hooks.json` (`$CODEX_HOME`) | `PreToolUse`, `Bash` | `permissionDecision: "deny"` (exit 2 also works) | `codex`, or `node .../@openai/codex/bin/codex.js` |
| Gemini CLI (`gemini`) | `~/.gemini/settings.json` | `BeforeTool`, `run_shell_command` | `{"decision":"deny","reason":...}` | `node .../gemini` or `@google/gemini-cli` |
| GitHub Copilot CLI (`copilot`) | `~/.copilot/hooks/bulkhead.json` (`$COPILOT_HOME`) | `preToolUse`, `bash` and `powershell` | `permissionDecision: "deny"` | `copilot`, or `node .../@github/copilot` |
| Cursor | `~/.cursor/hooks.json` | `beforeShellExecution` | `{"permission":"deny"}` | `cursor-agent` CLI only |
| opencode | `~/.config/opencode/plugins/bulkhead.js` | plugin hook `tool.execute.before`, `bash` | the plugin throws | `opencode` |
| Amp | `~/.config/amp/plugins/bulkhead.ts` | plugin event `tool.call`, shell tool | `{action: 'reject-and-continue'}` | `amp` (`@ampcode/cli`) |
| Cline | `~/.cline/hooks/PreToolUse.sh` (`.ps1` on Windows, `$CLINE_DIR`) | file hook `PreToolUse`, `run_commands` | `{"cancel":true,"errorMessage":...}` | `cline` |
| Factory Droid | `~/.factory/hooks.json` (or the `hooks` key of `settings.json` when that is where yours live) | `PreToolUse`, `Execute` | `permissionDecision: "deny"` | `droid` |
| Windsurf | `~/.codeium/windsurf/hooks.json` | `pre_run_command` | exit code 2 | none (the editor process is not tracked) |
| Devin CLI | `~/.config/devin/config.json` (`%APPDATA%\devin\config.json`) | `PreToolUse`, `exec` | exit code 2 | none (not matched) |
| Aider | — | — | Session discovery only | `aider`, `aider.exe`, the Python console script, or `python -m aider` |

The opencode and Amp rows install a small plugin, because both agents extend through code, not through a command. The plugin pipes `{ command, cwd, session_id }` to `bulkhead hook --agent opencode|amp` and turns exit code 2 into the agent's own rejection.

Aider sessions appear in status and can own servers or folders. Cursor's editor and Windsurf's editor are not matched as sessions (one editor process serves every chat and cannot be told apart by its process), only the `cursor-agent` CLI is; their hooks still guard every command either editor runs.

### Verified sources

- Aider: [console script](https://github.com/Aider-AI/aider/blob/main/pyproject.toml), [module entry point](https://github.com/Aider-AI/aider/blob/main/aider/__main__.py), [installation](https://aider.chat/docs/install.html), [home configuration](https://aider.chat/docs/config/aider_conf.html), and [`~/.aider` installation record](https://github.com/Aider-AI/aider/blob/main/aider/main.py).
- Codex: <https://developers.openai.com/codex/hooks> (locations `~/.codex/hooks.json` and `config.toml`; `PreToolUse` input `session_id`, `cwd`, `tool_name: "Bash"`, `tool_input.command`; deny shape and exit 2). A new or changed hook is skipped until you trust it in `/hooks`.
- Gemini CLI: <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md> and `docs/hooks/index.md` (`settings.json` layers `.gemini/settings.json`, `~/.gemini/settings.json`; `BeforeTool` input; `decision: "deny"`; exit 2), tool arguments in `docs/reference/tools.md` (`run_shell_command`: `command`, `dir_path`, `is_background`).
- Copilot CLI: <https://docs.github.com/en/copilot/reference/hooks-configuration> (`~/.copilot/hooks/*.json`, `.github/hooks/*.json`; camelCase payload `sessionId`, `cwd`, `toolName`, `toolArgs`; `permissionDecision`). Copilot treats a hook that crashes or exits non-zero as a denial, so `bulkhead hook --agent copilot` always exits 0.
- Cursor: <https://cursor.com/docs/hooks> (`~/.cursor/hooks.json`; `beforeShellExecution` input `command`, `cwd`, `conversation_id`; output `permission`). Cursor blocks on invalid or empty output, so the adapter always prints `{"permission":"allow"}` when it lets a command through. The CLI binary layout comes from <https://cursor.com/install>.
- opencode: plugin hook `tool.execute.before(input: { tool, sessionID, callID }, output: { args })` in `packages/plugin/src/index.ts` of <https://github.com/anomalyco/opencode> (tag v1.19.5) and the plugin guide `services/site/src/docs/v1/content/plugins.mdx` (`~/.config/opencode/plugins/`, throw to block).
- Amp: <https://ampcode.com/docs/markdown/plugin-api> and <https://ampcode.com/docs/markdown/customize/plugins> (`.amp/plugins`, `~/.config/amp/plugins`, `tool.call` with `reject-and-continue`, `helpers.shellCommandFromToolCall`).
- Cline: <https://github.com/cline/cline> `sdk/examples/hooks/README.md` and `PreToolUse_BlockDestructive.sh` (file hook payload `tool_call`, output `cancel`), `sdk/packages/shared/src/storage/paths.ts` (`~/.cline/hooks`, `$CLINE_DIR`), `sdk/packages/core/src/extensions/tools/helpers.ts` (the shapes `run_commands` accepts).
- Factory Droid: <https://docs.factory.ai/reference/hooks-reference> (served from docs.factory.com/harness/hooks; `~/.factory/hooks.json`, `PreToolUse` on `Execute`, exit 2 and `permissionDecision`).
- Windsurf: the Cascade hooks page (`pre_run_command` with `tool_info.command_line` and `cwd`, `trajectory_id`, `~/.codeium/windsurf/hooks.json`, exit 2 blocks). docs.windsurf.com now redirects to Devin Desktop and no longer serves that page, so it was read from an archived copy of <https://docs.windsurf.com/windsurf/cascade/hooks>.
- Devin CLI: <https://docs.devin.ai/cli/extensibility/hooks/overview.md> (`PreToolUse`, `tool_name: "exec"`, `~/.config/devin/config.json`, exit 2).

The process patterns come from each package's published `bin` entry and the launcher source (`codex-cli/bin/codex.js`, Gemini's `relaunch.ts`) and install script, not from running the agents. If an agent's launcher changes and a session is not listed in `bulkhead status`, the guards for it still work; only the cross-session ownership for that agent is missing.

## What bulkhead guards for these agents

- The Bash guards, as for Claude Code. [kill-guard](guards/kill-guard.md) also treats `codex`, `gemini`, `copilot`, `opencode`, `cline`, `droid` and `cursor-agent` as shared programs, so killing one by name is blocked.
- [port-guard](guards/port-guard.md): a dev server another session's tree is listening on is protected whichever agent owns it, and your own agent's servers are not blocked. The message says which agent owns the port ("another Codex session").
- [checkout-guard](guards/checkout-guard.md): `git checkout`, `stash`, `add -A` and `rm -rf` of a folder another agent works in are blocked. For other agents the folder is the process's working directory: `lsof` on macOS (one call for all agents), `/proc/<pid>/cwd` on Linux. On Windows there is no cheap way to read it, so checkout-guard cannot see other agents' folders there (port-guard and the process tree still work). The process table is read only when one of the agents' config folders (`~/.codex`, `~/.gemini`, ...) exists, so a machine without them pays nothing.
- `bulkhead status` and `bulkhead top` list the sessions. `status` gets an `AGENT` column as soon as one session is not Claude Code:

```
SESSION  AGENT   STARTED       RSS     PROJECT
18672    claude  Oct 12 17:49  1.4 GB  ~/src/acme-web
  :3000  node  pid 24632
21040    codex   09:12         410 MB  ~/src/acme-api
```

- `bulkhead log` records the agent on each block (`agent` in `events.jsonl`).

Not available for other agents: [orphan-reaper](guards/orphan-reaper.md) (it relies on Claude Code's session end event and session files), the status line, and the `/bulkhead:` slash commands. Guard settings, `BULKHEAD_DISABLE` and the `.claude/bulkhead.json` project file apply to every agent. The block messages talk about Claude sessions in a few places; the agents read them as plain instructions.

## Removing it

Delete the bulkhead entry from the config file (or restore `<file>.bulkhead-backup`), or for the plugin and file agents delete the file bulkhead created. A plugin install is removed with `copilot plugin uninstall bulkhead`, by deleting `~/.cursor/plugins/local/bulkhead`, or by taking `claude-bulkhead` out of opencode's `plugin` list.
