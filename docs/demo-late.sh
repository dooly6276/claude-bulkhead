#!/usr/bin/env bash
# Starts the :3002 dev server as part of the real claude session's process family (CLAUDE_PID),
# once that session has written its session file. Run after claude is up.
sessions=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions
for _ in $(seq 1 240); do
  pid=$(grep -l "\"cwd\":\"$DEMO_REPO/search\"" "$sessions"/*.json 2>/dev/null | head -1 | xargs -r basename 2>/dev/null | sed 's/\.json//')
  [ -n "$pid" ] && break
  sleep 0.5
done
[ -n "$pid" ] || exit 1
(cd "$DEMO_REPO/search" && CLAUDE_PID=$pid nohup node search-server.js >/dev/null 2>&1 &)
echo "$pid" > /tmp/demo/claude.pid
