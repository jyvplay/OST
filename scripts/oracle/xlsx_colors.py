#!/usr/bin/env python3
"""TT47 independent colour oracle (test-only).

Resolves SpreadsheetML colours WITHOUT our TypeScript code: openpyxl (MIT) supplies the
colour objects (rgb / theme+tint / indexed), lxml parses theme1.xml, and the tint is applied
with Python's stdlib colorsys HLS conversion.

  stdin  : one .xlsx path per line
  stdout : JSON lines {"file", "palette_ok", "cells": {"Sheet!A1": [fill|null, font|null]}}
           or {"file", "error"}
  --palette : print openpyxl's COLOR_INDEX (first 66) as JSON and exit
"""
import colorsys, json, sys, warnings, zipfile
warnings.filterwarnings("ignore")
import openpyxl
from openpyxl.cell.cell import MergedCell
from openpyxl.styles.colors import COLOR_INDEX
from lxml import etree

if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "--palette":
    print(json.dumps([c[2:].upper() for c in COLOR_INDEX[:64]])); sys.exit(0)

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
ORDER = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"]

def theme_colors(path):
    z = zipfile.ZipFile(path)
    names = [n for n in z.namelist() if n.startswith("xl/theme/") and n.endswith(".xml")]
    if not names:
        return []
    root = etree.fromstring(z.read(sorted(names)[0]))
    scheme = root.find(f".//{{{A}}}clrScheme")
    if scheme is None:
        return []
    out = []
    for name in ORDER:
        el = scheme.find(f"{{{A}}}{name}")
        val = ""
        if el is not None:
            s = el.find(f"{{{A}}}srgbClr"); y = el.find(f"{{{A}}}sysClr")
            if s is not None:
                val = s.get("val", "").upper()
            elif y is not None:
                val = (y.get("lastClr") or ("FFFFFF" if y.get("val") == "window" else "000000")).upper()
        out.append(val)
    return out

def tint(hexrgb, t):
    if not t:
        return hexrgb.upper()
    r, g, b = (int(hexrgb[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l * (1 + t) if t < 0 else l * (1 - t) + t
    return "".join(f"{round(x * 255):02X}" for x in colorsys.hls_to_rgb(h, max(0, min(1, l)), s))

def resolve(c, theme, indexed):
    if c is None:
        return None
    try:
        if c.type == "rgb" and isinstance(c.rgb, str) and len(c.rgb) == 8:
            base = c.rgb[2:]
        elif c.type == "theme":
            base = theme[c.theme] if c.theme < len(theme) and theme[c.theme] else None
        elif c.type == "indexed":
            base = indexed[c.indexed] if c.indexed < len(indexed) else None
        else:
            return None
    except Exception:
        return None
    if not base:
        return None
    return "#" + tint(base, c.tint or 0).lower()

def main():
  for line in sys.stdin:
      p = line.rstrip("\n")
      if not p:
          continue
      try:
          wb = openpyxl.load_workbook(p)
          theme = theme_colors(p)
          idx = [c[2:].upper() for c in COLOR_INDEX]
          custom = getattr(wb, "_colors", None)
          if custom:
              idx = [c[2:].upper() if isinstance(c, str) else c for c in custom] + idx[len(custom):]
          cells = {}; merged = []
          for ws in wb.worksheets:
              for row in ws.iter_rows():
                  for c in row:
                      if isinstance(c, MergedCell):  # openpyxl resets non-anchor merged cells; excluded on both sides
                          merged.append(f"{ws.title}!{c.coordinate}"); continue
                      if not c.has_style:
                          continue
                      fill = resolve(c.fill.fgColor, theme, idx) if c.fill is not None and c.fill.fill_type == "solid" else None
                      font = resolve(c.font.color, theme, idx) if c._style.fontId != 0 and c.font is not None else None
                      if fill or font:
                          cells[f"{ws.title}!{c.coordinate}"] = [fill, font]
          print(json.dumps({"file": p, "cells": cells, "merged": merged}), flush=True)
      except Exception as e:
          print(json.dumps({"file": p, "error": f"{type(e).__name__}: {e}"[:200]}), flush=True)

if __name__ == "__main__":
    main()
