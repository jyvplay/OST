#!/usr/bin/env python3
"""TT77 test-only oracle: encode a matrix of JPEG 2000 codestreams with OpenJPEG (via glymur, MIT, using the libopenjp2
bundled with Pillow) and write, per case, the codestream plus OpenJPEG's own decode as PNM. Lossless cases also record
the source image, so the decoder is checked against the truth, not only against another decoder.

usage: jpx_gen.py OUTDIR > manifest.jsonl
"""
import json, os, sys
import numpy as np
import glymur

out = sys.argv[1]
os.makedirs(out, exist_ok=True)


def scene(w, h, ch, seed=7, bits=8):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    base = [(x * 255 / max(1, w - 1)), (y * 255 / max(1, h - 1)), ((x + y) % 64) * 4]
    img = np.zeros((h, w, ch), dtype=np.float64)
    for c in range(ch):
        v = base[c % 3] * 0.6 + rng.normal(0, 18, (h, w))
        v[(x - w // 3) ** 2 + (y - h // 2) ** 2 < (min(w, h) // 4) ** 2] = 30 + 60 * c  # a disc: sharp edges
        v[h // 5: h // 5 + 3, :] = 250  # a thin line
        img[:, :, c] = v
    img = np.clip(img, 0, 255) * ((2 ** bits - 1) / 255)
    return img.astype(np.uint16 if bits > 8 else np.uint8)


def pnm(path, a):
    a = np.asarray(a)
    if a.ndim == 2:
        a = a[:, :, None]
    h, w, ch = a.shape
    if a.dtype != np.uint8:
        a = (a >> 8).astype(np.uint8) if a.max() > 255 else a.astype(np.uint8)
    if ch == 2:
        a = a[:, :, :1]
        ch = 1
    if ch == 4:
        a = a[:, :, :3]
        ch = 3
    with open(path, "wb") as f:
        f.write(f"{'P5' if ch == 1 else 'P6'}\n{w} {h}\n255\n".encode())
        f.write(a.tobytes())


CASES = [
    # name, w, h, channels, bits, encoder kwargs, lossless
    ("rev53_rgb", 97, 61, 3, 8, {}, True),
    ("rev53_gray", 97, 61, 1, 8, {}, True),
    ("rev53_nomct", 64, 40, 3, 8, {"mct": False}, True),
    ("rev53_numres1", 50, 33, 1, 8, {"numres": 1}, True),
    ("rev53_numres7", 300, 200, 1, 8, {"numres": 7}, True),
    ("rev53_tiles", 97, 61, 3, 8, {"tilesize": (32, 24), "numres": 3}, True),
    ("rev53_cb16", 97, 61, 1, 8, {"cbsize": (16, 16)}, True),
    ("rev53_cb8x32", 97, 61, 1, 8, {"cbsize": (8, 32)}, True),
    ("rev53_prec", 120, 90, 3, 8, {"psizes": [(64, 64), (32, 32), (16, 16)], "cbsize": (16, 16)}, True),
    ("rev53_sop_eph", 97, 61, 3, 8, {"sop": True, "eph": True}, True),
    ("rev53_LRCP_layers", 97, 61, 3, 8, {"prog": "LRCP", "cratios": [20, 5, 1]}, True),
    ("rev53_RLCP", 97, 61, 3, 8, {"prog": "RLCP", "cratios": [10, 1]}, True),
    ("rev53_RPCL", 97, 61, 3, 8, {"prog": "RPCL", "psizes": [(32, 32), (16, 16)], "cbsize": (8, 8)}, True),
    ("rev53_PCRL", 97, 61, 3, 8, {"prog": "PCRL", "psizes": [(32, 32), (16, 16)], "cbsize": (8, 8)}, True),
    ("rev53_CPRL", 97, 61, 3, 8, {"prog": "CPRL", "psizes": [(32, 32), (16, 16)], "cbsize": (8, 8)}, True),
    ("rev53_bypass", 97, 61, 1, 8, {"modesw": 1}, True),
    ("rev53_reset", 97, 61, 1, 8, {"modesw": 2}, True),
    ("rev53_termall", 97, 61, 1, 8, {"modesw": 4}, True),
    ("rev53_vcausal", 97, 61, 1, 8, {"modesw": 8}, True),
    ("rev53_erterm", 97, 61, 1, 8, {"modesw": 16}, True),
    ("rev53_segsym", 97, 61, 1, 8, {"modesw": 32}, True),
    ("rev53_allmodes", 97, 61, 3, 8, {"modesw": 63}, True),
    ("rev53_bypass_term", 97, 61, 1, 8, {"modesw": 5}, True),
    ("rev53_16bit", 64, 48, 1, 16, {}, True),
    ("rev53_12bit_tiles", 70, 50, 1, 12, {"tilesize": (32, 32)}, True),
    ("rev53_plt_tlm", 97, 61, 3, 8, {"plt": True, "tlm": True}, True),
    ("rev53_rgba", 40, 30, 4, 8, {"numres": 3}, True),
    ("rev53_tiny", 1, 1, 1, 8, {"numres": 1}, True),
    ("rev53_thin", 1, 37, 1, 8, {"numres": 1}, True),
    ("rev53_wide", 53, 2, 3, 8, {"numres": 2}, True),
    ("irr97_rgb", 97, 61, 3, 8, {"irreversible": True}, False),
    ("irr97_gray", 97, 61, 1, 8, {"irreversible": True}, False),
    ("irr97_layers", 97, 61, 3, 8, {"irreversible": True, "cratios": [40, 10, 2]}, False),
    ("irr97_q", 97, 61, 3, 8, {"irreversible": True, "psnr": [30, 40, 50]}, False),
    ("irr97_tiles_prec", 130, 70, 3, 8, {"irreversible": True, "tilesize": (64, 32), "psizes": [(32, 32), (16, 16)], "cbsize": (8, 8)}, False),
    ("irr97_allmodes", 97, 61, 1, 8, {"irreversible": True, "modesw": 63}, False),
    ("irr97_numres1", 33, 21, 1, 8, {"irreversible": True, "numres": 1}, False),
    ("irr97_big", 400, 300, 3, 8, {"irreversible": True, "cratios": [30]}, False),
    ("rev53_lossy_layers", 97, 61, 3, 8, {"cratios": [30, 8]}, False),
    ("j2k_codestream", 50, 40, 3, 8, {"irreversible": True}, False),
]

for name, w, h, ch, bits, kw, lossless in CASES:
    src = scene(w, h, ch, bits=bits)
    ext = ".j2k" if name.startswith("j2k") else ".jp2"
    path = os.path.join(out, name + ext)
    try:
        arr = src if ch > 1 else src[:, :, 0]
        glymur.Jp2k(path, data=arr, **kw)
        dec = glymur.Jp2k(path)[:]
        pnm(path + ".oj.pnm", dec)
        rec = {"name": name, "file": path, "w": w, "h": h, "ch": ch, "bits": bits, "lossless": lossless, "opts": {k: str(v) for k, v in kw.items()}, "oj": path + ".oj.pnm"}
        if lossless:
            if bits == 8:
                pnm(path + ".src.pnm", src)
            rec["src_equals_oj"] = bool(np.array_equal(np.asarray(dec).reshape(src.shape), src))
        print(json.dumps(rec))
    except Exception as e:  # an encoder refusal is recorded, not hidden
        print(json.dumps({"name": name, "error": str(e)[:200]}))
