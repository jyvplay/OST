#!/usr/bin/env python3
"""TT54 oracle — compare readMetadata() (JSON lines from scripts/tt54/meta-dump.mts) with independent readers.

usage: meta_check.py DUMP.jsonl [--json OUT]
  images   Pillow 13 (+ pillow-heif for HEIF): size (HEIF: displayed size), frame count, every IFD0 / Exif / GPS /
           IFD1 tag value, orientation, GPS decimal degrees (computed here from Pillow's raw rationals),
           PNG text chunks, XMP simple properties (packet parsed here with lxml)
  audio    mutagen: duration, sample rate, channels, tags (easy keys), number + bytes of embedded pictures
  video    PyAV (FFmpeg): duration, width/height
  pdf      pypdf: page count, /Info strings, first-page CropBox size
  ooxml    python-docx / openpyxl / python-pptx core properties
All oracles are test-only (some are GPL / LGPL); nothing here ships in Fusion.
"""
import hashlib, json, math, sys, warnings
warnings.filterwarnings("ignore")

def load(path):
    return [json.loads(l) for l in open(path) if l.strip()]

def norm(v):
    """Pillow / ours -> comparable python value"""
    if isinstance(v, dict) and "u8" in v: return ("bytes", v["n"], bytes(v["u8"][:64]))
    if isinstance(v, (bytes, bytearray)): return ("bytes", len(v), bytes(v[:64]))
    if v is None: return float("nan")
    if isinstance(v, str): return v.replace("\x00", "").strip()
    if isinstance(v, (list, tuple)):
        if len(v) == 1: return norm(v[0])
        return tuple(norm(x) for x in v)
    try: return float(v)
    except Exception: return str(v)

def same(a, b):
    if isinstance(a, tuple) and isinstance(b, tuple) and a and b and a[0] == "bytes" and b[0] == "bytes": return a[1] == b[1] and a[2] == b[2]
    # BYTE arrays: Pillow gives bytes, ours a list of ints (count <= 4) or vice versa
    if isinstance(a, tuple) and a and a[0] == "bytes" and isinstance(b, (tuple, float)):
        bb = b if isinstance(b, tuple) else (b,)
        return a[1] == len(bb) and all(float(x) == y for x, y in zip(a[2], bb))
    if isinstance(b, tuple) and b and b[0] == "bytes": return same(b, a)
    if isinstance(a, float) and isinstance(b, float): return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9) or (math.isnan(a) and math.isnan(b))
    if isinstance(a, tuple) and isinstance(b, tuple): return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, str) and isinstance(b, str):
        if a == b: return True
        # EXIF ASCII holding UTF-8 bytes: we decode UTF-8 (fatal) and fall back to Latin-1; Pillow always Latin-1
        try: return b.encode("latin-1").decode("utf-8") == a
        except Exception: return False
    if isinstance(a, float) and isinstance(b, str) or isinstance(a, str) and isinstance(b, float):
        try: return math.isclose(float(a), float(b))
        except Exception: return False
    return a == b

RES = {}
def tally(cat, ok, detail=None):
    r = RES.setdefault(cat, {"ok": 0, "bad": 0, "bad_list": []})
    if ok: r["ok"] += 1
    else:
        r["bad"] += 1
        if detail and len(r["bad_list"]) < 40: r["bad_list"].append(detail)

