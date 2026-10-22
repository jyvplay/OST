#!/usr/bin/env python3
"""TT60 independent oracle for WordprocessingML table revisions (lxml + python-docx; shares no code with src/lib/office).

Usage: docx_tblrev.py FILE.docx
Prints one JSON object:
  opens        python-docx opens the package (string = the error)
  tables       python-docx's view: [[cell text per cell] per row] per top-level table (no revision processing)
  rows         every tracked row: {table, row, marks: [{kind, id, author, date}], text}
  pr_changes   every w:tblPrChange / w:trPrChange / w:tcPrChange: {kind, id, author, old: {local-name: w:val | w:fill | w:w}}
  props        current table / row / cell property values per table (tblStyle, trHeight per row, shd fill per cell)
  order_ok     each w:trPr obeys CT_TrPr (base properties, then ins?, del?, trPrChange?) and each w:tr obeys
               (tblPrEx?, trPr?, cells...) ; order_errors lists violations
  ids_unique   every revision-record w:id (ins, del, *PrChange, rPrChange, pPrChange) is unique in document.xml
  accept / reject   top-level tables as [[cell text]] after accepting / rejecting ALL changes, ECMA-376 §17.13.5:
               row w:del accepted = row removed, row w:ins rejected = row removed (a row carrying both is removed
               either way except accept-ins+reject-del); run w:ins accept = keep text, reject = drop; run w:del reversed;
               a table whose every row is removed disappears
"""
import json
import sys
import zipfile

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
q = lambda t: "{%s}%s" % (W, t)
TRPR_BASE = {"cnfStyle", "divId", "gridBefore", "gridAfter", "wBefore", "wAfter", "cantSplit", "trHeight", "tblHeader",
             "tblCellSpacing", "jc", "hidden"}
REV_TAGS = {"ins", "del", "tblPrChange", "trPrChange", "tcPrChange", "rPrChange", "pPrChange", "tblPrExChange",
            "sectPrChange", "numberingChange", "cellIns", "cellDel", "cellMerge"}


def local(el):
    return etree.QName(el).localname


def cell_text(tc, mode):
    """text of a cell's own paragraphs (nested tables included), resolving run revisions per mode (None/accept/reject)"""
    paras = []
    for p in tc.iter(q("p")):
        s = []
        for t in p.iter(q("t"), q("delText")):
            anc = [local(a) for a in t.iterancestors() if a.tag in (q("ins"), q("del"))]
            if mode == "accept" and "del" in anc:
                continue
            if mode == "reject" and "ins" in anc:
                continue
            if mode is None and local(t) == "delText":
                continue
            s.append(t.text or "")
        paras.append("".join(s))
    return "\n".join(paras)


def row_marks(tr):
    trpr = tr.find(q("trPr"))
    out = []
    if trpr is None:
        return out
    for m in trpr:
        if local(m) in ("ins", "del"):
            out.append({"kind": local(m), "id": m.get(q("id")), "author": m.get(q("author")), "date": m.get(q("date"))})
    return out


def tables_view(body, mode):
    res = []
    for tbl in body.findall(q("tbl")):
        rows = []
        for tr in tbl.findall(q("tr")):
            kinds = {m["kind"] for m in row_marks(tr)}
            if mode == "accept" and "del" in kinds:
                continue
            if mode == "reject" and "ins" in kinds:
                continue
            rows.append([cell_text(tc, mode) for tc in tr.findall(q("tc"))])
        if rows:
            res.append(rows)
    return res


def main():
    path = sys.argv[1]
    z = zipfile.ZipFile(path)
    doc = etree.fromstring(z.read("word/document.xml"))
    body = doc.find(q("body"))
    out = {}
    try:
        import docx
        d = docx.Document(path)
        out["opens"] = True
        out["tables"] = [[[c.text for c in r.cells] for r in t.rows] for t in d.tables]
    except Exception as e:  # noqa: BLE001
        out["opens"] = str(e)
        out["tables"] = []
    rows = []
    for ti, tbl in enumerate(body.iter(q("tbl"))):
        for ri, tr in enumerate(tbl.findall(q("tr"))):
            m = row_marks(tr)
            if m:
                rows.append({"table": ti, "row": ri, "marks": m, "text": [cell_text(tc, None) for tc in tr.findall(q("tc"))]})
    out["rows"] = rows
    prc = []
    for ch in doc.iter(q("tblPrChange"), q("trPrChange"), q("tcPrChange")):
        old = {}
        inner = ch[0] if len(ch) else None
        if inner is not None:
            for k in inner:
                v = k.get(q("val")) or k.get(q("fill")) or k.get(q("w"))
                old[local(k)] = v
        prc.append({"kind": local(ch), "id": ch.get(q("id")), "author": ch.get(q("author")), "old": old})
    out["pr_changes"] = prc
    props = []
    for tbl in body.iter(q("tbl")):
        tp = tbl.find(q("tblPr"))
        st = tp.find(q("tblStyle")) if tp is not None else None
        rinfo = []
        for tr in tbl.findall(q("tr")):
            trpr = tr.find(q("trPr"))
            h = trpr.find(q("trHeight")) if trpr is not None else None
            fills = []
            for tc in tr.findall(q("tc")):
                tcpr = tc.find(q("tcPr"))
                shd = tcpr.find(q("shd")) if tcpr is not None else None
                fills.append(shd.get(q("fill")) if shd is not None else None)
            rinfo.append({"height": h.get(q("val")) if h is not None else None, "fills": fills})
        props.append({"style": st.get(q("val")) if st is not None else None, "rows": rinfo})
    out["props"] = props
    errs = []
    for tr in doc.iter(q("tr")):
        names = [local(k) for k in tr if isinstance(k.tag, str)]
        seen_cell = False
        for i, n in enumerate(names):
            if n == "tblPrEx" and (i != 0):
                errs.append("tblPrEx not first in w:tr")
            if n == "trPr" and (seen_cell or (i > 1) or (i == 1 and names[0] != "tblPrEx")):
                errs.append("trPr misplaced in w:tr: %s" % names)
            if n in ("tc", "sdt", "customXml"):
                seen_cell = True
        if names.count("trPr") > 1:
            errs.append("two trPr")
    for trpr in doc.iter(q("trPr")):
        stage = 0  # 0 base, 1 ins, 2 del, 3 trPrChange
        for k in trpr:
            n = local(k)
            want = 0 if n in TRPR_BASE else {"ins": 1, "del": 2, "trPrChange": 3}.get(n, -1)
            if want < 0:
                errs.append("unknown trPr child " + n)
            elif want < stage or (want == stage and want > 0):
                errs.append("trPr order: %s" % [local(x) for x in trpr])
                break
            else:
                stage = want
    out["order_ok"] = not errs
    out["order_errors"] = errs
    ids = [el.get(q("id")) for el in doc.iter() if isinstance(el.tag, str) and el.tag.startswith("{%s}" % W)
           and local(el) in REV_TAGS and el.get(q("id")) is not None]
    out["ids_unique"] = len(ids) == len(set(ids))
    out["ids"] = ids
    out["accept"] = tables_view(body, "accept")
    out["reject"] = tables_view(body, "reject")
    print(json.dumps(out))


main()
