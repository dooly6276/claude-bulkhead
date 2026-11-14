"""The GitHub social card (1280x640): three commands a coding agent ran and the bulkhead message it got back.
build.py writes it to a temp folder and render.js turns it into docs/social-preview.png.
The messages are shortened from the real `bulkhead explain` output for these commands."""
import os
import sys

from common import DARK, MONO, SANS, e

W, H = 1280, 640
C = DARK

BLOCKS = [
    ('rm -rf "$BUILD_DIR"/*',
     'rm-empty-var: if BUILD_DIR is empty, $BUILD_DIR/* becomes /*, the whole drive.',
     'Use rm -rf "${BUILD_DIR:?}"/* so the shell stops when the variable is empty.'),
    ('rm -rf .git',
     "rm-git-dir: deletes the history, every commit not pushed and the stashes.",
     'To remove a checkout, use git worktree remove <path>. To start over, ask the user first.'),
    ('pkill -f node',
     'kill-guard: matches node in 2 other sessions (dev servers on :3000 and :3001).',
     'Stop only what you started: kill <your own pid> (lsof -ti :3002 finds it).'),
]


def block(y, cmd, msg, hint):
    x = 128
    pre = 'Bash('
    return f'''<circle cx="{x + 6}" cy="{y - 7}" r="6" fill="{C['red']}"/>
<text x="{x + 24}" y="{y}" font-family="{e(MONO)}" font-size="22" fill="{C['fg']}">{e(pre)}<tspan fill="{C['fg']}" font-weight="600">{e(cmd)}</tspan>)</text>
<rect x="{x + 20}" y="{y + 14}" width="1024" height="34" rx="4" fill="{C['redbg']}"/>
<text x="{x + 32}" y="{y + 37}" font-family="{e(MONO)}" font-size="17.5" fill="{C['red']}"><tspan font-weight="700">[bulkhead]</tspan> {e(msg)}</text>
<text x="{x + 32}" y="{y + 72}" font-family="{e(MONO)}" font-size="17.5" fill="{C['mute']}">{e(hint)}</text>'''


def build():
    blocks = '\n'.join(block(262 + i * 110, *b) for i, b in enumerate(BLOCKS))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="{e(SANS)}">
<rect width="{W}" height="{H}" fill="#06090e"/>
<text x="{W / 2}" y="84" text-anchor="middle" font-size="62" font-weight="800" fill="#f0f4f8" letter-spacing="-1.5">claude-bulkhead</text>
<text x="{W / 2}" y="130" text-anchor="middle" font-size="26" fill="#a9b6c6">Hooks that stop coding agents from wiping, killing and overwriting your work.</text>
<rect x="96" y="168" width="1088" height="420" rx="14" fill="{C['term']}" stroke="{C['line2']}" stroke-width="1.5"/>
<path d="M96 210 h1088" stroke="{C['line']}"/>
<circle cx="124" cy="189" r="6" fill="{C['base']}"/><circle cx="144" cy="189" r="6" fill="{C['base']}"/><circle cx="164" cy="189" r="6" fill="{C['base']}"/>
<text x="640" y="195" text-anchor="middle" font-family="{e(MONO)}" font-size="16" fill="{C['dim']}">claude  ~/code/acme-web</text>
{blocks}
<text x="{W / 2}" y="622" text-anchor="middle" font-size="19" fill="{C['dim']}">Claude Code, Codex, Gemini CLI, Copilot CLI, Cursor, opencode.  MIT, zero dependencies.</text>
</svg>'''


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "social.svg"), "w") as f:
        f.write(build())
    print("social.svg written")
