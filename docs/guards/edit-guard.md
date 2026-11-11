# edit-guard

[Back to README](../../README.md) | [All guards](../../README.md#guards)

Two sessions edit the same file. One rewrites a function the other just changed, or reverts it without knowing it was there, and neither agent can tell who changed what ([claude-code#94571](https://github.com/anthropics/claude-code/issues/94571), [#107965](https://github.com/anthropics/claude-code/issues/107965)). edit-guard tells the agent, right before it edits, that another live session touched this file a few minutes ago. It needs no server and no daemon.

## How it works

- After every `Edit`, `Write`, `MultiEdit` and `NotebookEdit`, a PostToolUse hook adds `{ session, file, time }` to a small file for the repository in the state directory (`edits/<id>.json`). The file holds at most 300 entries, drops entries older than two hours, and is replaced atomically. The repository is found by reading `.git` (and `commondir` for a linked worktree), without running git.
- Before the next edit, a PreToolUse hook reads that file. If a different session edited the same file within `editGuard.windowMinutes` (default 30), and that session is still alive according to `~/.claude/sessions`, the agent is told. The match is by the file's path inside the repository, so an edit in another worktree of the same repository counts.
- With no other session's edit on record, the hook reads one file that does not exist and exits. It does not read the session files or scan processes. When it finds a recent edit it reads the session files (a few small JSON files and one signal-0 check per session); that measures under 5 ms in the tests, on top of Node's own start-up.
- Windows paths are compared without case. A broken or unreadable state file is ignored, and any error lets the edit go ahead.

## What Claude sees

In the default `warn` mode the edit goes ahead, and the next request carries one line next to the tool result:

```
Note: session 4821 (~/dev/api, branch feat-x) edited this file 6 min ago; re-read it before assuming its contents, and don't revert their change.
```

For a file edited in another worktree of the same repository:

```
Note: session 4821 edited the same file in another worktree (~/dev/api-wt, branch feat-y) 6 min ago; the two versions will conflict on merge, so look at its change before overwriting this one.
```

A session is told once per edit the other session makes, so a long run of edits does not repeat the note. The hook returns `hookSpecificOutput.additionalContext` for `PreToolUse` and no `permissionDecision`, so it informs the model without approving anything and your permission prompts are unchanged ([hooks reference](https://code.claude.com/docs/en/hooks)).

## Modes

```json
{ "editGuard": { "mode": "ask", "windowMinutes": 15 } }
```

| `mode` | Effect |
|---|---|
| `warn` (default) | Edit goes ahead; the agent gets the note. Never blocks |
| `ask` | The same note is shown to you in a permission prompt (`permissionDecision: "ask"`), and the agent gets it too. You decide |
| `block` | The edit is stopped (exit 2) with the note and a pointer to this setting, on every attempt while the other session is live and inside the window. Logged in `bulkhead log` |

Turn it off with `BULKHEAD_DISABLE=edit-guard` or `"editGuard": { "enabled": false }`.

## Limits

It sees edits made through Claude Code's edit tools, not changes made by shell commands (`sed -i`, a formatter, `git checkout`). It sees only sessions that have the plugin. Two edits made in the same second can race to write the state file; one entry may be lost, which at worst means one missed note.
