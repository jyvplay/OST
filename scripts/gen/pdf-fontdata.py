#!/usr/bin/env python3
"""TT52 — generate src/lib/pdf/fontdata.ts (data only, no code) from permissive sources, fetched via the GitHub API:

  * Adobe Glyph List + AGLFN + ZapfDingbats list — adobe-type-tools/agl-aglfn (BSD-3-Clause)
  * the 14 standard-font AFM metrics — Adobe Core14 AFMs as shipped by apache/pdfbox (each file's header grants:
    "may be used, copied, and distributed for any purpose and without charge"; checked below)
  * StandardEncoding / Symbol / ZapfDingbats built-in encodings — the AFM "C <code>" fields of those fonts
  * CFF standard strings — Adobe TN 5176 Appendix A, list taken from fonttools/fonttools (MIT)
  * WinAnsiEncoding / MacRomanEncoding — ISO 32000-2 Annex D, derived here from cp1252 / mac_roman + AGLFN names, with
    the Annex D deviations applied (bullet at undefined WinAnsi codes, currency at Mac 0xDB, no Apple logo, etc.)

usage: python3 scripts/gen/pdf-fontdata.py   (needs `gh auth token` or GITHUB_TOKEN)
"""
import base64, json, os, subprocess, sys, urllib.request

PDFBOX_REF = os.environ.get("PDFBOX_REF", "trunk")
AGL_REF = os.environ.get("AGL_REF", "master")
TOKEN = os.environ.get("GITHUB_TOKEN") or subprocess.run(["gh", "auth", "token"], capture_output=True, text=True).stdout.strip()

def get(repo, path, ref):
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/contents/{path}?ref={ref}", headers={"Authorization": f"token {TOKEN}", "Accept": "application/vnd.github.raw"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("latin-1")

FONTS = ["Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique", "Helvetica", "Helvetica-Bold", "Helvetica-Oblique",
         "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Symbol", "ZapfDingbats"]

def parse_afm(text):
    head, glyphs, kern = {}, [], None
    in_metrics = False
    for line in text.splitlines():
        if line.startswith("StartCharMetrics"): in_metrics = True; continue
        if line.startswith("EndCharMetrics"): in_metrics = False; continue
        if in_metrics:
            if not line.strip(): continue
            f = {}
            for part in line.split(";"):
                t = part.strip().split()
                if t: f[t[0]] = t[1:]
            glyphs.append((int(f["C"][0]), f["N"][0], int(round(float(f["WX"][0])))))
        else:
            t = line.split(None, 1)
            if len(t) == 2 and t[0] in ("FontBBox", "Ascender", "Descender", "CapHeight", "XHeight", "ItalicAngle", "IsFixedPitch", "Weight"): head[t[0]] = t[1].strip()
    return head, glyphs

