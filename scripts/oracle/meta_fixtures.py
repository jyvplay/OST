#!/usr/bin/env python3
"""TT54 — synthetic metadata fixtures for formats the camera / audio corpora lack (test-only).

usage: meta_fixtures.py OUTDIR      writes files + OUTDIR/expected.json (what the WRITER put in)
Writers: Pillow (PNG text / zTXt / iTXt / eXIf, APNG, GIF comment + animation, WebP lossy / lossless / animated + EXIF + XMP,
AVIF + EXIF, TIFF multi-page, BMP), piexif (GPS + orientation EXIF), PyAV (MP4 / MKV / WebM with title + artist tags),
mutagen (MP4 ilst tags + cover, ID3v2.3 / v2.4 with UTF-16 and APIC, FLAC picture, Opus tags).
"""
import io, json, os, sys
import piexif
from PIL import Image, PngImagePlugin

out = sys.argv[1]; os.makedirs(out, exist_ok=True)
exp = {}
def img(w=64, h=40, mode="RGB", color=(240, 120, 30)):
    return Image.new(mode, (w, h), color)

gps = {piexif.GPSIFD.GPSLatitudeRef: b"S", piexif.GPSIFD.GPSLatitude: ((33, 1), (52, 1), (813, 100)),
       piexif.GPSIFD.GPSLongitudeRef: b"E", piexif.GPSIFD.GPSLongitude: ((151, 1), (12, 1), (3015, 100)),
       piexif.GPSIFD.GPSAltitudeRef: 1, piexif.GPSIFD.GPSAltitude: (12, 1)}
exif_d = {"0th": {piexif.ImageIFD.Make: b"Fusion", piexif.ImageIFD.Model: b"TT54 Cam", piexif.ImageIFD.Orientation: 6},
          "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2026:10:21 09:30:15", piexif.ExifIFD.ExposureTime: (1, 250), piexif.ExifIFD.FNumber: (28, 10), piexif.ExifIFD.ISOSpeedRatings: 400, piexif.ExifIFD.FocalLength: (50, 1)},
          "GPS": gps}
