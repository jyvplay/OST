#!/usr/bin/env python3
"""TT62 independent OOXML schema-conformance oracle (lxml + the ECMA-376 transitional XSDs; shares no code with src/).

The schemas are the ECMA-376 transitional set as shipped in python-docx's ref/xsd (MIT repository; the XSDs are Ecma's,
freely usable). They are test-only data and are NOT committed: fetch them with
    scripts/oracle/fetch-xsd.sh            (→ /home/user/tools/xsd, or $OOXML_XSD)

Usage: ooxml_xsd.py FILE.docx|.xlsx|.pptx [...]
Prints JSON {file: {"parts": {part: [error, ...]}, "checked": n, "skipped": [part, ...], "ok": bool}}.

Per part, by its content type in [Content_Types].xml (Override, else Default by extension):
  * Markup Compatibility (ECMA-376 Part 3) is applied first, as a consumer that understands only the 2006 namespaces
    would: elements / attributes in namespaces listed in mc:Ignorable are removed (with their subtree);
    mc:AlternateContent is replaced by the children of its first mc:Choice whose Requires namespaces are all understood,
    else by mc:Fallback, else removed; mc:* attributes are dropped. Non-ignorable unknown namespaces are LEFT IN, so the
    schema rejects them (that is what Office does: an un-understood, non-ignorable namespace is an error).
  * the processed part is validated against one combined schema (wml + sml + dml + shared + vml + opc).
Parts whose type has no schema here (core properties use Dublin Core schemas we do not have, images, binaries,
customXml items, vbaProject…) are listed under "skipped".

ONE documented schema erratum is tolerated: sml.xsd declares SpreadsheetML <t> (CT_Rst / CT_RElt text) as the simple type
ST_Xstring, which forbids attributes, yet Excel itself writes <t xml:space="preserve"> whenever text has edge spaces (TT62
corpus check: 37 Excel-authored POI files, plus LibreOffice and ONLYOFFICE ones). That one attribute on that one element
is removed before validation and counted in "errata"; everything else stays strict.
"""
import json
import os
import posixpath
import sys
import zipfile

from lxml import etree

XSD = os.environ.get("OOXML_XSD", "/home/user/tools/xsd")
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"

UNDERSTOOD = {
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://schemas.openxmlformats.org/presentationml/2006/main",
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "http://schemas.openxmlformats.org/officeDocument/2006/sharedTypes",
    "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
    "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes",
    "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties",
    "http://schemas.openxmlformats.org/schemaLibrary/2006/main",
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "http://schemas.openxmlformats.org/drawingml/2006/chartDrawing",
    "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "http://schemas.openxmlformats.org/drawingml/2006/lockedCanvas",
    "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "http://schemas.openxmlformats.org/package/2006/content-types",
    "http://schemas.openxmlformats.org/package/2006/relationships",
    "urn:schemas-microsoft-com:vml",
    "urn:schemas-microsoft-com:office:office",
    "urn:schemas-microsoft-com:office:word",
    "urn:schemas-microsoft-com:office:excel",
    "urn:schemas-microsoft-com:office:powerpoint",
    "http://www.w3.org/XML/1998/namespace",
}

SCHEMA_FILES = ["wml.xsd", "sml.xsd", "pml.xsd", "dml-main.xsd", "dml-chart.xsd", "dml-chartDrawing.xsd", "dml-diagram.xsd",
                "dml-picture.xsd", "dml-lockedCanvas.xsd", "dml-spreadsheetDrawing.xsd", "dml-wordprocessingDrawing.xsd",
                "shared-documentPropertiesExtended.xsd", "shared-documentPropertiesCustom.xsd", "vml-main.xsd",
                "vml-officeDrawing.xsd", "vml-wordprocessingDrawing.xsd", "vml-spreadsheetDrawing.xsd",
                "opc/opc-contentTypes.xsd", "opc/opc-relationships.xsd"]

_schema = None


def schema():
    global _schema
    if _schema is None:
        seen = {}
        for f in SCHEMA_FILES:
            t = etree.parse(os.path.join(XSD, f)).getroot().get("targetNamespace")
            seen.setdefault(t, f)
        # the xml: namespace (xml:space, xml:lang) — a minimal from-scratch declaration, imported first so it wins
        xmlxsd = os.path.join(XSD, "_xml.xsd")
        if not os.path.exists(xmlxsd):
            with open(xmlxsd, "w") as fh:
                fh.write('<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="http://www.w3.org/XML/1998/namespace">'
                         '<xsd:attribute name="space"><xsd:simpleType><xsd:restriction base="xsd:NCName"><xsd:enumeration value="default"/>'
                         '<xsd:enumeration value="preserve"/></xsd:restriction></xsd:simpleType></xsd:attribute>'
                         '<xsd:attribute name="lang" type="xsd:language"/><xsd:attribute name="base" type="xsd:anyURI"/>'
                         '<xsd:attribute name="id" type="xsd:ID"/></xsd:schema>')
        imports = '<xsd:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="%s"/>' % xmlxsd
        imports += "".join('<xsd:import namespace="%s" schemaLocation="%s"/>' % (ns, os.path.join(XSD, f)) for ns, f in seen.items())
        wrapper = '<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:fusion:ooxml-all" elementFormDefault="qualified">%s</xsd:schema>' % imports
        _schema = etree.XMLSchema(etree.fromstring(wrapper.encode(), base_url=os.path.join(XSD, "_wrapper.xsd")))
    return _schema


