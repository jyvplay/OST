#!/usr/bin/env python3
"""Test-only fixture generator for the TT53 lossless trimmers (PyAV / FFmpeg — LGPL, never shipped with Fusion).

usage: media_fixtures.py OUTDIR
Writes short clips whose every frame is visually distinct (moving bars + frame-number blocks) so decoded-frame hashes
identify frames uniquely. Key frames are forced every 1 s (GOP 30 @ 30 fps); H.264 uses B-frames (reordering).
"""
import sys, os, fractions, json
import numpy as np
import av

out = sys.argv[1]; os.makedirs(out, exist_ok=True)
W, H, FPS, SECS = 160, 96, 30, 6

def frame_rgb(i):
    y, x = np.mgrid[0:H, 0:W]
    img = np.zeros((H, W, 3), np.uint8)
    img[..., 0] = (x * 255 // W + i * 7) % 256
    img[..., 1] = (y * 255 // H + i * 3) % 256
    img[..., 2] = ((x // 16 + y // 16 + i) % 2) * 200
    for b in range(8):  # frame number as 8 binary blocks
        if (i >> b) & 1: img[0:12, b * 20:(b + 1) * 20] = 255
        else: img[0:12, b * 20:(b + 1) * 20] = 0
    return img

def make(name, fmt, vcodec, acodec, options=None, vopts=None, audio_only=False, video=True):
    path = os.path.join(out, name)
    c = av.open(path, "w", format=fmt, options=options or {})
    vs = None
    if video and not audio_only:
        vs = c.add_stream(vcodec, rate=FPS); vs.width, vs.height, vs.pix_fmt = W, H, "yuv420p"
        vs.options = vopts or {}
    as_ = None
    if acodec:
        rate = 48000
        as_ = c.add_stream(acodec, rate=rate); as_.layout = "stereo"
    if vs:
        for i in range(FPS * SECS):
            fr = av.VideoFrame.from_ndarray(frame_rgb(i), format="rgb24").reformat(format="yuv420p")
            fr.pts = i; fr.time_base = fractions.Fraction(1, FPS)
            for p in vs.encode(fr): c.mux(p)
        for p in vs.encode(None): c.mux(p)
    if as_:
        n = as_.codec_context.frame_size or 1024; rate = 48000; t = 0
        while t < rate * SECS:
            k = np.arange(t, t + n)
            tone = (0.2 * np.sin(2 * np.pi * (220 + (k // rate) * 110) * k / rate)).astype(np.float32)
            fmt_s = as_.codec_context.format.name
            arr = np.stack([tone, tone])
            if fmt_s.startswith("s16"): arr = (arr * 32767).astype(np.int16)
            af = av.AudioFrame.from_ndarray(arr if fmt_s.endswith("p") else arr.T.reshape(1, -1).copy(), format=fmt_s, layout="stereo")
            af.sample_rate = rate; af.pts = t; af.time_base = fractions.Fraction(1, rate)
            for p in as_.encode(af): c.mux(p)
            t += n
        for p in as_.encode(None): c.mux(p)
    c.close()
    return path

x264 = {"bf": "2", "g": "30", "x264-params": "keyint=30:min-keyint=30:scenecut=0:bframes=2:b-pyramid=none", "preset": "veryfast"}
vpx = {"g": "30", "keyint_min": "30", "deadline": "realtime", "cpu-used": "8"}
made = {}
made["h264-aac.mp4"] = make("h264-aac.mp4", "mp4", "libx264", "aac", vopts=x264)
made["h264-aac-faststart.mp4"] = make("h264-aac-faststart.mp4", "mp4", "libx264", "aac", options={"movflags": "faststart"}, vopts=x264)
made["h264-frag.mp4"] = make("h264-frag.mp4", "mp4", "libx264", "aac", options={"movflags": "frag_keyframe+empty_moov+default_base_moof"}, vopts=x264)
made["h264-aac.mov"] = make("h264-aac.mov", "mov", "libx264", "aac", vopts=x264)
made["h264-only.mp4"] = make("h264-only.mp4", "mp4", "libx264", None, vopts=x264)
made["aac-only.mp4"] = make("aac-only.mp4", "mp4", None, "aac", audio_only=True)
made["vp8-opus.webm"] = make("vp8-opus.webm", "webm", "libvpx", "libopus", vopts=vpx)
made["vp9-opus.webm"] = make("vp9-opus.webm", "webm", "libvpx-vp9", "libopus", vopts=vpx)
made["h264-aac.mkv"] = make("h264-aac.mkv", "matroska", "libx264", "aac", vopts=x264)
made["opus-only.webm"] = make("opus-only.webm", "webm", None, "libopus", audio_only=True)
print(json.dumps({k: os.path.getsize(v) for k, v in made.items()}))