def check_image(d):
    from PIL import Image, ExifTags
    import pillow_heif; pillow_heif.register_heif_opener()
    f = d["file"]
    try: im = Image.open(f)
    except Exception as e:
        tally("image.open-oracle-refuses", True, f"{f}: {e}"); return
    heif = d["format"] in ("heif", "avif")
    # pillow-heif applies irot / imir (displayed size); Pillow's own AVIF plugin reports the stored size
    w, h = (d.get("displayWidth"), d.get("displayHeight")) if d["format"] == "heif" else (d.get("width"), d.get("height"))
    tally("image.size", (w, h) == im.size, f"{f}: ours {(w, h)} pillow {im.size}")
    nf = getattr(im, "n_frames", 1)
    if not heif: tally("image.frames", (d.get("frames") or 1) == nf, f"{f}: ours {d.get('frames')} pillow {nf}")
    try: ex = im.getexif()
    except Exception as e: ex = None; tally("image.exif-oracle-error", True, f"{f}: {e}")
    ours = d.get("exif") or {}
    if ex is not None and len(ex) and not heif:
        groups = [("ifd0", dict(ex))]
        for name, ifd in (("exif", ExifTags.IFD.Exif), ("gps", ExifTags.IFD.GPSInfo), ("ifd1", ExifTags.IFD.IFD1)):
            try: groups.append((name, dict(ex.get_ifd(ifd))))
            except Exception: pass
        for name, tags in groups:
            mine = ours.get(name) or {}
            for tag, val in tags.items():
                if d["format"] == "tiff" and name == "ifd0" and tag in (273, 279, 324, 325): continue  # Pillow rewrites strip tables on load
                if tag == 37500: tally("exif.makernote-len", (str(tag) in mine), f"{f}: MakerNote missing"); continue
                m = mine.get(str(tag))
                if m is None and name == "ifd0" and tag == 274 and "tiff:Orientation" in (d.get("xmp") or {}):
                    tally("exif.orientation-from-xmp (Pillow merges XMP; browsers and ours: EXIF only)", True); continue
                if m is None and isinstance(norm(val), float) and math.isnan(norm(val)): tally("exif.tag", True); continue
                if m is None: tally("exif.tag", False, f"{f} {name}:{tag} missing (pillow {str(val)[:60]})"); continue
                if isinstance(m, str) and m.startswith("(") and m.endswith(" bytes)"): tally("exif.tag", True); continue
                ok = same(norm(m), norm(val))
                tally("exif.tag", ok, f"{f} {name}:{tag} ours {str(norm(m))[:80]} pillow {str(norm(val))[:80]}")
        # orientation: compared where EXIF carries it (a missing raw tag is already caught by exif.tag above)
        o = ex.get(0x0112) if "274" in (ours.get("ifd0") or {}) else None
        if o in range(1, 9): tally("exif.orientation", d.get("orientation") == o, f"{f}: ours {d.get('orientation')} pillow {o}")
        g = ex.get_ifd(ExifTags.IFD.GPSInfo) if ExifTags.IFD.GPSInfo in ex else {}
        if g.get(2) and g.get(4) and len(g[2]) == 3:
            z = lambda x: 0.0 if math.isnan(float(x)) else float(x)  # documented policy: unknown min/sec = 0
            dms = lambda t: float(t[0]) + z(t[1]) / 60 + z(t[2]) / 3600
            lat = dms(g[2]) * (-1 if str(g.get(1, "N")).upper().startswith("S") else 1)
            lon = dms(g[4]) * (-1 if str(g.get(3, "E")).upper().startswith("W") else 1)
            ok = d.get("gps") and math.isclose(d["gps"]["lat"], lat, abs_tol=1e-7) and math.isclose(d["gps"]["lon"], lon, abs_tol=1e-7)
            tally("exif.gps", bool(ok), f"{f}: ours {d.get('gps')} oracle {(lat, lon)}")
        if heif is False and ExifTags.IFD.IFD1:
            try: i1 = ex.get_ifd(ExifTags.IFD.IFD1)
            except Exception: i1 = {}
            if i1.get(513) and i1.get(514):
                tally("exif.thumbnail", (ours.get("thumb") or 0) == i1[514] or (ours.get("thumb") == 0 and d["picture"] is None), f"{f}: ours {ours.get('thumb')} ifd1 len {i1[514]}")
    if heif and "exif" in im.info and im.info["exif"]:
        tally("heif.exif-present", bool(ours), f"{f}: oracle has EXIF, ours none")
    if d["format"] == "png" and getattr(im, "text", None):
        for k, v in im.text.items():
            if k == "XML:com.adobe.xmp": continue
            key = {"Title": "title", "Author": "creator", "Description": "description", "Comment": "comment", "Software": "software"}.get(k, k)
            tally("png.text", d["tags"].get(key) == v, f"{f}: {k} ours {d['tags'].get(key)!r} pillow {v!r}"[:200])
    x = im.info.get("xmp")
    if x:
        exp = xmp_simple(x if isinstance(x, (bytes, bytearray)) else str(x).encode())
        mine = d.get("xmp") or {}
        for k, v in exp.items():
            tally("xmp.prop", mine.get(k) == v, f"{f}: {k} ours {mine.get(k)!r} lxml {v!r}"[:200])

