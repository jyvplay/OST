#!/usr/bin/env python3
"""TT76 test-only oracle: what openpyxl (MIT, an independent SpreadsheetML reader) sees of AutoFilter criteria.

For every worksheet: the AutoFilter ref, each filterColumn's criteria (typed: values / dateGroupItem / customFilters /
top10 / dynamicFilter / colorFilter + the dxf's colour / iconFilter) and the rows the FILE marks hidden; the same for
every table's own autoFilter. Nothing here ships in Fusion.

    python3 scripts/oracle/xlsx_filters.py a.xlsx b.xlsx ...   → JSON {file: {sheets: {...}} | {error}}
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")
import openpyxl  # noqa: E402


def colour(c):
    if c is None or getattr(c, "type", None) == "auto":  # (an unset Color.auto reads back as a truthy descriptor)
        return None
    rgb = getattr(c, "rgb", None)
    if rgb == "00000000":  # openpyxl's default for an absent colour
        return None
    return ("#" + rgb[-6:].upper()) if isinstance(rgb, str) and len(rgb) >= 6 else None


def column(fc, dxfs):
    out = {"colId": fc.colId}
    if fc.filters is not None:
        f = fc.filters
        out["values"] = sorted(str(v) for v in (f.filter or []))
        out["blank"] = bool(f.blank)
        out["dates"] = [
            {k: getattr(d, k) for k in ("year", "month", "day", "hour", "minute", "second", "dateTimeGrouping") if getattr(d, k) is not None}
            for d in (f.dateGroupItem or [])
        ]
    if fc.top10 is not None:
        t = fc.top10
        out["top10"] = {"top": t.top is not False, "percent": bool(t.percent), "val": t.val, "filterVal": t.filterVal}
    if fc.customFilters is not None:
        cf = fc.customFilters
        out["custom"] = {"and": bool(cf._and if hasattr(cf, "_and") else getattr(cf, "and_", False)),
                         "rules": [{"op": r.operator or "equal", "val": r.val} for r in (cf.customFilter or [])]}
    if fc.dynamicFilter is not None:
        d = fc.dynamicFilter
        out["dynamic"] = {"type": d.type, "val": d.val, "maxVal": d.maxVal}
    if fc.colorFilter is not None:
        c = fc.colorFilter
        dx = dxfs[c.dxfId] if c.dxfId is not None and c.dxfId < len(dxfs) else None
        cell = c.cellColor is not False
        rgb = None
        if dx is not None:
            # openpyxl fills absent colours with its default "00000000"; patternType none = Excel's "No Fill"
            if cell and dx.fill is not None and getattr(dx.fill, "patternType", None) not in (None, "none"):
                rgb = colour(dx.fill.bgColor) or colour(dx.fill.fgColor)
            elif not cell and dx.font is not None:
                rgb = colour(dx.font.color)
        out["color"] = {"cell": cell, "dxfId": c.dxfId, "rgb": rgb}
    if fc.iconFilter is not None:
        out["icon"] = {"iconSet": fc.iconFilter.iconSet, "iconId": fc.iconFilter.iconId}
    return out


def autofilter(af, dxfs):
    if af is None or not af.ref:
        return None
    return {"ref": af.ref, "columns": [column(fc, dxfs) for fc in (af.filterColumn or [])]}


def main():
    res = {}
    for path in sys.argv[1:]:
        try:
            wb = openpyxl.load_workbook(path)
            dxfs = list(wb._differential_styles.dxf or []) if hasattr(wb, "_differential_styles") else []
            sheets = {}
            for ws in wb.worksheets:
                hidden = sorted(r - 1 for r, d in ws.row_dimensions.items() if d.hidden)
                tables = {t.displayName: autofilter(t.autoFilter, dxfs) for t in ws.tables.values()}
                sheets[ws.title] = {"autoFilter": autofilter(ws.auto_filter, dxfs), "hidden": hidden, "tables": tables}
            res[path] = {"sheets": sheets}
        except Exception as e:  # noqa: BLE001 — the test reports it
            res[path] = {"error": "%s: %s" % (type(e).__name__, e)}
    print(json.dumps(res, default=str))


if __name__ == "__main__":
    main()
