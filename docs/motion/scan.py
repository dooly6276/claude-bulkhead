"""docs/scan.svg and docs/scan-light.svg: an animated terminal running `bulkhead scan`.

The text is the real output of the tool on the synthetic transcripts that
scripts/demo-scan/make-transcripts.js writes. This script runs both and animates what comes back;
it keeps three of the example blocks and wraps lines longer than the terminal at word boundaries.
"""
import os
import re
import subprocess
import tempfile

from common import DARK, LIGHT, MONO, EASE, INOUT, KF, e, tw, vars_css, svg_doc

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
KEEP_EXAMPLES = ("stage-all", "pkill", "disk-wide-scan")
W = 1200
FS, LH = 15, 22
PAD = 30
COLS = 118
P = 16.0
STILL = 12.0


def scan_output():
    tmp = tempfile.mkdtemp(prefix="bulkhead-demo-")
    subprocess.run(["node", os.path.join(ROOT, "scripts/demo-scan/make-transcripts.js"), tmp], check=True,
                   stdout=subprocess.DEVNULL)
    env = dict(os.environ, TZ="UTC", HOME="/Users/dev", NO_COLOR="1")
    out = subprocess.run(["node", os.path.join(ROOT, "bin/bulkhead"), "scan", "--path", tmp, "-n", "1"],
                         check=True, capture_output=True, text=True, env=env).stdout
    subprocess.run(["rm", "-rf", tmp], check=True)
    return out.rstrip("\n").split("\n")


def wrap(s, cols=COLS):
    if len(s) <= cols:
        return [s]
    out, cur = [], ""
    for word in s.split(" "):
        if cur and len(cur) + 1 + len(word) > cols:
            out.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}" if cur else word
    return out + [cur]


def parse(lines):
    """Splits the output into header, table, example blocks and closing lines."""
    i = lines.index("")
    head = lines[:i]
    j = lines.index("", i + 1)
    table = lines[i + 1:j]
    rest = lines[j + 1:]
    blocks, cur = [], []
    closing = []
    k = 0
    while k < len(rest):
        ln = rest[k]
        if ln == "":
            if cur:
                blocks.append(cur)
            cur = []
        elif re.match(r"^\d+ commands? in ", ln):
            closing = rest[k:]
            break
        else:
            cur.append(ln)
        k += 1
    keep = [b for b in blocks if b[0].split()[1] in KEEP_EXAMPLES]
    return head, table, keep, closing


