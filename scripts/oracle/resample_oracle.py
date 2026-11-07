#!/usr/bin/env python3
"""Independent numerical reference for TT146's resampler and key light.

TEST-ONLY. Nothing here ships in Fusion; it exists so the JavaScript
implementation is checked against a second language with a different numeric
pipeline (numpy float64) rather than against itself.

Protocol: one JSON object on stdin, one JSON object on stdout.

  {"op":"resample","width":W,"height":H,"data":[...],"dstW":..,"dstH":..,"kernel":"lanczos3"}
  {"op":"relight","width":W,"height":H,"data":[...],"azimuth":..,"elevation":..,"intensity":..,"relief":..,"shininess":..,"specular":..}
  {"op":"pillow","width":W,"height":H,"data":[...],"dstW":..,"dstH":..}   # a third-party Lanczos, for a sanity band

The resampler is implemented from the same *definition* the JavaScript uses
(normalised separable windowed sinc, support widened on reduction, premultiplied
alpha) but written independently; agreement therefore checks the implementation,
not a shared code path.
"""
import json
import math
import sys

import numpy as np


def sinc(x):
    if x == 0:
        return 1.0
    return math.sin(math.pi * x) / (math.pi * x)


def kernel_value(kernel, x):
    ax = abs(x)
    if kernel == "linear":
        return 1.0 - ax if ax < 1 else 0.0
    if kernel == "cubic":
        a = -0.5
        if ax < 1:
            return (a + 2) * ax**3 - (a + 3) * ax**2 + 1
        if ax < 2:
            return a * ax**3 - 5 * a * ax**2 + 8 * a * ax - 4 * a
        return 0.0
    if kernel == "lanczos3":
        return sinc(ax) * sinc(ax / 3) if ax < 3 else 0.0
    raise ValueError(kernel)


SUPPORT = {"linear": 1.0, "cubic": 2.0, "lanczos3": 3.0}
MAX_TAPS = 32
MAX_FILTER_SCALE = 4.0


def tap_table(src_len, dst_len, kernel):
    ratio = dst_len / src_len
    filter_scale = min(MAX_FILTER_SCALE, max(1.0, 1.0 / ratio))
    support = SUPPORT[kernel] * filter_scale
    taps = min(MAX_TAPS, src_len, max(1, int(math.ceil(support * 2))))
    table = np.zeros((dst_len, taps), dtype=np.float64)
    starts = np.zeros(dst_len, dtype=np.int64)
    for i in range(dst_len):
        centre = (i + 0.5) / ratio - 0.5
        first = int(math.ceil(centre - support))
        if first + taps - 1 > src_len - 1:
            first = src_len - taps
        if first < 0:
            first = 0
        starts[i] = first
        row = np.array([kernel_value(kernel, (first + t - centre) / filter_scale) for t in range(taps)])
        total = row.sum()
        if total == 0:
            nearest = min(src_len - 1, max(0, int(round(centre))))
            starts[i] = nearest
            row = np.zeros(taps)
            row[0] = 1.0
        table[i] = row / row.sum()
    return starts, table, taps


def resample(width, height, data, dst_w, dst_h, kernel):
    src = np.array(data, dtype=np.float64).reshape(height, width, 4)
    alpha = src[:, :, 3:4] / 255.0
    rgb = src[:, :, :3] * alpha
    a = src[:, :, 3:4]

    hs, hw, ht = tap_table(width, dst_w, kernel)
    vs, vw, vt = tap_table(height, dst_h, kernel)

    # Horizontal pass (premultiplied), float64 throughout.
    mid = np.zeros((height, dst_w, 4), dtype=np.float64)
    for x in range(dst_w):
        lo = hs[x]
        block_rgb = rgb[:, lo:lo + ht, :]
        block_a = a[:, lo:lo + ht, :]
        w = hw[x]
        mid[:, x, :3] = np.tensordot(block_rgb, w, axes=([1], [0]))
        mid[:, x, 3] = np.tensordot(block_a[:, :, 0], w, axes=([1], [0]))

    out = np.zeros((dst_h, dst_w, 4), dtype=np.uint8)
    for y in range(dst_h):
        lo = vs[y]
        w = vw[y]
        block = mid[lo:lo + vt, :, :]
        r = np.tensordot(w, block[:, :, 0], axes=([0], [0]))
        g = np.tensordot(w, block[:, :, 1], axes=([0], [0]))
        b = np.tensordot(w, block[:, :, 2], axes=([0], [0]))
        al = np.tensordot(w, block[:, :, 3], axes=([0], [0]))
        for x in range(dst_w):
            alpha_out = max(0.0, min(255.0, al[x]))
            # Below half a level the sample is fully transparent: unpremultiplying
            # by a ringing residual (1e-14) is how white specks appear.
            if alpha_out < 0.5:
                continue
            inv = 255.0 / alpha_out
            out[y, x, 0] = clamp(round_half_up(r[x] * inv))
            out[y, x, 1] = clamp(round_half_up(g[x] * inv))
            out[y, x, 2] = clamp(round_half_up(b[x] * inv))
            out[y, x, 3] = clamp(round_half_up(alpha_out))
    return out.reshape(-1).tolist()


