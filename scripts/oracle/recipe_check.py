#!/usr/bin/env python3
"""TT54 (MD-03) — independent oracle for the photo recipe engine (test-only; numpy + Pillow).

  recipe_check.py --prep DIR   write the raw RGBA sources (+ sources.json)
  recipe_check.py DIR          verify DIR/rec/* written by scripts/tt54/recipe-run.mts

Geometry: numpy rot90 / flip and slicing must match BIT-EXACTLY; non-aligned crops are compared with Pillow's
EXTENT transform (bilinear, pixel-centre sampling); straighten with Pillow rotate() + a centred EXTENT crop (two
resamplings → PSNR bound) and the crop scale is checked for MAXIMALITY numerically (corners of the rotated-back
rectangle, independent of the closed form). Tone: a numpy reimplementation from the documented equations
(DESIGN-TT54 §A) — max |diff| ≤ 1 level.
"""
import json, math, os, sys

def jsround(v): return math.floor(v + 0.5)  # JS Math.round (Python round() is half-to-even)
import numpy as np
from PIL import Image

def prep(d):
    os.makedirs(d, exist_ok=True)
    corpus = os.environ.get("EXIF_CORPUS", "/home/user/tools/corpus/exif")
    photo = Image.open(os.path.join(corpus, "jpg__gps__DSCN0010.jpg")).convert("RGBA").resize((160, 120), Image.LANCZOS)
    y, x = np.mgrid[0:37, 0:61]
    odd = Image.fromarray(np.dstack([(x * 4) % 256, (y * 7) % 256, ((x + y) * 3) % 256, 255 - (x * 2)]).astype(np.uint8), "RGBA")
    half = photo.resize((80, 60), Image.BOX)
    srcs = {"photo": photo, "odd": odd, "photo_half": half}
    for n, im in srcs.items(): open(os.path.join(d, f"src_{n}.rgba"), "wb").write(np.asarray(im).tobytes())
    json.dump([{"name": n, "w": im.width, "h": im.height} for n, im in srcs.items() if n != "photo_half"] + [{"name": "photo_half", "w": 80, "h": 60}], open(os.path.join(d, "sources.json"), "w"))

def lin(c):
    c = c / 255.0; return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def enc(l): return np.where(l <= 0.0031308, l * 12.92, 1.055 * np.power(np.maximum(l, 0), 1 / 2.4) - 0.055)
def curve(v, sh, hi, c):
    x = np.clip(v + sh * 0.9 * v * (1 - v) ** 2, 0, 1)
    x = np.clip(x + hi * 0.9 * x * x * (1 - x), 0, 1)
    x = x + c * (x * x * (3 - 2 * x) - x) if c >= 0 else 0.5 + (x - 0.5) * (1 + 0.5 * c)
    return np.clip(x, 0, 1)
def tone_ref(a, t):
    if all(abs(v) == 0 for v in t.values()): return a.copy()
    g = 2 ** t["exposure"]; gains = [g * (1 + 0.25 * t["warmth"]), g * (1 + 0.15 * t["tint"]), g * (1 - 0.25 * t["warmth"])]
    ch = [curve(np.minimum(1, enc(np.minimum(1, lin(a[..., i].astype(float)) * gains[i]))), t["shadows"], t["highlights"], t["contrast"]) for i in range(3)]
    r, gg, b = ch
    sat, vib = 1 + t["saturation"], t["vibrance"]
    if sat != 1 or vib:
        l = 0.2126 * r + 0.7152 * gg + 0.0722 * b; chroma = np.maximum(np.maximum(r, gg), b) - np.minimum(np.minimum(r, gg), b)
        f = np.maximum(0, sat * (1 + vib * (1 - chroma))); r, gg, b = l + (r - l) * f, l + (gg - l) * f, l + (b - l) * f
    if t["vignette"]:
        H, W = a.shape[:2]; yy, xx = np.mgrid[0:H, 0:W]; cx, cy = (W - 1) / 2, (H - 1) / 2; rm = np.hypot(cx, cy) or 1
        m = 1 - t["vignette"] * 0.8 * (np.hypot(xx - cx, yy - cy) / rm) ** 2; r, gg, b = r * m, gg * m, b * m
    out = np.dstack([np.round(np.clip(v, 0, 1) * 255) for v in (r, gg, b)] + [a[..., 3].astype(float)])
    return out.astype(np.uint8)

