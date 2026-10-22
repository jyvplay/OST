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
  *_runs        TT57: [text, bold, italic, underline, strike, size, colour] segments after resolution — w:rPrChange
                (§17.13.5.31) accept = drop the record, reject = the run's rPr becomes the recorded original rPr
  *_paras       TT57: [pStyle, jc, numId, ilvl, ind-left] per body paragraph after resolution — w:pPrChange (§17.13.5.29)
                accept = drop the record, reject = pPr becomes the recorded pPr (the mark's rPr and sectPr are kept)
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
    for el in doc.iter(q("rPrChange")):
        rpr = el.getparent()
        run = rpr.getparent() if rpr is not None else None
        if run is None or run.tag != q("r"):
            continue  # paragraph-mark / style-level rPrChange: not a run formatting change
        in_move = any(a.tag in (q("moveFrom"), q("moveTo")) for a in run.iterancestors())
        revs.append({"kind": "fmt", "id": el.get(q("id")), "author": el.get(q("author")), "date": el.get(q("date")),
                     "text": run_text(run), "mark": False, "nested": False, "in_move": in_move})
    for el in doc.iter(q("pPrChange")):
        ppr = el.getparent()
        para = ppr.getparent() if ppr is not None else None
        if para is None or ppr.tag != q("pPr") or para.tag != q("p"):
            continue  # style / numbering-level pPrChange: not a paragraph change
        revs.append({"kind": "pfmt", "id": el.get(q("id")), "author": el.get(q("author")), "date": el.get(q("date")),
                     "text": "".join(run_text(r) for r in para if r.tag != q("pPr")), "mark": False, "nested": False})
    return revs


def body_paras(d):
    out = []
    for p in d.find(q("body")).iter(q("p")):
        ppr = p.find(q("pPr"))
        g = lambda path, a="val": (ppr.find(path).get(q(a)) if ppr is not None and ppr.find(path) is not None else None)
        out.append([g(q("pStyle")), g(q("jc")), g(q("numPr") + "/" + q("numId")), g(q("numPr") + "/" + q("ilvl")), g(q("ind"), "left") or g(q("ind"), "start")])
    return out


ON = lambda e: e is not None and e.get(q("val")) not in ("0", "false", "off", "none")


def run_fmt(r):
    """direct run formatting (no styles): bold, italic, underline, strike, size (half-points), colour"""
    rpr = r.find(q("rPr"))
    if rpr is None:
        return [False, False, False, False, None, None]
    u = rpr.find(q("u"))
    sz = rpr.find(q("sz"))
    col = rpr.find(q("color"))
    return [ON(rpr.find(q("b"))), ON(rpr.find(q("i"))), ON(u), ON(rpr.find(q("strike"))),
            int(sz.get(q("val"))) if sz is not None else None,
            col.get(q("val")) if col is not None and col.get(q("val")) != "auto" else None]


def body_runs(d):
    """[[text, fmt...], …] over the body after resolution; paragraphs separated by a "\n" segment; adjacent equal merged"""
    out = []
    body = d.find(q("body"))
    paras = list(body.iter(q("p")))
    for pi, p in enumerate(paras):
        for r in p.iter(q("r")):
            if r.getparent() is not None and r.getparent().tag in (q("del"),):
                continue
            t = run_text(r)
            if not t:
                continue
            f = run_fmt(r)
            if out and out[-1][1:] == f:
                out[-1][0] += t
            else:
                out.append([t] + f)
        if pi < len(paras) - 1:
            out.append(["\n", None, None, None, None, None, None])
    return out


def resolve(doc, decide, want_runs=False):
    """decide(kind, id) -> True accept / False reject. Works on a deep copy; returns the body text."""
    d = copy.deepcopy(doc)
    joins = set()
    for el in list(d.iter(q("pPrChange"))):
        ppr = el.getparent()
        if ppr is None or ppr.tag != q("pPr") or ppr.getparent() is None or ppr.getparent().tag != q("p"):
            continue
        if decide("pfmt", el.get(q("id"))):
            ppr.remove(el)
        else:
            inner = el.find(q("pPr"))
            keep = [ch for ch in ppr if ch.tag in (q("rPr"), q("sectPr"))]
            for ch in list(ppr):
                ppr.remove(ch)
            for ch in (list(inner) if inner is not None else []):
                ppr.append(ch)
            for ch in keep:
                ppr.append(ch)
    for el in list(d.iter(q("rPrChange"))):
        rpr = el.getparent()
        if rpr is None or rpr.getparent() is None or rpr.getparent().tag != q("r"):
            continue
        acc = decide("fmt", el.get(q("id")))
        if acc:
            rpr.remove(el)
        else:
            inner = el.find(q("rPr"))
            for ch in list(rpr):
                rpr.remove(ch)
            if inner is not None:
                for ch in list(inner):
                    rpr.append(ch)
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
    if want_runs == "paras":
        return body_paras(d)
    if want_runs:
        return body_runs(d)
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
        "accept_runs": resolve(doc, lambda k, i: True, True),
        "reject_runs": resolve(doc, lambda k, i: False, True),
        "decided_runs": resolve(doc, lambda k, i: decisions.get("%s:%s" % (k, i), True), True),
        "accept_paras": resolve(doc, lambda k, i: True, "paras"),
        "reject_paras": resolve(doc, lambda k, i: False, "paras"),
        "decided_paras": resolve(doc, lambda k, i: decisions.get("%s:%s" % (k, i), True), "paras"),
    }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
