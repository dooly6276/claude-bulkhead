"""Rebuilds every motion asset: docs/hero.svg, docs/hero-light.svg, docs/scan.svg, docs/scan-light.svg,
and docs/social-preview.png. Run from anywhere: python3 docs/motion/build.py"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.dirname(HERE)
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)

import hero      # noqa: E402
import scan      # noqa: E402
import social    # noqa: E402
from common import DARK, LIGHT  # noqa: E402

LIMIT = 80 * 1024


def main():
    sizes = {
        "hero.svg": hero.write(os.path.join(DOCS, "hero.svg"), DARK),
        "hero-light.svg": hero.write(os.path.join(DOCS, "hero-light.svg"), LIGHT),
    }
    lines = scan.scan_output()
    sizes["scan.svg"] = scan.write(os.path.join(DOCS, "scan.svg"), DARK, lines)[0]
    sizes["scan-light.svg"] = scan.write(os.path.join(DOCS, "scan-light.svg"), LIGHT, lines)[0]
    for name, n in sizes.items():
        print(f"{name:16} {n / 1024:5.1f} KB" + ("  OVER 80 KB" if n > LIMIT else ""))
    if "--no-png" not in sys.argv:
        with tempfile.TemporaryDirectory(prefix="bulkhead-social-") as tmp:
            card = os.path.join(tmp, "social.svg")
            with open(card, "w") as f:
                f.write(social.build())
            subprocess.run(["node", os.path.join(HERE, "render.js"), card], check=True)


if __name__ == "__main__":
    main()
