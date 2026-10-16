"""
External PSD oracle (TT16) built on psd-tools — an independent Python implementation of the Adobe PSD format with
its own numpy compositor. Used by scripts/oracle-psd.mts. Never shipped, never imported by the app.

  check  <file.psd> <expect.json> <ours_rgba.bin>   psd-tools reads OUR file; compares structure + pixels; composites
  make   <out_dir>                                 psd-tools WRITES files for our reader; dumps expectations

Output: one JSON object on stdout.
"""
import json, sys, os
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer
from psd_tools.constants import BlendMode, Compression

def layer_rgba(layer):
    # psd-tools: topil() of a pixel layer gives the layer's own pixels at its bbox (RGBA when it has transparency)
    im = layer.topil()
    if im is None:
        return None
    return np.asarray(im.convert("RGBA"), dtype=np.uint8)

def check(path, expect_path, rgba_path):
    exp = json.load(open(expect_path))
    psd = PSDImage.open(path)
    out = {"size": [psd.width, psd.height], "layers": [], "problems": []}
    W, H = psd.width, psd.height
    if [W, H] != [exp["width"], exp["height"]]:
        out["problems"].append(f"size {W}x{H} != {exp['width']}x{exp['height']}")
    layers = list(psd)  # top-level, bottom -> top
    if len(layers) != len(exp["layers"]):
        out["problems"].append(f"layer count {len(layers)} != {len(exp['layers'])}")
    for L, E in zip(layers, exp["layers"]):
        rec = {"name": L.name, "bbox": list(L.bbox), "offset": [L.left, L.top], "size": [L.width, L.height],
               "opacity": L.opacity, "blend": L.blend_mode.value.decode("latin1"), "visible": L.visible,
               "hasMask": L.mask is not None}
        if L.name != E["name"]: out["problems"].append(f"name {L.name!r} != {E['name']!r}")
        if [L.left, L.top, L.width, L.height] != [E["x"], E["y"], E["w"], E["h"]]:
            out["problems"].append(f"{E['name']}: geometry {[L.left, L.top, L.width, L.height]} != {[E['x'], E['y'], E['w'], E['h']]}")
        if L.opacity != E["opacity255"]: out["problems"].append(f"{E['name']}: opacity {L.opacity} != {E['opacity255']}")
        if rec["blend"] != E["blendKey"]: out["problems"].append(f"{E['name']}: blend {rec['blend']!r} != {E['blendKey']!r}")
        if L.visible != E["visible"]: out["problems"].append(f"{E['name']}: visible {L.visible} != {E['visible']}")
        # exact channel data via psd-tools' own decoder (numpy channel arrays, 0..1 floats → bytes)
        arr = L.numpy()  # H x W x C float in [0,1] incl. alpha when present
        if arr is None:
            out["problems"].append(f"{E['name']}: no pixel data")
        else:
            got = np.rint(arr * 255).astype(np.uint8)
            if got.shape[2] == 3:
                got = np.concatenate([got, np.full(got.shape[:2] + (1,), 255, np.uint8)], axis=2)
            want = np.frombuffer(open(E["pixels"], "rb").read(), dtype=np.uint8).reshape(E["h"], E["w"], 4)
            if got.shape != want.shape:
                out["problems"].append(f"{E['name']}: pixel shape {got.shape} != {want.shape}")
            else:
                d = int(np.abs(got.astype(int) - want.astype(int)).max())
                rec["pixelMaxDiff"] = d
                if d != 0: out["problems"].append(f"{E['name']}: pixel max diff {d}")
        if E.get("mask"):
            m = L.mask
            if m is None:
                out["problems"].append(f"{E['name']}: mask missing")
            else:
                rec["maskBbox"] = list(m.bbox); rec["maskDisabled"] = bool(m.disabled)
                mim = np.asarray(m.topil(), dtype=np.uint8)
                want = np.frombuffer(open(E["mask"], "rb").read(), dtype=np.uint8).reshape(E["h"], E["w"])
                if mim.shape != want.shape or int(np.abs(mim.astype(int) - want.astype(int)).max()) != 0:
                    out["problems"].append(f"{E['name']}: mask pixels differ")
                if bool(m.disabled) != (not E["maskEnabled"]):
                    out["problems"].append(f"{E['name']}: mask disabled flag {m.disabled}")
        out["layers"].append(rec)
    ours = np.frombuffer(open(rgba_path, "rb").read(), dtype=np.uint8).reshape(H, W, 4).astype(int)
    # (1) merged image data as psd-tools reads it (this is OUR merged composite, decoded by THEIR codec)
    merged = np.asarray(psd.topil().convert("RGBA"), dtype=np.uint8).astype(int)
    out["mergedMaxDiff"] = int(np.abs(merged - ours).max())
    # (2) psd-tools' own compositor, forced to recompute from layers (independent blend maths)
    comp = np.asarray(psd.composite(force=True, ignore_preview=True, color=0.0, alpha=0.0, apply_icc=False).convert("RGBA"), dtype=np.uint8).astype(int)
    a_ours, a_comp = ours[..., 3], comp[..., 3]
    out["compositeAlphaMaxDiff"] = int(np.abs(a_ours - a_comp).max())
    vis = (a_ours > 0) & (a_comp > 0)
    rgb_d = np.abs(ours[..., :3] - comp[..., :3]).max(axis=2)
    out["compositeRgbMaxDiff"] = int(rgb_d[vis].max()) if vis.any() else 0
    out["compositeRgbMeanDiff"] = float(rgb_d[vis].mean()) if vis.any() else 0.0
    out["compositeRgbP99"] = float(np.percentile(rgb_d[vis], 99)) if vis.any() else 0.0
    print(json.dumps(out))

