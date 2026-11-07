"""
TT148 test-only fixture generator (FF-06, negative case).

Writes a genuine HEIF/HEVC file — real bytes from libheif via pillow-heif, not a
hand-made header — as JSON on stdout. The app must refuse it *for the right
reason*, and a browser engine without an HEVC image decoder must fail to decode
it while decoding the AVIF fixture produced by avif_fixture.py. Two encoders,
two containers, same extensions: that is the case this pair exists to pin.

Test-only; nothing here ships in Fusion.
"""
import base64
import io
import json
import sys

import pillow_heif
from PIL import Image

pillow_heif.register_heif_opener()


def main() -> int:
    w, h = 20, 14
    im = Image.new("RGB", (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 12) % 256, (y * 18) % 256, ((x * y) * 5) % 256)
    buf = io.BytesIO()
    im.save(buf, format="HEIF", quality=80)
    data = buf.getvalue()
    brand = data[8:12].decode("ascii", "replace")
    json.dump({
        "bytes": base64.b64encode(data).decode(),
        "width": w,
        "height": h,
        "brand": brand,
        "encoder": f"pillow-heif {pillow_heif.__version__}",
    }, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
