#!/usr/bin/env python3
"""TT61 independent probe of footnote / endnote run formatting (lxml only; shares no code with src/lib/office).

Usage:
  docx_noteruns.py probe FILE.docx        -> JSON {"footnote": {id: [{"style": pStyle, "runs": [[text, b, i, u], ...],
                                              "ref": has w:footnoteRef, "refFirst": the mark precedes all text}...]}, "endnote": {...}}  (separators skipped)
  docx_noteruns.py format IN.docx OUT.docx -> rewrites footnote 1 as two formatted paragraphs (the TT61 fixture):
       P1: <footnoteRef/> " See " "Smith"(b) " in " "Journal of Tests"(i) ", 2026."
       P2: "Second " "line"(u) " here."
"""
import json
import sys
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
q = lambda t: "{%s}%s" % (W, t)


def flag(rpr, name):
    if rpr is None:
        return False
    e = rpr.find(q(name))
    if e is None:
        return False
    v = e.get(q("val"))
    return v not in ("0", "false", "off", "none")


def probe(path):
    z = zipfile.ZipFile(path)
    out = {"footnote": {}, "endnote": {}}
    for kind in ("footnote", "endnote"):
        name = "word/%ss.xml" % kind
        if name not in z.namelist():
            continue
        root = etree.fromstring(z.read(name))
        for n in root.findall(q(kind)):
            if n.get(q("type")) in ("separator", "continuationSeparator", "continuationNotice"):
                continue
            paras = []
            for p in n.findall(q("p")):
                ps = p.find(q("pPr") + "/" + q("pStyle"))
                runs = []
                ref = False
                ref_first = False
                for r in p.iter(q("r")):
                    if r.find(q(kind + "Ref")) is not None:
                        ref = True
                        ref_first = not runs
                    t = "".join(x.text or "" for x in r.findall(q("t")))
                    if not t:
                        continue
                    rpr = r.find(q("rPr"))
                    runs.append([t, flag(rpr, "b"), flag(rpr, "i"), flag(rpr, "u")])
                # adjacent runs with identical formatting are one span for comparison purposes
                merged = []
                for x in runs:
                    if merged and merged[-1][1:] == x[1:]:
                        merged[-1][0] += x[0]
                    else:
                        merged.append(list(x))
                paras.append({"style": ps.get(q("val")) if ps is not None else None, "runs": merged, "ref": ref, "refFirst": ref_first})
            out[kind][n.get(q("id"))] = paras
    print(json.dumps(out))


def fmt(src, dst):
    zin = zipfile.ZipFile(src)
    root = etree.fromstring(zin.read("word/footnotes.xml"))
    note = [n for n in root.findall(q("footnote")) if n.get(q("id")) == "1"][0]
    p1 = note.find(q("p"))
    for p in note.findall(q("p"))[1:]:
        note.remove(p)
    # keep pPr and the footnoteRef run, drop the rest
    for r in list(p1):
        if r.tag == q("r") and r.find(q("footnoteRef")) is None:
            p1.remove(r)

    def run(parent, text, b=False, i=False, u=False):
        r = etree.SubElement(parent, q("r"))
        if b or i or u:
            rpr = etree.SubElement(r, q("rPr"))
            if b:
                etree.SubElement(rpr, q("b"))
            if i:
                etree.SubElement(rpr, q("i"))
            if u:
                etree.SubElement(rpr, q("u")).set(q("val"), "single")
        t = etree.SubElement(r, q("t"))
        t.text = text
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    run(p1, " See ")
    run(p1, "Smith", b=True)
    run(p1, " in ")
    run(p1, "Journal of Tests", i=True)
    run(p1, ", 2026.")
    p2 = etree.SubElement(note, q("p"))
    ppr = p1.find(q("pPr"))
    if ppr is not None:
        import copy
        p2.append(copy.deepcopy(ppr))
    run(p2, "Second ")
    run(p2, "line", u=True)
    run(p2, " here.")
    zout = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "word/footnotes.xml":
            data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        zout.writestr(item, data)
    zout.close()


if sys.argv[1] == "probe":
    probe(sys.argv[2])
else:
    fmt(sys.argv[2], sys.argv[3])