def main():
    afms = {}; copyrights = set()
    for f in FONTS:
        t = get("apache/pdfbox", f"pdfbox/src/main/resources/org/apache/pdfbox/resources/afm/{f}.afm", PDFBOX_REF)
        assert "Adobe Systems Incorporated" in t, f"unexpected header in {f}.afm"
        afms[f] = parse_afm(t)
        copyrights.add(next(l[8:].strip() for l in t.splitlines() if l.startswith("Comment Copyright")))
    lic_pdfbox = get("apache/pdfbox", "LICENSE.txt", PDFBOX_REF)
    i = lic_pdfbox.index("   This file and the 14 PostScript(R) AFM files it accompanies")
    grant = lic_pdfbox[i:lic_pdfbox.index("obligation to support the use of the AFM files.", i) + len("obligation to support the use of the AFM files.")]
    lic = get("adobe-type-tools/agl-aglfn", "LICENSE.md", AGL_REF)
    assert "BSD" in lic or "Redistribution and use" in lic
    agl = {}; zapf_names = {}
    for line in get("adobe-type-tools/agl-aglfn", "glyphlist.txt", AGL_REF).splitlines():
        if line.startswith("#") or ";" not in line: continue
        name, cps = line.split(";")[:2]
        agl[name] = "".join(chr(int(c, 16)) for c in cps.split())
    for line in get("adobe-type-tools/agl-aglfn", "zapfdingbats.txt", AGL_REF).splitlines():
        if line.startswith("#") or ";" not in line: continue
        name, cp = line.split(";")[:2]
        zapf_names[name] = chr(int(cp, 16))  # a1..a191 → dingbat code points: ZapfDingbats fonts only (not general AGL)
    aglfn = {}
    for line in get("adobe-type-tools/agl-aglfn", "aglfn.txt", AGL_REF).splitlines():
        if line.startswith("#") or ";" not in line: continue
        cp, name = line.split(";")[:2]
        aglfn[chr(int(cp, 16))] = name

    def enc_from_afm(font):
        e = [None] * 256
        for c, n, _ in afms[font][1]:
            if 0 <= c < 256: e[c] = n
        return e
    standard = enc_from_afm("Helvetica")
    symbol = enc_from_afm("Symbol")
    zapf = enc_from_afm("ZapfDingbats")

    def from_codec(codec):
        e = [None] * 256
        for c in range(32, 256):
            try: ch = bytes([c]).decode(codec)
            except UnicodeDecodeError: continue
            e[c] = aglfn.get(ch)
        return e
    win = from_codec("cp1252")
    win[0xA0] = "space"; win[0xAD] = "hyphen"           # Annex D: WinAnsi 0xA0 = space, 0xAD = hyphen
    for c in (0x7F, 0x81, 0x8D, 0x8F, 0x90, 0x9D): win[c] = "bullet"   # Annex D note: bullet also at these codes
    win[0x7F] = "bullet"
    mac = from_codec("mac_roman")
    mac[0xDB] = "currency"; mac[0xF0] = None; mac[0xCA] = "space"      # Annex D MacRomanEncoding
    for c in range(32, 127):
        if win[c] is None: win[c] = standard[c] or aglfn.get(chr(c))
        if mac[c] is None: mac[c] = aglfn.get(chr(c))
    # ASCII names in Annex D: 0x27 quotesingle / 0x60 grave for Win/Mac (Standard has quoteright/quoteleft)
    # all glyph names: union, shared across the width tables
    names = sorted({n for f in FONTS for _, n, _ in afms[f][1]})
    idx = {n: i for i, n in enumerate(names)}
    out = ["/** GENERATED by scripts/gen/pdf-fontdata.py — do not edit. Sources: Adobe Glyph List + AGLFN (BSD-3-Clause,",
           " *  adobe-type-tools/agl-aglfn); Adobe Core14 AFM metrics (free redistribution grant in each AFM, via apache/pdfbox);",
           " *  encodings per ISO 32000-2 Annex D.",
           " *",
           " *  MODIFIED: only the glyph names, advance widths, FontBBox, Ascender, Descender, CapHeight, XHeight, ItalicAngle,",
           " *  IsFixedPitch, Weight and the built-in encodings were extracted from the 14 Adobe AFM files and re-encoded below.",
           " *  Copyright notices of the AFM files:"] + [f" *    {c}" for c in sorted(copyrights)] + [
           " *  Licence of the AFM files (verbatim, from apache/pdfbox LICENSE.txt):"] + [" * " + l for l in grant.splitlines()] + [" */"]
    out.append("export const GLYPH_NAMES = " + json.dumps(" ".join(names)) + ";")
    fonts = {}
    for f in FONTS:
        head, glyphs = afms[f]
        w = [0] * len(names)
        for _, n, wx in glyphs: w[idx[n]] = wx
        bbox = [int(x) for x in head["FontBBox"].split()]
        fonts[f] = {"bbox": bbox, "asc": int(head.get("Ascender", bbox[3])), "desc": int(head.get("Descender", bbox[1])),
                    "cap": int(head.get("CapHeight", bbox[3])), "xh": int(head.get("XHeight", 0)), "italic": float(head.get("ItalicAngle", 0)),
                    "fixed": head.get("IsFixedPitch") == "true", "bold": head.get("Weight", "") in ("Bold", "Black"),
                    "w": base64.b64encode(b"".join(x.to_bytes(2, "little") for x in w)).decode()}
    out.append("export const STD14: Record<string, { bbox: number[]; asc: number; desc: number; cap: number; xh: number; italic: number; fixed: boolean; bold: boolean; w: string }> = " + json.dumps(fonts) + ";")
    enc = lambda e: json.dumps(" ".join(x or "." for x in e))
    out.append("export const ENC_STANDARD = " + enc(standard) + ";")
    out.append("export const ENC_WINANSI = " + enc(win) + ";")
    out.append("export const ENC_MACROMAN = " + enc(mac) + ";")
    out.append("export const ENC_SYMBOL = " + enc(symbol) + ";")
    out.append("export const ENC_ZAPF = " + enc(zapf) + ";")
    # AGL as "name hex;" pairs (multi-code-point values joined with '_')
    agl_s = ";".join(f"{n} {'_'.join('%04X' % ord(c) for c in v)}" for n, v in sorted(agl.items()))
    out.append("export const AGL = " + json.dumps(agl_s) + ";")
    out.append("export const AGL_ZAPF = " + json.dumps(";".join(f"{n} {'%04X' % ord(v)}" for n, v in sorted(zapf_names.items()))) + ";")
    # CFF standard strings (Adobe TN 5176 Appendix A) — the list as published in fontTools (MIT), parsed, not executed
    import ast
    src = get("fonttools/fonttools", "Lib/fontTools/cffLib/__init__.py", os.environ.get("FONTTOOLS_REF", "main"))
    i = src.index("cffStandardStrings = [")
    std = ast.literal_eval(src[src.index("[", i):src.index("]", i) + 1])
    assert len(std) == 391 and std[0] == ".notdef" and std[390] == "Semibold", len(std)
    out.append("/** CFF standard strings, SID 0–390 (Adobe TN 5176 Appendix A; list via fontTools, MIT) */")
    out.append("export const CFF_STD = " + json.dumps(" ".join(std)) + ";")
    dst = os.path.join(os.path.dirname(__file__), "../../src/lib/pdf/fontdata.ts")
    open(dst, "w").write("\n".join(out) + "\n")
    print("wrote", dst, os.path.getsize(dst), "bytes;", len(names), "glyph names;", len(agl), "AGL entries")

if __name__ == "__main__":
    main()
