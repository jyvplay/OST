"""TT78 oracle: what openpyxl (an independent reader, MIT) sees of outlines and table calculated columns.

Usage: xlsx_outline.py FILE... → JSON {file: {sheets: {name: {rows, cols, summaryBelow, summaryRight, maxRow, maxCol,
tables: [{name, ref, cols: [{name, calc, array}], formulas: {col_index: {row: formula}}}]}}} | {error}}.
rows / cols map 0-based index → [outlineLevel, hidden, collapsed] for every dimension with any of them set.
"""
import json
import sys
import warnings

import openpyxl
from openpyxl.utils import range_boundaries

warnings.simplefilter("ignore")


def sheet_info(ws):
    rows = {}
    for idx, d in ws.row_dimensions.items():
        lvl, hid, col = int(d.outline_level or 0), bool(d.hidden), bool(getattr(d, "collapsed", False))
        if lvl or hid or col:
            rows[idx - 1] = [lvl, hid, col]
    cols = {}
    for _key, d in ws.column_dimensions.items():
        lvl, hid, col = int(d.outline_level or 0), bool(d.hidden), bool(getattr(d, "collapsed", False))
        if not (lvl or hid or col) or d.min is None:
            continue
        for c in range(d.min, min(d.max or d.min, 16384) + 1):
            cols[c - 1] = [lvl, hid, col]
    op = ws.sheet_properties.outlinePr
    tables = []
    for t in ws.tables.values():
        c0, r0, c1, r1 = range_boundaries(t.ref)
        tcols = []
        for tc in t.tableColumns:
            f = tc.calculatedColumnFormula
            tcols.append({"name": tc.name, "calc": (f.attr_text if f is not None else None), "array": bool(f is not None and f.array)})
        formulas = {}
        hdr = int(t.headerRowCount if t.headerRowCount is not None else 1)
        tot = int(t.totalsRowCount or 0)
        for i, tc in enumerate(tcols):
            if not tc["calc"]:
                continue
            got = {}
            for r in range(r0 + hdr, r1 - tot + 1):
                v = ws.cell(row=r, column=c0 + i).value
                got[r - 1] = v if isinstance(v, str) else (None if v is None else repr(v))
            formulas[i] = got
        tables.append({"name": t.displayName or t.name, "ref": t.ref, "cols": tcols, "formulas": formulas})
    return {
        "rows": rows,
        "cols": cols,
        "summaryBelow": True if op is None or op.summaryBelow is None else bool(op.summaryBelow),
        "summaryRight": True if op is None or op.summaryRight is None else bool(op.summaryRight),
        "tables": tables,
    }


def main(files):
    out = {}
    for f in files:
        try:
            wb = openpyxl.load_workbook(f)
            out[f] = {"sheets": {ws.title: sheet_info(ws) for ws in wb.worksheets}}
        except Exception as e:  # noqa: BLE001 — report, the caller decides
            out[f] = {"error": f"{type(e).__name__}: {e}"[:300]}
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1:])
