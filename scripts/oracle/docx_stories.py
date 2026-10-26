#!/usr/bin/env python3
"""TT65 independent oracle: tracked revisions in EVERY story of a .docx (lxml only; shares no code with src/lib/office).

For each story — the main text (word/document.xml), every header / footer part, every real footnote / endnote — it reports
  * revisions: [{kind, id, author, text}] in document order (kind = ins | del | pPrChange | rPrChange | mark-ins | mark-del)
  * accept / reject: the story as a reader sees it after Accept All / Reject All — a list of [text, jc] paragraphs, where a
    paragraph whose mark is (accepted-)deleted or (rejected-)inserted joins the next one (the surviving mark is the next's)
and package-wide:
  * ids: every revision-record w:id (ins, del, *PrChange, cellIns/cellDel/cellMerge, tblGridChange) across ALL parts
  * ids_unique: no id repeats (ECMA-376 §17.13.5: each annotation id is unique in the document)
  * opens: python-docx opens the package
Text: w:t / w:delText (as the view dictates), w:tab and w:ptab as "\\t", w:br as "\\n", field results (not instructions),
w:fldSimple results; note reference marks (w:footnoteRef / w:endnoteRef) give no text.
Usage: docx_stories.py FILE.docx  → JSON on stdout
"""
import json
import sys
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"


def q(n):
    return "{%s}%s" % (W, n)


REC = {q(n) for n in ("ins", "del", "rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange", "cellIns", "cellDel", "cellMerge", "tblGridChange", "sectPrChange", "numberingChange", "tblPrExChange")}
PARSER = etree.XMLParser(resolve_entities=False, huge_tree=True)


def run_text(r, deleted_ok):
    """text of one w:r: w:t (and w:delText when deleted text is to be shown)"""
    out = []
    for c in r:
        t = c.tag
        if t == q("t") or (deleted_ok and t == q("delText")):
            out.append(c.text or "")
        elif t in (q("tab"), q("ptab")):
            out.append("\t")
        elif t in (q("br"), q("cr")):
            out.append("\n")
        elif t == q("noBreakHyphen"):
            out.append("\u2011")
    return "".join(out)


def para_view(p, mode):
    """(text, jc, mark_survives) of one paragraph under mode 'accept' | 'reject'"""
    text = []  # instruction text (w:instrText) is never collected: only field results show

    def walk(node, ins, dele):
        for c in node:
            t = c.tag
            if t == q("pPr"):
                continue
            if t == q("ins"):
                walk(c, True, dele)
            elif t == q("del"):
                walk(c, ins, True)
            elif t in (q("moveTo"), q("moveFrom")):
                walk(c, ins or t == q("moveTo"), dele or t == q("moveFrom"))
            elif t == q("r"):
                show = (not dele) if mode == "accept" else (not ins)
                if show:
                    text.append(run_text(c, dele))
            elif t in (q("hyperlink"), q("smartTag"), q("sdt"), q("sdtContent"), q("fldSimple"), q("customXml")):
                walk(c, ins, dele)
            elif t == q("sdtPr") or t == q("sdtEndPr"):
                continue

    walk(p, False, False)
    ppr = p.find(q("pPr"))
    jc = None
    mark = None
    if ppr is not None:
        j = ppr.find(q("jc"))
        jc = j.get(q("val")) if j is not None else None
        ch = ppr.find(q("pPrChange"))
        if mode == "reject" and ch is not None:
            old = ch.find(q("pPr"))
            j2 = old.find(q("jc")) if old is not None else None
            jc = j2.get(q("val")) if j2 is not None else None
        rpr = ppr.find(q("rPr"))
        if rpr is not None:
            if rpr.find(q("ins")) is not None:
                mark = "ins"
            elif rpr.find(q("del")) is not None:
                mark = "del"
    survives = not ((mode == "accept" and mark == "del") or (mode == "reject" and mark == "ins"))
    if jc in ("start", "left"):
        jc = None
    if jc == "end":
        jc = "right"
    return "".join(text), jc, survives


def story_view(root, mode):
    """paragraphs (document order, tables flattened) with joins applied"""
    # a join keeps the FIRST paragraph's properties (Word merges that way) unless that paragraph has no text left in this
    # view — a paragraph removed / rejected as a whole is not a merge, the next paragraph keeps its own
    out = []
    carry = ""
    carry_jc = None
    for p in root.iter(q("p")):
        # a paragraph inside a text box is its own story in Word; none of our fixtures has one, skip nested ones
        if any(a.tag == q("txbxContent") for a in p.iterancestors()):
            continue
        t, jc, survives = para_view(p, mode)
        if carry == "" and t != "":
            carry_jc = jc
        if survives:
            out.append([carry + t, carry_jc if carry != "" else jc])
            carry = ""
        else:
            carry += t
    if carry:
        out.append([carry, carry_jc])
    return out


def revisions(root):
    out = []
    for e in root.iter():
        if e.tag not in REC:
            continue
        par = e.getparent()
        kind = etree.QName(e).localname
        if kind in ("ins", "del") and par is not None and par.tag == q("rPr") and par.getparent() is not None and par.getparent().tag == q("pPr"):
            kind = "mark-" + kind
        txt = ""
        if kind in ("ins", "del"):
            txt = "".join(run_text(r, True) for r in e.iter(q("r")))
        out.append({"kind": kind, "id": e.get(q("id")), "author": e.get(q("author")), "text": txt})
    return out


def main(path):
    z = zipfile.ZipFile(path)
    names = {n.lower(): n for n in z.namelist()}

    def read(name):
        n = names.get(name.lower())
        return etree.fromstring(z.read(n), PARSER) if n else None

    rels = read("word/_rels/document.xml.rels")
    targets = {}
    if rels is not None:
        for r in rels:
            targets[r.get("Id")] = (r.get("Type").rsplit("/", 1)[-1], r.get("Target"))
    stories = {}
    ids = []
    body = read("word/document.xml")
    stories["body"] = body
    for rid, (ty, tgt) in sorted(targets.items(), key=lambda kv: kv[1][1]):
        if ty in ("header", "footer"):
            part = tgt[1:] if tgt.startswith("/") else "word/" + tgt
            root = read(part)
            if root is not None:
                stories["%s:%s" % (ty, part.split("/")[-1])] = root
    for kind in ("footnote", "endnote"):
        root = read("word/%ss.xml" % kind)
        if root is None:
            continue
        for n in root.findall(q(kind)):
            if n.get(q("type")) in ("separator", "continuationSeparator", "continuationNotice"):
                continue
            stories["%s:%s" % (kind, n.get(q("id")))] = n
    res = {"stories": {}}
    for name, root in stories.items():
        revs = revisions(root)
        ids.extend(r["id"] for r in revs if r["id"] is not None)
        res["stories"][name] = {"revisions": revs, "accept": story_view(root, "accept"), "reject": story_view(root, "reject")}
    # records in parts not walked as stories (comments are a separate id space for w:comment, but revisions inside them count)
    for extra in ("word/comments.xml",):
        root = read(extra)
        if root is not None:
            ids.extend(e.get(q("id")) for e in root.iter() if e.tag in REC and e.get(q("id")) is not None)
    res["ids"] = ids
    res["ids_unique"] = len(ids) == len(set(ids))
    try:
        import docx  # python-docx

        docx.Document(path)
        res["opens"] = True
    except Exception as e:  # noqa: BLE001
        res["opens"] = "%s: %s" % (type(e).__name__, e)
    print(json.dumps(res))


if __name__ == "__main__":
    main(sys.argv[1])
