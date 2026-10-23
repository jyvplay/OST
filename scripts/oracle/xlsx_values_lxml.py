#!/usr/bin/env python3
"""TT67 test-only oracle: cell values of an .xlsx read with lxml and REAL namespace resolution (ElementTree Clark
names, so any prefix — x:, s:, default — works), independent of openpyxl and of our reader.

Usage: xlsx_values_lxml.py FILE  → JSON {sheet: {A1: value}} for non-empty cells.
       xlsx_values_lxml.py FILE --empty-text → JSON {sheet: [A1, …]}: CONSTANT string cells (t = s / inlineStr / str,
       no <f>) whose text is "" — Excel's non-blank empty text (TT68) — excluding cached children of array formulas. Values: shared / inline / rich
strings (runs concatenated), booleans as true/false, numbers as float, errors as their text, formula-string results.
Only what ECMA-376 §18.3.1.4 (c), §18.4 (sst / is / r / t) define; styles and dates are not interpreted (numbers stay
serials). Main namespaces accepted: transitional, strict and the Excel 2007 beta namespace.
"""
import json
import posixpath
import sys
import zipfile

from lxml import etree

MAIN = {"http://schemas.openxmlformats.org/spreadsheetml/2006/main", "http://purl.oclc.org/ooxml/spreadsheetml/main",
        "http://schemas.microsoft.com/office/excel/2006/2"}
RNS = {"http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"}
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


def local(el):
    return etree.QName(el).localname if isinstance(el.tag, str) else None


def is_main(el):
    return isinstance(el.tag, str) and etree.QName(el).namespace in MAIN


def kids(el, name):
    return [k for k in el if is_main(k) and local(k) == name]


def text_of(si):
    """<si>/<is>: plain <t> or rich runs <r><t>; phonetic runs (rPh) excluded."""
    out = []
    for k in si:
        if not is_main(k):
            continue
        if local(k) == "t":
            out.append(k.text or "")
        elif local(k) == "r":
            for t in kids(k, "t"):
                out.append(t.text or "")
    return "".join(out)


def parse(z, name):
    lower = {n.lower(): n for n in z.namelist()}
    real = lower.get(name.lower())
    if real is None:
        return None
    return etree.fromstring(z.read(real), etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True))


def col_index(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n


def a1(c, r):
    s = ""
    while c:
        c, m = divmod(c - 1, 26)
        s = chr(65 + m) + s
    return f"{s}{r}"


def main(path):
    z = zipfile.ZipFile(path)
    wb = parse(z, "xl/workbook.xml")
    rels = parse(z, "xl/_rels/workbook.xml.rels")
    targets = {}
    if rels is not None:
        for r in rels:
            if isinstance(r.tag, str) and etree.QName(r).namespace == PKG:
                targets[r.get("Id")] = posixpath.normpath(posixpath.join("xl", r.get("Target"))) if not r.get("Target", "").startswith("/") else r.get("Target")[1:]
    sst = []
    sst_name = next((posixpath.normpath(posixpath.join("xl", r.get("Target"))) for r in (rels if rels is not None else []) if isinstance(r.tag, str) and r.get("Type", "").endswith("/sharedStrings")), "xl/sharedStrings.xml")
    sx = parse(z, sst_name)
    if sx is not None:
        sst = [text_of(si) for si in kids(sx, "si")]
    out = {}
    sheets = next((s for s in wb if is_main(s) and local(s) == "sheets"), None)
    for sh in (kids(sheets, "sheet") if sheets is not None else []):
        rid = next((v for k, v in sh.attrib.items() if etree.QName(k).namespace in RNS and etree.QName(k).localname == "id"), None)
        part = targets.get(rid)
        if not part:
            continue
        x = parse(z, part)
        if x is None:
            continue
        d = {}
        cand, arrays = [], []
        data = next((k for k in x if is_main(k) and local(k) == "sheetData"), None)
        row_no = 0
        for row in (kids(data, "row") if data is not None else []):
            row_no = int(row.get("r")) if row.get("r") else row_no + 1
            col_no = 0
            for c in kids(row, "c"):
                ref = c.get("r")
                col_no = col_index(ref) if ref else col_no + 1
                t = c.get("t", "n")
                v = next(iter(kids(c, "v")), None)
                vt = v.text if v is not None else None
                if t == "inlineStr":
                    ist = next(iter(kids(c, "is")), None)
                    val = text_of(ist) if ist is not None else None
                elif vt is None:
                    val = None
                elif t == "s":
                    try:
                        ix = int(vt)
                    except ValueError:
                        ix = -1
                    val = sst[ix] if 0 <= ix < len(sst) else None
                elif t == "b":
                    val = vt.strip() in ("1", "true")
                elif t in ("str", "e"):
                    val = vt
                else:
                    try:
                        val = float(vt)
                    except ValueError:
                        val = vt
                fe = next(iter(kids(c, "f")), None)
                if fe is not None and fe.get("t") == "array" and fe.get("ref") and ":" in fe.get("ref"):
                    lo, hi = fe.get("ref").split(":")
                    arrays.append((col_index(lo), int("".join(ch for ch in lo if ch.isdigit())), col_index(hi), int("".join(ch for ch in hi if ch.isdigit())), col_no, row_no))
                if EMPTY_TEXT:
                    if val == "" and t in ("s", "inlineStr", "str") and fe is None:
                        cand.append((col_no, row_no))
                elif val is not None and val != "":
                    d[a1(col_no, row_no)] = val
        if EMPTY_TEXT:
            # constant empty-text cells, minus cached children of array formulas (the anchor re-computes them)
            inside = lambda c, r: any(c0 <= c <= c1 and r0 <= r <= r1 and (c, r) != (ca, ra) for c0, r0, c1, r1, ca, ra in arrays)
            d = sorted(a1(c, r) for c, r in cand if not inside(c, r))
        out[sh.get("name")] = d
    print(json.dumps(out))


EMPTY_TEXT = "--empty-text" in sys.argv

if __name__ == "__main__":
    main([a for a in sys.argv[1:] if not a.startswith("--")][0])
