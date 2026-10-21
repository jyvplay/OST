#!/usr/bin/env python3
"""Test-only oracle for the TT53 lossless trimmers (PyAV / FFmpeg — LGPL, never shipped).

usage: media_check.py ORIGINAL TRIMMED T0 T1
  T0 = start the trimmer reported (presentation time in the original that must play at 0), T1 = requested end.
Prints one JSON object:
  decode_errors      exceptions while demuxing/decoding the trimmed file (must be 0)
  video_expected     original frames with T0 - e <= t < T1 - e (by presentation time)
  video_got          frames the trimmed file displays (t >= -e after FFmpeg applies edit lists)
  video_match        True when the displayed frames hash-equal the expected frames in order
  time_err_max       max |t_trim - (t_orig - T0)| over matched frames (seconds)
  time_err_rel/shift spacing error relative to the first shown frame, and that frame's offset from (t_orig - T0)
  packets_foreign    trimmed packets whose bytes do not occur in the original (must be 0: lossless)
  audio_first/last   first/last audio packet time in the trimmed file (s) and audio packet count
  duration           container duration of the trimmed file (s)
"""
import sys, json, hashlib
from collections import Counter
import av

orig, trim, T0, T1 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
E = 1e-3

def frames(path):
    out, errs = [], 0
    try:
        c = av.open(path)
        vs = [s for s in c.streams if s.type == "video"]
        if not vs: c.close(); return out, errs
        for f in c.decode(vs[0]):
            t = float(f.pts * f.time_base) if f.pts is not None else None
            out.append((t, hashlib.sha1(f.to_ndarray(format="yuv420p").tobytes()).hexdigest()))
        c.close()
    except Exception as ex:  # noqa: BLE001 — any decoder/demuxer failure counts
        errs += 1; sys.stderr.write(f"decode: {ex}\n")
    return out, errs

def packets(path):
    res, errs = {}, 0
    try:
        c = av.open(path)
        for s in c.streams:
            res[s.type] = res.get(s.type, [])
        for p in c.demux():
            if p.size == 0: continue
            t = float(p.pts * p.time_base) if p.pts is not None else None
            res[p.stream.type].append((t, bytes(p)))
        dur = c.duration / 1e6 if c.duration else None
        c.close()
    except Exception as ex:  # noqa: BLE001
        errs += 1; sys.stderr.write(f"demux: {ex}\n"); dur = None
    return res, errs, dur

of, _ = frames(orig)
tf, e1 = frames(trim)
op, _, _ = packets(orig)
tp, e2, dur = packets(trim)
expected = [h for (t, h) in of if t is not None and T0 - 1e-5 <= t < T1 - 1e-5]  # tighter than any frame step
shown = [(t, h) for (t, h) in tf if t is not None and t >= -E]
got = [h for (_, h) in shown]
otime = {h: t for (t, h) in of}
terr = max([abs(t - (otime[h] - T0)) for (t, h) in shown if h in otime] or [0.0])
# FFmpeg moves the first kept frame of an edit to 0 when the edit starts between frames: compare spacing + the shift
pairs = [(t, otime[h]) for (t, h) in shown if h in otime]
shift = round(pairs[0][0] - (pairs[0][1] - T0), 6) if pairs else 0.0
trel = max([abs((t - pairs[0][0]) - (o - pairs[0][1])) for (t, o) in pairs] or [0.0])
pool = Counter(b for lst in op.values() for (_, b) in lst)
foreign = 0
for lst in tp.values():
    for (_, b) in lst:
        if pool[b] > 0: pool[b] -= 1
        else: foreign += 1
aud = [t for (t, _) in tp.get("audio", []) if t is not None]
print(json.dumps({
    "decode_errors": e1 + e2, "video_expected": len(expected), "video_got": len(got), "video_match": got == expected,
    "time_err_max": round(terr, 6), "time_err_rel": round(trel, 6), "time_shift": shift, "packets_foreign": foreign,
    "audio_packets": len(aud), "audio_first": round(min(aud), 4) if aud else None, "audio_last": round(max(aud), 4) if aud else None,
    "duration": dur,
}))