def luma(r, g, b):
    return 0.299 * r + 0.587 * g + 0.114 * b


def relight(width, height, data, azimuth, elevation, intensity, relief=2.0, shininess=32.0, specular=0.25):
    img = np.array(data, dtype=np.float64).reshape(height, width, 4)
    if intensity == 0:
        return img.astype(np.uint8).reshape(-1).tolist()
    elevation = min(85.0, max(0.0, elevation))
    az = math.radians(azimuth % 360.0)
    el = math.radians(elevation)
    lx = math.cos(el) * math.cos(az)
    ly = -math.cos(el) * math.sin(az)
    lz = math.sin(el)
    hx, hy, hz = lx, ly, lz + 1.0
    hl = math.hypot(hx, hy, hz) or 1.0
    hx, hy, hz = hx / hl, hy / hl, hz / hl

    lum = 0.299 * img[:, :, 0] + 0.587 * img[:, :, 1] + 0.114 * img[:, :, 2]
    # Same clamped-edge Sobel as the JavaScript (border pixels repeat their neighbour).
    padded = np.pad(lum, 1, mode="edge")
    gx = ((padded[0:-2, 2:] + 2 * padded[1:-1, 2:] + padded[2:, 2:])
          - (padded[0:-2, 0:-2] + 2 * padded[1:-1, 0:-2] + padded[2:, 0:-2])) / 8.0
    gy = ((padded[2:, 0:-2] + 2 * padded[2:, 1:-1] + padded[2:, 2:])
          - (padded[0:-2, 0:-2] + 2 * padded[0:-2, 1:-1] + padded[0:-2, 2:])) / 8.0
    sx = (-gx * relief) / 64.0
    sy = (-gy * relief) / 64.0
    nl = np.sqrt(sx * sx + sy * sy + 1.0)
    nx, ny, nz = sx / nl, sy / nl, 1.0 / nl

    diffuse = np.maximum(0.0, nx * lx + ny * ly + nz * lz)
    spec_base = np.maximum(0.0, nx * hx + ny * hy + nz * hz)
    spec = np.power(spec_base, shininess) * specular

    gain = 1.0 + intensity * diffuse
    add = intensity * spec * 255.0
    out = np.zeros_like(img)
    alpha = img[:, :, 3]
    for c in range(3):
        out[:, :, c] = img[:, :, c] * gain + add
    out[:, :, 3] = alpha
    out[alpha == 0] = 0
    out = np.clip(np.floor(out[:, :, :3] + 0.5), 0, 255)
    packed = np.zeros((height, width, 4), dtype=np.uint8)
    packed[:, :, :3] = out
    packed[:, :, 3] = np.clip(alpha, 0, 255)
    return packed.reshape(-1).tolist()


def round_half_up(v):
    # JavaScript's Math.round, which is floor(v + 0.5) for the non-negative range here.
    return int(math.floor(v + 0.5))


def clamp(v):
    return max(0, min(255, int(v)))


def pillow(width, height, data, dst_w, dst_h):
    """A third-party Lanczos, for a sanity band rather than an exact match."""
    from PIL import Image

    img = Image.frombytes("RGBA", (width, height), bytes(data))
    resized = img.resize((dst_w, dst_h), Image.LANCZOS)
    return list(resized.tobytes())


def main():
    payload = json.loads(sys.stdin.read())
    op = payload["op"]
    if op == "resample":
        out = resample(payload["width"], payload["height"], payload["data"],
                       payload["dstW"], payload["dstH"], payload.get("kernel", "lanczos3"))
    elif op == "relight":
        out = relight(payload["width"], payload["height"], payload["data"],
                      payload["azimuth"], payload["elevation"], payload["intensity"],
                      payload.get("relief", 2.0), payload.get("shininess", 32.0), payload.get("specular", 0.25))
    elif op == "pillow":
        out = pillow(payload["width"], payload["height"], payload["data"], payload["dstW"], payload["dstH"])
    else:
        raise SystemExit(f"unknown op {op}")
    sys.stdout.write(json.dumps({"data": out}))


if __name__ == "__main__":
    main()
