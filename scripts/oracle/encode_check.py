#!/usr/bin/env python3
"""TT54 (FF-07) — independent verification of scripts/tt54/encode-run.mts outputs (test-only).

Readers: Pillow 13 (libjpeg / libpng / libwebp / libavif), exifread, FFmpeg via PyAV (mov demuxer + libdav1d),
pillow-heif (libheif + libde265). Prints a JSON summary; exit 1 on any failure.
"""
import io, json, os, struct, sys
import numpy as np
from PIL import Image
import exifread, av, pillow_heif

d = sys.argv[1]; out = os.path.join(d, "out")
rep = json.load(open(os.path.join(out, "report.json")))
src_exif = Image.open(os.path.join(d, "exif_src.jpg")).getexif()
src_sub = src_exif.get_ifd(0x8769); src_gps = src_exif.get_ifd(0x8825)
fails, stats = [], {"exif": 0, "avif": 0, "heic": 0, "psnr": {}}

def bad(f, why): fails.append(f"{f}: {why}")
def arr(im): return np.asarray(im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") and "transparency" in im.info or im.mode == "RGBA" else "RGB"), dtype=np.float64)
def psnr(a, b):
    a = np.asarray(a.convert("RGB"), dtype=np.float64); b = np.asarray(b.convert("RGB"), dtype=np.float64)
    if a.shape != b.shape: return -1.0
    m = ((a - b) ** 2).mean(); return 99.0 if m == 0 else 10 * np.log10(255 ** 2 / m)

def count_blocks(b, fmt):
    if fmt == "jpeg":
        n, o = 0, 2
        while o + 4 <= len(b) and b[o] == 0xFF and 0xE0 <= b[o + 1] <= 0xEF:
            ln = struct.unpack(">H", b[o + 2:o + 4])[0]
            if b[o + 1] == 0xE1 and b[o + 4:o + 10] == b"Exif\0\0": n += 1
            o += 2 + ln
        return n
    if fmt == "png":
        n, o = 0, 8
        while o + 12 <= len(b):
            ln, t = struct.unpack(">I4s", b[o:o + 8]); n += t == b"eXIf"; o += 12 + ln
        return n
    n, o = 0, 12
    while o + 8 <= len(b):
        t = b[o:o + 4]; ln = struct.unpack("<I", b[o + 4:o + 8])[0]; n += t == b"EXIF"; o += 8 + ln + (ln & 1)
    return n

for o in rep["outputs"]:
    f = o["file"]; path = os.path.join(out, f)
    if o["kind"] == "exif":
        stats["exif"] += 1
        b = open(path, "rb").read()
        im = Image.open(path); im.load(); base = Image.open(os.path.join(d, o["base"])); base.load()
        if im.size != base.size or not np.array_equal(arr(im), arr(base)): bad(f, "pixels changed by EXIF injection")
        ex = im.getexif()
        if ex.get(0x0112) != 1: bad(f, f"Orientation {ex.get(0x0112)}")
        if ex.get(0x0131) != "Fusion Photos": bad(f, f"Software {ex.get(0x0131)!r}")
        for t in (0x010F, 0x0110):
            if ex.get(t) != src_exif.get(t): bad(f, f"IFD0 {t:#x} {ex.get(t)!r} != {src_exif.get(t)!r}")
        sub = ex.get_ifd(0x8769)
        for t in (0x9003, 0x829A, 0x829D, 0x8827):
            if t in src_sub and str(sub.get(t)) != str(src_sub.get(t)): bad(f, f"Exif {t:#x} {sub.get(t)!r} != {src_sub.get(t)!r}")
        if sub.get(0xA002) != o["w"] or sub.get(0xA003) != o["h"]: bad(f, f"PixelDimension {sub.get(0xA002)}x{sub.get(0xA003)}")
        gps = ex.get_ifd(0x8825)
        if bool(gps) != o["keepLocation"]: bad(f, f"GPS present={bool(gps)} keepLocation={o['keepLocation']}")
        if gps and [str(x) for x in gps.get(2, ())] != [str(x) for x in src_gps.get(2, ())]: bad(f, "GPSLatitude differs")
        if 0x927C in sub: bad(f, "MakerNote leaked")
        if ex.get_ifd(0x8769) and 0x0201 in ex: bad(f, "IFD1 thumbnail pointer in IFD0?")
        # exifread (second EXIF parser)
        tags = exifread.process_file(io.BytesIO(b), details=False)
        if tags:
            if str(tags.get("Image Make", "")).strip() != str(src_exif.get(0x010F, "")).strip(): bad(f, f"exifread Make {tags.get('Image Make')}")
            if str(tags.get("Image Orientation", "")) not in ("Horizontal (normal)", "1"): bad(f, f"exifread Orientation {tags.get('Image Orientation')}")
            if any(k.startswith("GPS ") for k in tags) != o["keepLocation"]: bad(f, "exifread GPS presence")
            stats["exifread"] = stats.get("exifread", 0) + 1
        else: stats["exifread_unsupported"] = stats.get("exifread_unsupported", 0) + 1
        tb = open(os.path.join(out, "twice." + f), "rb").read()
        if count_blocks(b, o["fmt"]) != 1 or count_blocks(tb, o["fmt"]) != 1: bad(f, f"EXIF blocks {count_blocks(b, o['fmt'])}/{count_blocks(tb, o['fmt'])}")
        t2 = Image.open(io.BytesIO(tb)); t2.load()
        if not np.array_equal(arr(t2), arr(base)): bad(f, "twice: pixels changed")
        if o["fmt"] == "webp":
            flags = b[20]; w = 1 + int.from_bytes(b[24:27], "little"); h = 1 + int.from_bytes(b[27:30], "little")
            if b[12:16] != b"VP8X" or not flags & 0x08: bad(f, "VP8X EXIF flag")
            if (w, h) != base.size: bad(f, f"VP8X canvas {w}x{h}")
            if bool(flags & 0x10) != (base.mode == "RGBA"): bad(f, f"VP8X alpha flag {bool(flags & 0x10)} vs mode {base.mode}")
        if o["ourOrientation"] != 1 or o["ourGps"] != o["keepLocation"] or o["ourDims"] != [o["w"], o["h"]]: bad(f, f"our reader: {o['ourOrientation']} {o['ourGps']} {o['ourDims']}")
    elif o["kind"] == "avif":
        stats["avif"] += 1
        im = Image.open(path); im.load(); ref = Image.open(os.path.join(d, o["ref"])); src = Image.open(os.path.join(d, o["src"]))
        if im.size != ref.size or list(im.size) != [o["seq"]["width"], o["seq"]["height"]]: bad(f, f"size {im.size} ref {ref.size} seq {o['seq']['width']}x{o['seq']['height']}")
        p_ref, p_src = psnr(im, ref), psnr(im, src)
        # libavif and swscale convert YUV→RGB with different chroma upsampling, so RGB differs on hard colour edges;
        # the container property is "same bitstream" → compare LUMA (and the FFmpeg demux path below bit-exactly)
        ya = np.asarray(im.convert("YCbCr"), float)[..., 0]; yb = np.asarray(ref.convert("YCbCr"), float)[..., 0]
        my = ((ya - yb) ** 2).mean() if ya.shape == yb.shape else 1e9; p_y = 99.0 if my == 0 else 10 * np.log10(255 ** 2 / my)
        stats["psnr"][f] = {"libavif_vs_dav1d_rgb": round(p_ref, 2), "libavif_vs_dav1d_luma": round(p_y, 2), "vs_source": round(p_src, 2)}
        if p_y < 42: bad(f, f"libavif luma differs from dav1d decode of the same bitstream: {p_y:.2f} dB")
        if p_src < 24: bad(f, f"PSNR vs source {p_src:.2f} dB")
        ex = im.getexif()
        if o["withExif"]:
            if ex.get(0x010F) != src_exif.get(0x010F) or ex.get(0x0112) != 1: bad(f, f"AVIF Exif item: Make {ex.get(0x010F)!r} Orientation {ex.get(0x0112)}")
        elif len(ex): bad(f, "unexpected EXIF")
        try:
            with av.open(path) as c:
                fr = next(c.decode(video=0)); ff = fr.to_image()
                p_ff = psnr(ff, ref); stats["psnr"][f]["ffmpeg_demux_vs_dav1d"] = round(p_ff, 2)
                if ff.size != ref.size or p_ff < 38: bad(f, f"FFmpeg demux+dav1d: {ff.size} {p_ff:.2f} dB")
        except Exception as e: bad(f, f"FFmpeg could not demux: {e}")
        if o["ourDims"] != list(im.size) or o["ourFormat"] != "avif": bad(f, f"our reader {o['ourDims']} {o['ourFormat']}")
    elif o["kind"] == "heic":
        stats["heic"] += 1
        hf = pillow_heif.open_heif(path); im = hf.to_pillow(); ref = Image.open(os.path.join(d, o["ref"]))
        p = psnr(im, ref); stats["psnr"][f] = {"libheif_rewrapped_vs_original": round(p, 2), "identical": bool(np.array_equal(np.asarray(im.convert('RGB')), np.asarray(ref.convert('RGB'))))}
        if im.size != ref.size or p < 40: bad(f, f"rewrapped HEIC {im.size} {p:.2f} dB")
        exb = hf.info.get("exif")
        if not exb: bad(f, "no Exif item")
        else:
            e = Image.Exif(); e.load(exb[6:] if exb.startswith(b"Exif\0\0") else exb)
            if e.get(0x010F) != src_exif.get(0x010F): bad(f, f"HEIC Exif Make {e.get(0x010F)!r}")
        if o["ourDims"] != list(im.size): bad(f, f"our reader {o['ourDims']}")

for k, v in rep["negative"].items():
    if not v.startswith("refused"): bad(k, "accepted a malformed input")
if rep.get("noExifSource") is not None: bad("noExifSource", "empty EXIF produced a block")
print(json.dumps({"fails": fails, **stats}, indent=1))
sys.exit(1 if fails else 0)
