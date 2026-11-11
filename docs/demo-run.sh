#!/usr/bin/env bash
# Builds the split screen in tmux (left: live bulkhead view, right: the real claude) and attaches.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
T="tmux -u -L bulkhead-demo"
$T -f "$DEMO_ROOT/docs/demo-tmux.conf" new-session -d -x "${COLS:-110}" -y "${ROWS:-28}" -s demo "node $DEMO_ROOT/docs/demo-top.js"
$T split-window -h -t demo -c "$DEMO_REPO/search" "claude --model ${DEMO_MODEL:-opus} --plugin-dir /tmp/demo/plugin --setting-sources '' --permission-mode default --allowedTools Bash"
$T select-pane -t demo:0.0 -T "bulkhead top   2 Claude Code sessions, 1 machine"
$T select-pane -t demo:0.1 -T "session B   storefront/search   fix/search-latency   ${DEMO_MODEL_LABEL:-Opus 5.5}"
$T select-pane -t demo:0.1
bash "$DEMO_ROOT/docs/demo-late.sh" >/dev/null 2>&1 &
(sleep 1.5; $T resize-pane -t demo:0.0 -x "${LEFT:-52}") >/dev/null 2>&1 &
exec $T attach -t demo
