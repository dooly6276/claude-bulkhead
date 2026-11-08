---
description: Replay your past Claude Code sessions against the bulkhead guards and show what they would have stopped
argument-hint: "[7d|30d|2026-10-01]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" scan:*)
---

Shell commands from this machine's Claude Code transcripts, replayed against the guards, for the period `$ARGUMENTS` (all kept history when empty):

!`node "${CLAUDE_PLUGIN_ROOT}/bin/bulkhead" scan -n 2 --since="$ARGUMENTS" 2>&1 || true`

Summarize for the user in a few lines:

- How many sessions ran at once at the busiest moment, and which guards would have fired most, in which projects.
- Which hits look like real collisions between sessions (checkout-guard, kill-guard, disk-guard) and which are habits worth a rule in the project's CLAUDE.md (wait-guard, basics).
- What was already stopped by a hook or declined by the user, so they see what the guards would have saved them from doing by hand.

Do not paste whole commands back; the examples above are already masked. If nothing would have been stopped, say so in one line and mention that this usually means one session at a time.
