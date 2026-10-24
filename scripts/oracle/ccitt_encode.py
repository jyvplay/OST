"""Test-only oracle: encode bitmaps with libtiff's CCITT encoders (through Pillow) and print JSONL
{name, w, h, k, eol, bits(hex of packed raw rows, 1 = CCITT black run), data(hex of the compressed strip)}.
libtiff is an independent implementation of ITU-T T.4/T.6; our decoder (src/lib/pdf/pdfccitt.ts) must reproduce
the original bitmap from libtiff's bytes exactly."""
import io, json, random, struct, sys
from PIL import Image, TiffImagePlugin

def bitmaps(seed=7):
    rnd = random.Random(seed)
    def img(w, h, f):
        im = Image.new("1", (w, h), 1)  # 1 = paper (white)
        px = im.load()
        for y in range(h):
            for x in range(w):
                if f(x, y): px[x, y] = 0  # ink
        return im
    yield "white", img(64, 8, lambda x, y: False)
    yield "black", img(77, 9, lambda x, y: True)
    yield "stripes", img(101, 23, lambda x, y: (x // 3 + y) % 2 == 0)
    yield "checker1", img(33, 17, lambda x, y: (x + y) % 2 == 0)
    yield "box", img(200, 60, lambda x, y: 20 <= x < 180 and 10 <= y < 50 and not (25 <= x < 175 and 15 <= y < 45))
    yield "wide", img(2600, 6, lambda x, y: x > 5 and x < 2550 and y % 2 == 0)  # extended make-up codes
    noise = [[rnd.random() < 0.08 for _ in range(173)] for _ in range(41)]
    yield "noise", img(173, 41, lambda x, y: noise[y][x])
    blobs = [(rnd.randrange(300), rnd.randrange(120), rnd.randrange(3, 25)) for _ in range(30)]
    yield "blobs", img(300, 120, lambda x, y: any((x - cx) ** 2 + (y - cy) ** 2 < r * r for cx, cy, r in blobs))
    yield "text", img(240, 40, lambda x, y: (y % 10) < 7 and (x % 7) in (1, 2, 4) and (x // 30 + y // 10) % 3 != 0)

def strip(im, comp, t4=None):
    b = io.BytesIO()
    info = TiffImagePlugin.ImageFileDirectory_v2()
    info[278] = im.height  # RowsPerStrip: one strip
    if t4 is not None: info[292] = t4  # T4Options
    im.save(b, format="TIFF", compression=comp, tiffinfo=info)
    t = Image.open(io.BytesIO(b.getvalue()))
    off = t.tag_v2[273]; cnt = t.tag_v2[279]
    off = off[0] if isinstance(off, tuple) else off; cnt = cnt[0] if isinstance(cnt, tuple) else cnt
    photo = t.tag_v2.get(262)
    return b.getvalue()[off:off + cnt], photo

for name, im in bitmaps():
    w, h = im.size
    # raw rows with 1 = ink (CCITT "black")
    rows = bytearray()
    px = im.load()
    for y in range(h):
        for xb in range(0, w, 8):
            v = 0
            for k in range(8):
                x = xb + k
                v = (v << 1) | (1 if x < w and px[x, y] == 0 else 0)
            rows.append(v)
    for comp, k, t4 in (("group4", -1, None), ("group3", 0, 0), ("group3", 1, 1)):
        try:
            data, photo = strip(im, comp, t4)
        except Exception as e:
            print(json.dumps({"name": name, "comp": comp, "error": str(e)[:100]})); continue
        print(json.dumps({"name": f"{name}-{comp}-k{k}", "w": w, "h": h, "k": k, "photo": photo, "bits": rows.hex(), "data": data.hex()}))
