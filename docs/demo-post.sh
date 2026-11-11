#!/usr/bin/env bash
# Turns the vhs recording (/tmp/demo-raw.mp4) into docs/demo.mp4, docs/demo.gif and docs/demo-thumb.png.
#  - keeps the Claude Code banner, drops only the footer status row ("manual mode on ...")
#  - re-times the clip (typing slowed, typed prompt held, the block moment slowed to about 3 s, the end held)
#  - pads a caption strip under the terminal; captions are rendered with PIL (ffmpeg here has no drawtext)
#    and overlaid with timed enable
# vhs does not record in real time, so the T_* values are seconds in the raw file. Find them with
#   ffmpeg -i raw.mp4 -vf fps=5,scale=586:-1,tile=4x9 grid.png
# T_TYPE0 first typed character, T_TYPED prompt fully typed, T_BLOCK0/T_BLOCK1 the hook block,
# T_GLITCH0 last clean frame before the banner scrolls off (frames between it and T_FINAL are dropped:
# the banner leaves a flickering remnant), T_FINAL the frame to end on (new :3002 PID, answer shown).
set -eu
cd "$(dirname "$0")"
raw=${1:-/tmp/demo-raw.mp4}
: "${T_TYPE0:=0.98}" "${T_TYPED:=2.3}" "${T_THINK:=4.6}" "${T_BLOCK1:=5.55}" "${T_GLITCH0:=6.1}" "${T_FINAL:=6.8}"
LABEL_H=28; BODY_H=743   # pane label row, then terminal rows up to the footer row (800 px total, footer cut)
STRIP_H=109
W=1760
tmp=$(mktemp -d)
python3 - "$tmp" <<'PY'
import sys
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
caps = [
 "Two Claude Code sessions on one machine. Session A serves checkout on :3000.",
 "In a hurry, you tell session B to pkill node. That would take down checkout too.",
 "bulkhead blocks it before it runs.",
 "Claude restarts only its own server. checkout never goes down.",
]
font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 38)
for i, c in enumerate(caps, 1):
    im = Image.new('RGB', (1792, STRIP_H + 12 if False else 121), (0x1e, 0x1e, 0x2e))
    d = ImageDraw.Draw(im)
    w = d.textlength(c, font=font)
    assert w < 1700, (c, w)
    d.text(((1792 - w) / 2, 12 + (109 - 38) / 2 - 4), c, font=font, fill=(255, 255, 255))
    im.save(f'{out}/cap{i}.png')
PY
seg() { echo "[0:v]trim=$2:$3,setpts=(PTS-STARTPTS)/$4[$1];"; }
freeze() { local e; e=$(awk -v t="$2" 'BEGIN{printf "%.3f", t+0.05}'); echo "[0:v]trim=$2:$e,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=$3[$1];"; }
# output timeline: typing 0-3.4, typed hold to 5.0, thinking to 7.3, block (slowed) to 10.5, restart, end hold
: "${HOLD_END:=5.0}"
filter="
$(seg a0 $T_TYPE0 $T_TYPED 0.4)
$(freeze a1 $T_TYPED 1.6)
$(seg a2 $T_TYPED $T_THINK 1.0)
$(seg a3 $T_THINK $T_BLOCK1 0.3)
$(seg a4 $T_BLOCK1 $T_GLITCH0 0.6)
$(freeze a5 $T_FINAL $HOLD_END)
[a0][a1][a2][a3][a4][a5]concat=n=6:v=1[c];
[c]fps=25,split[l][b];
[l]crop=iw:$LABEL_H:0:0[lab];
[b]crop=iw:$BODY_H:0:$LABEL_H[body];
[lab][body]vstack,pad=iw+32:ih+24+$STRIP_H:16:12:color=0x1e1e2e,pad=iw+56:ih+56:28:28:color=0x11111b,drawbox=x=27:y=27:w=iw-54:h=ih-54:color=0x45475a:t=1[base];
[base][1:v]overlay=28:811:enable='between(t,0,${C1:-3.9})'[o1];
[o1][2:v]overlay=28:811:enable='between(t,${C1:-3.9},${C2:-8.5})'[o2];
[o2][3:v]overlay=28:811:enable='between(t,${C2:-8.5},${C3:-11.15})'[o3];
[o3][4:v]overlay=28:811:enable='gte(t,${C3:-11.15})',format=yuv420p[v]"
ffmpeg -v error -y -i "$raw" -i $tmp/cap1.png -i $tmp/cap2.png -i $tmp/cap3.png -i $tmp/cap4.png \
  -filter_complex "$filter" -map '[v]' -c:v libx264 -crf 20 -preset slow -movflags +faststart demo.mp4
ffmpeg -v error -y -sseof -0.5 -i demo.mp4 -frames:v 1 -update 1 demo-thumb.png
ffmpeg -v error -y -i demo.mp4 -vf "fps=15,scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" demo.gif
rm -rf "$tmp"
ls -l demo.mp4 demo.gif demo-thumb.png
ffprobe -v error -show_entries stream=width,height:format=duration -of csv=p=0 demo.mp4
