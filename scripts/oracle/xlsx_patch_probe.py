#!/usr/bin/env python3
"""Independent oracle for the lossless .xlsx patch writer (TT46).

stdin: lines "orig<TAB>cand".  stdout: one JSON object per line with
  ok        – cand loads in openpyxl
  diff      – [sheet!A1, ...] cells whose value/formula differ
  styleDiff – {sheet!A1: [fields]} font/fill/numFmt/border/alignment differences
  extras    – per-feature counts (merges, cf ranges, validations, comments,
              images, charts, defined names) that differ between orig and cand
  partsLost – zip parts present in orig but missing from cand (calcChain excluded)
Uses openpyxl (MIT) only as a test oracle; nothing here ships in the app.
"""
import json, sys, zipfile, warnings
warnings.filterwarnings("ignore")
import openpyxl

def norm(v):
    if hasattr(v, "text") and not isinstance(v, str):
        v = "=" + str(v.text).lstrip("=")
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    if hasattr(v, "isoformat"):
        v = v.isoformat()
    return v

def style_sig(c):
    f = c.font; fl = c.fill; a = c.alignment; b = c.border
    col = lambda x: None if x is None else (x.rgb if x.type == "rgb" else f"{x.type}:{x.theme if x.type=='theme' else x.indexed}:{x.tint}")
    return {
        "font": (f.name, f.sz, bool(f.b), bool(f.i), f.u, col(f.color)),
        "fill": (fl.fill_type, col(fl.fgColor) if fl.fill_type else None),
        "numFmt": c.number_format,
        "align": (a.horizontal, a.vertical, bool(a.wrap_text)),
        "border": tuple(((getattr(b, s).style, col(getattr(b, s).color)) if getattr(b, s, None) is not None else (None, None)) for s in ("left", "right", "top", "bottom")),
    }

def extras(wb):
    out = {}
    for ws in wb.worksheets:
        out[ws.title] = {
            "merges": sorted(str(m) for m in ws.merged_cells.ranges),
            "cf": sorted(str(r.sqref) for r in ws.conditional_formatting),
            "dv": sorted(str(d.sqref) for d in ws.data_validations.dataValidation),
            "comments": sorted(c.coordinate for row in ws.iter_rows() for c in row if c.comment),
            "images": len(getattr(ws, "_images", [])),
            "charts": len(getattr(ws, "_charts", [])),
        }
    out["__names__"] = sorted(wb.defined_names.keys()) if hasattr(wb.defined_names, "keys") else []
    return out

def cells(wb):
    d, s = {}, {}
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for c in row:
                v = norm(c.value)
                key = f"{ws.title}!{c.coordinate}"
                if v is not None and v != "":
                    d[key] = v
                if c.has_style:
                    s[key] = style_sig(c)
    return d, s

ORACLE_SHEET_LIMIT = 8 << 20  # openpyxl holds two full copies; >8 MiB of sheet XML exhausts the 4 GB sandbox

def run(orig, cand, res):
    try:
        size = sum(i.file_size for i in zipfile.ZipFile(orig).infolist() if i.filename.startswith("xl/worksheets/"))
    except Exception:
        size = 0
    if size > ORACLE_SHEET_LIMIT:
        res["skip"] = f"oracle limitation: {size >> 20} MiB of worksheet XML exceeds the openpyxl memory budget"
        print(json.dumps(res)); sys.stdout.flush(); return
    try:
        a = openpyxl.load_workbook(orig)
    except Exception as e:
        res["skip"] = f"orig unreadable: {type(e).__name__}"
        print(json.dumps(res)); sys.stdout.flush(); return
    if not a.worksheets:
        res["skip"] = "oracle limitation: openpyxl reads this (Strict OOXML) file as zero worksheets"
        print(json.dumps(res)); sys.stdout.flush(); return
    try:
        b = openpyxl.load_workbook(cand)
        res["ok"] = True
    except Exception as e:
        res["ok"] = False; res["error"] = f"{type(e).__name__}: {e}"[:300]
        print(json.dumps(res)); sys.stdout.flush(); return
    try:
        da, sa = cells(a); db, sb = cells(b)
    except Exception as e:
        res["skip"] = f"oracle could not walk cells: {type(e).__name__}: {e}"[:200]
        print(json.dumps(res)); sys.stdout.flush(); return
    if not da and not db:
        res["skip"] = "oracle limitation: openpyxl sees no cells in the original (pre-release/unknown namespace)"
        print(json.dumps(res)); sys.stdout.flush(); return
    res["diff"] = sorted(k for k in set(da) | set(db) if da.get(k) != db.get(k))[:50]
    sd = {}
    for k in set(sa) | set(sb):
        x, y = sa.get(k), sb.get(k)
        if x is None or y is None:
            # a style present on one side only matters if it isn't the default look
            continue
        f = [n for n in x if x[n] != y[n]]
        if f:
            sd[k] = f
    res["styleDiff"] = dict(list(sorted(sd.items()))[:50])
    ea, eb = extras(a), extras(b)
    res["extras"] = {k: [ea.get(k), eb.get(k)] for k in set(ea) | set(eb) if ea.get(k) != eb.get(k)}
    za = set(zipfile.ZipFile(orig).namelist()); zb = set(zipfile.ZipFile(cand).namelist())
    res["partsLost"] = sorted(p for p in za - zb if not p.endswith("calcChain.xml") and not p.endswith("/"))  # directory entries are not OPC parts
    if len(sys.argv) > 1 and sys.argv[1] == "--values":
        res["values"] = {k: db.get(k) for k in json.loads(sys.argv[2])}
    print(json.dumps(res, default=str)); sys.stdout.flush()


for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    orig, cand = line.split("\t")
    res = {"file": orig}
    try:
        run(orig, cand, res)
    except Exception as e:
        res["skip"] = f"oracle error: {type(e).__name__}: {e}"[:200]
        print(json.dumps(res)); sys.stdout.flush()