def scale_numeric(w, h, deg):
    """largest k such that the centred k·w × k·h rectangle, rotated by deg, stays inside w × h (bisection)"""
    a = np.radians(deg); ca, sa = np.cos(a), np.sin(a)
    def inside(k):
        for sx in (-1, 1):
            for sy in (-1, 1):
                X, Y = sx * k * w / 2, sy * k * h / 2; u, v = X * ca - Y * sa, X * sa + Y * ca
                if abs(u) > w / 2 + 1e-9 or abs(v) > h / 2 + 1e-9: return False
        return True
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2; lo, hi = (mid, hi) if inside(mid) else (lo, mid)
    return lo

def bilinear_extent(a, W, H, x0, y0, cw, ch):
    """float64 bilinear EXTENT crop: output centre i+0.5 ↦ input x0 + (i+0.5)·cw/W, input centres at j+0.5, edge clamp"""
    h, w = a.shape[:2]
    u = x0 + (np.arange(W) + 0.5) * cw / W - 0.5; v = y0 + (np.arange(H) + 0.5) * ch / H - 0.5
    u = np.clip(u, 0, w - 1); v = np.clip(v, 0, h - 1)
    ix = np.minimum(np.floor(u).astype(int), w - 1); iy = np.minimum(np.floor(v).astype(int), h - 1)
    jx = np.minimum(ix + 1, w - 1); jy = np.minimum(iy + 1, h - 1); tx = (u - ix)[None, :, None]; ty = (v - iy)[:, None, None]
    A = a.astype(float)
    top = A[iy][:, ix] * (1 - tx) + A[iy][:, jx] * tx; bot = A[jy][:, ix] * (1 - tx) + A[jy][:, jx] * tx
    return np.floor(top * (1 - ty) + bot * ty + 0.5).astype(np.uint8)

def psnr(a, b):
    m = ((a.astype(float) - b.astype(float)) ** 2).mean(); return 99.0 if m == 0 else 10 * np.log10(255 ** 2 / m)

