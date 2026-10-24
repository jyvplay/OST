#!/usr/bin/env python3
"""TT51 package validator (lxml + python-pptx), independent of our writer. Checks the rules whose violation makes
PowerPoint offer "repair": every XML part well-formed; every part covered by [Content_Types].xml (Default or Override);
every Override names an existing part; every internal relationship target exists; presentation sldIdLst ids unique and
>= 256, r:ids resolve to slide parts; shape ids unique within each slide; every r:id/r:embed/r:link used in a part
exists in that part's .rels; python-pptx opens the file and walks every shape + notes.
usage: pptx_validate.py file.pptx  -> JSON {"ok": bool, "problems": [...]}"""
import json, posixpath, sys, zipfile
from lxml import etree

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"

def rels_path(part):
    d, b = posixpath.split(part)
    return posixpath.join(d, "_rels", b + ".rels")

def validate(path):
    probs = []
    z = zipfile.ZipFile(path)
    names = {n for n in z.namelist() if not n.endswith("/")}
    lower = {n.lower(): n for n in names}
    xml = {}
    for n in names:
        if n.endswith(".xml") or n.endswith(".rels"):
            try:
                xml[n] = etree.fromstring(z.read(n))
            except Exception as e:
                probs.append(f"malformed XML {n}: {e}")
    ct = xml.get("[Content_Types].xml")
    if ct is None:
        return ["no [Content_Types].xml"]
    defaults = {d.get("Extension").lower() for d in ct.findall(f"{{{CT}}}Default")}
    overrides = {o.get("PartName").lstrip("/").lower() for o in ct.findall(f"{{{CT}}}Override")}
    for o in overrides:
        if o not in lower:
            probs.append(f"Override for missing part /{o}")
    for n in names:
        if n == "[Content_Types].xml":
            continue
        ext = n.rsplit(".", 1)[-1].lower() if "." in n else ""
        if n.lower() not in overrides and ext not in defaults:
            probs.append(f"no content type for {n}")
    rels_of = {}
    for n in names:
        if not n.endswith(".rels"):
            continue
        d = posixpath.dirname(posixpath.dirname(n))
        src = posixpath.join(d, posixpath.basename(n)[:-5])
        ids = {}
        for r in xml.get(n, etree.Element("x")).findall(f"{{{PR}}}Relationship"):
            ids[r.get("Id")] = r
            if r.get("TargetMode") == "External":
                continue
            t = r.get("Target")
            if t.startswith("#"):
                continue  # in-document bookmark (hyperlink to a location), not a part
            tp = t.lstrip("/") if t.startswith("/") else posixpath.normpath(posixpath.join(d, t))
            if tp.lower() not in lower:
                probs.append(f"{n}: {r.get('Id')} -> missing {tp}")
        rels_of[src] = ids
    for n, root in xml.items():
        if n.endswith(".rels") or n == "[Content_Types].xml":
            continue
        ids = rels_of.get(n, {})
        for el in root.iter():
            for k, v in el.attrib.items():
                if k.startswith(f"{{{R}}}") and v and v not in ids:
                    probs.append(f"{n}: dangling r:{k.split('}')[1]}={v}")
    pres = xml.get("ppt/presentation.xml")
    if pres is not None:
        seen = set()
        for s in pres.iter(f"{{{P}}}sldId"):
            i = int(s.get("id"))
            if i < 256 or i in seen:
                probs.append(f"bad/duplicate sldId {i}")
            seen.add(i)
    for n, root in xml.items():
        if n.startswith("ppt/slides/slide") and n.endswith(".xml"):
            ids = [e.get("id") for e in root.iter(f"{{{P}}}cNvPr")]
            dup = {i for i in ids if ids.count(i) > 1}
            if dup:
                probs.append(f"{n}: duplicate shape ids {sorted(dup)}")
    try:
        from pptx import Presentation
        p = Presentation(path)
        for s in p.slides:
            for sh in s.shapes:
                _ = sh.name, sh.shape_type
                if sh.has_text_frame:
                    _ = sh.text_frame.text
            if s.has_notes_slide:
                _ = s.notes_slide.notes_text_frame
    except Exception as e:
        probs.append(f"python-pptx: {type(e).__name__}: {e}")
    return probs

if __name__ == "__main__":
    for f in sys.argv[1:]:
        pr = validate(f)
        print(json.dumps({"file": f, "ok": not pr, "problems": pr[:20]}))
