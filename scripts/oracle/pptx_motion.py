#!/usr/bin/env python3
"""TT76 test-only oracle: transitions + main-sequence effects of every slide, read with lxml (independent of Fusion).

Per slide part: the transition (Choice p14 branch and Fallback branch: element name + attributes, spd, p14:dur, advClick,
advTm), the main sequence's effects in order (click group, after-chain, presetID / class / subtype, nodeType, target
spid, delay), whether every p:cTn id is unique, and every spTgt / bldP spid that names no shape on the slide (dangling).
Also whether python-pptx (MIT) opens the package.

    python3 scripts/oracle/pptx_motion.py a.pptx ...   → JSON {file: {pptx_ok, slides: {part: {...}}} | {error}}
"""
import json
import re
import sys
import zipfile
import warnings

warnings.filterwarnings("ignore")
from lxml import etree  # noqa: E402

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"
N = {"p": P, "mc": MC, "p14": P14}


def tdesc(t):
    if t is None:
        return None
    kids = [k for k in t if isinstance(k.tag, str)]
    c = kids[0] if kids else None
    return {
        "spd": t.get("spd"), "dur": t.get("{%s}dur" % P14), "advClick": t.get("advClick"), "advTm": t.get("advTm"),
        "child": etree.QName(c).localname if c is not None else None,
        "childNs": "p14" if c is not None and etree.QName(c).namespace == P14 else ("p" if c is not None else None),
        "attrs": dict(c.attrib) if c is not None else {},
    }


def slide_info(xml):
    root = etree.fromstring(xml)
    ids = {e.get("id") for e in root.iter("{%s}cNvPr" % P)}
    out = {"transition": None, "effects": [], "idsUnique": True, "dangling": [], "hasTiming": False}
    for k in root:
        if k.tag == "{%s}transition" % P:
            out["transition"] = {"choice": None, "fallback": tdesc(k), "ac": False}
        elif k.tag == "{%s}AlternateContent" % MC:
            ch = k.find("mc:Choice/p:transition", N)
            fb = k.find("mc:Fallback/p:transition", N)
            if ch is not None or fb is not None:
                out["transition"] = {"choice": tdesc(ch), "fallback": tdesc(fb), "ac": True,
                                     "requires": (k.find("mc:Choice", N).get("Requires") if k.find("mc:Choice", N) is not None else None)}
    timing = root.find("p:timing", N)
    if timing is not None:
        out["hasTiming"] = True
        cids = [c.get("id") for c in timing.iter("{%s}cTn" % P)]
        out["idsUnique"] = len(cids) == len(set(cids))
        out["dangling"] = sorted({e.get("spid") for e in timing.iter() if isinstance(e.tag, str) and etree.QName(e).localname in ("spTgt", "bldP", "bldGraphic", "bldDgm", "bldOleChart") and e.get("spid") not in ids})
        seq = None
        for s in timing.iter("{%s}seq" % P):
            c = s.find("p:cTn", N)
            if c is not None and c.get("nodeType") == "mainSeq":
                seq = c
                break
        if seq is not None:
            for gi, g in enumerate(seq.findall("p:childTnLst/p:par", N)):
                for si, sub in enumerate(g.findall("p:cTn/p:childTnLst/p:par", N)):
                    for ef in sub.findall("p:cTn/p:childTnLst/p:par", N):
                        c = ef.find("p:cTn", N)
                        cond = c.find("p:stCondLst/p:cond", N)
                        tg = next(iter(ef.iter("{%s}spTgt" % P)), None)
                        out["effects"].append({
                            "group": gi, "sub": si, "presetID": c.get("presetID"), "presetClass": c.get("presetClass"),
                            "presetSubtype": c.get("presetSubtype"), "nodeType": c.get("nodeType"),
                            "spid": tg.get("spid") if tg is not None else None,
                            "delay": cond.get("delay") if cond is not None else None,
                            "groupAuto": any(cd.get("evt") == "onBegin" for cd in g.findall("p:cTn/p:stCondLst/p:cond", N)),
                        })
    return out


def main():
    res = {}
    for path in sys.argv[1:]:
        try:
            z = zipfile.ZipFile(path)
            slides = {n: slide_info(z.read(n)) for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)}
            ok = True
            try:
                from pptx import Presentation
                Presentation(path)
            except Exception as e:  # noqa: BLE001
                ok = "%s: %s" % (type(e).__name__, e)
            res[path] = {"pptx_ok": ok, "slides": slides}
        except Exception as e:  # noqa: BLE001
            res[path] = {"error": "%s: %s" % (type(e).__name__, e)}
    print(json.dumps(res))


if __name__ == "__main__":
    main()
