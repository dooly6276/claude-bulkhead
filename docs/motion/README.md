# Motion assets

Python 3 (stdlib only) sources for the animated README graphics. They write:

- `docs/hero.svg`, `docs/hero-light.svg`: four Claude Code sessions on one machine, five guard moments, then the `bulkhead scan` result (25 s loop).
- `docs/scan.svg`, `docs/scan-light.svg`: a terminal running `bulkhead scan` (16 s loop). The text is the real output of the tool on the synthetic transcripts from `scripts/demo-scan/make-transcripts.js`, regenerated on every build.
- `docs/social-preview.png`: the 1280x640 GitHub social card, a still of the hero under the title.

Rebuild everything from the repository root:

```sh
PLAYWRIGHT=/path/to/node_modules/playwright python3 docs/motion/build.py
```

`node` must be on PATH (the scan text comes from `bin/bulkhead scan`). Playwright is only used to render the PNG and is not a dependency of this repo; pass `--no-png` to skip it.

The SVGs use CSS keyframes only (no script, no external fonts), share one period per file so they loop seamlessly, and show a fully revealed still frame under `prefers-reduced-motion`.

| File | Role |
|---|---|
| `common.py` | palettes, the keyframe helper (`KF`), SVG wrapper |
| `hero.py` | hero timeline and layout |
| `scan.py` | runs the scan demo and animates its output |
| `social.py` | social card SVG |
| `render.js` | social card SVG to PNG |
| `build.py` | runs all of the above |
