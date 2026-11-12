#!/usr/bin/env python3
"""Decode QR matrices produced by `src/lib/qr.ts` with a real scanner engine.

This is the part of the QR verification that cannot be faked by construction: the
module grids come from the TypeScript encoder on stdin, and `zxing-cpp` — the C++
port of the ZXing barcode library, used by real camera apps — has to read them back.

Input (stdin):  {"cases": [{"payload": "...", "ecc": "M", "rows": ["##..", ...]}]}
Output (stdout): {"results": [{"decoded": "...", "ecLevel": "M", "format": "QRCode", "ok": true}]}

Requires: zxing-cpp, pillow, numpy (see docs/test-results/tt151-qr.json for the versions
actually used).
"""
import json
import sys

import numpy as np
import zxingcpp
from PIL import Image

SCALE = 10
QUIET = 4


def to_image(rows):
    n = len(rows)
    side = (n + 2 * QUIET) * SCALE
    pix = np.full((side, side), 255, dtype=np.uint8)
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch == "#":
                y0 = (y + QUIET) * SCALE
                x0 = (x + QUIET) * SCALE
                pix[y0:y0 + SCALE, x0:x0 + SCALE] = 0
    return Image.fromarray(pix)


def main():
    doc = json.load(sys.stdin)
    results = []
    for case in doc["cases"]:
        res = zxingcpp.read_barcode(to_image(case["rows"]))
        results.append({
            "decoded": None if res is None else res.text,
            "ecLevel": None if res is None else res.ec_level,
            "format": None if res is None else str(res.format),
            "ok": res is not None and res.text == case["payload"],
        })
    json.dump({
        "provenance": {
            "decoder": "zxing-cpp " + getattr(zxingcpp, "__version__", "?"),
            "scale": SCALE,
            "quietZone": QUIET,
        },
        "results": results,
    }, sys.stdout)


if __name__ == "__main__":
    main()
