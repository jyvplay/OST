#!/usr/bin/env python3
"""TT52 test-only oracle: verify edited PDFs written by scripts/tt52-editcmp.mts with PDFium (pypdfium2) and qpdf (pikepdf).
Usage: pdf_editcheck.py OUTDIR CORPUSDIR  → prints JSON summary + failures."""
import sys, json, os, hashlib
import pypdfium2 as pdfium, pypdfium2.raw as R, pikepdf
out, corpus = sys.argv[1], sys.argv[2]
jobs = json.load(open(os.path.join(out, "jobs.json")))
fails, ok, oracle_skip = [], 0, 0
def text_of(pdf, i):
    p = pdf[i]; t = p.get_textpage(); s = t.get_text_range(); t.close(); return s
def sig(pdf, i):  # page signature: size + first 200 chars of text
    p = pdf[i]; w, h = p.get_size(); return (round(w), round(h), "".join(text_of(pdf, i).split())[:200])
_can = {}
def oracle_opens(src, pw):  # can each oracle open the ORIGINAL? if not, that oracle cannot judge our output
    if src in _can: return _can[src]
    r = [True, True]
    try: pikepdf.open(os.path.join(corpus, src), password=pw or "").close()
    except Exception: r[0] = False
    try: pdfium.PdfDocument(os.path.join(corpus, src), password=pw).close()
    except Exception: r[1] = False
    _can[src] = r; return r
skipped = []
for j in jobs:
    path = os.path.join(out, j["file"]); pw = j.get("password") or None; why = []
    srcs = [j["src"]] if "src" in j else j.get("merge", []) + ([j["extract"]] if "extract" in j else [])
    caps = [oracle_opens(s_, pw) for s_ in srcs]; use_q = all(c[0] for c in caps); use_p = all(c[1] for c in caps)
    if not use_q and not use_p: skipped.append(j["file"]); continue
    if use_q:
      try:
        q = pikepdf.open(path, password=pw or "")
        want = len(j["order"]) if "order" in j else 1 if "extract" in j else j["pages"]
        if len(q.pages) != want: why.append(f"qpdf pages {len(q.pages)} != {want}")
        if "title" in j and str(q.docinfo.get("/Title", "")) != j["title"]: why.append(f"qpdf title {q.docinfo.get('/Title')!r}")
        q.close()
      except Exception as e: why.append(f"qpdf open: {e}")
    if use_p:
     try:
        d = pdfium.PdfDocument(path, password=pw)
        if "rot0" in j:
            if d[0].get_rotation() != j["rot0"]: why.append(f"rot {d[0].get_rotation()} != {j['rot0']}")
            n = R.FPDFPage_GetAnnotCount(d[0]); 
            if n != j["annots0"]: why.append(f"annots {n} != {j['annots0']}")
            src = pdfium.PdfDocument(os.path.join(corpus, j["src"]), password=pw)
            if len(d) != len(src): why.append(f"pdfium pages {len(d)} != {len(src)}")
            # untouched pages keep their text
            for i in range(1, min(len(d), 3)):
                if sig(d, i) != sig(src, i): why.append(f"page {i} changed")
            if j.get("incremental"):
                a = open(os.path.join(corpus, j["src"]), "rb").read(); b = open(path, "rb").read()
                if b[:len(a)] != a: why.append("not an append-only update")
            src.close()
        if "order" in j:
            src = pdfium.PdfDocument(os.path.join(corpus, j["src"]), password=pw)
            if len(d) != len(j["order"]): why.append(f"ops pages {len(d)} != {len(j['order'])}")
            else:
                for k, o in enumerate(j["order"]):
                    if o == -1:
                        w, h = d[k].get_size()
                        if (round(w), round(h)) != tuple(j["blank"]): why.append(f"blank size {(w, h)}")
                    elif sig(d, k) != sig(src, o): why.append(f"ops page {k} != src {o}"); break
            src.close()
        if "merge" in j:
            a = pdfium.PdfDocument(os.path.join(corpus, j["merge"][0])); b = pdfium.PdfDocument(os.path.join(corpus, j["merge"][1]))
            exp = [(a, i) for i in range(len(a))] + [(b, i) for i in range(len(b))]
            if len(d) != len(exp): why.append(f"merge pages {len(d)} != {len(exp)}")
            else:
                for k, (s, i) in enumerate(exp):
                    if sig(d, k) != sig(s, i): why.append(f"merge page {k}"); break
        if "extract" in j:
            s = pdfium.PdfDocument(os.path.join(corpus, j["extract"]))
            if len(d) != 1 or sig(d, 0) != sig(s, j["index"]): why.append("extract mismatch")
        d.close()
     except Exception as e: why.append(f"pdfium: {e}")
    if why: fails.append({"file": j["file"], "why": why[:4]})
    else: ok += 1
print(json.dumps({"jobs": len(jobs), "ok": ok, "fail": len(fails), "unverifiable": len(skipped), "unverifiable_files": skipped}))
for f in fails[:60]: print(json.dumps(f, ensure_ascii=False))
