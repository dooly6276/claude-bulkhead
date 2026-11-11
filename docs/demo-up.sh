#!/usr/bin/env bash
# Started by demo-setup.sh in its own process so the recorded shell prints no job messages.
sessions=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions
# a copied system binary gets killed by macOS (signature), so rename via argv0 instead
nohup bash -c 'exec -a claude sleep 900' >/dev/null 2>&1 &
DEMO_STANDIN=$!
printf '{"pid":%d,"sessionId":"demo-checkout","cwd":"%s/checkout","startedAt":%d}\n' "$DEMO_STANDIN" "$DEMO_REPO" "$(( $(date +%s) * 1000 ))" > "$sessions/$DEMO_STANDIN.json"
(cd "$DEMO_REPO/checkout" && CLAUDE_PID=$DEMO_STANDIN nohup node checkout-server.js >/dev/null 2>&1 & echo $! > /tmp/demo/checkout.pid)
echo "$DEMO_STANDIN" > /tmp/demo/standin.pid
sleep 1
