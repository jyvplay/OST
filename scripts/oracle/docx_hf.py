"""TT49 independent oracle for Writer headers/footers (python-docx 1.2, MIT + lxml): for each .docx path on argv,
one JSON object describing every section's header/footer slots as python-docx resolves them — linked or not,
'different first page', each paragraph's visible text (field results included, as Word shows them before
updating), alignment and the field instructions it holds. Never uses our reader."""
import sys, json
import docx
from docx.oxml.ns import qn

def para(p):
    instr = "".join(t.text or "" for t in p._p.iter(qn("w:instrText")))
    simple = [f.get(qn("w:instr")) for f in p._p.iter(qn("w:fldSimple"))]
    return {"text": p.text, "align": str(p.alignment) if p.alignment is not None else None,
            "style": p.style.name if p.style is not None else None,
            "fields": [w for w in (instr + " " + " ".join(simple)).split() if w.isupper() and w.isalpha()],
            "fldChars": [c.get(qn("w:fldCharType")) for c in p._p.iter(qn("w:fldChar"))],
            "pictures": len(list(p._p.iter(qn("w:drawing")))) + len(list(p._p.iter(qn("w:pict"))))}

def slot(hf):
    if hf.is_linked_to_previous:
        return {"linked": True}
    return {"linked": False, "paras": [para(p) for p in hf.paragraphs], "tables": len(hf.tables)}

def probe(path):
    d = docx.Document(path)
    secs = []
    for s in d.sections:
        secs.append({"firstPage": bool(s.different_first_page_header_footer),
                     "header": slot(s.header), "footer": slot(s.footer),
                     "firstHeader": slot(s.first_page_header), "firstFooter": slot(s.first_page_footer)})
    return {"file": path, "sections": secs, "body": [p.text for p in d.paragraphs][:200]}

for path in sys.argv[1:]:
    try:
        print(json.dumps(probe(path)))
    except Exception as e:  # noqa: BLE001 — report, don't crash the batch
        print(json.dumps({"file": path, "error": f"{type(e).__name__}: {e}"}))
