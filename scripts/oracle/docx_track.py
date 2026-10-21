#!/usr/bin/env python3
"""TT56 independent Track Changes oracle (lxml + python-docx; neither shares code with src/lib/office).

Usage: docx_track.py FILE.docx [DECISIONS_JSON]
Prints one JSON object:
  revs          every w:ins / w:del (run-level and paragraph-mark) as {kind, id, author, date, text, mark, nested}
  ids_unique    every revision w:id is unique within document.xml
  track         settings.xml carries an enabled <w:trackRevisions/>
  opens         python-docx opens the package
  accept_text / reject_text   body text after accepting / rejecting everything (ECMA-376 §17.13.5 semantics:
                accept ins = unwrap, accept del = remove; reject is the reverse; a removed paragraph mark joins the
                paragraph with the following one)
  decided_text  body text after applying DECISIONS ({"ins:12": true, "del:13": false, …}; true = accept)
  plain_text    body text ignoring nothing (only meaningful for a file without revisions)
"""
import copy
import json
import sys
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
q = lambda t: "{%s}%s" % (W, t)


def load(path):
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    doc = etree.fromstring(z.read("word/document.xml"))
    settings = etree.fromstring(z.read("word/settings.xml")) if "word/settings.xml" in names else None
    return doc, settings


def run_text(el):
    out = []
    for n in el.iter():
        if n.tag in (q("t"), q("delText")):
            out.append(n.text or "")
        elif n.tag == q("tab"):
            out.append("\t")
        elif n.tag in (q("br"), q("cr")) and n.get(q("type")) not in ("page", "column"):
            out.append("\n")
    return "".join(out)


def revisions(doc):
    revs = []
    for el in doc.iter(q("ins"), q("del")):
        parent = el.getparent()
        mark = parent is not None and parent.tag == q("rPr") and parent.getparent() is not None and parent.getparent().tag == q("pPr")
        nested = parent is not None and parent.tag == q("ins")
        revs.append({
            "kind": "ins" if el.tag == q("ins") else "del",
            "id": el.get(q("id")),
            "author": el.get(q("author")),
            "date": el.get(q("date")),
            "text": "\u00b6" if mark else run_text(el),
            "mark": bool(mark),
            "nested": bool(nested),
        })
    return revs


def resolve(doc, decide):
    """decide(kind, id) -> True accept / False reject. Works on a deep copy; returns the body text."""
    d = copy.deepcopy(doc)
    joins = set()
    for el in list(d.iter(q("ins"), q("del"))):
        if el.getparent() is None:
            continue
        # detached subtree check: walk up to the root
        anc = el
        while anc.getparent() is not None:
            anc = anc.getparent()
        if anc is not d:
            continue
        kind = "ins" if el.tag == q("ins") else "del"
        acc = decide(kind, el.get(q("id")))
        parent = el.getparent()
        if parent.tag == q("rPr") and parent.getparent() is not None and parent.getparent().tag == q("pPr"):
            para = parent.getparent().getparent()
            parent.remove(el)
            if (kind == "del") == acc:
                joins.add(para)
            continue
        keep = (kind == "ins") == acc
        if not keep:
            parent.remove(el)
            continue
        idx = parent.index(el)
        if kind == "del":
            for n in el.iter(q("delText")):
                n.tag = q("t")
            for n in el.iter(q("delInstrText")):
                n.tag = q("instrText")
        for i, ch in enumerate(list(el)):
            parent.insert(idx + i, ch)
        parent.remove(el)
    body = d.find(q("body"))
    parts = []
    for p in body.iter(q("p")):
        txt = "".join(run_text(r) for r in p if r.tag != q("pPr"))
        parts.append((txt, p in joins))
    out = ""
    for i, (t, join) in enumerate(parts):
        out += t
        if i < len(parts) - 1:
            out += "" if join else "\n"
    return out


def main():
    path = sys.argv[1]
    decisions = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    doc, settings = load(path)
    revs = revisions(doc)
    ids = [r["id"] for r in revs]
    track = False
    if settings is not None:
        tr = settings.find(q("trackRevisions"))
        track = tr is not None and tr.get(q("val")) not in ("0", "false", "off")
    try:
        import docx  # python-docx
        docx.Document(path)
        opens = True
    except Exception as e:  # noqa: BLE001
        opens = "error: %s" % e
    res = {
        "revs": revs,
        "ids_unique": len(ids) == len(set(ids)),
        "track": track,
        "opens": opens,
        "accept_text": resolve(doc, lambda k, i: True),
        "reject_text": resolve(doc, lambda k, i: False),
        "decided_text": resolve(doc, lambda k, i: decisions.get("%s:%s" % (k, i), True)),
    }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
