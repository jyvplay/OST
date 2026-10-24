#!/usr/bin/env python3
"""TT58 independent footnote / endnote oracle (lxml + zipfile + python-docx; shares no code with src/lib/office).

Usage: docx_notes.py FILE.docx
Prints one JSON object:
  refs        [[kind, id], ...] every w:footnoteReference / w:endnoteReference in word/document.xml, in order
  notes       {"footnote": {id: text}, "endnote": {id: text}} ordinary notes (separators excluded); text = the note's
              paragraphs joined by "\\n" with the leading space after the reference mark stripped
  ref_mark    {"footnote": {id: bool}} the note body starts with w:footnoteRef / w:endnoteRef (Word's numbering mark)
  separators  {"footnote": [types], "endnote": [types]} special notes present
  dangling    references whose note is missing (must be empty)
  orphans     ordinary notes no reference points at
  ids_unique  note ids unique per part
  parts_ok    every notes part found through document.xml.rels has a matching [Content_Types] Override
  opens       python-docx opens the package
  styles      paragraph style of every note paragraph, e.g. {"footnote": {id: ["FootnoteText"]}}
"""
import json
import posixpath
import sys
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
q = lambda t: "{%s}%s" % (W, t)
TYPES = {
    "footnote": ("http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
                 "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"),
    "endnote": ("http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"),
}


def ptext(p):
    out = []
    for n in p.iter():
        if n.tag == q("t"):
            out.append(n.text or "")
        elif n.tag == q("tab"):
            out.append("\t")
        elif n.tag in (q("br"), q("cr")) and n.get(q("type")) not in ("page", "column"):
            out.append("\n")
    return "".join(out)


def main():
    z = zipfile.ZipFile(sys.argv[1])
    names = set(z.namelist())
    doc = etree.fromstring(z.read("word/document.xml"))
    rels = etree.fromstring(z.read("word/_rels/document.xml.rels")) if "word/_rels/document.xml.rels" in names else None
    ct = etree.fromstring(z.read("[Content_Types].xml"))
    overrides = {o.get("PartName"): o.get("ContentType") for o in ct.iter("{%s}Override" % CT)}
    refs = [["footnote" if e.tag == q("footnoteReference") else "endnote", e.get(q("id"))]
            for e in doc.iter(q("footnoteReference"), q("endnoteReference"))]
    notes = {"footnote": {}, "endnote": {}}
    ref_mark = {"footnote": {}, "endnote": {}}
    seps = {"footnote": [], "endnote": []}
    styles = {"footnote": {}, "endnote": {}}
    ids_unique = True
    parts_ok = True
    for kind, (rtype, ctype) in TYPES.items():
        targets = [r.get("Target") for r in (rels.iter("{%s}Relationship" % R) if rels is not None else []) if r.get("Type") == rtype]
        if not targets:
            continue
        path = posixpath.normpath(posixpath.join("word", targets[0])) if not targets[0].startswith("/") else targets[0][1:]
        if path not in names:
            parts_ok = False
            continue
        if overrides.get("/" + path) != ctype:
            parts_ok = False
        root = etree.fromstring(z.read(path))
        ids = []
        for n in root.findall(q(kind)):
            nid = n.get(q("id"))
            ids.append(nid)
            t = n.get(q("type"))
            if t in ("separator", "continuationSeparator", "continuationNotice"):
                seps[kind].append(t)
                continue
            paras = n.findall(q("p"))
            txt = "\n".join(ptext(p) for p in paras)
            if txt.startswith(" "):
                txt = txt[1:]
            notes[kind][nid] = txt
            first = paras[0] if paras else None
            ref_mark[kind][nid] = first is not None and first.find(".//" + q(kind + "Ref")) is not None
            st = []
            for p in paras:
                ps = p.find(q("pPr") + "/" + q("pStyle"))
                st.append(ps.get(q("val")) if ps is not None else None)
            styles[kind][nid] = st
        if len(ids) != len(set(ids)):
            ids_unique = False
    dangling = [r for r in refs if r[1] not in notes[r[0]]]
    referenced = {(k, i) for k, i in refs}
    orphans = [[k, i] for k in notes for i in notes[k] if (k, i) not in referenced]
    try:
        import docx  # python-docx
        docx.Document(sys.argv[1])
        opens = True
    except Exception as e:  # noqa: BLE001
        opens = "error: %s" % e
    print(json.dumps({"refs": refs, "notes": notes, "ref_mark": ref_mark, "separators": seps, "dangling": dangling,
                      "orphans": orphans, "ids_unique": ids_unique, "parts_ok": parts_ok, "opens": opens, "styles": styles}))


if __name__ == "__main__":
    main()