NS = {
    "http://purl.org/dc/elements/1.1/": "dc", "http://ns.adobe.com/xap/1.0/": "xmp", "http://ns.adobe.com/xap/1.0/rights/": "xmpRights",
    "http://ns.adobe.com/xap/1.0/mm/": "xmpMM", "http://ns.adobe.com/photoshop/1.0/": "photoshop", "http://ns.adobe.com/exif/1.0/": "exif",
    "http://ns.adobe.com/tiff/1.0/": "tiff", "http://ns.adobe.com/lightroom/1.0/": "lr", "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/": "Iptc4xmpCore",
    "http://ns.adobe.com/pdf/1.3/": "pdf", "http://ns.adobe.com/camera-raw-settings/1.0/": "crs",
}
RDF = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"
def xmp_simple(raw):
    from lxml import etree
    s = raw.decode("utf-8", "replace")
    a = s.find("<x:xmpmeta"); b = s.rfind("</x:xmpmeta>")
    if a >= 0 and b > a: s = s[a:b + 12]
    else:
        a = s.find("<rdf:RDF"); b = s.rfind("</rdf:RDF>")
        if a >= 0 and b > a: s = s[a:b + 10]
    try: root = etree.fromstring(s.encode(), etree.XMLParser(resolve_entities=False, no_network=True, recover=False))
    except Exception: return {}
    out = {}
    def canon(tag):
        if not tag.startswith("{"): return None
        uri, local = tag[1:].split("}", 1); p = NS.get(uri); return f"{p}:{local}" if p else None
    for desc in root.iter(RDF + "Description"):
        for k, v in desc.attrib.items():
            c = canon(k)
            if c and c not in out: out[c] = v.strip()
        for p in desc:
            if not isinstance(p.tag, str): continue
            c = canon(p.tag)
            if not c or c in out: continue
            cont = [k for k in p if isinstance(k.tag, str) and k.tag in (RDF + "Alt", RDF + "Seq", RDF + "Bag")]
            if cont:
                lis = [k for k in cont[0] if k.tag == RDF + "li"]
                if cont[0].tag == RDF + "Alt":
                    best = next((k for k in lis if k.get("{http://www.w3.org/XML/1998/namespace}lang") == "x-default"), lis[0] if lis else None)
                    out[c] = (best.text or "").strip() if best is not None else ""
                else: out[c] = "; ".join(t for t in ((k.text or "").strip() for k in lis) if t)
            elif len([k for k in p if isinstance(k.tag, str)]) == 0:
                r = p.get(RDF + "resource")
                out[c] = r if r is not None else (p.text or "").strip()
    return out

EASY = {"title": "title", "artist": "artist", "album": "album", "albumartist": "albumArtist", "date": "date", "tracknumber": "track", "discnumber": "disc", "genre": "genre", "composer": "composer"}
def check_audio(d):
    import mutagen
    f = d["file"]
    try: mf = mutagen.File(f)
    except Exception as e: tally("audio.oracle-refuses", True, f"{f}: {e}"); return
    if mf is None or not hasattr(mf, "info"): return
    info = mf.info
    L = getattr(info, "length", None)
    if L:
        ours = d.get("duration")
        ok = ours is not None and abs(ours - L) <= max(0.06, 0.01 * L)
        tally("audio.duration", ok, f"{f}: ours {ours} mutagen {L:.4f} ({type(mf).__name__})")
    sr = getattr(info, "sample_rate", None)
    if sr: tally("audio.sampleRate", d.get("sampleRate") == sr, f"{f}: ours {d.get('sampleRate')} mutagen {sr}")
    ch = getattr(info, "channels", None)
    if ch: tally("audio.channels", d.get("channels") == ch, f"{f}: ours {d.get('channels')} mutagen {ch}")
    try: easy = mutagen.File(f, easy=True)
    except Exception: easy = None
    if easy is not None and easy.tags is not None:
        for k, key in EASY.items():
            try: v = easy.tags.get(k)
            except Exception: v = None
            if not v: continue
            exp = "; ".join(str(x) for x in v if str(x))
            got = d["tags"].get(key)
            if k == "genre": ok = got is not None and all(g.strip() in got for g in exp.split("; "))
            elif k == "date": ok = got is not None and (got == exp or got.startswith(exp) or exp.startswith(got))
            else: ok = got == exp
            if not ok and (f.endswith("id3v1v2-combined.mp3") and k == "date"):
                # KNOWN: a v2.4 tag carrying the v2.3-only TYER=2004 next to ID3v1 year 1337; mutagen drops the
                # out-of-version frame and takes v1, we keep the ID3v2 value (as common players show it)
                tally("audio.tag-known-disagreement", True, f"{f}: {k} ours {got!r} mutagen {exp!r}"); continue
            tally("audio.tag", ok, f"{f}: {k} ours {got!r} mutagen {exp!r}"[:220])
    pics = []
    tags = getattr(mf, "tags", None)
    try:
        if hasattr(mf, "pictures") and mf.pictures: pics = [p.data for p in mf.pictures]
        elif tags is not None and hasattr(tags, "getall"): pics = [p.data for p in tags.getall("APIC")] + [p.data for p in tags.getall("PIC")]
        elif tags is not None and "covr" in tags: pics = [bytes(c) for c in tags["covr"]]
    except Exception: pass
    if pics:
        p = d.get("picture")
        ok = p is not None and any(hashlib.sha256(x).hexdigest() == p["sha"] for x in pics)
        tally("audio.picture", ok, f"{f}: ours {p and p['n']} oracle {[len(x) for x in pics]}")

