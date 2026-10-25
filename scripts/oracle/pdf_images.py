#!/usr/bin/env python3
"""TT77 oracle: PDFium's own decoded image bitmaps (FPDFImageObj_GetBitmap, i.e. pypdfium2 get_bitmap(render=False)).

usage: pdf_images.py OUTDIR [--filters JBIG2Decode,JPXDecode] [--pages N] FILE...
writes OUTDIR/<stem>-p<page>-i<k>.pgm|.ppm (as decoded by PDFium, before any CTM / soft mask) and prints one JSON line per
image: {file, page, i, filters, w, h, mode, png}. Image objects are listed in content order, recursing into forms,
so they line up with the order in which Fusion's interpreter draws them.
"""
import json, os, sys
import pypdfium2 as pdfium
import pypdfium2.raw as raw

def main(argv):
    outdir = argv[0]; os.makedirs(outdir, exist_ok=True)
    want = None; pages = 3; files = []
    it = iter(argv[1:])
    for a in it:
        if a == "--filters": want = set(next(it).split(","))
        elif a == "--pages": pages = int(next(it))
        else: files.append(a)
    for f in files:
        stem = os.path.splitext(os.path.basename(f))[0]
        try: pdf = pdfium.PdfDocument(f)
        except Exception as e: print(json.dumps({"file": f, "error": str(e)})); continue
        for pi in range(min(pages, len(pdf))):
            page = pdf[pi]; imgs = []
            try: imgs = list(page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=15))  # recurses into forms
            except Exception as e: print(json.dumps({"file": f, "page": pi, "error": str(e)})); continue
            for k, o in enumerate(imgs):
                try: flt = list(o.get_filters())
                except Exception: flt = []
                if want and not (set(flt) & want): continue
                rec = {"file": f, "page": pi, "i": k, "filters": flt}
                try:
                    bm = o.get_bitmap(render=False); im = bm.to_pil()
                    if im.mode not in ("L", "RGB"): im = im.convert("RGB")
                    png = os.path.join(outdir, f"{stem}-p{pi}-i{k}.{'pgm' if im.mode == 'L' else 'ppm'}"); im.save(png)
                    rec.update(w=im.width, h=im.height, mode=im.mode, png=png)
                except Exception as e: rec["error"] = str(e)
                print(json.dumps(rec), flush=True)

if __name__ == "__main__": main(sys.argv[1:])
