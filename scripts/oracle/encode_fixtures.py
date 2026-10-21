#!/usr/bin/env python3
"""TT54 (FF-07) — fixtures for the export encoder test (test-only; Pillow, PyAV/FFmpeg, pillow-heif).

OUTDIR/
  src_<name>.png             source pixels (RGB or RGBA)
  base_<name>.<fmt>          the same pixels written by Pillow WITHOUT metadata: jpg, png, webp (VP8 lossy, simple
                             format), webpll (VP8L lossless), and for the RGBA source webpa (VP8X+ALPH) / webpall
  exif_src.jpg               a camera JPEG with GPS (from the exif corpus) — the metadata source
  av1_<name>.obu             one AV1 key frame from FFmpeg libsvtav1 (an encoder independent of Chromium's libaom),
                             low-overhead OBUs, sequence header included
  av1_<name>_ref.png         that bitstream decoded by FFmpeg libdav1d → RGB (the reference for our AVIF wrapping)
  heic_<name>.hvcC / .hevc   hvcC box payload + HEVC item data extracted from a libheif/x265 HEIC (box walk below)
  heic_<name>_ref.png        the original HEIC decoded by libheif
  manifest.json
"""
import json, os, struct, sys, glob
import numpy as np
from PIL import Image
import av, pillow_heif
from fractions import Fraction

def leb128(b, o):
    v = 0
    for i in range(8):
        x = b[o + i]; v |= (x & 0x7f) << (7 * i)
        if not x & 0x80: return v, o + i + 1
    raise ValueError("leb128")

def obu_types(b):
    """low-overhead OBU walk (every OBU must carry obu_has_size_field)"""
    o, t = 0, []
    while o < len(b):
        h = b[o]; typ = (h >> 3) & 15; ext = (h >> 2) & 1; has = (h >> 1) & 1
        if not has: raise ValueError("OBU without size field")
        n, p = leb128(b, o + 1 + ext); t.append(typ); o = p + n
    return t

out = sys.argv[1]; os.makedirs(out, exist_ok=True)
man = {"images": [], "av1": [], "heic": []}

