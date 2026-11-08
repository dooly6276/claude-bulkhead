"""Shared helpers for the claude-bulkhead motion SVGs (Python 3 stdlib only).

The keyframe helper follows the one in antibody/assets/motion (same author, MIT).
Every animation runs on one shared period, so all of them stay in step and loop seamlessly.
"""
from xml.sax.saxutils import escape

MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace'
SANS = 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif'
CH = 0.61  # widest common monospace advance (em); used to size typing covers

DARK = {
    "bg": "#0a0e14", "panel": "#10161e", "term": "#0c1118", "bar": "#131b25", "line": "#1d2632",
    "line2": "#2a3646", "fg": "#e6edf3", "mute": "#9ba8b8", "dim": "#7a8798",
    "ac": "#34d6b4", "acbg": "#0f2a26", "red": "#ff7b72", "redbg": "#2a1517", "amber": "#e3b341",
    "amberbg": "#2a2213", "blue": "#79c0ff", "track": "#1a222d", "base": "#3a4a5e",
}
LIGHT = {
    "bg": "#f6f8fa", "panel": "#ffffff", "term": "#ffffff", "bar": "#f3f5f8", "line": "#e1e6ec",
    "line2": "#cdd5df", "fg": "#1f2328", "mute": "#4f5a66", "dim": "#5f6b78",
    "ac": "#0a7f6a", "acbg": "#e3f6f1", "red": "#c9252d", "redbg": "#fdecec", "amber": "#9a6200",
    "amberbg": "#fbf1dc", "blue": "#0969da", "track": "#e8ecf1", "base": "#b4c0cd",
}

EASE = "cubic-bezier(.22,1,.36,1)"      # ease-out-quint
BACK = "cubic-bezier(.34,1.4,.64,1)"    # gentle overshoot
INOUT = "cubic-bezier(.65,0,.35,1)"
IN = "cubic-bezier(.55,0,1,.45)"


def e(s):
    return escape(str(s), {'"': "&quot;"})


def vars_css(p):
    return "svg{" + ";".join(f"--{k}:{v}" for k, v in p.items()) + "}"


def tw(text, fs):
    """Upper bound of the rendered width of monospace text."""
    return len(text) * CH * fs


class KF:
    """Collects @keyframes for one shared period and remembers them for the still frame."""

    def __init__(self, period, still):
        self.period = period
        self.still = still
        self.blocks = []
        self.rules = []
        self.still_rules = []
        self.n = 0

    def pct(self, t):
        p = max(0.0, min(100.0, t / self.period * 100))
        return f"{p:.3f}".rstrip("0").rstrip(".") + "%"

    def add(self, frames, base=""):
        """frames: [(t, css, timing_or_None)]. Returns a class name to put on the element."""
        self.n += 1
        name = f"k{self.n}"
        frames = sorted(frames, key=lambda f: f[0])
        if frames[0][0] > 0:
            frames.insert(0, (0, frames[0][1], None))
        if frames[-1][0] < self.period:
            frames.append((self.period, frames[-1][1], None))
        out = []
        for t, css, tf in frames:
            body = css + (f";animation-timing-function:{tf}" if tf else "")
            out.append(f"{self.pct(t)}{{{body}}}")
        self.blocks.append(f"@keyframes {name}{{{''.join(out)}}}")
        self.rules.append(f".{name}{{animation:{name} {self.period}s linear infinite;{base}}}")
        # value held at the still time (callers keep the still time inside a hold)
        held = frames[0][1]
        for t, css, _ in frames:
            if t <= self.still + 1e-9:
                held = css
        self.still_rules.append(f".{name}{{{held}}}")
        return name

    # -- common shapes of motion ------------------------------------------------------------

    def show(self, t_in, t_out=None, dy=8, fade=0.35, ease=EASE, dx=0, out_dy=None):
        """Visible from t_in to t_out (None: until the end of the period)."""
        hid = f"opacity:0;transform:translate({dx}px,{dy}px)"
        on = "opacity:1;transform:translate(0px,0px)"
        fr = [(0, hid, None), (t_in, hid, ease), (t_in + fade, on, None)]
        if t_out is not None:
            o = dy * -0.5 if out_dy is None else out_dy
            fr += [(t_out, on, INOUT), (t_out + fade * 0.8, f"opacity:0;transform:translate(0px,{o}px)", None)]
        return self.add(fr)

    def fade(self, spans, fade=0.3, lo=0.0, hi=1.0, ease=EASE):
        """Opacity hi during each (t_in, t_out) span, lo otherwise. t_in may be 0 (shown at start)."""
        fr = [(0, f"opacity:{lo}", None)]
        for a, b in spans:
            if a <= 0:
                fr = [(0, f"opacity:{hi}", None)]
            else:
                fr += [(a, f"opacity:{lo}", ease), (a + fade, f"opacity:{hi}", None)]
            if b is not None and b < self.period:
                fr += [(b, f"opacity:{hi}", INOUT), (b + fade, f"opacity:{lo}", None)]
        return self.add(fr)

    def typing(self, t0, dur, width, n, hide_at=None):
        """Slides a cover off text: translateX 0 -> width in n steps. Resets after hide_at."""
        fr = [(0, "transform:translate(0px,0px)", None), (t0, "transform:translate(0px,0px)", f"steps({max(1, n)},end)"),
              (t0 + dur, f"transform:translate({width:.1f}px,0px)", None)]
        if hide_at is not None:
            fr += [(hide_at, f"transform:translate({width:.1f}px,0px)", None),
                   (hide_at + 0.01, "transform:translate(0px,0px)", None)]
        return self.add(fr)

    def css(self):
        return "\n".join(self.blocks + self.rules)

    def still_css(self):
        return "@media (prefers-reduced-motion:reduce){*{animation:none!important}" + "".join(self.still_rules) + "}"

    def static_css(self):
        return "*{animation:none!important}" + "".join(self.still_rules)


def svg_doc(w, h, title, desc, css, body, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'role="img" aria-labelledby="t d" xml:space="preserve" font-family="{e(SANS)}">'
            + f'<title id="t">{e(title)}</title><desc id="d">{e(desc)}</desc>'
            + f"<style>{css}</style>{body}</svg>")
