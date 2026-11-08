"""docs/hero.svg and docs/hero-light.svg: four Claude Code sessions on one machine, five guard moments,
then the bulkhead scan result. One seamless CSS loop; reduced motion shows the stage-all moment."""
from common import (DARK, LIGHT, MONO, SANS, EASE, BACK, INOUT, IN, KF, e, tw, vars_css, svg_doc)

W, H = 1200, 624
P = 25.0
INTRO = 1.4
BEAT = 4.0
B = [INTRO + i * BEAT for i in range(5)]   # port, kill, disk, stage-all, slot
END = B[4] + BEAT                           # 21.4
RESET = 24.5
STILL = B[3] + 2.9                          # stage-all, fully revealed

# scan numbers: real output of `bulkhead scan` on scripts/demo-scan transcripts
SCAN = {"commands": 24, "sessions": 13, "overlap": 4, "files": 14, "kb": 338, "shell": 527}

X0, X1 = 32, 1168
TX = 60                 # terminal text left
TY0, TLH = 262, 28      # first baseline, line pitch
CARD_Y, CARD_H, CARD_W, GAP = 76, 96, 272, 16
TERM_Y, TERM_H = 188, 258
STRIP_Y, STRIP_H = 462, 142

SESS = [
    ("main", "~/code/acme-web"),
    ("feat/checkout", "~/code/acme-web-checkout"),
    ("fix/auth", "~/code/acme-web-auth"),
    ("docs/setup", "~/code/acme-web"),
]


def card_x(i):
    return X0 + i * (CARD_W + GAP)


