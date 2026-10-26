#!/usr/bin/env python3
"""TT54 mutation check for the metadata / TIFF / encoder / recipe stack: each mutant re-introduces one plausible bug;
scripts/tt54-meta.mts (Pillow / libavif / libheif / FFmpeg / exifread / pypdf / numpy oracles, negative shapes) must FAIL
for every mutant. Files are restored byte-for-byte (verified) and so is docs/test-results/tt54-meta.json.
Run from the repository root:  python3 scripts/tt54-mutants.py  (MUT=<substring>)
"""
import os, subprocess, sys, pathlib
T, R, E, X, P = "src/lib/image/tiff.ts", "src/lib/photos/recipe.ts", "src/lib/image/encode.ts", "src/lib/meta/exif.ts", "src/lib/pdf/pdfdoc.ts"
TIF, REC, ENC, NEG, META, RCV = "TIFF decoder", "MD-03", "FF-07", "Negative shapes", "metadata readers", "PDF recovery"
MUTANTS = [
    ("TIFF LZW code width grows one code late (no early change)", T, "if (next + 1 >= 1 << width && width < 12) width++;", "if (next >= 1 << width && width < 12) width++;", TIF),
    ("TIFF horizontal predictor ignored", T, "if (pred === 2) unpredict(px, rows, rowBytes, sppChunk, bits, le);", "if (pred === -2) unpredict(px, rows, rowBytes, sppChunk, bits, le);", TIF),
    ("TIFF palette green read from the red table", T, "data[d + 1] = map[k + v] >> 8;", "data[d + 1] = map[v] >> 8;", TIF),
    ("TIFF 16-bit samples read with the wrong byte order", T, "const v = le ? row[i * 2] | (row[i * 2 + 1] << 8) : (row[i * 2] << 8) | row[i * 2 + 1];", "const v = (row[i * 2] << 8) | row[i * 2 + 1];", TIF),
    ("TIFF planar files decoded as chunky", T, "const planes = planar === 2 ? spp : 1, sppChunk = planar === 2 ? 1 : spp;", "const planes = 1, sppChunk = spp;", TIF),
    ("TIFF strip placed at the wrong row", T, "out.set(px.subarray(0, Math.min(want, px.length)), s * rps * rowBytes);", "out.set(px.subarray(0, Math.min(want, px.length)), s * rowBytes);", TIF),
    ("TIFF PackBits run one byte short", T, "const c = Math.min(1 - n, want - o);", "const c = Math.min(-n, want - o);", TIF),
    ("TIFF sub-byte samples read LSB-first", T, "return (row[bit >> 3] >> (8 - bits - (bit & 7))) & maxv;", "return (row[bit >> 3] >> (bit & 7)) & maxv;", TIF),
    ("TIFF associated alpha left premultiplied / unassociated alpha dropped", T, "data[d + 3] = spp > 3 && extra.length ? to8(get(3)) : 255;", "data[d + 3] = 255;", TIF),
    ("TIFF strip bounds check removed", T, 'if (o + l > b.length) throw new TiffError("strip outside the file");', "", NEG),
    ("TIFF tiles accepted", T, 'if (tags.has(322) || tags.has(324)) throw new TiffError("tiled TIFF is not supported");', "", NEG),
    ("TIFF pixel cap removed", T, "if (W * H > MAX_PIXELS) throw new TiffError(", "if (false) throw new TiffError(", NEG),
    ("Recipe quarter turn maps columns wrong", R, "const nx = t === 1 ? h - 1 - y : t === 2", "const nx = t === 1 ? y : t === 2", REC),
    ("Recipe accepts inherited preset names", R, "Object.prototype.hasOwnProperty.call(PRESETS, o.preset)", "o.preset in PRESETS", REC),
    ("Recipe vignette linear instead of quadratic", R, "const m = 1 - vg * 0.8 * d * d;", "const m = 1 - vg * 0.8 * d;", REC),
    ("Recipe saturation uses Rec.601 luma", R, "const l = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;", "const l = 0.299 * rr + 0.587 * gg + 0.114 * bb;", REC),
    ("Recipe straighten forgets the fill crop", R, "const k = deg ? straightenScale(w, h, deg) : 1;", "const k = 1;", REC),
    ("Recipe exposure applied in gamma space", R, "toSrgb(Math.min(1, TO_LIN[i] * g))", "Math.min(1, (i / 255) * g)", REC),
    ("Recipe crop origin allowed to reach the edge (zero-size crop)", R, "const x = clampN(c.x, 0, 0.99), y = clampN(c.y, 0, 0.99);", "const x = clampN(c.x, 0, 1), y = clampN(c.y, 0, 1);", REC),
    ("Export keeps GPS without consent", E, "const gps: Entry[] = o.keepLocation ?", "const gps: Entry[] = true ?", ENC),
    ("Export keeps the source orientation tag", E, "ifd0.push({ tag: TAG.Orientation, type: 3, count: 1, bytes: short(1) });", "", ENC),
    ("JPEG export leaves the encoder's own Exif block (two blocks)", E, "return cat([jpg.subarray(0, at), seg, stripApp1Exif(jpg.subarray(at))]);", "return cat([jpg.subarray(0, at), seg, jpg.subarray(at)]);", ENC),
    ("PNG export keeps an old eXIf chunk", E, 'if (type === "eXIf") { o = end; continue; }', "", ENC),
    ("WebP export forgets the VP8X EXIF flag", E, "vp8x.data[0] |= 0x08;", "", ENC),
    ("WebP chunk walk ignores odd-size padding", E, "o += 8 + n + (n & 1);", "o += 8 + n;", ENC),
    ("AVIF export drops the Exif item", E, "nclx, exif });", "nclx });", ENC),
    ("EXIF southern latitudes not negated", X, '.toUpperCase().startsWith("S") ? -1 : 1;', ".toUpperCase().startsWith(\"S\") ? 1 : 1;", META),
    ("EXIF out-of-range orientation passed through", X, "return o >= 1 && o <= 8 ? o : 1;", "return o;", NEG),
    ("PDF incremental update loses /Info", P, 'else for (const k of ["Info", "ID"]) if (!this.trailer.has(k) && trailer.has(k)) this.trailer.set(k, trailer.get(k));', "else void 0;", META),
    ("PDF recovery does not borrow /Info from older trailers", P, 'for (const k of ["Encrypt", "ID", "Info"]) if (!trailer.has(k)) {', 'for (const k of ["Encrypt", "ID"]) if (!trailer.has(k)) {', RCV),
]
RESULTS = pathlib.Path("docs/test-results/tt54-meta.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
SELECTED = [m for m in MUTANTS if os.environ.get("MUT", "") in m[0]]
killed = 0
for name, path, old, new, _ in SELECTED:
    n = pathlib.Path(path).read_text().count(old); assert n == 1, f"anchor for '{name}' found {n} times"
try:
    for name, path, old, new, only in SELECTED:
        p = pathlib.Path(path); orig = p.read_bytes(); text = orig.decode()
        try:
            p.write_text(text.replace(old, new))
            try:
                r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt54-meta.mts"],
                                   env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=900)
                out = r.stdout + r.stderr; dead = "FAILED:" in out or r.returncode != 0
            except subprocess.TimeoutExpired:
                out = "timeout"; dead = True
            failed = [l.strip()[2:70] for l in out.splitlines() if l.strip().startswith("✗")]
            print(f"{'KILLED ' if dead else 'SURVIVED'} {name}  ← {', '.join(failed) or out[-200:]}", flush=True)
            killed += dead
        finally:
            p.write_bytes(orig)
            assert p.read_bytes() == orig, f"{path} not restored"
finally:
    if saved is not None: RESULTS.write_bytes(saved)
print(f"{killed}/{len(SELECTED)} mutants killed")
sys.exit(0 if killed == len(SELECTED) else 1)
