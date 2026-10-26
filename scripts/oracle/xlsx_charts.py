#!/usr/bin/env python3
"""TT50 oracle: chart facts as read by openpyxl (MIT, independent implementation) — one JSON line per file.
Usage: xlsx_charts.py FILE...   Output per file: {"file", "charts": [{sheet, type, barDir, grouping, title, catTitle,
valTitle, series:[{tx, cat, val, trend}], anchor}]} or {"file", "error"}."""
import json, sys, warnings
warnings.filterwarnings("ignore")
from openpyxl import load_workbook
AUTO = "\u0000auto"

def text_of(t):
    if t is None: return None
    tx = getattr(t, "tx", None)
    if tx is None: return AUTO  # title element without text: the application shows its automatic text
    if tx.strRef is not None and tx.strRef.f:
        c = tx.strRef.strCache
        return c.pt[0].v if c is not None and c.pt else ""
    if tx.rich is not None:
        ps = tx.rich.p or []
        # openpyxl fills a title WITHOUT text with one empty run (t == ''), while an explicit empty <a:t/> reads as 'None'
        if len(ps) == 1 and ps[0].pPr is None and len(ps[0].r or []) == 1 and ps[0].r[0].t == "" and ps[0].r[0].rPr is None: return AUTO
        paras = []
        for p in tx.rich.p or []:
            # openpyxl quirk: an empty <a:t></a:t> is read as the string 'None'
            paras.append("".join((r.t if r.t not in (None, "None") else "") for r in (p.r or [])) + "".join((f.t or "") for f in (getattr(p, "fld", None) or [])))
        return " ".join(paras).strip()
    if tx.strRef is not None:
        c = tx.strRef.strCache
        return c.pt[0].v if c is not None and c.pt else ""
    return AUTO  # openpyxl materialises an empty Text() for a title without text

def ref(ds):
    if ds is None: return None
    for k in ("numRef", "strRef", "multiLvlStrRef"):
        r = getattr(ds, k, None)
        if r is not None and getattr(r, "f", None): return r.f
    return None

def one(path):
    wb = load_workbook(path)
    out = []
    for ws in list(wb.worksheets) + list(getattr(wb, "chartsheets", [])):
        for ch in getattr(ws, "_charts", []):
            parts = [ch] + list(getattr(ch, "_charts", []))[1:] if hasattr(ch, "_charts") else [ch]
            d = {"sheet": ws.title, "type": ch.tagname, "barDir": getattr(ch, "barDir", None), "grouping": getattr(ch, "grouping", None),
                 "title": text_of(ch.title), "series": []}
            for ax_name in ("x_axis", "y_axis"):
                ax = getattr(ch, ax_name, None)
                d[ax_name] = text_of(getattr(ax, "title", None)) if ax is not None else None
            for s in ch.series:
                tx = None
                if s.tx is not None:
                    tx = s.tx.strRef.f if s.tx.strRef is not None else s.tx.v
                tr = s.trendline
                d["series"].append({"tx": tx, "cat": ref(s.cat) or ref(getattr(s, "xVal", None)), "val": ref(s.val) or ref(getattr(s, "yVal", None)),
                                    "trend": tr.trendlineType if tr is not None else None, "order": tr.order if tr is not None else None, "period": tr.period if tr is not None else None})
            a = getattr(ch, "anchor", None)
            fr = getattr(a, "_from", None)
            d["anchor"] = [fr.col, fr.row] if fr is not None else None
            out.append(d)
    return out

for p in sys.argv[1:]:
    try: print(json.dumps({"file": p, "charts": one(p)}))
    except Exception as e: print(json.dumps({"file": p, "error": f"{type(e).__name__}: {e}"[:200]}))
