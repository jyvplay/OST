#!/usr/bin/env python3
"""TT53 mutation check for the lossless trimmers (src/lib/media/bmff.ts, ebml.ts): each mutant re-introduces one
plausible bug; scripts/tt53-media.mts (FFmpeg/PyAV decode-and-hash oracle, Chromium playback, structural timing,
negative shapes) must FAIL for every mutant. Files are restored byte-for-byte (verified) and so is
docs/test-results/tt53-media.json.  Run from the repository root:  python3 scripts/tt53-mutants.py  (MUT=<substring>)
"""
import os, subprocess, sys, pathlib
B, E = "src/lib/media/bmff.ts", "src/lib/media/ebml.ts"
MUTANTS = [
    ("MP4 start search ignores sync flags (cuts mid-GOP)", B, "if (t.sync[i] && ptOf(t, i) <= from + eps) k = i;", "if (ptOf(t, i) <= from + eps) k = i;", "MP4/MOV sweep"),
    ("MP4 end prefix stops at the first frame past the end (B-frames lost)", B, "for (let i = k; i < n; i++) if (ptOf(t, i) < to - eps) m = i;", "for (let i = k; i < n && ptOf(t, i) < to - eps; i++) m = i;", "MP4/MOV sweep"),
    ("MP4 edit list forgets the source's own media offset", B, "const mediaAtT0 = (T0 - t.dwell) * t.timescale + t.mediaTime - D;", "const mediaAtT0 = (T0 - t.dwell) * t.timescale - D;", "MP4/MOV sweep"),
    ("MP4 composition offsets (ctts) dropped", B, "if (ctts.some(([, c]) => c !== 0)) stbl.push(", "if (false) stbl.push(", "MP4/MOV sweep"),
    ("MP4 sync sample table (stss) dropped", B, "if (stss.length < s.length) stbl.push(", "if (false) stbl.push(", "MP4/MOV sweep"),
    ("MP4 audio keeps only frames starting after the cut (gap at 0)", B, "if (e > from + eps && p < to - eps) keep.push(i);", "if (p >= from - eps && p < to - eps) keep.push(i);", "MP4/MOV sweep"),
    ("MP4 movie header keeps the source duration", B, "withDuration(r, m.mvhd, Math.round(outDur * m.timescale), 16, 24)", "raw(r, m.mvhd)", "MP4/MOV sweep"),
    ("MP4 chunk offsets miss the mdat header", B, "moov = build(ftyp.length + moov.length + mdatHdr, wide);", "moov = build(ftyp.length + moov.length, wide);", "MP4/MOV sweep"),
    ("MP4 encv (CENC video) accepted", B, 'e.type === "encv" || ', "", "negative shapes"),
    ("MP4 multi-edit lists accepted", B, 'if (media !== null) throw new MediaError("edit lists with more than one media edit are not supported");', "", "negative shapes"),
    ("MP4 several sample descriptions accepted (wrong sdi for half the range)", B, "if (sdis.size > 1) throw new MediaError(", "if (false) throw new MediaError(", "negative shapes"),
    ("MP4 fixed-size stsz count not bounded by the file size", B, " || (fixed && fixed * n > r.b.length)", "", "negative shapes"),
    ("MP4 truncated fragment keeps a decode prefix with display gaps", B, "if (mx < minLost) break; k--;", "break; k--;", "negative shapes"),
    ("MP4 largesize header misread", B, "if (size === 1) { size = r.u64(p + 8); hdr = 16; }", "if (size === 1) { size = r.u64(p + 8); hdr = 8; }", "unusual-but-valid"),
    ("EBML unknown size checked after the range test (live recordings rejected)", E, "if (ones) return [v, len, true];", "", "MediaRecorder"),
    ("EBML SimpleBlock key-frame flag ignored", E, "key: simple ? !!(flags & 0x80) : true", "key: true", "WebM/MKV sweep"),
    ("EBML B-frame reference extension removed (display gap)", E, "if (ext === lastVideo) break; lastVideo = ext;", "break;", "WebM/MKV sweep"),
    ("EBML int16 cluster split removed", E, " || t - cur.time > 32767 || t - cur.time < -32768", "", "int16"),
    ("EBML unknown-size cluster does not end at the next cluster", E, "if (e.unknown && (SEGMENT_LEVEL.has(c.id) || c.id === ID.EBML)) { clusterEnd = q; break; }", "", "MediaRecorder"),
    ("EBML relative timestamp high byte not patched", E, "rawEl[o] = (rel >> 8) & 255; rawEl[o + 1] = rel & 255;", "rawEl[o + 1] = rel & 255;", "WebM/MKV sweep"),
    ("EBML Duration not written", E, "infoKids.push(el(ID.Duration, f64(endT)));", "", "self-indexed"),
    ("EBML Cues point one byte past the cluster", E, "uEl(ID.CueClusterPosition, pos)))", "uEl(ID.CueClusterPosition, pos + 1)))", "self-indexed"),
    ("EBML encrypted tracks accepted", E, 'throw new MediaError("encrypted tracks cannot be trimmed");', "void 0;", "negative shapes"),
    ("EBML reported end overshoots the next real frame", E, "Math.min(next, last + vStep));", "last + vStep);", "irregular recorder"),
    ("EBML audio kept from before the key frame (negative timestamps)", E, "else if (x.time >= keyTime - eps && x.time < otherEnd - eps) keep.push(x);", "else if (x.time < otherEnd - eps) keep.push(x);", "WebM/MKV sweep"),
]
RESULTS = pathlib.Path("docs/test-results/tt53-media.json"); saved = RESULTS.read_bytes() if RESULTS.exists() else None
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
                r = subprocess.run(["node", "--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt53-media.mts"],
                                   env={**os.environ, "ONLY": only}, capture_output=True, text=True, timeout=600)
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
