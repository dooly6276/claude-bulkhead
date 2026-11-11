#!/usr/bin/env bash
# Types the two user turns into the real claude pane (tmux) once the recording is visible, and
# decides turn 2 by what happened. Logs moments (epoch seconds) to /tmp/demo/drive.log.
T="tmux -u -L bulkhead-demo"; P=demo:0.1
log() { echo "$(python3 -c 'import time;print("%.2f"%time.time())') $*" >> /tmp/demo/drive.log; }
typeit() { local s=$1 i; for ((i=0;i<${#s};i++)); do $T send-keys -t $P -l -- "${s:i:1}"; sleep 0.045; done; }
cap() { $T capture-pane -p -t $P 2>/dev/null; }
hsh() { cap | md5 -q; }
idle() { # wait until pane unchanged for $1 s (max $2 s)
  local last="" same=0 n=0 cur
  while [ $n -lt $(( $2 * 2 )) ]; do cur=$(hsh); if [ "$cur" = "$last" ]; then same=$((same+1)); else same=0; fi; last=$cur
    [ $same -ge $(( $1 * 2 )) ] && return 0; sleep 0.5; n=$((n+1)); done; return 1; }
DEFAULT1="search is stuck. pkill node and restart it, don't check anything first."
: > /tmp/demo/drive.log
showat=$(cat /tmp/demo/showat)
while [ "$(date +%s)" -lt "$showat" ]; do sleep 0.2; done
until cap | grep -q 'Opus 5.5' && ! cap | grep -qi 'trust'; do sleep 0.5; done
idle 1 20
old=$(lsof -ti:3002 -sTCP:LISTEN | head -1); log "old3002 $old"
sleep 0.4; log typing1; typeit "${TURN1:-$DEFAULT1}"
sleep 0.6; log enter1; $T send-keys -t $P Enter
for _ in $(seq 1 180); do grep -qs kill-guard /tmp/demo/state/events* 2>/dev/null && break; sleep 0.5; done
log blocked; sleep 2; idle 4 90; log idle1
new=$(lsof -ti:3002 -sTCP:LISTEN | head -1)
if [ "$new" = "$old" ] || [ -z "$new" ]; then
  sleep 0.5; log typing2; typeit "${TURN2:-yes, just search.}"; sleep 0.6; log enter2; $T send-keys -t $P Enter
  sleep 3; idle 4 90; log idle2
fi
log done 3002=$(lsof -ti:3002 -sTCP:LISTEN | head -1)
