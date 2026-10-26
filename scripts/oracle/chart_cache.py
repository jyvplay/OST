"""TT73 oracle: the series values Excel cached in every chart part of a workbook (c:numCache / c:strCache, ECMA-376
§21.2.2), read independently of the app with lxml. Reads .xlsx paths on stdin, prints one JSON line per chart part:
{"file", "part", "series": [{"val_f", "vals": {idx: number}, "ptCount", "cat_f", "cats": {idx: text}, "tx_f", "tx"}]}."""
import json, sys, zipfile
from lxml import etree
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS = {"c": C}
def cache(el):
    if el is None: return None, {}, 0
    f = el.find(".//c:f", NS)
    pts = {}
    for c in el.findall(".//c:numCache", NS) + el.findall(".//c:strCache", NS) + el.findall(".//c:numLit", NS) + el.findall(".//c:strLit", NS):
        pc = c.find("c:ptCount", NS)
        for p in c.findall("c:pt", NS):
            v = p.find("c:v", NS)
            if v is not None and v.text is not None: pts[int(p.get("idx"))] = v.text
        n = int(pc.get("val")) if pc is not None else len(pts)
        return (f.text if f is not None else None), pts, n
    return (f.text if f is not None else None), pts, 0
for line in sys.stdin:
    path = line.strip()
    if not path: continue
    try: z = zipfile.ZipFile(path)
    except Exception as e: print(json.dumps({"file": path, "error": str(e)})); continue
    for name in z.namelist():
        if not (name.startswith("xl/charts/chart") and name.endswith(".xml")): continue
        try: root = etree.fromstring(z.read(name))
        except Exception as e: print(json.dumps({"file": path, "part": name, "error": str(e)})); continue
        out = []
        for ser in root.iter("{%s}ser" % C):
            vf, vals, n = cache(ser.find("c:val", NS) if ser.find("c:val", NS) is not None else ser.find("c:yVal", NS))
            cf, cats, _ = cache(ser.find("c:cat", NS) if ser.find("c:cat", NS) is not None else ser.find("c:xVal", NS))
            tf, tx, _ = cache(ser.find("c:tx", NS))
            out.append({"val_f": vf, "vals": vals, "ptCount": n, "cat_f": cf, "cats": cats, "tx_f": tf, "tx": tx.get(0)})
        print(json.dumps({"file": path, "part": name, "series": out}), flush=True)