def check(d):
    rep = json.load(open(os.path.join(d, "rec", "report.json")))
    srcs = {s["name"]: s for s in json.load(open(os.path.join(d, "sources.json")))}
    src = {n: np.frombuffer(open(os.path.join(d, f"src_{n}.rgba"), "rb").read(), np.uint8).reshape(s["h"], s["w"], 4) for n, s in srcs.items()}
    fails, stats = [], {"exact": 0, "tone_cases": 0, "tone_max_diff": 0, "straighten_psnr": {}, "half_res_mad": {}}
    for k, v in rep["props"].items():
        if v is not True: fails.append(f"property {k} = {v}")
    for c in rep["cases"]:
        name = f"{c['src']}.{c['case']}"; out = np.frombuffer(open(os.path.join(d, "rec", name + ".rgba"), "rb").read(), np.uint8).reshape(c["h"], c["w"], 4)
        if c.get("half"): continue
        a = src[c["src"]]; r = c["recipe"]
        geo = a
        if r.get("rotate"): geo = np.rot90(geo, -r["rotate"])
        if r.get("flipH"): geo = geo[:, ::-1]
        if r.get("flipV"): geo = geo[::-1]
        geo = np.ascontiguousarray(geo)
        H0, W0 = geo.shape[:2]
        st = r.get("straighten", 0); cr = r.get("crop")
        if st:
            k = scale_numeric(W0, H0, st); fw, fh = W0 * k, H0 * k
            cx = cr or {"x": 0, "y": 0, "w": 1, "h": 1}
            W, H = max(1, jsround(fw * cx["w"])), max(1, jsround(fh * cx["h"]))
            if (W, H) != (c["w"], c["h"]): fails.append(f"{name}: size {c['w']}x{c['h']} vs numeric {W}x{H}")
            # the size equality above checks the closed-form scale (implementation) against bisection (oracle)
            rot = Image.fromarray(geo).rotate(-st, resample=Image.BILINEAR, center=(W0 / 2, H0 / 2))
            x0 = W0 / 2 - fw / 2 + cx["x"] * fw; y0 = H0 / 2 - fh / 2 + cx["y"] * fh
            ref = np.asarray(rot.transform((W, H), Image.EXTENT, (x0, y0, x0 + fw * cx["w"], y0 + fh * cx["h"]), Image.BILINEAR))
            if ref.shape == out.shape:
                p = psnr(ref[..., :3], out[..., :3]); stats["straighten_psnr"][name] = round(p, 2)
                if p < 30: fails.append(f"{name}: straighten PSNR {p:.2f} dB vs Pillow rotate+crop")
            geo_ref = None
        elif cr:
            W, H = max(1, jsround(W0 * cr["w"])), max(1, jsround(H0 * cr["h"]))
            x0, y0 = cr["x"] * W0, cr["y"] * H0
            if float(x0).is_integer() and float(y0).is_integer() and W == W0 * cr["w"] and H == H0 * cr["h"]:
                geo_ref = geo[int(y0):int(y0) + H, int(x0):int(x0) + W]
            else:
                geo_ref = bilinear_extent(geo, W, H, x0, y0, W0 * cr["w"], H0 * cr["h"])
                pil = np.asarray(Image.fromarray(geo).transform((W, H), Image.EXTENT, (x0, y0, x0 + W0 * cr["w"], y0 + H0 * cr["h"]), Image.BILINEAR))
                if pil.shape == geo_ref.shape and psnr(pil[..., :3], geo_ref[..., :3]) < 35: fails.append(f"{name}: float bilinear reference disagrees with Pillow EXTENT")
        else:
            geo_ref = geo
        if geo_ref is not None:
            exp = tone_ref(np.ascontiguousarray(geo_ref), c["tone"])
            if exp.shape != out.shape: fails.append(f"{name}: shape {out.shape} vs {exp.shape}"); continue
            diff = np.abs(exp.astype(int) - out.astype(int))
            aligned = not cr or float(cr["x"] * W0).is_integer() and float(cr["y"] * H0).is_integer() and float(cr["w"] * W0).is_integer() and float(cr["h"] * H0).is_integer()
            # geometry is reproduced exactly (aligned: slicing; non-aligned: the float64 bilinear above, rounded the same
            # way) → only float32-LUT vs float64 tone rounding remains: ≤ 1 level
            if diff.max() > 1: fails.append(f"{name}: max diff {diff.max()} (aligned={aligned}, tolerance 1)")
            if any(abs(v) > 0 for v in c["tone"].values()): stats["tone_cases"] += 1; stats["tone_max_diff"] = max(stats["tone_max_diff"], int(diff.max()))
            elif diff.max() == 0: stats["exact"] += 1
        must_same = c["case"] in ("identity", "ratingOnly")
        if c["sameAsSource"] != must_same: fails.append(f"{name}: sameAsSource={c['sameAsSource']}")
    # resolution independence (render(full)↓2 vs render(half))
    for c in rep["cases"]:
        if not c.get("half"): continue
        full = next(x for x in rep["cases"] if x["src"] == "photo" and x["case"] == c["case"])
        fa = np.frombuffer(open(os.path.join(d, "rec", f"photo.{c['case']}.rgba"), "rb").read(), np.uint8).reshape(full["h"], full["w"], 4)
        ha = np.frombuffer(open(os.path.join(d, "rec", f"photo_half.{c['case']}.rgba"), "rb").read(), np.uint8).reshape(c["h"], c["w"], 4)
        down = np.asarray(Image.fromarray(fa).resize((c["w"], c["h"]), Image.BOX))
        mad = float(np.abs(down[..., :3].astype(float) - ha[..., :3].astype(float)).mean()); stats["half_res_mad"][c["case"]] = round(mad, 2)
        if abs(full["w"] / 2 - c["w"]) > 1 or abs(full["h"] / 2 - c["h"]) > 1: fails.append(f"half {c['case']}: size {c['w']}x{c['h']} vs full {full['w']}x{full['h']}")
        if mad > 6: fails.append(f"half {c['case']}: mean abs diff {mad:.2f}")
    print(json.dumps({"fails": fails, "cases": len(rep["cases"]), **stats}, indent=1))
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    if sys.argv[1] == "--prep": prep(sys.argv[2])
    else: check(sys.argv[1])
