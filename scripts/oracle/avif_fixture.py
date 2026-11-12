"""
TT148 test-only fixture generator (FF-06).

Emits a small AVIF encoded by Pillow/libavif and the dimensions Pillow reports
for it, as JSON on stdout. The app is then asked to identify the same bytes and
(a real browser) to decode them — so the fixture is produced by one independent
implementation and consumed by another, never by the code under test.

Nothing here ships in Fusion: this file exists only for the suites.
"""
import base64
import io
import json
import sys

from PIL import Image


def main() -> int:
    w, h = 24, 16
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 10) % 256, (y * 15) % 256, ((x + y) * 7) % 256)
    buf = io.BytesIO()
    im.save(buf, format="AVIF", quality=90)
    data = buf.getvalue()
    # Pillow's own reading of what it just wrote.
    back = Image.open(io.BytesIO(data))
    json.dump({
        "bytes": base64.b64encode(data).decode(),
        "width": back.width,
        "height": back.height,
        "format": back.format,
        "encoder": f"Pillow {Image.__version__}",
        "samples": [[px[0, 0][0], px[0, 0][1], px[0, 0][2]]],
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