exif_bytes = piexif.dump(exif_d)
lat = -(33 + 52 / 60 + 8.13 / 3600); lon = 151 + 12 / 60 + 30.15 / 3600
XMP = ('<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:x2="http://ns.adobe.com/xap/1.0/" x2:Rating="4">'
       '<dc:title><rdf:Alt><rdf:li xml:lang="fr">Bonjour</rdf:li><rdf:li xml:lang="x-default">Poolside &amp; sun</rdf:li></rdf:Alt></dc:title>'
       '<dc:subject><rdf:Bag><rdf:li>pool</rdf:li><rdf:li>miami</rdf:li></rdf:Bag></dc:subject>'
       '<dc:creator><rdf:Seq><rdf:li>Ana</rdf:li><rdf:li>Bo</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
camera = {"make": "Fusion", "model": "TT54 Cam", "dateTaken": "2026-10-21T09:30:15", "exposure": "1/250 s", "fNumber": "f/2.8", "iso": "ISO 400", "focalLength": "50 mm"}
xmp_exp = {"title": "Poolside & sun", "keywords": "pool; miami", "creator": "Ana; Bo", "rating": "4"}

# PNG: tEXt + zTXt + iTXt + eXIf + XMP iTXt
pi = PngImagePlugin.PngInfo()
pi.add_text("Title", "Sunset swim"); pi.add_text("Author", "Fusion OS", zip=True); pi.add_itxt("Description", "Ünïcödé — ok", lang="en", tkey="Beschreibung", zip=True)
pi.add_itxt("XML:com.adobe.xmp", XMP)
img(80, 50, "RGBA").save(f"{out}/text.png", pnginfo=pi, exif=exif_bytes)
exp["text.png"] = {"format": "png", "width": 80, "height": 50, "orientation": 6, "displayWidth": 50, "displayHeight": 80, "tags": {"title": "Sunset swim", "creator": "Fusion OS", "description": "Ünïcödé — ok", **camera}, "gps": [lat, lon, -12]}
# APNG
frames = [img(30, 20, color=(i * 60, 10, 200)) for i in range(4)]
frames[0].save(f"{out}/anim.png", save_all=True, append_images=frames[1:], duration=100)
exp["anim.png"] = {"format": "png", "width": 30, "height": 20, "frames": 4}
# GIF: comment + 5 frames
g = [img(33, 17, color=(i * 50, 255 - i * 40, 90)) for i in range(5)]
g[0].save(f"{out}/anim.gif", save_all=True, append_images=g[1:], duration=80, loop=0, comment=b"made by TT54")
exp["anim.gif"] = {"format": "gif", "width": 33, "height": 17, "frames": 5, "tags": {"comment": "made by TT54"}}
# WebP lossy / lossless / animated with EXIF + XMP
img(101, 57).save(f"{out}/lossy.webp", quality=80, exif=exif_bytes, xmp=XMP.encode())
exp["lossy.webp"] = {"format": "webp", "width": 101, "height": 57, "orientation": 6, "tags": {**camera, **xmp_exp}, "gps": [lat, lon, -12]}
img(77, 33, "RGBA", (1, 2, 3, 128)).save(f"{out}/lossless.webp", lossless=True)
exp["lossless.webp"] = {"format": "webp", "width": 77, "height": 33}
w = [img(41, 29, color=(i * 50, 100, 20)) for i in range(3)]
w[0].save(f"{out}/anim.webp", save_all=True, append_images=w[1:], duration=120)
exp["anim.webp"] = {"format": "webp", "width": 41, "height": 29, "frames": 3}
# JPEG with EXIF + XMP via Pillow
img(120, 90).save(f"{out}/camera.jpg", quality=85, exif=exif_bytes, xmp=XMP.encode())
exp["camera.jpg"] = {"format": "jpeg", "width": 120, "height": 90, "orientation": 6, "displayWidth": 90, "displayHeight": 120, "tags": {**camera, **xmp_exp}, "gps": [lat, lon, -12]}
# AVIF with EXIF (Pillow 13 libavif)
img(64, 48).save(f"{out}/photo.avif", quality=60, exif=exif_bytes)
exp["photo.avif"] = {"format": "avif", "width": 64, "height": 48, "tags": {"make": "Fusion", "model": "TT54 Cam"}}
# TIFF multi-page + BMP
t = [img(20, 10), img(20, 10, color=(0, 0, 0)), img(20, 10, color=(9, 9, 9))]
t[0].save(f"{out}/pages.tif", save_all=True, append_images=t[1:])
exp["pages.tif"] = {"format": "tiff", "width": 20, "height": 10, "frames": 3}
img(13, 7).save(f"{out}/small.bmp")
exp["small.bmp"] = {"format": "bmp", "width": 13, "height": 7}
# SVG
open(f"{out}/vector.svg", "w").write('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150" width="12cm"><title>Logo  </title><rect width="10" height="10"/></svg>')
exp["vector.svg"] = {"format": "svg", "width": round(12 * 96 / 2.54), "height": round(12 * 96 / 2.54 / 2), "tags": {"title": "Logo"}}

# --- audio/video via PyAV + mutagen
import av, numpy as np
def tone(path, fmt, codec, rate=48000, seconds=1.5, meta=None, video=False, layout="stereo"):
    c = av.open(path, "w", format=fmt)
    for k, v in (meta or {}).items(): c.metadata[k] = v
    vs = None
    if video:
        vs = c.add_stream("libvpx" if fmt == "webm" else "libx264", rate=25); vs.width, vs.height, vs.pix_fmt = 96, 64, "yuv420p"
    a = c.add_stream(codec, rate=rate, layout=layout)
    n = int(rate * seconds); t = np.arange(n) / rate; s = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)
    fr = av.AudioFrame.from_ndarray(np.stack([s, s]).reshape(1, -1) if layout == "stereo" else s.reshape(1, -1), format="s16", layout=layout); fr.sample_rate = rate
    for p in a.encode(fr): c.mux(p)
    for p in a.encode(None): c.mux(p)
    if vs:
        for i in range(int(25 * seconds)):
            f = av.VideoFrame.from_ndarray(np.full((64, 96, 3), i * 5 % 255, np.uint8), format="rgb24")
            for p in vs.encode(f): c.mux(p)
        for p in vs.encode(None): c.mux(p)
    c.close()
