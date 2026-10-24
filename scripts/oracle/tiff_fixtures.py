#!/usr/bin/env python3
"""TT54 (FF-13) — TIFF decoder fixtures + expected RGBA (test-only; Pillow + numpy): tiff_fixtures.py OUTDIR
  corpus  the 8 TIFFs of ianare/exif-samples (LZW + predictor 2, RGB / RGBA)
  gen_*   Pillow-written: modes 1 / L / P(16 colours) / RGB / RGBA(alpha ramp) / I;16 (full range) ×
          compression none / LZW / Adobe Deflate / PackBits; a 7-rows-per-strip LZW file
  hand    an uncompressed PlanarConfiguration=2 RGB file built byte by byte (Pillow cannot write planar)
Expected pixels: Pillow's decode → RGBA, except I;16 where the display mapping is the top 8 bits of each sample
(Pillow's own I;16→RGBA conversion CLIPS at 255 instead of scaling — a reference-semantics difference, disclosed).
"""
import glob, json, os, shutil, struct, sys
import numpy as np
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True); os.chdir(out)
corpus = os.environ.get("EXIF_CORPUS", "/home/user/tools/corpus/exif")
cam = Image.open(os.path.join(corpus, "jpg__gps__DSCN0010.jpg"))
man = []
for f in sorted(glob.glob(os.path.join(corpus, "tiff__*.tiff"))): shutil.copy(f, os.path.basename(f)); man.append(os.path.basename(f))
src = cam.convert("RGB").resize((97, 61))
a = np.asarray(src.convert("RGBA")).copy(); a[..., 3] = np.linspace(0, 255, 97).astype(np.uint8)[None, :]
modes = {"1": src.convert("1"), "L": src.convert("L"), "P": src.convert("P", palette=Image.ADAPTIVE, colors=16), "RGB": src, "RGBA": Image.fromarray(a, "RGBA")}
for m, im in modes.items():
    for comp in ["raw", "tiff_lzw", "tiff_adobe_deflate", "packbits"]:
        n = f"gen_{m}_{comp}.tif"; im.save(n, compression=None if comp == "raw" else comp); man.append(n)
src.save("gen_RGB_strips.tif", compression="tiff_lzw", tiffinfo={278: 7}); man.append("gen_RGB_strips.tif")
for n in man:
    im = Image.open(n); im.load(); open(n + ".rgba", "wb").write(np.asarray(im.convert("RGBA")).tobytes()); json.dump({"w": im.width, "h": im.height}, open(n + ".json", "w"))
v16 = (np.asarray(src.convert("L")).astype(np.uint16) * 257 + (np.arange(97, dtype=np.uint16) % 7)[None, :]); im16 = Image.fromarray(v16)
for comp in ["raw", "tiff_lzw", "tiff_adobe_deflate", "packbits"]:
    n = f"gen_I16_{comp}.tif"; im16.save(n, compression=None if comp == "raw" else comp)
    back = np.asarray(Image.open(n)).astype(np.uint16); assert np.array_equal(back, v16), n
    g = (back >> 8).astype(np.uint8); open(n + ".rgba", "wb").write(np.dstack([g, g, g, np.full_like(g, 255)]).tobytes()); json.dump({"w": 97, "h": 61}, open(n + ".json", "w")); man.append(n)
s2 = cam.convert("RGB").resize((53, 29)); b2 = np.asarray(s2); W, H = s2.size; planes = [b2[..., c].tobytes() for c in range(3)]
off = 8; po = []
for p in planes: po.append(off); off += len(p)
bps, so, sc = off, off + 6, off + 18; ifd = off + 30
tags = [(256, 3, 1, W), (257, 3, 1, H), (258, 3, 3, bps), (259, 3, 1, 1), (262, 3, 1, 2), (273, 4, 3, so), (277, 3, 1, 3), (278, 3, 1, H), (279, 4, 3, sc), (284, 3, 1, 2)]
bb = bytearray(b"II*\0" + struct.pack("<I", ifd)) + b"".join(planes) + struct.pack("<3H", 8, 8, 8) + struct.pack("<3I", *po) + struct.pack("<3I", *[len(p) for p in planes]) + struct.pack("<H", len(tags))
for t, ty, c, v in tags: bb += struct.pack("<HHI", t, ty, c) + (struct.pack("<HH", v, 0) if ty == 3 and c == 1 else struct.pack("<I", v))
bb += struct.pack("<I", 0); open("hand_RGB_planar.tif", "wb").write(bb)
im = Image.open("hand_RGB_planar.tif"); im.load(); assert im.tag_v2.get(284) == 2 and np.array_equal(np.asarray(im.convert("RGB")), b2)
open("hand_RGB_planar.tif.rgba", "wb").write(np.asarray(im.convert("RGBA")).tobytes()); json.dump({"w": W, "h": H}, open("hand_RGB_planar.tif.json", "w")); man.append("hand_RGB_planar.tif")
json.dump(man, open("manifest.json", "w")); print(len(man))
