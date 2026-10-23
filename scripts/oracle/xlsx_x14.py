#!/usr/bin/env python3
"""TT66 independent Excel 2010 (x14) conditional-formatting oracle (lxml only; shares no code with src/).

Schemas: [MS-XLSX] Appendix A (fetch with scripts/oracle/fetch-msxlsx-xsd.sh) for the x14 / xm namespaces, combined with
the ECMA-376 transitional sml.xsd (scripts/oracle/fetch-xsd.sh) for the 2006 SpreadsheetML types they import. Microsoft
splits SpreadsheetML into xlsheet.xsd / xlbasictypes.xsd …; those imports are pointed at sml.xsd through a shim schema
that includes sml.xsd and aliases the TWO basic types ECMA keeps in the sharedTypes namespace instead (ST_Xstring,
ST_Guid — both plain restrictions there). Every other import is pointed at the Appendix file with that targetNamespace.
Positive control (TT66): the x14 blocks Excel wrote in POI's NewStyleConditionalFormattings.xlsx and the
simple-monthly-budget.xlsx corpus file validate.

Usage: xlsx_x14.py FILE.xlsx [...]  →  JSON {file: {sheet_part: report}}; report =
  {"x14_valid": [bool per <x14:conditionalFormattings>], "x14_errors": [...],
   "main": [{"type","priority","sqref","formulas","link"}], "x14": [{"type","id","priority","sqref","f","attrs",
   "bar": {...}|None, "icons": {...}|None, "dxf": bool}], "problems": [str]}
problems (structural rules MS-XLSX / ECMA-376 state that a schema cannot express):
  * the worksheet <extLst> is not the last child;  * a main rule's <x14:id> resolves to zero or several x14 rules;
  * duplicate x14 rule ids;  * duplicate priorities among rules that carry one;  * a main-schema formula refers to
    another sheet (a "!" outside string literals — Excel 2007's schema cannot carry it);
  * an x14 rule with no <xm:sqref> in its <x14:conditionalFormatting>.
"""
import json, os, re, sys, zipfile
from lxml import etree

BASE = os.environ.get("OOXML_XSD", "/home/user/tools/xsd")
MS = os.environ.get("MSXLSX_XSD", os.path.join(BASE, "msxlsx"))
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
X14 = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
XM = "http://schemas.microsoft.com/office/excel/2006/main"
SHARED = "http://schemas.openxmlformats.org/officeDocument/2006/sharedTypes"
ALIASES = ["ST_Xstring", "ST_Guid"]

def build():
    out = os.path.join(MS, "built")
    os.makedirs(out, exist_ok=True)
    rel = os.path.relpath(BASE, out)
    ns = {S: "sml-shim.xsd",
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships": rel + "/shared-relationshipReference.xsd",
          "http://schemas.openxmlformats.org/drawingml/2006/main": rel + "/dml-main.xsd"}
    files = sorted(f for f in os.listdir(MS) if f.endswith(".xsd"))
    for f in files:
        m = re.search(r'targetNamespace="([^"]+)"', open(os.path.join(MS, f), encoding="utf-8").read())
        if m: ns.setdefault(m.group(1), f)
    body = "".join('<xsd:simpleType name="%s"><xsd:restriction base="s:%s"/></xsd:simpleType>' % (a, a) for a in ALIASES)
    with open(os.path.join(out, "sml-shim.xsd"), "w") as fh:
        fh.write('<?xml version="1.0"?><xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:s="%s" targetNamespace="%s" '
                 'elementFormDefault="qualified"><xsd:import namespace="%s" schemaLocation="%s/shared-commonSimpleTypes.xsd"/>'
                 '<xsd:include schemaLocation="%s/sml.xsd"/>%s</xsd:schema>' % (SHARED, S, SHARED, rel, rel, body))
    for f in files:
        s = open(os.path.join(MS, f), encoding="utf-8").read(); seen = set()
        def rep(m):
            n = m.group(1)
            if n in seen: return ""
            seen.add(n); return '<xsd:import namespace="%s" schemaLocation="%s"/>' % (n, ns[n])
        with open(os.path.join(out, f), "w", encoding="utf-8") as fh:
            fh.write(re.sub(r'<xsd:import namespace="([^"]+)" schemaLocation="[^"]+"\s*/>', rep, s))
    return etree.XMLSchema(etree.parse(os.path.join(out, "5_4_spreadsheetml_2009_9_main.xsd")))