tone(f"{out}/tagged.mkv", "matroska", "libopus", meta={"title": "Matroska title", "artist": "Mk Artist"}, video=True)
exp["tagged.mkv"] = {"format": "mkv", "width": 96, "height": 64, "tags": {"title": "Matroska title", "artist": "Mk Artist"}}
tone(f"{out}/tagged.webm", "webm", "libopus", meta={"title": "Web title"}, video=True)
exp["tagged.webm"] = {"format": "webm", "width": 96, "height": 64, "tags": {"title": "Web title"}}
tone(f"{out}/clip.mp4", "mp4", "aac", meta={"title": "Clip title", "artist": "Clip Artist", "location": "+25.7617-080.1918/"}, video=True)
exp["clip.mp4"] = {"format": "mp4", "width": 96, "height": 64, "tags": {"title": "Clip title", "artist": "Clip Artist"}}
tone(f"{out}/song.m4a", "ipod", "aac")
from mutagen.mp4 import MP4, MP4Cover
cover = io.BytesIO(); img(16, 16).save(cover, "PNG")
m = MP4(f"{out}/song.m4a"); m["\xa9nam"] = "M4A song"; m["\xa9ART"] = "Mutagen"; m["trkn"] = [(3, 12)]; m["\xa9gen"] = "Synthpop"; m["covr"] = [MP4Cover(cover.getvalue(), MP4Cover.FORMAT_PNG)]; m.save()
exp["song.m4a"] = {"format": "m4a", "tags": {"title": "M4A song", "artist": "Mutagen", "track": "3/12", "genre": "Synthpop"}, "pictureBytes": len(cover.getvalue())}
tone(f"{out}/song.opus", "ogg", "libopus", meta={"title": "Opus song", "artist": "Ogg Artist"})
exp["song.opus"] = {"format": "opus", "tags": {"title": "Opus song", "artist": "Ogg Artist"}}
tone(f"{out}/v23.mp3", "mp3", "libmp3lame", rate=44100)
from mutagen.id3 import ID3, TIT2, TPE1, TCON, APIC, TRCK, Encoding
for ver, name in ((3, "v23.mp3"), (4, "v24.mp3")):
    if name == "v24.mp3":
        import shutil; shutil.copy(f"{out}/v23.mp3", f"{out}/v24.mp3")
    t = ID3(); t.add(TIT2(encoding=Encoding.UTF16, text="Ünï title")); t.add(TPE1(encoding=Encoding.UTF8 if ver == 4 else Encoding.LATIN1, text=["A1", "A2"] if ver == 4 else "Solo"))
    t.add(TCON(encoding=0, text="(17)")); t.add(TRCK(encoding=0, text="7/9")); t.add(APIC(encoding=3, mime="image/png", type=3, desc="cover", data=cover.getvalue()))
    t.save(f"{out}/{name}", v2_version=ver)
    exp[name] = {"format": "mp3", "tags": {"title": "Ünï title", "artist": "A1; A2" if ver == 4 else "Solo", "genre": "Rock", "track": "7/9"}, "pictureBytes": len(cover.getvalue())}
json.dump(exp, open(f"{out}/expected.json", "w"), indent=1, ensure_ascii=False)
print(len(exp), "fixtures")
