#!/usr/bin/env python3
"""TEST-ONLY PDF oracles for TT52 (nothing here ships in Fusion). Independent implementations:
  * PDFium 156 via pypdfium2 (BSD-3/Apache-2.0)  — Chrome's PDF engine: rendering + text
  * qpdf 12 via pikepdf (MPL-2.0 / Apache-2.0)   — structural validation
  * pypdf 6 (BSD-3)                              — structure, annotations, forms

Usage (one JSON object per input file, one per line):
  pdf_probe.py --survey FILES…            what the file uses (filters, fonts, encryption, annotations, forms)
  pdf_probe.py --struct FILES…            page count, boxes, rotation, Info metadata (pypdf and pdfium agreement)
  pdf_probe.py --text [--pages N] FILES…  pdfium text per page
  pdf_probe.py --render OUTDIR --scale S [--pages N] [--password PW] FILES…   pdfium PNG per page (+ sizes)
  pdf_probe.py --check FILES…             qpdf: opens, object stream / xref problems, warnings
  pdf_probe.py --annots FILES…            pypdf annotations per page (subtype, rect, contents, has appearance)
  pdf_probe.py --forms FILES…             pypdf form field values
"""
import json, os, sys, warnings, logging
warnings.filterwarnings("ignore"); logging.disable(logging.CRITICAL)
args = sys.argv[1:]
mode = args.pop(0)
opt = {}
if mode == "--render": opt["render"] = args.pop(0)
while args and args[0].startswith("--"):
    k = args.pop(0)[2:]; opt[k] = args.pop(0)
PW = opt.get("password")
NP = int(opt.get("pages", "0")) or None

def out(o): print(json.dumps(o, ensure_ascii=False), flush=True)

def survey(f):
    import pikepdf
    o = {"file": f}
    try:
        pdf = pikepdf.open(f, password=PW or "")
    except pikepdf.PasswordError:
        o["error"] = "password"; return o
    except Exception as e:
        o["error"] = type(e).__name__ + ": " + str(e)[:120]; return o
    o["pages"] = len(pdf.pages); o["version"] = pdf.pdf_version
    o["encrypted"] = pdf.is_encrypted
    if pdf.is_encrypted:
        enc = pdf.encryption; o["enc"] = {"R": enc.R, "V": enc.V, "bits": enc.bits, "stream": str(enc.stream_method), "user_pw_empty": True}
    filters, fonts, xobj = {}, {}, {"Image": 0, "Form": 0}
    annots, forms = {}, 0
    for obj in pdf.objects:
        try:
            if isinstance(obj, pikepdf.Stream):
                fl = obj.get("/Filter")
                for x in (fl if isinstance(fl, pikepdf.Array) else [fl] if fl is not None else []):
                    filters[str(x)] = filters.get(str(x), 0) + 1
                st = obj.get("/Subtype")
                if obj.get("/Type") == "/XObject" or st in ("/Image", "/Form"):
                    if st in ("/Image", "/Form"): xobj[str(st)[1:]] += 1
            elif isinstance(obj, pikepdf.Dictionary):
                t = obj.get("/Type")
                if t == "/Font":
                    k = str(obj.get("/Subtype"))
                    fonts[k] = fonts.get(k, 0) + 1
                elif t == "/Annot" or (obj.get("/Subtype") is not None and obj.get("/Rect") is not None and t is None):
                    k = str(obj.get("/Subtype")); annots[k] = annots.get(k, 0) + 1
        except Exception:
            pass
    try:
        af = pdf.Root.get("/AcroForm")
        if af is not None and af.get("/Fields") is not None: forms = len(af.Fields)
    except Exception:
        pass
    o.update(filters=filters, fonts=fonts, xobj=xobj, annots=annots, fields=forms,
             objects=len(pdf.objects), xref_stream=any(isinstance(x, pikepdf.Stream) and x.get("/Type") == "/XRef" for x in pdf.objects))
    return o

