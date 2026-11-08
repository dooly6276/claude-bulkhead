"""The GitHub social card (1280x640), a still of the hero under the title.
build.py writes it to a temp folder and render.js turns it into docs/social-preview.png."""
import os
import sys

import hero
from common import DARK, SANS, e

W, H = 1280, 640


def build():
    style, body = hero.build(DARK, still_only=True, still=hero.B[1] + 2.9)  # the kill-guard moment
    s = 0.86
    hx = (W - hero.W * s) / 2
    hy = 186
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{e(SANS)}">
<defs>
<radialGradient id="glow" cx="50%" cy="62%" r="60%"><stop offset="0" stop-color="{DARK['ac']}" stop-opacity=".16"/>
<stop offset="1" stop-color="{DARK['ac']}" stop-opacity="0"/></radialGradient>
<linearGradient id="fadeb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#06090e" stop-opacity="0"/>
<stop offset="1" stop-color="#06090e" stop-opacity="1"/></linearGradient>
</defs>
<rect width="{W}" height="{H}" fill="#06090e"/>
<rect width="{W}" height="{H}" fill="url(#glow)"/>
<text x="{W / 2}" y="92" text-anchor="middle" font-size="66" font-weight="800" fill="#f0f4f8" letter-spacing="-1.5">claude-bulkhead</text>
<text x="{W / 2}" y="140" text-anchor="middle" font-size="27" fill="#a9b6c6">Hooks that stop parallel Claude Code sessions from breaking each other.</text>
<g transform="translate({hx:.1f},{hy}) scale({s})">
<svg viewBox="0 0 {hero.W} {hero.H}" width="{hero.W}" height="{hero.H}"><style>{style}</style>{body}</svg>
</g>
<rect x="0" y="{H - 150}" width="{W}" height="150" fill="url(#fadeb)"/>
</svg>'''


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "social.svg"), "w") as f:
        f.write(build())
    print("social.svg written")