def check_video(d):
    import av
    f = d["file"]
    try: c = av.open(f)
    except Exception as e: tally("video.oracle-refuses", True, f"{f}: {e}"); return
    vs = [s for s in c.streams if s.type == "video"]
    if c.duration:
        L = c.duration / 1e6; ours = d.get("duration")
        tally("video.duration", ours is not None and abs(ours - L) <= max(0.1, 0.01 * L), f"{f}: ours {ours} ffmpeg {L:.3f}")
    if vs and vs[0].codec_context.width:
        s = vs[0]
        tally("video.size", (d.get("width"), d.get("height")) == (s.codec_context.width, s.codec_context.height), f"{f}: ours {(d.get('width'), d.get('height'))} ffmpeg {(s.codec_context.width, s.codec_context.height)}")
    c.close()

def check_pdf(d):
    import pypdf
    f = d["file"]
    try:
        r = pypdf.PdfReader(f, strict=False)
        enc = r.trailer.get("/Encrypt")
        enc = enc.get_object() if enc is not None else None
        if r.is_encrypted and isinstance(enc, dict):  # /Encrypt null = absent (ISO 32000 §7.3.9)
            tally("pdf.encrypted", bool(d.get("encrypted")), f"{f}: ours not encrypted"); return
        n = len(r.pages)
    except Exception as e: tally("pdf.oracle-refuses", True, f"{f}: {str(e)[:80]}"); return
    if d.get("pages") is None: tally("pdf.pages", False, f"{f}: ours none, pypdf {n}"); return
    tally("pdf.pages", d.get("pages") == n, f"{f}: ours {d.get('pages')} pypdf {n}")
    try: info = r.metadata or {}
    except Exception: info = {}
    for k, t in (("/Title", "title"), ("/Author", "creator"), ("/Subject", "subject"), ("/Keywords", "keywords"), ("/Creator", "application"), ("/Producer", "producer")):
        try: v = info.get(k)
        except Exception: continue
        if isinstance(v, str) and v.strip():
            tally("pdf.info", d["tags"].get(t) == v.strip(), f"{f}: {k} ours {d['tags'].get(t)!r} pypdf {v.strip()!r}"[:200])
    try:
        # ISO 32000 §14.11.2: a CropBox reaching beyond the MediaBox is reduced to their intersection
        p = r.pages[0]; cb, mb = p.cropbox, p.mediabox
        x0, x1 = max(min(cb.left, cb.right), min(mb.left, mb.right)), min(max(cb.left, cb.right), max(mb.left, mb.right))
        y0, y1 = max(min(cb.bottom, cb.top), min(mb.bottom, mb.top)), min(max(cb.bottom, cb.top), max(mb.bottom, mb.top))
        w, h = float(x1 - x0), float(y1 - y0)
        if w <= 0 or h <= 0: tally("pdf.pagesize-oracle-degenerate", True, f"{f}"); return
        if (p.get("/Rotate") or 0) % 180: w, h = h, w
        ps = d.get("pageSize")
        tally("pdf.pagesize", ps is not None and abs(ps["w"] - w) < 0.02 and abs(ps["h"] - h) < 0.02, f"{f}: ours {ps} pypdf {(w, h)}")
    except Exception: pass

