#!/usr/bin/env python3
"""TT47 independent conditional-format oracle (test-only).

openpyxl (MIT) reads the cfRule list (type, operator, formulas, dxfId, sqref); lxml reads the raw
<dxf> elements from styles.xml; colours are resolved by xlsx_colors.resolve (stdlib colorsys tint).
Emits every constant cellIs rule whose dxf has a solid fill or font colour:
  stdin: .xlsx paths   stdout: JSON lines {"file", "rules": [[sheet, range, op, a, b, fill, font]]} | {"file","error"}
"""
import json, os, sys, warnings, zipfile
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import openpyxl
from openpyxl.styles.colors import COLOR_INDEX
from lxml import etree
from xlsx_colors import theme_colors, tint

S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
OP = {"greaterThan": "gt", "lessThan": "lt", "greaterThanOrEqual": "ge", "lessThanOrEqual": "le", "equal": "eq", "between": "between"}

def const(f):
    f = f.strip()
    if len(f) >= 2 and f[0] == '"' and f[-1] == '"':
        return f[1:-1].replace('""', '"')
    try:
        v = float(f)
        return v if v == v and abs(v) != float("inf") else None
    except ValueError:
        return None

def color(el, theme, idx):
    if el is None:
        return None
    if el.get("auto") in ("1", "true"):
        return None
    base = None
    if el.get("rgb") and len(el.get("rgb")) == 8:
        base = el.get("rgb")[2:]
    elif el.get("theme") is not None:
        i = int(el.get("theme")); base = theme[i] if i < len(theme) and theme[i] else None
    elif el.get("indexed") is not None:
        i = int(el.get("indexed")); base = idx[i] if i < len(idx) else None
    if not base:
        return None
    return "#" + tint(base, float(el.get("tint") or 0)).lower()

def dxfs(path, theme):
    z = zipfile.ZipFile(path)
    if "xl/styles.xml" not in z.namelist():
        return []
    root = etree.fromstring(z.read("xl/styles.xml"))
    idx = [c[2:].upper() for c in COLOR_INDEX] + ["000000", "FFFFFF"]
    custom = root.find(f"{{{S}}}colors/{{{S}}}indexedColors")
    if custom is not None:
        lst = [c.get("rgb", "")[2:].upper() for c in custom.findall(f"{{{S}}}rgbColor")]
        idx = lst + idx[len(lst):]
    out = []
    for d in root.findall(f"{{{S}}}dxfs/{{{S}}}dxf"):
        font = d.find(f"{{{S}}}font"); pf = d.find(f"{{{S}}}fill/{{{S}}}patternFill")
        fc = color(font.find(f"{{{S}}}color"), theme, idx) if font is not None else None
        fill = None
        if pf is not None:
            fill = color(pf.find(f"{{{S}}}bgColor"), theme, idx) or color(pf.find(f"{{{S}}}fgColor"), theme, idx)
        out.append((fill, fc))
    return out

for line in sys.stdin:
    p = line.rstrip("\n")
    if not p:
        continue
    try:
        theme = theme_colors(p); dx = dxfs(p, theme)
        wb = openpyxl.load_workbook(p)
        rules = []
        for ws in wb.worksheets:
            for cf in ws.conditional_formatting:
                for r in cf.rules:
                    if r.type != "cellIs" or r.operator not in OP or not r.formula or r.dxfId is None or r.dxfId >= len(dx):
                        continue
                    a = const(r.formula[0]); b = const(r.formula[1]) if len(r.formula) > 1 else None
                    if a is None or (r.operator == "between" and (b is None or isinstance(a, str) or isinstance(b, str))):
                        continue
                    if isinstance(a, str) and r.operator != "equal":
                        continue
                    fill, fc = dx[r.dxfId]
                    if not fill and not fc:
                        continue
                    for rng in str(cf.sqref).split():
                        rules.append([ws.title, rng.replace("$", ""), OP[r.operator], a, b if r.operator == "between" else None, fill, fc])
        print(json.dumps({"file": p, "rules": rules}), flush=True)
    except Exception as e:
        print(json.dumps({"file": p, "error": f"{type(e).__name__}: {e}"[:200]}), flush=True)
