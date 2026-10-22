"""TT57 oracle: the hyperlinks of every worksheet as openpyxl (MIT) reads them, plus a package/validity check.

Usage: xlsx_links.py FILE  ->  JSON {"opens": bool, "sheets": {name: [[ref, target, location, tooltip], ...]}, "rels_ok": bool}
"cells" = what openpyxl attaches to each cell (it expands a ranged <hyperlink> to every cell of the range);
"sheets" = the raw <hyperlink> elements with their relationship targets resolved by lxml, independently of openpyxl.
"""
import json, sys, zipfile, re
from lxml import etree

def main(path):
    out = {"opens": False, "sheets": {}, "cells": {}, "rels_ok": True, "errors": [], "hl_rels": {}}
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path)
        out["opens"] = True
        for ws in wb.worksheets:
            cells = []
            for row in ws.iter_rows():
                for c in row:
                    h = c.hyperlink
                    if h is not None:
                        cells.append([c.coordinate, h.target or None, h.location or None, h.tooltip or None])
            out["cells"][ws.title] = sorted(cells)
    except Exception as e:  # noqa: BLE001
        out["errors"].append(f"openpyxl: {e!r}")
    # raw package check: every r:id on a <hyperlink> resolves to an External hyperlink relationship, ids unique per part
    NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    RID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    wbx = etree.fromstring(z.read("xl/workbook.xml"))
    wrels = etree.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    relmap = {r.get("Id"): r.get("Target") for r in wrels}
    for s in wbx.iter("{%s}sheet" % NS["m"]):
        tgt = relmap.get(s.get(RID))
        if not tgt: continue
        part = tgt.lstrip("/") if tgt.startswith("/") else "xl/" + tgt
        if part not in names: continue
        x = etree.fromstring(z.read(part))
        relp = part.rsplit("/", 1)[0] + "/_rels/" + part.rsplit("/", 1)[1] + ".rels"
        rels = {}
        if relp in names:
            rx = etree.fromstring(z.read(relp))
            ids = [r.get("Id") for r in rx]
            if len(ids) != len(set(ids)): out["rels_ok"] = False; out["errors"].append(f"{relp}: duplicate Id")
            rels = {r.get("Id"): r for r in rx}
        out["hl_rels"][s.get("name")] = sum(1 for r in rels.values() if r.get("Type", "").endswith("/hyperlink"))
        raw = []
        for h in x.iter("{%s}hyperlink" % NS["m"]):
            rid = h.get(RID); target = None
            if rid:
                r = rels.get(rid)
                if r is None or not r.get("Type", "").endswith("/hyperlink") or r.get("TargetMode") != "External":
                    out["rels_ok"] = False; out["errors"].append(f"{part}: {rid} unresolved")
                else: target = r.get("Target")
            raw.append([h.get("ref"), target, h.get("location"), h.get("tooltip")])
        # child order: hyperlinks must come after dataValidations and before printOptions/pageMargins/drawing
        order = [etree.QName(k).localname for k in x]
        if "hyperlinks" in order:
            i = order.index("hyperlinks")
            if any(order.index(n) > i for n in ("sheetData", "mergeCells", "conditionalFormatting", "dataValidations") if n in order) or \
               any(order.index(n) < i for n in ("printOptions", "pageMargins", "pageSetup", "headerFooter", "drawing", "legacyDrawing", "tableParts", "extLst") if n in order):
                out["rels_ok"] = False; out["errors"].append(f"{part}: hyperlinks out of schema order {order}")
        out["sheets"][s.get("name")] = raw
    print(json.dumps(out))

main(sys.argv[1])