# content type -> validate? (True = schema-validated part)
VALIDATED_SUFFIX = (
    "wordprocessingml.document.main+xml", "wordprocessingml.template.main+xml", "wordprocessingml.styles+xml",
    "wordprocessingml.numbering+xml", "wordprocessingml.footnotes+xml", "wordprocessingml.endnotes+xml",
    "wordprocessingml.header+xml", "wordprocessingml.footer+xml", "wordprocessingml.comments+xml",
    "wordprocessingml.settings+xml", "wordprocessingml.fontTable+xml", "wordprocessingml.webSettings+xml",
    "spreadsheetml.sheet.main+xml", "spreadsheetml.template.main+xml", "spreadsheetml.worksheet+xml",
    "spreadsheetml.styles+xml", "spreadsheetml.sharedStrings+xml", "spreadsheetml.chartsheet+xml",
    "spreadsheetml.comments+xml", "spreadsheetml.table+xml", "spreadsheetml.pivotTable+xml",
    "spreadsheetml.pivotCacheDefinition+xml", "spreadsheetml.pivotCacheRecords+xml", "spreadsheetml.calcChain+xml",
    "drawing+xml", "drawingml.chart+xml", "officedocument.extended-properties+xml",
    "relationships+xml", "theme+xml",
    # TT73: PresentationML (pml.xsd) — the deck, slides, layouts, masters, notes, handouts, properties, comments
    "presentationml.presentation.main+xml", "presentationml.template.main+xml", "presentationml.slideshow.main+xml",
    "presentationml.slide+xml", "presentationml.slideLayout+xml", "presentationml.slideMaster+xml",
    "presentationml.notesSlide+xml", "presentationml.notesMaster+xml", "presentationml.handoutMaster+xml",
    "presentationml.presProps+xml", "presentationml.viewProps+xml", "presentationml.tableStyles+xml",
    "presentationml.commentAuthors+xml", "presentationml.comments+xml",
)


def mce(el, ignorable=frozenset(), understood=UNDERSTOOD):
    """apply Markup Compatibility processing in place to el's subtree; returns the list of nodes replacing el"""
    ig = set(ignorable)
    v = el.get("{%s}Ignorable" % MC)
    if v:
        for pre in v.split():
            ns = el.nsmap.get(pre)
            if ns:
                ig.add(ns)
    ns_of = lambda tag: etree.QName(tag).namespace
    if isinstance(el.tag, str) and ns_of(el.tag) == MC and etree.QName(el).localname == "AlternateContent":
        chosen = None
        for ch in el:
            if not isinstance(ch.tag, str):
                continue
            ln = etree.QName(ch).localname
            if ln == "Choice":
                req = [ch.nsmap.get(p) or el.nsmap.get(p) for p in (ch.get("Requires") or "").split()]
                if req and all(r in understood for r in req):
                    chosen = ch
                    break
            elif ln == "Fallback":
                chosen = ch
                break
        out = []
        if chosen is not None:
            for k in list(chosen):
                out.extend(mce(k, frozenset(ig), understood))
        return out
    if isinstance(el.tag, str) and ns_of(el.tag) in ig:
        return []
    for a in list(el.attrib):
        ans = ns_of(a) if a.startswith("{") else None
        if ans == MC or (ans and ans in ig):
            del el.attrib[a]
    for ch in list(el):
        if not isinstance(ch.tag, str):
            continue
        repl = mce(ch, frozenset(ig), understood)
        if len(repl) == 1 and repl[0] is ch:
            continue
        parent = ch.getparent()
        idx = parent.index(ch)
        tail = ch.tail
        parent.remove(ch)
        for j, r in enumerate(repl):
            parent.insert(idx + j, r)
        if tail and tail.strip():
            pass
    return [el]


def content_types(z):
    ct = etree.fromstring(z.read("[Content_Types].xml"))
    over, dflt = {}, {}
    for e in ct:
        ln = etree.QName(e).localname
        if ln == "Override":
            over[e.get("PartName").lstrip("/")] = e.get("ContentType")
        elif ln == "Default":
            dflt[e.get("Extension").lower()] = e.get("ContentType")
    return over, dflt


def check(path):
    z = zipfile.ZipFile(path)
    over, dflt = content_types(z)
    res = {"parts": {}, "checked": 0, "skipped": [], "errata": 0}
    sch = schema()
    for name in z.namelist():
        if name.endswith("/"):
            continue
        if name == "[Content_Types].xml":
            ctype = "content-types"
        else:
            ctype = over.get(name) or dflt.get(name.rsplit(".", 1)[-1].lower() if "." in posixpath.basename(name) else "", "")
        if ctype != "content-types" and not ctype.endswith(VALIDATED_SUFFIX):
            res["skipped"].append(name)
            continue
        try:
            root = etree.fromstring(z.read(name))
        except etree.XMLSyntaxError as e:
            res["parts"][name] = ["not well-formed: %s" % e]
            res["checked"] += 1
            continue
        kept = mce(root)
        if kept:
            for t in kept[0].iter("{%s}t" % SML):
                if XML_SPACE in t.attrib:
                    del t.attrib[XML_SPACE]
                    res["errata"] += 1
        errs = []
        if not kept:
            errs.append("root removed by markup compatibility processing")
        else:
            doc = etree.ElementTree(kept[0])
            if not sch.validate(doc):
                for e in sch.error_log:
                    errs.append("line %d: %s" % (e.line, e.message))
        res["parts"][name] = errs[:25] + (["… %d more" % (len(errs) - 25)] if len(errs) > 25 else [])
        res["checked"] += 1
    res["ok"] = all(not v for v in res["parts"].values())
    return res


if __name__ == "__main__":
    print(json.dumps({f: check(f) for f in sys.argv[1:]}))