def struct(f):
    import pypdf, pypdfium2 as pdfium
    o = {"file": f}
    try:
        r = pypdf.PdfReader(f, strict=False)
        if r.is_encrypted:
            if r.decrypt(PW or "") == 0: o["error"] = "password"; return o
        pages = []
        for p in r.pages:
            mb = [float(x) for x in p.mediabox]; cb = [float(x) for x in p.cropbox]
            pages.append({"media": mb, "crop": cb, "rotate": int(p.get("/Rotate", 0) or 0) % 360})
        o["pypdf"] = {"n": len(pages), "pages": pages}
        try:
            md = r.metadata or {}
            o["info"] = {k: str(v) for k, v in md.items() if k in ("/Title", "/Author", "/Subject", "/Producer", "/Creator")}
        except Exception:
            o["info"] = None
    except Exception as e:
        o["pypdf_error"] = type(e).__name__ + ": " + str(e)[:120]
    try:
        d = pdfium.PdfDocument(f, password=PW)
        o["pdfium"] = {"n": len(d), "sizes": [list(d[i].get_size()) for i in range(len(d))], "rot": [d[i].get_rotation() for i in range(len(d))]}
        d.close()
    except Exception as e:
        o["pdfium_error"] = type(e).__name__ + ": " + str(e)[:120]
    return o

def text(f):
    import pypdfium2 as pdfium
    o = {"file": f}
    try:
        d = pdfium.PdfDocument(f, password=PW)
        n = len(d) if NP is None else min(NP, len(d))
        o["pages"] = []
        for i in range(n):
            tp = d[i].get_textpage(); o["pages"].append(tp.get_text_range()); tp.close()
        d.close()
    except Exception as e:
        o["error"] = type(e).__name__ + ": " + str(e)[:120]
    return o

def render(f):
    import pypdfium2 as pdfium
    outdir = opt["render"]; scale = float(opt.get("scale", "1"))
    o = {"file": f, "pngs": []}
    try:
        d = pdfium.PdfDocument(f, password=PW)
        try: d.init_forms()  # PDFium draws AcroForm widgets only with a form environment
        except Exception: pass
        n = len(d) if NP is None else min(NP, len(d))
        for i in range(n):
            # draw_forms: annotation appearance streams are drawn, like a viewer does
            img = d[i].render(scale=scale, draw_annots=True, may_draw_forms=True).to_pil().convert("RGB")
            p = os.path.join(outdir, f"{os.path.basename(f)}.p{i}.png"); img.save(p); o["pngs"].append({"path": p, "w": img.width, "h": img.height})
        d.close()
    except Exception as e:
        o["error"] = type(e).__name__ + ": " + str(e)[:120]
    return o

def check(f):
    import pikepdf
    o = {"file": f}
    try:
        with pikepdf.open(f, password=PW or "") as pdf:
            probs = pdf.check()  # qpdf --check equivalent: list of problems found while walking every object
            o["ok"] = True; o["problems"] = [str(p)[:200] for p in probs]; o["pages"] = len(pdf.pages)
    except Exception as e:
        o["ok"] = False; o["error"] = type(e).__name__ + ": " + str(e)[:160]
    return o

def annots(f):
    import pypdf
    o = {"file": f, "pages": []}
    try:
        r = pypdf.PdfReader(f, strict=False)
        if r.is_encrypted: r.decrypt(PW or "")
        for p in r.pages:
            lst = []
            for a in (p.get("/Annots") or []):
                a = a.get_object()
                lst.append({"subtype": str(a.get("/Subtype")), "rect": [round(float(x), 2) for x in a.get("/Rect", [])],
                            "contents": str(a.get("/Contents")) if a.get("/Contents") is not None else None,
                            "ap": a.get("/AP") is not None, "color": [float(x) for x in a.get("/C", [])] or None})
            o["pages"].append(lst)
    except Exception as e:
        o["error"] = type(e).__name__ + ": " + str(e)[:160]
    return o

def forms(f):
    import pypdf
    o = {"file": f}
    try:
        r = pypdf.PdfReader(f, strict=False)
        if r.is_encrypted: r.decrypt(PW or "")
        fl = r.get_fields() or {}
        o["fields"] = {k: (str(v.get("/V")) if v.get("/V") is not None else None) for k, v in fl.items()}
    except Exception as e:
        o["error"] = type(e).__name__ + ": " + str(e)[:160]
    return o

FN = {"--survey": survey, "--struct": struct, "--text": text, "--render": render, "--check": check, "--annots": annots, "--forms": forms}[mode]
for f in args:
    try:
        out(FN(f))
    except Exception as e:  # never let one file kill the batch
        out({"file": f, "error": "probe crashed: " + type(e).__name__ + ": " + str(e)[:120]})
