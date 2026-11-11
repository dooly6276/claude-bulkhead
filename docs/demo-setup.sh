#!/usr/bin/env bash
# Sets up the scene for docs/demo.tape (macOS or Linux). Source it: `source docs/demo-setup.sh`.
# Scene: repo "storefront" with two git worktrees under ~/code/storefront (created only for the
# recording, removed by demo-teardown.sh):
#   checkout  branch feat/checkout-redesign, dev server on :3000, owned by a stand-in "other
#             Claude Code session" (a process named `claude` plus the session file Claude Code writes)
#   search    branch fix/search-latency, dev server on :3002, the real `claude` runs here
root=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)
export DEMO_ROOT=$root BULKHEAD_STATE_DIR=/tmp/demo/state PATH=$root/bin:$PATH
export DEMO_REPO=$HOME/code/storefront
mkdir -p /tmp/demo/safe "$BULKHEAD_STATE_DIR"
rm -f "$BULKHEAD_STATE_DIR"/events* 2>/dev/null
sessions=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions
mkdir -p "$sessions"
if [ ! -d "$DEMO_REPO/main/.git" ]; then
  mkdir -p "$DEMO_REPO/main"
  (cd "$DEMO_REPO/main" && git init -q -b main && git -c user.name=dev -c user.email=dev@example.com commit -q --allow-empty -m init \
    && git branch feat/checkout-redesign && git branch fix/search-latency \
    && git worktree add -q ../checkout feat/checkout-redesign && git worktree add -q ../search fix/search-latency)
fi
for pair in checkout:3000 search:3002; do
  name=${pair%%:*}; port=${pair##*:}
  cat > "$DEMO_REPO/$name/$name-server.js" <<JS
const port = $port
console.log('  ▲ Next.js 15.1.0\n  - Local:   http://localhost:' + port + '\n\n ✓ Ready in 1.4s')
require('http').createServer((q, s) => s.end(JSON.stringify({ service: '$name', status: 'ok' }) + '\n')).listen(port)
JS
  printf '{ "name": "storefront-%s", "private": true, "scripts": { "dev": "node %s-server.js" } }\n' "$name" "$name" > "$DEMO_REPO/$name/package.json"
done
cat > "$DEMO_REPO/search/CLAUDE.md" <<'MD'
# storefront

Next.js storefront. Each worktree runs its own dev server on a fixed port.

## Dev server
- Start: `npm run dev` (this worktree uses port 3002)
- Restart: `pkill node && npm run dev`
MD
# hooks-only copy of the plugin (no skill, so Claude does not know about the guards in advance) and a
# safety net: if a hook ever failed, pkill/killall here would do nothing instead of killing node.
# A pkill that would only reach the demo's own processes (pattern names a demo folder, or every
# process it matches runs from the demo search worktree) runs for real: what Claude reports afterwards
# must match what bulkhead did (it allows such a kill).
P=/tmp/demo/plugin; rm -rf $P; mkdir -p $P/.claude-plugin
ln -s "$root/src" $P/src; ln -s "$root/hooks" $P/hooks; ln -s "$root/bin" $P/bin
cp "$root/.claude-plugin/plugin.json" $P/.claude-plugin/
for n in pkill killall; do printf '#!/bin/sh\necho "demo safety shim: %s not executed" >&2\nexit 0\n' $n > /tmp/demo/safe/$n; chmod +x /tmp/demo/safe/$n; done
cat > /tmp/demo/safe/pkill <<SHIM
#!/bin/sh
case "\$*" in
  *"$DEMO_REPO/"*|*"~/code/storefront/"*) exec /usr/bin/pkill "\$@" ;;
esac
pids=\$(/usr/bin/pgrep "\$@" 2>/dev/null | grep -vx "\$\$")
if [ -n "\$pids" ]; then
  ok=1
  for p in \$pids; do
    cwd=\$(lsof -a -p "\$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "\$cwd" in "$DEMO_REPO"/search|"$DEMO_REPO"/search/*) ;; *) ok=0 ;; esac
  done
  [ \$ok = 1 ] && exec /usr/bin/pkill "\$@"
fi
echo "demo safety shim: pkill not executed" >&2
exit 0
SHIM
chmod +x /tmp/demo/safe/pkill
export PATH=/tmp/demo/safe:$PATH
bash "$root/docs/demo-up.sh" >/dev/null 2>&1
# Tear down afterwards with: bash docs/demo-teardown.sh