def make(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    rng = np.random.default_rng(42)
    res = {"files": []}
    W, H = 48, 32
    modes = [BlendMode.NORMAL, BlendMode.MULTIPLY, BlendMode.SCREEN, BlendMode.OVERLAY, BlendMode.DARKEN, BlendMode.LIGHTEN,
             BlendMode.COLOR_DODGE, BlendMode.COLOR_BURN, BlendMode.HARD_LIGHT, BlendMode.SOFT_LIGHT, BlendMode.DIFFERENCE, BlendMode.EXCLUSION]
    for comp in [Compression.RAW, Compression.RLE, Compression.ZIP]:
        psd = PSDImage.new("RGBA", (W, H), color=(255, 255, 255, 255))
        bg = Image.fromarray(np.dstack([rng.integers(0, 256, (H, W, 3), dtype=np.uint8), np.full((H, W), 255, np.uint8)]), "RGBA")
        PixelLayer.frompil(bg, psd, name="Background", top=0, left=0, compression=comp)
        expect = []
        for i, mode in enumerate(modes[:6] if comp != Compression.RLE else modes):
            w, h = int(rng.integers(5, 20)), int(rng.integers(5, 16))
            top, left = int(rng.integers(-3, H - 4)), int(rng.integers(-3, W - 4))
            px = np.dstack([rng.integers(0, 256, (h, w, 3), dtype=np.uint8), rng.integers(0, 256, (h, w), dtype=np.uint8)])
            lay = PixelLayer.frompil(Image.fromarray(px, "RGBA"), psd, name=f"L{i} {mode.name.lower()} é", top=top, left=left, compression=comp)
            lay.blend_mode = mode
            lay.opacity = int(rng.integers(80, 256))
            if i == 2: lay.visible = False
        path = os.path.join(out_dir, f"theirs_{comp.name.lower()}.psd")
        psd.save(path)
        psd2 = PSDImage.open(path)
        for L in psd2:
            arr = np.rint(L.numpy() * 255).astype(np.uint8)
            if arr.shape[2] == 3: arr = np.concatenate([arr, np.full(arr.shape[:2] + (1,), 255, np.uint8)], axis=2)
            fn = path + f".{len(expect)}.bin"; open(fn, "wb").write(arr.tobytes())
            expect.append({"name": L.name, "x": L.left, "y": L.top, "w": L.width, "h": L.height, "opacity255": L.opacity,
                           "blendKey": L.blend_mode.value.decode("latin1"), "visible": L.visible, "pixels": fn})
        comp_img = np.asarray(psd2.composite(force=True, ignore_preview=True, color=0.0, alpha=0.0, apply_icc=False).convert("RGBA"), dtype=np.uint8)
        cf = path + ".composite.bin"; open(cf, "wb").write(comp_img.tobytes())
        res["files"].append({"path": path, "width": W, "height": H, "layers": expect, "composite": cf, "compression": comp.name})
    # flattened, layer-less document (merged image only) → our fallback path
    flat = Image.fromarray(rng.integers(0, 256, (20, 30, 3), dtype=np.uint8), "RGB")
    fp = os.path.join(out_dir, "theirs_flat.psd")
    PSDImage.frompil(flat).save(fp)
    ff = fp + ".rgb.bin"; open(ff, "wb").write(np.asarray(flat, dtype=np.uint8).tobytes())
    res["flat"] = {"path": fp, "width": 30, "height": 20, "rgb": ff, "layers": len(list(PSDImage.open(fp)))}
    # grayscale flattened
    g = Image.fromarray(rng.integers(0, 256, (10, 12), dtype=np.uint8), "L")
    gp = os.path.join(out_dir, "theirs_gray.psd"); PSDImage.frompil(g).save(gp)
    gf = gp + ".l.bin"; open(gf, "wb").write(np.asarray(g, dtype=np.uint8).tobytes())
    res["gray"] = {"path": gp, "width": 12, "height": 10, "l": gf}
    print(json.dumps(res))

if __name__ == "__main__":
    if sys.argv[1] == "check": check(sys.argv[2], sys.argv[3], sys.argv[4])
    elif sys.argv[1] == "make": make(sys.argv[2])
    else: raise SystemExit("usage: check|make")
