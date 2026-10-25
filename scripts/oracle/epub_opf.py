#!/usr/bin/env python3
"""TT75 oracle: an independent EPUB package reader on lxml (BSD) + the standard library, for differential testing of
src/lib/epub/epub-core.ts. Input: EPUB files. Output JSON {file: {title, creators, identifier, version, direction,
spine: [[path, linear]], manifest: [path...], toc: [[depth, label, href]], layout} | {error}}.
Written independently from the TS code (XPath over namespaces, posixpath for paths, urllib for percent-decoding)."""
import json, sys, zipfile, posixpath, re
from urllib.parse import unquote
from lxml import etree

NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container", "o": "http://www.idpf.org/2007/opf",
      "dc": "http://purl.org/dc/elements/1.1/", "x": "http://www.w3.org/1999/xhtml", "e": "http://www.idpf.org/2007/ops",
      "n": "http://www.daisy.org/z3986/2005/ncx/"}
PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, recover=False)

def ws(s): return re.sub(r"[ \t\r\n]+", " ", s or "").strip()

def resolve(base_file, href):
    href = href.strip()
    if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", href) or href.startswith("//"): return None
    frag = ""
    if "#" in href: href, frag = href.split("#", 1)
    href = href.split("?", 1)[0]
    if not href: return base_file, unquote(frag)
    segs = [] if href.startswith("/") else base_file.split("/")[:-1]
    for s in href.split("/"):
        s = unquote(s)
        if s in ("", "."): continue
        if s == "..":
            if segs: segs.pop()
            continue
        segs.append(s)
    return "/".join(segs), unquote(frag)

def text(el): return ws("".join(el.itertext())) or ""

def main():
    out = {}
    for f in sys.argv[1:]:
        try:
            z = zipfile.ZipFile(f)
            cont = etree.fromstring(z.read("META-INF/container.xml"), PARSER)
            rfs = cont.xpath("//c:rootfile", namespaces=NS)
            rf = next((r for r in rfs if r.get("media-type") == "application/oebps-package+xml"), rfs[0])
            opf_path = resolve("", rf.get("full-path"))[0]
            opf = etree.fromstring(z.read(opf_path), PARSER)
            uid = opf.get("unique-identifier")
            idents = opf.xpath("//o:metadata//dc:identifier", namespaces=NS)
            ident = next((i for i in idents if i.get("id") == uid), idents[0] if idents else None)
            titles = [text(t) for t in opf.xpath("//o:metadata//dc:title", namespaces=NS)]
            titles = [t for t in titles if t]
            man = {}
            for it in opf.xpath("//o:manifest/o:item", namespaces=NS):
                if it.get("id") in man or it.get("href") is None: continue
                r = resolve(opf_path, it.get("href"))
                if r: man[it.get("id")] = (r[0], (it.get("media-type") or "").lower().strip(), (it.get("properties") or "").split())
            spine_el = opf.find("o:spine", NS)
            spine = [[man[i.get("idref")][0], i.get("linear") != "no"] for i in spine_el.findall("o:itemref", NS) if i.get("idref") in man]
            layout = next((ws(m.text) for m in opf.xpath("//o:metadata/o:meta[@property='rendition:layout']", namespaces=NS) if not m.get("refines")), "reflowable")
            toc = []
            nav = next((v for v in man.values() if "nav" in v[2]), None)
            if nav:
                try:
                    doc = etree.fromstring(re.sub(rb"<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?>", b"", z.read(nav[0])), PARSER)
                    navs = [n for n in doc.iter("{%s}nav" % NS["x"]) if "toc" in (n.get("{%s}type" % NS["e"]) or "").split()]
                    def walk(ol, d):
                        for li in ol.findall("x:li", NS):
                            head = next((k for k in li if k.tag in ("{%s}a" % NS["x"], "{%s}span" % NS["x"])), None)
                            if head is None: continue
                            label = text(head)
                            if not label:
                                img = next((k for k in head.iter() if etree.QName(k).localname in ("img", "image", "svg")), None)
                                label = ws((img.get("alt") or img.get("title") if img is not None else None) or head.get("title") or "") or ""
                            href = None
                            if head.tag == "{%s}a" % NS["x"] and head.get("href") is not None:
                                r = resolve(nav[0], head.get("href")); href = (r[0] + ("#" + r[1] if r[1] else "")) if r else head.get("href")
                            toc.append([d, label or "(untitled)", href])
                            sub = li.find("x:ol", NS)
                            if sub is not None: walk(sub, d + 1)
                    if navs:
                        ol = navs[0].find("x:ol", NS)
                        if ol is None: ol = next(iter(navs[0].iter("{%s}ol" % NS["x"])), None)
                        if ol is not None: walk(ol, 0)
                except Exception:
                    toc = []
            if not toc:
                ncx_id = spine_el.get("toc")
                ncx = man.get(ncx_id) if ncx_id else next((v for v in man.values() if v[1] == "application/x-dtbncx+xml"), None)
                if ncx:
                    doc = etree.fromstring(re.sub(rb"<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?>", b"", z.read(ncx[0])), PARSER)
                    def walk_n(e, d):
                        for np in e.findall("n:navPoint", NS):
                            lab = np.find("n:navLabel/n:text", NS); c = np.find("n:content", NS)
                            r = resolve(ncx[0], c.get("src")) if c is not None and c.get("src") else None
                            toc.append([d, (text(lab) if lab is not None else "") or "(untitled)", (r[0] + ("#" + r[1] if r[1] else "")) if r else None])
                            walk_n(np, d + 1)
                    nm = doc.find("n:navMap", NS)
                    if nm is not None: walk_n(nm, 0)
            ppd = spine_el.get("page-progression-direction")
            out[f] = {"title": titles[0] if titles else "Untitled", "creators": [c for c in (text(x) for x in opf.xpath("//o:metadata//dc:creator", namespaces=NS)) if c],
                      "identifier": "".join(ident.itertext()).strip() if ident is not None else "", "version": opf.get("version") or "",
                      "direction": ppd if ppd in ("ltr", "rtl") else "default", "spine": spine, "manifest": sorted(v[0] for v in man.values()), "toc": toc, "layout": layout}
        except Exception as e:  # noqa: BLE001
            out[f] = {"error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out))

if __name__ == "__main__":
    main()