def cross_sheet(f):
    return "!" in re.sub(r'"(?:[^"]|"")*"', "", f or "")

def q(ns, n): return "{%s}%s" % (ns, n)

def report(xml, sch):
    root = etree.fromstring(xml)
    r = {"x14_valid": [], "x14_errors": [], "main": [], "x14": [], "problems": []}
    kids = [k for k in root if isinstance(k.tag, str)]
    lst = [k for k in kids if k.tag == q(S, "extLst")]
    if lst and kids[-1] is not lst[-1]: r["problems"].append("worksheet extLst is not the last child")
    for cf in root.findall(q(S, "conditionalFormatting")):
        for rule in cf.findall(q(S, "cfRule")):
            link = [e.text.strip() for e in rule.iter(q(X14, "id")) if e.text]
            fs = [e.text or "" for e in rule.findall(q(S, "formula"))]
            r["main"].append({"type": rule.get("type"), "priority": rule.get("priority"), "sqref": cf.get("sqref"), "formulas": fs, "link": link[0] if link else None})
            if any(cross_sheet(f) for f in fs): r["problems"].append("main cfRule with a cross-sheet formula: %s" % fs)
    for l in lst:
        for cfs in l.iter(q(X14, "conditionalFormattings")):
            ok = sch.validate(cfs); r["x14_valid"].append(ok)
            if not ok: r["x14_errors"].append(str(sch.error_log.last_error))
            for cfx in cfs.findall(q(X14, "conditionalFormatting")):
                sq = cfx.find(q(XM, "sqref"))
                if sq is None or not (sq.text or "").strip(): r["problems"].append("x14 conditionalFormatting without xm:sqref")
                for rule in cfx.findall(q(X14, "cfRule")):
                    bar = rule.find(q(X14, "dataBar")); ic = rule.find(q(X14, "iconSet"))
                    col = lambda e, n: (e.find(q(X14, n)).get("rgb") if e is not None and e.find(q(X14, n)) is not None else None)
                    cfvo = lambda e: [[c.get("type"), (c.findtext(q(XM, "f")) or None), c.get("gte")] for c in e.findall(q(X14, "cfvo"))]
                    r["x14"].append({
                        "type": rule.get("type"), "id": rule.get("id"), "priority": rule.get("priority"),
                        "sqref": (sq.text or "").strip() if sq is not None else None,
                        "f": [e.text or "" for e in rule.findall(q(XM, "f"))],
                        "attrs": {k: v for k, v in rule.attrib.items() if k not in ("id", "priority", "type")},
                        "bar": None if bar is None else {"attrs": dict(bar.attrib), "cfvo": cfvo(bar), "border": col(bar, "borderColor"), "neg": col(bar, "negativeFillColor"), "axis": col(bar, "axisColor"), "fill": col(bar, "fillColor")},
                        "icons": None if ic is None else {"attrs": dict(ic.attrib), "cfvo": cfvo(ic), "custom": [[c.get("iconSet"), c.get("iconId")] for c in ic.findall(q(X14, "cfIcon"))]},
                        "dxf": rule.find(q(X14, "dxf")) is not None})
    ids = [x["id"] for x in r["x14"] if x["id"]]
    up = [i.upper() for i in ids]
    if len(set(up)) != len(up): r["problems"].append("duplicate x14 rule ids")
    for m in r["main"]:
        if m["link"] and up.count(m["link"].upper()) != 1: r["problems"].append("x14:id %s resolves to %d rules" % (m["link"], up.count(m["link"].upper())))
    pr = [m["priority"] for m in r["main"]] + [x["priority"] for x in r["x14"] if x["priority"]]
    if len(set(pr)) != len(pr): r["problems"].append("duplicate priorities %s" % sorted(pr, key=lambda p: int(p or 0)))
    return r

def main():
    sch = build()
    res = {}
    for path in sys.argv[1:]:
        z = zipfile.ZipFile(path)
        res[path] = {n: report(z.read(n), sch) for n in z.namelist() if re.match(r"xl/worksheets/[^/]+\.xml$", n, re.I)}
    print(json.dumps(res))

if __name__ == "__main__":
    main()
