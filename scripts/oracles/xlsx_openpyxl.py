"""Independent OOXML oracle using openpyxl 3.1 (PyPI).

  read <file.xlsx>   -> JSON dump of what openpyxl sees in OUR writer's output
  write <file.xlsx>  -> author a styled workbook with openpyxl for OUR reader
                        (includes a shared formula block and an array formula,
                        injected at the XML level because openpyxl does not
                        author shared formulas itself)
"""
import json, sys, zipfile, shutil, os, tempfile
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment


def rgb(c):
    if c is None or c.type != "rgb" or c.rgb in (None, "00000000"):
        return None
    return "#" + str(c.rgb)[-6:].lower()


def read(path):
    wb = openpyxl.load_workbook(path)  # formulas as text
    wbv = openpyxl.load_workbook(path, data_only=True)  # cached values
    out = {"sheets": []}
    for ws in wb.worksheets:
        wv = wbv[ws.title]
        cells = {}
        for row in ws.iter_rows():
            for c in row:
                f = c.font
                v = c.value
                if hasattr(v, "text"):  # ArrayFormula
                    v = {"array": v.text, "ref": v.ref}
                rec = {
                    "value": v if isinstance(v, (int, float, str, bool, dict)) or v is None else str(v),
                    "cached": wv[c.coordinate].value if not hasattr(wv[c.coordinate].value, "isoformat") else str(wv[c.coordinate].value),
                    "bold": bool(f.b), "italic": bool(f.i), "underline": f.u,
                    "color": rgb(f.color) if f.color is not None else None,
                    "fill": rgb(c.fill.fgColor) if c.fill.fill_type == "solid" else None,
                    "numFmt": c.number_format,
                    "align": c.alignment.horizontal, "wrap": bool(c.alignment.wrap_text),
                }
                if c.value is None and not (rec["bold"] or rec["fill"] or rec["numFmt"] != "General"):
                    continue
                cells[c.coordinate] = rec
        widths = {k: d.width for k, d in ws.column_dimensions.items() if d.customWidth}
        out["sheets"].append({"title": ws.title, "cells": cells, "widths": widths, "freeze": ws.freeze_panes})
    print(json.dumps(out, default=str))


def write(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Data"
    ws["A1"] = "Item"; ws["A1"].font = Font(bold=True, italic=True, color="FF1F4E79")
    ws["B1"] = "Price"; ws["B1"].fill = PatternFill("solid", fgColor="FFFFF2CC")
    ws["B1"].alignment = Alignment(horizontal="center", wrap_text=True)
    for i, (n, p) in enumerate([("a", 1.5), ("b", 2.25), ("c", 4)], start=2):
        ws[f"A{i}"] = n; ws[f"B{i}"] = p; ws[f"B{i}"].number_format = "$#,##0.00"
        ws[f"C{i}"] = f"=B{i}*2"  # replaced by a shared formula block below
    ws["D2"] = "=TEXTJOIN(\",\",TRUE,A2:A4)"  # openpyxl writes it verbatim; we prefix in XML below
    ws["E1"].font = Font(underline="single")  # styled blank
    ws["F2"] = 45361; ws["F2"].number_format = "yyyy-mm-dd"
    ws.column_dimensions["A"].width = 20
    ws.freeze_panes = "A2"
    tmp = path + ".tmp"
    wb.save(tmp)
    # inject Excel-style shared + array formulas and the _xlfn prefix at the XML level
    zin = zipfile.ZipFile(tmp)
    zout = zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED)
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename == "xl/worksheets/sheet1.xml":
            x = data.decode()
            x = x.replace('<f>B2*2</f>', '<f t="shared" ref="C2:C4" si="0">B2*2</f>')
            x = x.replace('<f>B3*2</f>', '<f t="shared" si="0"/>').replace('<f>B4*2</f>', '<f t="shared" si="0"/>')
            x = x.replace('TEXTJOIN(', '_xlfn.TEXTJOIN(')
            # array formula at G2:G4 with stale cached children that must not block the re-spill
            x = x.replace('</row><row r="3"', '<c r="G2"><f t="array" ref="G2:G4">B2:B4*10</f><v>15</v></c></row><row r="3"', 1)
            x = x.replace('</row><row r="4"', '<c r="G3"><v>999</v></c></row><row r="4"', 1)
            x = x.replace('</row></sheetData>', '<c r="G4"><v>999</v></c></row></sheetData>', 1)
            data = x.encode()
        zout.writestr(item, data)
    zout.close(); zin.close(); os.remove(tmp)
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    {"read": read, "write": write}[sys.argv[1]](sys.argv[2])