def build(pal, lines):
    head, table, blocks, closing = parse(lines)
    k = KF(P, STILL)
    css = [vars_css(pal), f"""text{{font-family:{MONO};font-size:{FS}px;white-space:pre}}
.fg{{fill:var(--fg)}}.mu{{fill:var(--mute)}}.dm{{fill:var(--dim)}}.ac{{fill:var(--ac)}}.rd{{fill:var(--red)}}
.am{{fill:var(--amber)}}.b{{font-weight:700}}.cv{{fill:var(--term)}}"""]
    rows = []      # (kind, payload, t_in)
    x = PAD + 6
    out_t = P - 1.6

    def txt(y, inner, cls="fg"):
        return f'<text x="{x}" y="{y}" class="{cls}">{inner}</text>'

    def show(t0, dx=0, dy=6, fade=0.3):
        return k.add([(0, f"opacity:0;transform:translate({dx}px,{dy}px)", None),
                      (t0, f"opacity:0;transform:translate({dx}px,{dy}px)", EASE),
                      (t0 + fade, "opacity:1;transform:translate(0px,0px)", None)])

    def counted(y, variants, t0, cls, dt=0.06):
        """Several versions of one line, shown one after another (a counter), the last one stays."""
        parts = []
        for vi, inner in enumerate(variants):
            a = t0 + vi * dt
            fr = [(0, "opacity:0", None), (a, "opacity:0", None), (a + 0.004, "opacity:1", None)]
            if vi < len(variants) - 1:
                fr += [(a + dt, "opacity:1", None), (a + dt + 0.004, "opacity:0", None)]
            parts.append(f'<g class="{k.add(fr)}">{txt(y, inner, cls)}</g>')
        return "".join(parts)

    body = []
    y = 44 + PAD + 8
    # prompt and typed command
    cmd = "bulkhead scan --path ./demo -n 1"
    cmd_x = x + tw("$ ", FS)
    body.append(txt(y, f'<tspan class="ac b">$ </tspan>{e(cmd)}'))
    w = tw(cmd, FS) + 6
    t0, dur = 0.5, 0.9
    mv = k.add([(0, "transform:translate(0px,0px)", None), (t0, "transform:translate(0px,0px)", f"steps({len(cmd)},end)"),
                (t0 + dur, f"transform:translate({w:.1f}px,0px)", None), (out_t + 0.6, f"transform:translate({w:.1f}px,0px)", None),
                (out_t + 0.61, "transform:translate(0px,0px)", None)])
    caret = k.add([(0, "opacity:1", None), (0.25, "opacity:0", None), (0.5, "opacity:1", None),
                   (t0 + dur + 0.25, "opacity:1", None), (t0 + dur + 0.26, "opacity:0", None),
                   (out_t + 0.9, "opacity:0", None), (out_t + 0.91, "opacity:1", None),
                   (P - 0.5, "opacity:1", None), (P - 0.25, "opacity:0", None)])
    body.append(f'<g class="{mv}"><rect x="{cmd_x - 1:.1f}" y="{y - FS - 2}" width="{w + 2:.1f}" height="{FS + 9}" class="cv"/>'
                f'<rect x="{cmd_x - 1:.1f}" y="{y - FS + 1}" width="9" height="{FS + 3}" class="ac {caret}"/></g>')
    t = 1.65
    y += LH
    # header
    for i, ln in enumerate(head):
        if i == 0:
            inner = f'<tspan class="b">bulkhead scan</tspan>{e(ln[len("bulkhead scan"):])}'
            cls = "fg"
        else:
            m = re.match(r"^(\s+\w+\s+)(.*)$", ln)
            inner = f'<tspan class="dm">{e(m.group(1))}</tspan>{e(m.group(2))}' if m else e(ln)
            cls = "mu"
            if "overlap" in ln:
                inner = re.sub(r"up to (\d+) ", r'up to <tspan class="fg b">\1</tspan> ', inner)
        body.append(f'<g class="{show(t + 0.12 * i)}">{txt(y, inner, cls)}</g>')
        y += LH
    t += 0.12 * len(head) + 0.25
    y += LH
    # table: header bold, rows slide in, HITS counts up
    hits_col = table[0].index("HITS")
    for i, ln in enumerate(table):
        t_row = t + 0.1 * i
        if i == 0:
            body.append(f'<g class="{show(t_row, dx=-10, dy=0)}">{txt(y, e(ln), "fg b")}</g>')
        else:
            cell = ln[hits_col:hits_col + 4]
            n = int(cell)
            guard = ln.split()[0]
            col = "rd" if guard in ("kill-guard", "checkout-guard") else "am"
            variants = []
            for v in range(1, n + 1):
                row = ln[:hits_col] + str(v).rjust(4) + ln[hits_col + 4:]
                g_ = row[:len(guard)]
                variants.append(f'<tspan class="{col}">{e(g_)}</tspan>{e(row[len(guard):])}')
            inner = counted(y, variants, t_row + 0.1, "fg", dt=0.1)
            body.append(f'<g class="{show(t_row, dx=-12, dy=0)}">{inner}</g>')
        y += LH
    t += 0.1 * len(table) + 0.5
    # example blocks
    for bi, blk in enumerate(blocks):
        y += LH
        h = blk[0]
        m = re.match(r"^(\S+\s+\S+)(\s+\d+ times? in \d+ sessions?)(.*)$", h)
        col = "rd" if h.startswith(("checkout-guard", "kill-guard")) else "am"
        inner = (f'<tspan class="{col}">{e(m.group(1))}</tspan>{e(m.group(2))}<tspan class="dm">{e(m.group(3))}</tspan>'
                 if m else e(h))
        body.append(f'<g class="{show(t)}">{txt(y, inner, "fg")}</g>')
        y += LH
        for ln in blk[1:2]:
            mm = re.match(r"^(\s+\$ )(.*?)(\s{2}~.*)$", ln)
            if mm:
                meta = mm.group(3)
                tag = ""
                tm = re.search(r"\s+\[(.*)\]$", meta)
                if tm:
                    tag = f'<tspan class="ac">{e(tm.group(0))}</tspan>'
                    meta = meta[:tm.start()]
                inner = f'<tspan class="dm">{e(mm.group(1))}</tspan>{e(mm.group(2))}<tspan class="dm">{e(meta)}</tspan>{tag}'
            else:
                inner = e(ln)
            body.append(f'<g class="{show(t + 0.15)}">{txt(y, inner, "fg")}</g>')
            y += LH
        t += 0.45
    t += 0.3
    y += LH
    # closing sentence: the numbers count up; the long lines wrap like a terminal would
    first = closing[0]
    m = re.match(r"^(\d+)( commands? in )(\d+)( sessions? would have been stopped by bulkhead\.)(.*)$", first)
    total, sess = int(m.group(1)), int(m.group(3))
    steps = 10
    variants_lines = []
    for s in range(1, steps + 1):
        f = 1 - (1 - s / steps) ** 2
        a, b = round(total * f), round(sess * f)
        head_ = f"{a}{m.group(2)}{b}{m.group(4)}"
        variants_lines.append((head_ + m.group(5), len(head_)))
    wrapped0 = wrap(variants_lines[-1][0])
    bold_len = len(f"{total}{m.group(2)}{sess}{m.group(4)}")

    def styled(line, start, bl=bold_len):
        # bold for the first sentence, normal after it
        cut = max(0, min(len(line), bl - start))
        return f'<tspan class="b">{e(line[:cut])}</tspan>{e(line[cut:])}' if cut else e(line)

    c0 = 0
    for li, wl in enumerate(wrapped0):
        variants = []
        for vl, bl in variants_lines:
            seg = vl[:len(wl) + (len(vl) - len(variants_lines[-1][0]))]
            variants.append(styled(seg, 0, bl))
        # only the first wrapped line holds the numbers; later lines are static
        if li == 0:
            inner = counted(y, variants, t + 0.1, "fg", dt=0.06)
            body.append(f'<g class="{show(t)}">{inner}</g>')
        else:
            body.append(f'<g class="{show(t + 0.1)}">{txt(y, styled(wl, c0), "fg")}</g>')
        c0 += len(wl) + 1
        y += LH
    note = " ".join(closing[1:])
    for li, wl in enumerate(wrap(note)):
        body.append(f'<g class="{show(t + 0.9 + 0.1 * li)}">{txt(y, e(wl), "dm")}</g>')
        y += LH
    H = y + PAD - 4
    allout = k.add([(0, "opacity:1", None), (out_t, "opacity:1", INOUT), (out_t + 0.5, "opacity:0", None)])
    # the output fades out before the loop restarts; the cover re-hides the typed command
    chrome = (f'<rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="14" fill="var(--term)" stroke="var(--line)"/>'
              f'<path d="M1 44.5H{W - 1}" stroke="var(--line)"/>'
              + "".join(f'<circle cx="{24 + j * 18}" cy="22" r="6" fill="var(--line2)"/>' for j in range(3))
              + f'<text x="{W / 2}" y="27" text-anchor="middle" class="dm">~/code: bulkhead scan</text>')
    prompt_parts, out_parts = body[:2], body[2:]
    svg_body = chrome + "".join(prompt_parts) + f'<g class="{allout}">{"".join(out_parts)}</g>'
    style = "\n".join(css) + "\n" + k.css() + "\n" + k.still_css()
    return style, svg_body, H


TITLE = "bulkhead scan replaying Claude Code transcripts"
DESC = ("An animated terminal. The command bulkhead scan is typed, then its real output appears: 14 transcripts, "
        "527 shell commands, up to 4 sessions running at once, a table of 13 guard rules with hit counts counting up "
        "(checkout-guard stage-all 5, kill-guard pkill 5, disk-guard disk-wide-scan 3 and more), example commands "
        "such as git add -A, pkill node and du -sh ~, and the closing line: 24 commands in 13 sessions would have "
        "been stopped by bulkhead, 10 of them already stopped by a hook or declined.")


def write(path, pal, lines):
    style, body, H = build(pal, lines)
    svg = svg_doc(W, H, TITLE, DESC, style, body, "scan")
    with open(path, "w") as f:
        f.write(svg)
    return len(svg.encode()), H


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..")
    lines = scan_output()
    print("scan.svg", write(os.path.join(out, "scan.svg"), DARK, lines))
    print("scan-light.svg", write(os.path.join(out, "scan-light.svg"), LIGHT, lines))
