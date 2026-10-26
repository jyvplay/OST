#!/usr/bin/env python3
"""TT58 independent PivotTable oracle (pandas groupby; shares no code with src/lib/formula/pivot.ts).

stdin: {"table": [[field names...], [values...], ...], "spec": {"rows": [i], "cols": [j], "values": [{"field": k, "fn": f}],
        "filters": [{"field": i, "include": [labels]}]}}
stdout: {"cells": [[row_labels, col_labels, value_index, value], ...], "records": n}
  one entry for EVERY combination of a row-field prefix and a column-field prefix that has records (prefix [] = total),
  labels as Excel shows items ("(blank)", "TRUE"/"FALSE", numbers via repr of int when integral).
Summary functions follow Excel's PivotTable definitions: sum / product / max / min / average / countNums / stdDev /
stdDevp / var / varp use only numeric cells; count counts non-empty cells.
"""
import json
import math
import sys

import pandas as pd


def is_err(v):
    return isinstance(v, dict) and "e" in v


def label(v):
    if is_err(v):
        return v["e"]
    if v is None or v == "" or (isinstance(v, float) and math.isnan(v)):
        return "(blank)"
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def key(v):
    """grouping key matching Excel: numbers and text kept apart, text case-insensitive"""
    if v is None or v == "":
        return ("b",)
    if is_err(v):
        return ("e", v["e"])
    if isinstance(v, bool):
        return ("l", v)
    if isinstance(v, (int, float)):
        return ("n", float(v))
    return ("s", str(v).lower())


def agg(fn, vals):
    errs = [v["e"] for v in vals if is_err(v)]
    if errs and fn != "count":
        return {"e": errs[0]}
    nums = [float(v) for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
    s = pd.Series(nums, dtype="float64")
    if fn == "count":
        return sum(1 for v in vals if not (v is None or v == ""))
    if fn == "countNums":
        return len(nums)
    if fn == "sum":
        return float(s.sum()) if nums else 0
    if fn == "product":
        return float(s.prod()) if nums else 0
    if fn == "max":
        return float(s.max()) if nums else 0
    if fn == "min":
        return float(s.min()) if nums else 0
    if fn == "average":
        return float(s.mean()) if nums else "#DIV/0!"
    if fn == "var":
        return float(s.var(ddof=1)) if len(nums) > 1 else "#DIV/0!"
    if fn == "varp":
        return float(s.var(ddof=0)) if nums else "#DIV/0!"
    if fn == "stdDev":
        return float(s.std(ddof=1)) if len(nums) > 1 else "#DIV/0!"
    if fn == "stdDevp":
        return float(s.std(ddof=0)) if nums else "#DIV/0!"
    raise ValueError(fn)


def main():
    inp = json.load(sys.stdin)
    if "cases" in inp:
        print(json.dumps([run(c) for c in inp["cases"]]))
    else:
        print(json.dumps(run(inp)))


def run(inp):
    table, spec = inp["table"], inp["spec"]
    header, data = table[0], [r + [None] * (len(table[0]) - len(r)) for r in table[1:]]
    data = [r for r in data if any(not (v is None or v == "") for v in r)]
    # Excel's pivot cache keeps ONE item per case-insensitive value, captioned by its first occurrence in the source
    # (before filtering)
    caption = {}
    for r in [x + [None] * (len(header) - len(x)) for x in table[1:]]:
        for c in range(len(header)):
            caption.setdefault((c, key(r[c])), label(r[c]))
    for f in spec.get("filters") or []:
        inc = set(f["include"])
        data = [r for r in data if caption[(f["field"], key(r[f["field"]]))] in inc]
    rows, cols = spec["rows"], spec["cols"]
    values = spec["values"] or [{"field": (rows + cols)[0], "fn": "count"}]
    ncol = len(header)
    # a DataFrame of grouping keys (object dtype so 1 and "1" stay distinct) plus the raw values
    df = pd.DataFrame({"__i": range(len(data))})
    for c in set(rows + cols):
        df["k%d" % c] = [key(r[c]) for r in data]
    out = []
    for i in range(len(rows) + 1):
        for j in range(len(cols) + 1):
            by = ["k%d" % c for c in rows[:i]] + ["k%d" % c for c in cols[:j]]
            groups = [((), df["__i"].tolist())] if not by else [((g,) if len(by) == 1 else g, sub["__i"].tolist()) for g, sub in df.groupby(by, sort=False, dropna=False)]
            for g, idx in groups:
                if not idx:
                    continue
                first = data[idx[0]]
                rl = [caption[(c, key(first[c]))] for c in rows[:i]]
                cl = [caption[(c, key(first[c]))] for c in cols[:j]]
                for vi, v in enumerate(values):
                    out.append([rl, cl, vi, agg(v["fn"], [data[x][v["field"]] for x in idx])])
    return {"cells": out, "records": len(data), "ncol": ncol}


if __name__ == "__main__":
    main()
