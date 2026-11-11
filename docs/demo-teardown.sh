#!/usr/bin/env bash
# Removes everything demo-setup.sh and demo-run.sh created. Only touches processes started for the demo.
repo=$HOME/code/storefront
tmux -u -L bulkhead-demo kill-server 2>/dev/null
sleep 1
for port in 3000 3002; do
  for pid in $(lsof -ti:$port -sTCP:LISTEN 2>/dev/null); do
    lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | grep -q "^n$repo/" && kill "$pid" 2>/dev/null
  done
done
[ -f /tmp/demo/standin.pid ] && { kill "$(cat /tmp/demo/standin.pid)" 2>/dev/null; rm -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions/$(cat /tmp/demo/standin.pid).json"; }
# session files of the real claude that ran in the demo repo
grep -l "\"cwd\":\"$repo/" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/sessions/*.json 2>/dev/null | xargs -r rm -f
git -C "$repo/main" worktree prune 2>/dev/null
rm -rf "$repo" /tmp/demo
# transcripts the recorded claude wrote for the demo repo
rm -rf "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*-code-storefront-*
rmdir "$HOME/code" 2>/dev/null
# the recorded claude's session-end hook can still write /tmp/demo/state a moment later
sleep 2; rm -rf /tmp/demo
exit 0