def build(pal, still_only=False, still=STILL):
    k = KF(P, still)
    o = []      # body parts
    css = [vars_css(pal), f"""
text{{font-family:{SANS};white-space:pre}}.m{{font-family:{MONO}}}
.fg{{fill:var(--fg)}}.mu{{fill:var(--mute)}}.dm{{fill:var(--dim)}}.ac{{fill:var(--ac)}}.rd{{fill:var(--red)}}
.am{{fill:var(--amber)}}.bl{{fill:var(--blue)}}.b{{font-weight:700}}.sb{{font-weight:600}}
.pn{{fill:var(--panel);stroke:var(--line)}}.tm{{fill:var(--term);stroke:var(--line)}}.cv{{fill:var(--term)}}
.ln{{stroke:var(--line)}}.l2{{stroke:var(--line2)}}
"""]

    def t(x, y, s, cls="fg", size=16, mono=True, anchor=None, extra=""):
        a = f' text-anchor="{anchor}"' if anchor else ""
        return (f'<text x="{x}" y="{y}" font-size="{size}" class="{"m " if mono else ""}{cls}"{a}{extra}>'
                f'{s if s.startswith("<tspan") else e(s)}</text>')

    def g(cls, inner, extra=""):
        return f'<g class="{cls}"{extra}>{inner}</g>'

    def typed(x, y, inner_svg, plain, t0, size=16, hide_at=None, speed=0.032):
        """Text revealed by a cover that slides right in steps, with a caret riding its left edge."""
        w = tw(plain, size) + 6
        n = len(plain)
        dur = min(0.55, max(0.22, n * speed))
        mv = k.typing(t0, dur, w, n, hide_at)
        caret = k.fade([(t0, t0 + dur + 0.12)], fade=0.01)
        top = y - size + 1
        return (inner_svg +
                f'<g class="{mv}"><rect x="{x - 1}" y="{top - 3}" width="{w + 2:.1f}" height="{size + 9}" class="cv"/>'
                f'<rect x="{x - 1}" y="{top}" width="2" height="{size + 3}" class="ac {caret}"/></g>')

    # ---------------------------------------------------------------- frame and header
    o.append(f'<rect x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="18" fill="var(--bg)" stroke="var(--line)"/>')
    captions = [
        ("Four Claude Code sessions. One machine.", None),
        ("Two dev servers, one port. The second one moves.", B[0]),
        ("pkill node would take down every session's server.", B[1]),
        ("A parallel disk scan, cut down to one folder.", B[2]),
        ("git add -A would sweep in another session's edits.", B[3]),
        ("The third heavy job waits for RAM, then runs.", B[4]),
        ("bulkhead scan shows what it would have stopped.", END),
    ]
    for i, (cap, t0) in enumerate(captions):
        if t0 is None:
            cls = k.add([(0, "opacity:1;transform:translate(0px,0px)", None),
                         (INTRO - 0.3, "opacity:1;transform:translate(0px,0px)", INOUT),
                         (INTRO - 0.02, "opacity:0;transform:translate(0px,-4px)", None),
                         (RESET + 0.1, "opacity:0;transform:translate(0px,8px)", EASE),
                         (RESET + 0.45, "opacity:1;transform:translate(0px,0px)", None)])
        else:
            t_out = (RESET - 0.32) if t0 == END else t0 + BEAT - 0.32
            cls = k.show(t0, t_out, dy=8, fade=0.3)
        o.append(g(cls, t(X0, 50, cap, "fg b", 26, mono=False)))
    o.append(t(X1, 47, "acme-web: 4 sessions, 1 machine", "dm", 15, anchor="end"))

    # ---------------------------------------------------------------- session cards
    actor_spans = {0: [(B[2], B[2] + BEAT - 0.3), (B[4], B[4] + BEAT - 0.3)],
                   1: [(B[0], B[0] + BEAT - 0.3), (B[4], B[4] + BEAT - 0.3)],
                   2: [(B[1], B[1] + BEAT - 0.3), (B[4], B[4] + BEAT - 0.3)],
                   3: [(B[3], B[3] + BEAT - 0.3)]}
    status = {
        0: [(0, B[2], "editing src/cart.tsx", "mu"), (B[2], B[3], "checking disk usage", "mu"),
            (B[3], B[4], "editing 5 files here", "am"), (B[4], B[4] + 0.6, "starting next build", "mu"),
            (B[4] + 0.6, B[4] + 2.5, "next build   4 GB", "ac"),
            (B[4] + 2.5, RESET, "build finished", "mu")],
        1: [(0, B[0], "editing cart page", "mu"), (B[0], B[0] + 2.6, "starting dev server", "mu"),
            (B[0] + 2.6, B[4] + 1.1, "dev server :3001", "mu"),
            (B[4] + 1.1, RESET, "playwright   4 GB", "ac")],
        2: [(0, B[1], "dev server :3002", "mu"), (B[1], B[1] + BEAT, "restarting its server", "mu"),
            (B[1] + BEAT, B[4] + 1.6, "dev server :3002", "mu"),
            (B[4] + 1.6, B[4] + 2.7, "npm test   waiting", "am"), (B[4] + 2.7, RESET, "npm test   3 GB", "ac")],
        3: [(0, B[3], "writing docs/setup.md", "mu"), (B[3], B[4], "committing 2 files", "mu"),
            (B[4], RESET, "committed 3f9c2e1", "mu")],
    }
    for i, (br, path) in enumerate(SESS):
        x = card_x(i)
        o.append(f'<rect x="{x + .5}" y="{CARD_Y + .5}" width="{CARD_W - 1}" height="{CARD_H - 1}" rx="12" class="pn"/>')
        hl = k.fade(actor_spans[i], fade=0.3)
        o.append(f'<rect x="{x + .5}" y="{CARD_Y + .5}" width="{CARD_W - 1}" height="{CARD_H - 1}" rx="12" '
                 f'fill="none" stroke="var(--ac)" stroke-width="1.5" class="{hl}"/>')
        if i == 0:
            warn = k.fade([(B[3] + 0.9, B[3] + BEAT - 0.3)], fade=0.3)
            o.append(f'<rect x="{x + .5}" y="{CARD_Y + .5}" width="{CARD_W - 1}" height="{CARD_H - 1}" rx="12" '
                     f'fill="none" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="5 4" class="{warn}"/>')
        o.append(f'<circle cx="{x + 24}" cy="{CARD_Y + 25}" r="4.5" class="ac"/>')
        o.append(t(x + 38, CARD_Y + 31, br, "fg b", 17))
        o.append(t(x + 20, CARD_Y + 55, path, "dm", 15))
        for (a, b_, s, c) in status[i]:
            if a <= 0:
                spans = [(0, b_ - 0.25), (RESET + 0.1, None)]
            elif b_ >= RESET:
                spans = [(a, RESET - 0.3)]
            else:
                spans = [(a, b_ - 0.25)]
            cls = k.fade(spans, fade=0.25)
            o.append(g(cls, t(x + 20, CARD_Y + 80, s, c, 15)))
        # badge at the top right
        bx = x + CARD_W - 16
        if i in (0, 2):
            lab = ":3000" if i == 0 else ":3002"
            o.append(f'<rect x="{bx - 66}" y="{CARD_Y + 12}" width="66" height="26" rx="13" fill="var(--acbg)" '
                     f'stroke="var(--ac)" stroke-opacity=".45"/>')
            o.append(t(bx - 33, CARD_Y + 30, lab, "ac sb", 15, anchor="middle"))
        elif i == 1:
            cls = k.fade([(B[0] + 2.6, RESET - 0.3)], fade=0.35)
            o.append(g(cls, f'<rect x="{bx - 66}" y="{CARD_Y + 12}" width="66" height="26" rx="13" fill="var(--acbg)" '
                            f'stroke="var(--ac)" stroke-opacity=".45"/>' + t(bx - 33, CARD_Y + 30, ":3001", "ac sb", 15, anchor="middle")))
        else:
            o.append(f'<rect x="{bx - 76}" y="{CARD_Y + 12}" width="76" height="26" rx="13" fill="none" '
                     f'stroke="var(--line2)"/>')
            o.append(t(bx - 38, CARD_Y + 30, "shared", "mu", 15, anchor="middle"))

    # ---------------------------------------------------------------- terminal
    o.append(f'<rect x="{X0 + .5}" y="{TERM_Y + .5}" width="{X1 - X0 - 1}" height="{TERM_H - 1}" rx="12" class="tm"/>')
    o.append(f'<path d="M{X0 + 1} {TERM_Y + 40.5}H{X1 - 1}" class="ln"/>')
    for j in range(3):
        o.append(f'<circle cx="{X0 + 22 + j * 16}" cy="{TERM_Y + 20}" r="5" fill="var(--line2)"/>')
    o.append(f'<circle cx="{X1 - 20 - 16 * 0.6 * 15 - 14:.0f}" cy="{TERM_Y + 21}" r="4" class="ac"/>')
    o.append(t(X1 - 20, TERM_Y + 26, "machine: healthy", "mu", 15, anchor="end"))
    o.append(f'<clipPath id="tc"><rect x="{X0 + 1}" y="{TERM_Y + 41}" width="{X1 - X0 - 2}" height="{TERM_H - 42}" rx="11"/></clipPath>')

    labels = [
        (None, "4 sessions", "  each in its own git worktree"),
        (B[0], SESS[1][0], "  " + SESS[1][1]),
        (B[1], SESS[2][0], "  " + SESS[2][1]),
        (B[2], SESS[0][0], "  " + SESS[0][1]),
        (B[3], SESS[3][0], "  " + SESS[3][1] + "  (main is editing here too)"),
        (B[4], "3 sessions", "  heavy jobs through bulkhead-slot"),
        (END, "~/code", "  you, in any terminal"),
    ]
    LX = X0 + 84
    for t0, a, rest in labels:
        txt = f'<tspan class="fg sb">{e(a)}</tspan><tspan class="dm">{e(rest)}</tspan>'
        if t0 is None:
            cls = k.fade([(0, INTRO - 0.3), (RESET + 0.1, None)], fade=0.25)
        else:
            cls = k.fade([(t0, (RESET - 0.3) if t0 == END else t0 + BEAT - 0.3)], fade=0.25)
        o.append(g(cls, t(LX, TERM_Y + 26, txt, "fg", 15)))

    body = []
    # intro text
    intro = k.fade([(0, INTRO - 0.3), (RESET + 0.1, None)], fade=0.25)
    body.append(g(intro,
                  t(TX, TY0, "Each session thinks it has the machine to itself.", "mu", 16)
                  + t(TX, TY0 + TLH, "bulkhead's hooks check every shell command before it runs, and say what to run instead.", "dm", 15)
                  + f'<rect x="{TX}" y="{TY0 + 2 * TLH - 15}" width="9" height="18" class="ac"/>'))

    def dot(x, y, cls):
        return f'<circle cx="{x}" cy="{y - 5}" r="4.5" class="{cls}"/>'

    def elbow(x, y):
        return f'<path d="M{x} {y - 16}V{y - 6}H{x + 10}" fill="none" stroke="var(--dim)" stroke-width="1.5"/>'

    def check(x, y):
        return f'<path d="M{x} {y - 6}l4 4l8 -9" fill="none" stroke="var(--ac)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'

    def guard_beat(b, cmd, guard, msg, notes, safe, result, ok=True, extra_after=""):
        out_t = b + BEAT - 0.35
        hide = out_t + 0.4
        parts = []
        y = TY0
        # A: the blocked call
        red = k.fade([(b + 0.95, None)], fade=0.15)
        plain = f"Bash({cmd})"
        a_svg = (dot(TX + 4, y, "ac") + g(red, dot(TX + 4, y, "rd"))
                 + t(TX + 18, y, f'<tspan class="b">Bash(</tspan>{e(cmd)}<tspan class="b">)</tspan>', "fg", 16))
        parts.append(typed(TX + 18, y, a_svg, plain, b + 0.25, hide_at=hide))
        sx, sw = TX + 18 + tw("Bash(", 16) * 0.97, tw(cmd, 16) * 0.97
        strike = k.add([(0, "transform:scaleX(0)", None), (b + 0.9, "transform:scaleX(0)", EASE),
                        (b + 1.15, "transform:scaleX(1)", None), (hide, "transform:scaleX(1)", None),
                        (hide + 0.01, "transform:scaleX(0)", None)],
                       base=f"transform-origin:{sx:.1f}px {y - 5}px")
        parts.append(f'<path d="M{sx:.1f} {y - 5}h{sw:.1f}" stroke="var(--red)" stroke-width="2" class="{strike}"/>')
        # B + notes: the block message on a tinted band
        y1 = y + TLH
        band_h = TLH * (1 + len(notes)) + 2
        band = k.show(b + 0.95, None, dy=0, dx=-6, fade=0.3)
        parts.append(g(band, f'<rect x="{TX + 14}" y="{y1 - 20}" width="{X1 - TX - 34}" height="{band_h}" rx="6" '
                             f'fill="var(--redbg)"/><rect x="{TX + 14}" y="{y1 - 20}" width="3" height="{band_h}" class="rd"/>'))
        bl = k.show(b + 1.0, None, dy=6, fade=0.32)
        parts.append(g(bl, t(TX + 30, y1, f'<tspan class="b">[bulkhead] {e(guard)}:</tspan> {e(msg)}', "rd", 16)))
        for j, n in enumerate(notes):
            nl = k.show(b + 1.15 + 0.12 * j, None, dy=6, fade=0.32)
            parts.append(g(nl, t(TX + 30, y1 + TLH * (j + 1), n, "mu", 15)))
        # D: the safer call
        y2 = y1 + TLH * (1 + len(notes)) + 6
        d_svg = dot(TX + 4, y2, "ac") + t(TX + 18, y2, f'<tspan class="b">Bash(</tspan>{e(safe)}<tspan class="b">)</tspan>', "fg", 16)
        dshow = k.show(b + 1.7, None, dy=0, fade=0.01)
        parts.append(g(dshow, typed(TX + 18, y2, d_svg, f"Bash({safe})", b + 1.75, hide_at=hide)))
        # E: what came back
        y3 = y2 + TLH
        es = k.show(b + 2.45, None, dy=6, fade=0.32)
        res = elbow(TX + 6, y3) + (check(TX + 24, y3) + t(TX + 44, y3, result, "fg", 16) if ok else t(TX + 26, y3, result, "mu", 16))
        parts.append(g(es, res + extra_after))
        grp = k.add([(0, "opacity:0", None), (b, "opacity:0", EASE), (b + 0.3, "opacity:1", None),
                     (out_t, "opacity:1", INOUT), (out_t + 0.3, "opacity:0", None)])
        return g(grp, "".join(parts))

    body.append(guard_beat(
        B[0], "npm run dev", "port-guard",
        "port 3000 is already used by another Claude session (~/code/acme-web).",
        ["If you start yours anyway, requests to localhost:3000 reach the other project. Port 3001 is free:"],
        "npm run dev -- --port 3001", "Ready on http://localhost:3001"))
    body.append(guard_beat(
        B[1], "pkill node", "kill-guard", "pkill/killall matches every process with that name",
        ["Killing by name takes down their dev servers, test runs and builds, and can end your own session.",
         "Stop only the processes you started, by PID: lsof -ti :3002, then kill <pid>"],
        "kill $(lsof -ti :3002) && npm run dev -- --port 3002",
        "Ready on http://localhost:3002", extra_after=""))
    body.append(guard_beat(
        B[2], "ls ~ | xargs -P 10 du -sh", "disk-guard", "`ls ~ | xargs -P 10 du -sh` runs disk scans through xargs -P.",
        ["Several scans at once keep the disk at 100% and freeze the other sessions.",
         "Run one du at a time, in the foreground: du -sh <one folder>."],
        "du -sh ./node_modules", "1.2G    ./node_modules", ok=False))
    body.append(guard_beat(
        B[3], 'git add -A && git commit -m "docs: setup guide"', "checkout-guard",
        "`git add -A` stages every change in ~/code/acme-web (7 files),",
        ["and another Claude session works in the same tree (pid 4120).",
         "Some of those changes are probably its half-finished work, and they would go into your commit."],
        'git commit -m "docs: setup guide" -- README.md docs/setup.md',
        "[docs/setup 3f9c2e1] docs: setup guide, 2 files changed"))

    # ---- slot beat
    b = B[4]
    out_t = b + BEAT - 0.35
    sp = []
    rows = [("main", "bulkhead-slot run --gb=4 -- next build", b + 0.15),
            ("feat/checkout", "bulkhead-slot run --gb=4 -- npx playwright test", b + 0.65),
            ("fix/auth", "bulkhead-slot run --gb=3 -- npm test", b + 1.15)]
    CMDX = TX + 150
    CHIPX = X1 - 24 - 136
    for j, (br, cmd, t0) in enumerate(rows):
        y = TY0 + TLH * j
        rs = k.show(t0, None, dy=6, fade=0.3)
        sp.append(g(rs, t(TX, y, br, "bl sb", 16) + t(CMDX - 14, y, "$", "dm", 16)))
        sp.append(g(rs, typed(CMDX, y, t(CMDX, y, cmd, "fg", 16), cmd, t0 + 0.05, hide_at=out_t + 0.4, speed=0.012)))

    def chip(y, label, kind, t_in, t_out):
        fillv, strokev, txt = {"run": ("var(--acbg)", "var(--ac)", "ac"), "wait": ("var(--amberbg)", "var(--amber)", "am"),
                               "done": ("none", "var(--line2)", "dm")}[kind]
        cls = k.fade([(t_in, t_out - 0.22)], fade=0.22)
        return g(cls, f'<rect x="{CHIPX}" y="{y - 18}" width="136" height="26" rx="13" fill="{fillv}" stroke="{strokev}" '
                      f'stroke-opacity=".55"/>' + t(CHIPX + 68, y, label, txt + " sb", 15, anchor="middle"))

    y0, y1_, y2_ = TY0, TY0 + TLH, TY0 + 2 * TLH
    sp.append(chip(y0, "running 4 GB", "run", b + 0.6, b + 2.5))
    sp.append(chip(y0, "done", "done", b + 2.5, out_t))
    sp.append(chip(y1_, "running 4 GB", "run", b + 1.1, out_t))
    sp.append(chip(y2_, "waiting", "wait", b + 1.6, b + 2.7))
    sp.append(chip(y2_, "running 3 GB", "run", b + 2.7, out_t))
    w1 = k.show(b + 1.7, None, dy=6, fade=0.3)
    sp.append(g(w1, t(TX + 16, TY0 + 3 * TLH + 4,
                       "[bulkhead-slot] waiting: free 7.0 GB - this job 3 GB = 4.0 GB, below the 5 GB floor", "am", 15)))
    w2 = k.show(b + 2.75, None, dy=6, fade=0.3)
    sp.append(g(w2, t(TX + 16, TY0 + 4 * TLH + 4, "[bulkhead-slot] running npm test (3 GB)", "ac", 15)))
    sgrp = k.add([(0, "opacity:0", None), (b, "opacity:0", EASE), (b + 0.3, "opacity:1", None),
                  (out_t, "opacity:1", INOUT), (out_t + 0.3, "opacity:0", None)])
    body.append(g(sgrp, "".join(sp)))

    # ---- end card: bulkhead scan
    b = END
    out_t = RESET - 0.35
    ep = []
    ep.append(typed(TX + 18, TY0, t(TX, TY0, '<tspan class="ac b">$ </tspan><tspan class="fg">bulkhead scan</tspan>', "fg", 16),
                    "bulkhead scan", b + 0.2, hide_at=out_t + 0.4))
    l2 = k.show(b + 0.75, None, dy=6, fade=0.3)
    ep.append(g(l2, t(TX + 18, TY0 + TLH, f"read     {SCAN['files']} transcripts ({SCAN['kb']} KB), "
                                          f"{SCAN['files']} sessions, {SCAN['shell']} shell commands", "mu", 15)))
    l3 = k.show(b + 0.9, None, dy=6, fade=0.3)
    ep.append(g(l3, t(TX + 18, TY0 + 2 * TLH, f"overlap  up to {SCAN['overlap']} sessions running at once", "mu", 15)))
    tiles = [(SCAN["commands"], "commands it would have stopped"), (SCAN["sessions"], "sessions they came from"),
             (SCAN["overlap"], "sessions running at once, at most")]
    TW_ = (X1 - TX - 28 - 2 * 16) / 3
    ty = TY0 + 2 * TLH + 20
    for j, (num, lab) in enumerate(tiles):
        x = TX + j * (TW_ + 16)
        t0 = b + 1.1 + 0.15 * j
        sh = k.show(t0, None, dy=10, fade=0.4)
        inner = (f'<rect x="{x}" y="{ty}" width="{TW_:.1f}" height="92" rx="10" fill="var(--bar)" stroke="var(--line)"/>'
                 + t(x + 22, ty + 80, lab, "mu", 15, mono=False))
        # counter: a few values shown one after another
        steps = 9
        vals = sorted(set([round(num * (1 - (1 - s / steps) ** 2)) for s in range(1, steps + 1)]))
        tt = t0 + 0.15
        dt = 0.07
        for vi, v in enumerate(vals):
            a_ = tt + vi * dt
            last = vi == len(vals) - 1
            fr = [(0, "opacity:0", None), (a_, "opacity:0", None), (a_ + 0.005, "opacity:1", None)]
            if not last:
                fr += [(a_ + dt, "opacity:1", None), (a_ + dt + 0.005, "opacity:0", None)]
            c = k.add(fr)
            inner += g(c, t(x + 22, ty + 52, str(v), "ac b" if j == 0 else "fg b", 40, mono=False))
        ep.append(g(sh, inner))
    egrp = k.add([(0, "opacity:0", None), (b, "opacity:0", EASE), (b + 0.3, "opacity:1", None),
                  (out_t, "opacity:1", INOUT), (out_t + 0.3, "opacity:0", None)])
    body.append(g(egrp, "".join(ep)))
    o.append(f'<g clip-path="url(#tc)">{"".join(body)}</g>')

    # ---------------------------------------------------------------- machine strip
    o.append(f'<rect x="{X0 + .5}" y="{STRIP_Y + .5}" width="{X1 - X0 - 1}" height="{STRIP_H - 1}" rx="12" class="pn"/>')
    D1, D2 = 640, 900
    o.append(f'<path d="M{D1 + .5} {STRIP_Y + 18}V{STRIP_Y + STRIP_H - 18}M{D2 + .5} {STRIP_Y + 18}V{STRIP_Y + STRIP_H - 18}" class="ln"/>')
    ly = STRIP_Y + 32
    # RAM
    rx0, rx1 = X0 + 24, D1 - 24
    gb = (rx1 - rx0) / 32
    o.append(t(rx0, ly, "RAM", "dm sb", 15, extra=' letter-spacing="1.5"'))
    frees = [(0, B[4] + 0.6, "15.0"), (B[4] + 0.6, B[4] + 1.1, "11.0"), (B[4] + 1.1, B[4] + 2.5, "7.0"),
             (B[4] + 2.5, B[4] + 2.7, "11.0"), (B[4] + 2.7, B[4] + BEAT - 0.3, "8.0")]
    for a, b_, v in frees:
        spans = [(0, b_ - 0.18), (B[4] + BEAT - 0.3 + 0.2, None)] if a == 0 else [(a, b_ - 0.18)]
        cls = k.fade(spans, fade=0.18)
        o.append(g(cls, t(rx1, ly, f'<tspan class="fg sb">free {v} GB</tspan><tspan class="dm"> of 32 GB</tspan>', "fg", 15, anchor="end")))
    by = STRIP_Y + 52
    bh = 18
    o.append(f'<rect x="{rx0}" y="{by}" width="{rx1 - rx0}" height="{bh}" rx="5" fill="var(--track)"/>')
    o.append(f'<rect x="{rx0}" y="{by}" width="{17 * gb:.1f}" height="{bh}" rx="5" fill="var(--base)"/>')

    def seg(gb0, size, t_in, t_out, cls_extra=""):
        x = rx0 + gb0 * gb
        fr = [(0, "transform:scaleX(0)", None), (t_in, "transform:scaleX(0)", EASE), (t_in + 0.4, "transform:scaleX(1)", None)]
        fr += [(t_out, "transform:scaleX(1)", INOUT), (t_out + 0.35, "transform:scaleX(0)", None)]
        c = k.add(fr, base=f"transform-origin:{x:.1f}px {by}px")
        return f'<rect x="{x + 1:.1f}" y="{by}" width="{size * gb - 2:.1f}" height="{bh}" rx="3" class="ac {c}"/>'
    b = B[4]
    o.append(seg(17, 4, b + 0.6, b + 2.5))
    o.append(seg(21, 4, b + 1.1, b + BEAT - 0.3))
    o.append(seg(17, 3, b + 2.75, b + BEAT - 0.3))
    ghost = k.fade([(b + 1.6, b + 2.7)], fade=0.25)
    gx = rx0 + 25 * gb
    o.append(f'<rect x="{gx + 1:.1f}" y="{by + 1}" width="{3 * gb - 2:.1f}" height="{bh - 2}" rx="3" fill="var(--amberbg)" '
             f'stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="4 3" class="{ghost}"/>')
    fx = rx0 + 27 * gb
    o.append(f'<path d="M{fx:.1f} {by - 6}V{by + bh + 6}" stroke="var(--red)" stroke-width="2"/>')
    o.append(t(fx, by + bh + 26, "5 GB floor", "rd", 15, anchor="middle"))
    o.append(f'<rect x="{rx0}" y="{by + bh + 14}" width="12" height="12" rx="3" fill="var(--base)"/>')
    o.append(t(rx0 + 20, by + bh + 26, "sessions and dev servers", "dm", 15))
    leg = k.fade([(B[4] + 0.6, B[4] + BEAT - 0.3)], fade=0.3)
    o.append(g(leg, f'<rect x="{rx0}" y="{by + bh + 40}" width="12" height="12" rx="3" class="ac"/>'
                    + t(rx0 + 20, by + bh + 52, "jobs in bulkhead-slot", "dm", 15)
                    + f'<rect x="{rx0 + 240}" y="{by + bh + 40}" width="12" height="12" rx="3" fill="var(--amberbg)" stroke="var(--amber)" stroke-dasharray="3 2"/>'
                    + t(rx0 + 260, by + bh + 52, "waiting for room", "dm", 15)))
    # DISK
    dx0, dx1 = D1 + 24, D2 - 24
    o.append(t(dx0, ly, "DISK I/O", "dm sb", 15, extra=' letter-spacing="1.5"'))
    o.append(t(dx1, ly, "9%", "fg sb", 15, anchor="end"))
    nb = 14
    bw = (dx1 - dx0) / nb
    base_y = by + 52
    heights = [18, 28, 14, 22, 34, 19, 12, 26, 21, 31, 16, 24, 17, 11]
    durs = [2.5, 5, 2.5, 5, 2.5, 5, 2.5, 5, 2.5, 5, 2.5, 5, 2.5, 5]
    shimmer_css = []
    for j in range(nb):
        x = dx0 + j * bw
        h = heights[j]
        name = f"sh{j % 4}"
        delay = -(j * 0.37) % durs[j]
        o.append(f'<rect x="{x + 2:.1f}" y="{base_y - h}" width="{bw - 4:.1f}" height="{h}" rx="2" fill="var(--ac)" '
                 f'fill-opacity=".75" style="transform-origin:{x:.1f}px {base_y}px;animation:{name} {durs[j]}s {delay:.2f}s ease-in-out infinite"/>')
    shimmer_css.append("@keyframes sh0{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.6)}}"
                       "@keyframes sh1{0%,100%{transform:scaleY(.8)}50%{transform:scaleY(1.25)}}"
                       "@keyframes sh2{0%,100%{transform:scaleY(1.1)}50%{transform:scaleY(.7)}}"
                       "@keyframes sh3{0%,100%{transform:scaleY(.7)}50%{transform:scaleY(1.15)}}")
    o.append(f'<path d="M{dx0} {base_y + .5}H{dx1}" class="l2"/>')
    # the scan that did not happen
    b = B[2]
    spike = k.add([(0, "opacity:0;transform:scaleY(0)", None), (b + 0.55, "opacity:0;transform:scaleY(0)", EASE),
                   (b + 0.85, "opacity:1;transform:scaleY(1)", None), (b + 1.0, "opacity:1;transform:scaleY(1)", IN),
                   (b + 1.35, "opacity:0;transform:scaleY(0)", None)],
                  base=f"transform-origin:{dx0}px {base_y}px")
    o.append(f'<rect x="{dx0 + 1}" y="{by - 4}" width="{dx1 - dx0 - 2}" height="{base_y - by + 4}" rx="4" fill="var(--redbg)" '
             f'stroke="var(--red)" stroke-width="1.5" stroke-dasharray="5 4" class="{spike}"/>')
    blk = k.fade([(b + 1.0, b + BEAT - 0.4)], fade=0.3)
    o.append(g(blk, t(dx0, by + bh + 52, "10 parallel scans blocked", "rd", 15)))
    norm = k.fade([(0, b + 0.9), (b + BEAT - 0.1, None)], fade=0.3)
    o.append(g(norm, t(dx0, by + bh + 52, "shared by 4 sessions", "dm", 15)))
    # PORTS
    px0 = D2 + 24
    o.append(t(px0, ly, "LISTENING", "dm sb", 15, extra=' letter-spacing="1.5"'))
    rowsP = [(":3000", "main"), (":3001", "feat/checkout"), (":3002", "fix/auth")]
    for j, (pt, who) in enumerate(rowsP):
        y = STRIP_Y + 66 + j * 28
        if j == 1:
            on = k.fade([(B[0] + 2.75, RESET - 0.3)], fade=0.35)
            off = k.fade([(0, B[0] + 2.45), (RESET - 0.05, None)], fade=0.3)
            o.append(g(off, f'<circle cx="{px0 + 5}" cy="{y - 5}" r="4.5" fill="none" stroke="var(--dim)" stroke-width="1.5"/>'
                            + t(px0 + 20, y, pt, "dm", 15) + t(px0 + 84, y, "free", "dm", 15)))
            o.append(g(on, f'<circle cx="{px0 + 5}" cy="{y - 5}" r="4.5" class="ac"/>'
                           + t(px0 + 20, y, pt, "fg sb", 15) + t(px0 + 84, y, who, "mu", 15)))
        else:
            o.append(f'<circle cx="{px0 + 5}" cy="{y - 5}" r="4.5" class="ac"/>'
                     + t(px0 + 20, y, pt, "fg sb", 15) + t(px0 + 84, y, who, "mu", 15))
        # pulse when kill-guard keeps them alive
        if True:
            tb = B[1] + 1.0
            pr = k.add([(0, "opacity:0;transform:scale(1)", None), (tb, "opacity:.9;transform:scale(1)", EASE),
                        (tb + 0.9, "opacity:0;transform:scale(3)", None),
                        (tb + 1.0, "opacity:.9;transform:scale(1)", EASE), (tb + 1.9, "opacity:0;transform:scale(3)", None)],
                       base=f"transform-origin:{px0 + 5}px {y - 5}px")
            o.append(f'<circle cx="{px0 + 5}" cy="{y - 5}" r="4.5" fill="none" stroke="var(--ac)" stroke-width="1.5" class="{pr}"/>')
    kept = k.fade([(B[1] + 1.0, B[1] + BEAT - 0.4)], fade=0.3)
    o.append(g(kept, t(X1 - 24, ly, "all still up", "ac sb", 15, anchor="end")))

    style = "\n".join(css) + "\n" + "".join(shimmer_css) + "\n"
    style += k.static_css() if still_only else (k.css() + "\n" + k.still_css())
    return style, "".join(o)


TITLE = "claude-bulkhead: four Claude Code sessions sharing one machine without hurting each other"
DESC = ("Animated loop of four Claude Code sessions, each in its own git worktree of acme-web, on one machine with a "
        "status strip for RAM, disk I/O and listening ports. port-guard moves a second dev server from port 3000 to "
        "3001. kill-guard blocks pkill node and the agent restarts its own server by PID. disk-guard blocks a "
        "parallel du over the home folder and the agent measures one folder. checkout-guard blocks git add -A in a "
        "tree another session is editing and the agent commits only its own two files. bulkhead-slot makes a third "
        "heavy job wait for RAM, then runs it. The loop ends on bulkhead scan: 24 commands in 13 sessions would have "
        "been stopped, with up to 4 sessions running at once. The machine stays healthy throughout.")


def write(path, pal, still_only=False):
    style, body = build(pal, still_only)
    svg = svg_doc(W, H, TITLE, DESC, style, body, "hero")
    with open(path, "w") as f:
        f.write(svg)
    return len(svg.encode())


if __name__ == "__main__":
    import os
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..")
    print("hero.svg", write(os.path.join(out, "hero.svg"), DARK))
    print("hero-light.svg", write(os.path.join(out, "hero-light.svg"), LIGHT))