def synth(w, h, alpha=False):
    y, x = np.mgrid[0:h, 0:w]
    r = (x * 255 / max(1, w - 1)).astype(np.uint8)
    g = (y * 255 / max(1, h - 1)).astype(np.uint8)
    b = (((x // 16 + y // 16) % 2) * 180 + 40).astype(np.uint8)
    a = [r, g, b] + ([(255 - (x * 200 // max(1, w - 1))).astype(np.uint8)] if alpha else [])
    return Image.fromarray(np.dstack(a), "RGBA" if alpha else "RGB")

corpus = os.environ.get("EXIF_CORPUS", "/home/user/tools/corpus/exif")
cam = Image.open(os.path.join(corpus, "jpg__gps__DSCN0010.jpg"))
with open(os.path.join(corpus, "jpg__gps__DSCN0010.jpg"), "rb") as f: open(os.path.join(out, "exif_src.jpg"), "wb").write(f.read())
srcs = {"photo": cam.convert("RGB").resize((320, 240)), "odd": synth(333, 217), "alpha": synth(200, 150, True)}

for name, im in srcs.items():
    im.save(os.path.join(out, f"src_{name}.png"))
    bases = {}
    if im.mode == "RGB":
        im.save(os.path.join(out, f"base_{name}.jpg"), quality=90); bases["jpg"] = "jpeg"
        im.save(os.path.join(out, f"base_{name}.png")); bases["png"] = "png"
        im.save(os.path.join(out, f"base_{name}.webp"), "WEBP", quality=85); bases["webp"] = "webp"
        im.save(os.path.join(out, f"base_{name}.webpll"), "WEBP", lossless=True); bases["webpll"] = "webp"
    else:
        im.save(os.path.join(out, f"base_{name}.png")); bases["png"] = "png"
        im.save(os.path.join(out, f"base_{name}.webpa"), "WEBP", quality=85); bases["webpa"] = "webp"
        im.save(os.path.join(out, f"base_{name}.webpall"), "WEBP", lossless=True); bases["webpall"] = "webp"
    man["images"].append({"name": name, "w": im.width, "h": im.height, "mode": im.mode, "bases": bases})

def av1_key(name, im, crf):
    w, h = im.width - (im.width & 1), im.height - (im.height & 1)  # yuv420p encoders need even sizes
    im = im.convert("RGB").crop((0, 0, w, h))
    cc = av.CodecContext.create("libsvtav1", "w")
    cc.width, cc.height, cc.pix_fmt = w, h, "yuv420p"
    cc.time_base = Fraction(1, 25)
    cc.options = {"crf": str(crf), "preset": "8"}
    fr = av.VideoFrame.from_image(im).reformat(format="yuv420p")
    fr.pts = 0
    pk = list(cc.encode(fr)) + list(cc.encode(None))
    data = bytes(pk[0])
    ext = bytes(cc.extradata or b"")
    # when the sequence header went to extradata (global header), prepend its config OBUs (av1C: 4 bytes + OBUs)
    if 1 not in obu_types(data) and len(ext) > 4:
        data = ext[4:] + data
    assert 1 in obu_types(data), "no sequence header"
    open(os.path.join(out, f"av1_{name}.obu"), "wb").write(data)
    dec = av.CodecContext.create("libdav1d", "r")
    frames = list(dec.decode(av.Packet(data))) + list(dec.decode(None))
    ref = frames[0].to_image()
    ref.save(os.path.join(out, f"av1_{name}_ref.png"))
    im.save(os.path.join(out, f"av1_{name}_src.png"))
    man["av1"].append({"name": name, "w": w, "h": h, "bytes": len(data), "crf": crf})

av1_key("photo", srcs["photo"], 28)
av1_key("odd", srcs["odd"], 20)

def boxes(b, o=0, end=None):
    end = len(b) if end is None else end
    while o + 8 <= end:
        n, t = struct.unpack(">I4s", b[o:o + 8]); hdr = 8
        if n == 1: n = struct.unpack(">Q", b[o + 8:o + 16])[0]; hdr = 16
        if n == 0: n = end - o
        yield t.decode("latin1"), o + hdr, o + n
        o += n

def heic_extract(name, im):
    path = os.path.join(out, f"heic_{name}.heic")
    pillow_heif.from_pillow(im.convert("RGB")).save(path, quality=80)
    b = open(path, "rb").read()
    meta = next((s, e) for t, s, e in boxes(b) if t == "meta")
    ms, me = meta[0] + 4, meta[1]
    sub = {t: (s, e) for t, s, e in boxes(b, ms, me)}
    pitm = struct.unpack(">H", b[sub["pitm"][0] + 4: sub["pitm"][0] + 6])[0]
    # iloc (version 0/1, any offset/length sizes)
    s, e = sub["iloc"]; ver = b[s]; p = s + 4
    os_, ls = b[p] >> 4, b[p] & 15; bs, isz = b[p + 1] >> 4, (b[p + 1] & 15) if ver in (1, 2) else 0; p += 2
    rd = lambda n: (int.from_bytes(b[p:p + n], "big") if n else 0)
    cnt = struct.unpack(">H", b[p:p + 2])[0] if ver < 2 else struct.unpack(">I", b[p:p + 4])[0]; p += 2 if ver < 2 else 4
    data = None
    for _ in range(cnt):
        iid = rd(2) if ver < 2 else rd(4); p += 2 if ver < 2 else 4
        if ver in (1, 2): p += 2
        p += 2  # data_reference_index
        base = rd(bs); p += bs
        ec = rd(2); p += 2
        ext = []
        for _ in range(ec):
            if ver in (1, 2) and isz: p += isz
            off = rd(os_); p += os_; ln = rd(ls); p += ls; ext.append((base + off, ln))
        if iid == pitm: data = b"".join(b[a:a + l] for a, l in ext)
    # ipco → first hvcC + ispe (single-image files from libheif: the primary item's properties)
    s, e = sub["iprp"]; ipco = next((s2, e2) for t, s2, e2 in boxes(b, s, e) if t == "ipco")
    props = {t: (s2, e2) for t, s2, e2 in boxes(b, *ipco)}
    hs, he = props["hvcC"]; hvcc = b[hs:he]
    isp = props["ispe"]; W, H = struct.unpack(">II", b[isp[0] + 4: isp[0] + 12])
    open(os.path.join(out, f"heic_{name}.hvcC"), "wb").write(hvcc)
    open(os.path.join(out, f"heic_{name}.hevc"), "wb").write(data)
    pillow_heif.register_heif_opener()
    Image.open(path).convert("RGB").save(os.path.join(out, f"heic_{name}_ref.png"))
    man["heic"].append({"name": name, "w": W, "h": H, "bytes": len(data)})

heic_extract("photo", srcs["photo"])
json.dump(man, open(os.path.join(out, "manifest.json"), "w"), indent=1)
print(json.dumps({k: len(v) for k, v in man.items()}))
