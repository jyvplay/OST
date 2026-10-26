#!/usr/bin/env python3
"""TT54 e2e fixtures (test-only, Pillow): photos_fixtures.py OUTDIR
  o6.jpg     120×80 stored, EXIF Orientation 6 (display 80×120): stored left half RED, right half BLUE
             → displayed (90° clockwise) top half RED, bottom half BLUE
  photo.png  opaque 200×150 RGB from the GPS camera sample (for the bit-exact browser-vs-Node recipe check)
  photo.rgba the same pixels, raw RGBA (what the Node renderer gets)
  cam.jpg    the camera JPEG with Make/Model/DateTimeOriginal + GPS (export metadata source)
"""
import os, sys, shutil
import numpy as np
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
a = np.zeros((80, 120, 3), np.uint8); a[:, :60] = (230, 20, 20); a[:, 60:] = (20, 20, 230)
im = Image.fromarray(a); ex = Image.Exif(); ex[0x0112] = 6; ex[0x010F] = "FusionTest"; im.save(os.path.join(out, "o6.jpg"), quality=95, exif=ex.tobytes())
corpus = os.environ.get("EXIF_CORPUS", "/home/user/tools/corpus/exif")
src = os.path.join(corpus, "jpg__gps__DSCN0010.jpg")
p = Image.open(src).convert("RGB").resize((200, 150), Image.LANCZOS); p.save(os.path.join(out, "photo.png"))
open(os.path.join(out, "photo.rgba"), "wb").write(np.asarray(p.convert("RGBA")).tobytes())
shutil.copy(src, os.path.join(out, "cam.jpg"))
print("ok")
