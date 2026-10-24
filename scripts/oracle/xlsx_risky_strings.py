#!/usr/bin/env python3
"""TT47 oracle (test-only): string cells whose text could be mistaken for a number / boolean / formula.

openpyxl (MIT) reads each workbook; for every cell of data_type 's' whose text parses as a float, is
TRUE/FALSE (any case), or starts with '=' or an apostrophe, emit [sheet!ref, text].
  stdin: .xlsx paths   stdout: JSON lines {"file", "cells": [[ref, text]], "strings": n} | {"file", "error"}
"""
import json, sys, warnings
warnings.filterwarnings("ignore")
import openpyxl
from openpyxl.cell.cell import MergedCell

def risky(t):
    s = t.strip()
    if not s:
        return False
    if t.startswith("=") or t.startswith("'") or s.upper() in ("TRUE", "FALSE"):
        return True
    try:
        float(s); return True
    except ValueError:
        return False

for line in sys.stdin:
    p = line.rstrip("\n")
    if not p:
        continue
    try:
        wb = openpyxl.load_workbook(p)
        out = []; n = 0
        for ws in wb.worksheets:
            for row in ws.iter_rows():
                for c in row:
                    if isinstance(c, MergedCell) or c.data_type != "s" or not isinstance(c.value, str):
                        continue
                    n += 1
                    if risky(c.value):
                        out.append([f"{ws.title}!{c.coordinate}", c.value])
        print(json.dumps({"file": p, "cells": out, "strings": n}), flush=True)
    except Exception as e:
        print(json.dumps({"file": p, "error": f"{type(e).__name__}: {e}"[:200]}), flush=True)