def check_ooxml(d):
    f = d["file"]; fmt = d["format"]
    try:
        if fmt == "docx": import docx; cp = docx.Document(f).core_properties
        elif fmt == "xlsx": import openpyxl; cp = openpyxl.load_workbook(f, read_only=True).properties
        elif fmt == "pptx": import pptx; cp = pptx.Presentation(f).core_properties
        else: return
    except Exception as e: tally("ooxml.oracle-refuses", True, f"{f}: {str(e)[:80]}"); return
    # python-docx / openpyxl / python-pptx SYNTHESISE default core properties ("Word Document", now()) when the package
    # has no core-properties relationship; compare only packages that really carry the part
    import zipfile
    try:
        z = zipfile.ZipFile(f); rels = z.read("_rels/.rels").decode("utf-8", "replace")
        if "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" not in rels:
            # missing, or the non-OPC "officedocument/2006/..." type some writers use: the oracle libraries then invent defaults
            tally("ooxml.non-opc-or-missing-core-rel (oracle defaults skipped)", True); return
        from lxml import etree
        core = etree.fromstring(z.read("docProps/core.xml"))
        present = {etree.QName(e).localname for e in core.iter() if isinstance(e.tag, str) and (e.text or "").strip()}
    except Exception: return
    el = {"last_modified_by": "lastModifiedBy", "lastModifiedBy": "lastModifiedBy"}
    for attr, key in (("title", "title"), ("subject", "subject"), ("creator", "creator"), ("keywords", "keywords"), ("description", "description"), ("last_modified_by", "lastModifiedBy"), ("lastModifiedBy", "lastModifiedBy"), ("category", "category")):
        v = getattr(cp, attr, None)
        if el.get(attr, attr) not in present: continue  # openpyxl invents creator="openpyxl" for a missing element
        if isinstance(v, str) and v.strip():
            tally("ooxml.core", d["tags"].get(key) == v.strip(), f"{f}: {attr} ours {d['tags'].get(key)!r} oracle {v.strip()!r}"[:200])
    for attr, key in (("created", "created"), ("modified", "modified")):
        v = getattr(cp, attr, None)
        if attr not in present: continue  # openpyxl invents created = now() for a missing element
        if v is not None and hasattr(v, "year"):
            got = d["tags"].get(key) or ""
            tally("ooxml.date", got[:16].replace("T", " ") == v.strftime("%Y-%m-%d %H:%M"), f"{f}: {attr} ours {got!r} oracle {v}")

def check_fixture(d, e):
    import os
    f = os.path.basename(d["file"])
    for k, v in e.items():
        if k == "tags":
            for tk, tv in v.items(): tally("fixture.tag", d["tags"].get(tk) == tv, f"{f}: {tk} ours {d['tags'].get(tk)!r} writer {tv!r}")
        elif k == "gps":
            g = d.get("gps") or {}
            ok = g and abs(g["lat"] - v[0]) < 1e-7 and abs(g["lon"] - v[1]) < 1e-7 and (len(v) < 3 or abs(g.get("alt", 1e9) - v[2]) < 1e-6)
            tally("fixture.gps", bool(ok), f"{f}: ours {g} writer {v}")
        elif k == "pictureBytes": tally("fixture.picture", (d.get("picture") or {}).get("n") == v, f"{f}: ours {d.get('picture')} writer {v}")
        else: tally("fixture.field", d.get(k) == v, f"{f}: {k} ours {d.get(k)!r} writer {v!r}")

def main():
    rows = load(sys.argv[1])
    if "--fixtures" in sys.argv:
        import os
        fx = json.load(open(os.path.join(sys.argv[sys.argv.index("--fixtures") + 1], "expected.json")))
        for d in rows:
            e = fx.get(os.path.basename(d.get("file", "")))
            if e and "crash" not in d: check_fixture(d, e)
    crashes = [r for r in rows if "crash" in r]
    for r in crashes: tally("crash", False, f"{r['file']}: {r['crash'][:200]}")
    for d in rows:
        if "crash" in d: continue
        k, fmt = d["kind"], d["format"]
        try:
            if k == "image": check_image(d)
            elif k == "audio" or (k == "video" and fmt in ("ogv",)): check_audio(d)
            elif k == "video": check_video(d)
            elif fmt == "pdf": check_pdf(d)
            elif fmt in ("docx", "xlsx", "pptx"): check_ooxml(d)
        except Exception as e: tally("oracle-internal", False, f"{d['file']}: {e}")
    total_bad = 0
    for cat, r in sorted(RES.items()):
        print(f"{cat:28s} ok {r['ok']:6d}  bad {r['bad']:4d}")
        if not cat.endswith("refuses") and not cat.endswith("oracle-error"): total_bad += r["bad"]
        for x in r["bad_list"][:8]: print("    ", x)
    if "--json" in sys.argv: json.dump(RES, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=1)
    print("TOTAL_BAD", total_bad)

main()
