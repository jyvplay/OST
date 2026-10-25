#!/usr/bin/env python3
"""TT74 (FF-02) test-only oracle: mammoth (BSD-2-Clause, an independent docx -> HTML converter) vs Fusion's converter.

usage:
  docx_mammoth.py prep SRC_DIR DST_DIR        copy every .docx, removing ONLY what mammoth has no handler for
                                              (m:oMath / m:oMathPara, runs with direct w:vanish) so both engines
                                              read the same input; prints JSON {name: "ok" | "error ..."}
  docx_mammoth.py compare PREP_DIR OURS_DIR    mammoth-convert each prepared docx, parse its HTML and ours (OURS_DIR/
                                              NAME.html) with the SAME parser, print a JSON report per file

The parser reads block texts in reading order (p, h1-h6, li without nested lists, table cells' paragraphs), headings
(level, text), list items (ordered?, depth, text), table shapes (rows x cells), links (text, href) and note texts.
Nothing from mammoth ships in Fusion.
"""
import io, json, os, re, sys, zipfile
from lxml import etree, html as lhtml
from urllib.parse import unquote

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
PARTS = re.compile(r"^word/(document|footnotes|endnotes)\d*\.xml$")


def prep_part(data: bytes) -> bytes:
    root = etree.fromstring(data, etree.XMLParser(huge_tree=True, remove_blank_text=False))
    for m in root.iter(f"{{{M}}}oMathPara", f"{{{M}}}oMath"):
        pass
    for m in list(root.iter(f"{{{M}}}oMathPara")) + list(root.iter(f"{{{M}}}oMath")):
        par = m.getparent()
        if par is not None:
            par.remove(m)
    # display-preserving rewrites for constructs mammoth has no handler for (body_xml.py handlers table):
    #  w:fldSimple → its result runs (Word shows the field result, §17.16.19); w:ruby → its base text (the w:rt guide
    #  text is an annotation); HYPERLINK field switches other than \\l are dropped (mammoth's regex swallows \\o "tip"
    #  into the URL)
    for fs in list(root.iter(f"{{{W}}}fldSimple")):
        par = fs.getparent()
        if par is None:
            continue
        i = par.index(fs)
        for k in [c for c in fs if c.tag in (f"{{{W}}}r", f"{{{W}}}hyperlink", f"{{{W}}}fldSimple", f"{{{W}}}ins", f"{{{W}}}smartTag")]:
            par.insert(i, k)
            i += 1
        par.remove(fs)
    for rb in list(root.iter(f"{{{W}}}ruby")):
        base = rb.find(f"{{{W}}}rubyBase")
        par = rb.getparent()
        i = par.index(rb)
        if base is not None:
            for k in list(base):
                par.addnext(k) if False else None
            # ruby sits inside a run: replace it by the base runs' children (text, tabs)
            for k in [x for r in base.findall(f"{{{W}}}r") for x in r if x.tag != f"{{{W}}}rPr"]:
                par.insert(i, k)
                i += 1
        par.remove(rb)
    V = "urn:schemas-microsoft-com:vml"
    for tag in ("oval", "line", "polyline", "arc", "curve"):  # VML shape types mammoth lacks (it reads v:shape/rect/roundrect)
        for e in list(root.iter(f"{{{V}}}{tag}")):
            e.tag = f"{{{V}}}shape"
    for cr in list(root.iter(f"{{{W}}}cr")):  # carriage return = line break (§17.3.3.4); mammoth has no w:cr handler
        cr.tag = f"{{{W}}}br"
    for it in root.iter(f"{{{W}}}instrText"):
        t = it.text or ""
        m = re.match(r'^(\s*HYPERLINK\s+)((?:\\[a-km-z]\s+"[^"]*"\s*)*)(\\l\s+)?((?:\\[a-km-z]\s+"[^"]*"\s*)*)("[^"]*"|\S+)([\s\S]*)$', t, re.I)
        if m:
            it.text = f"{m.group(1)}{m.group(3) or ''}{m.group(5)} "
    for r in list(root.iter(f"{{{W}}}r")):
        rpr = r.find(f"{{{W}}}rPr")
        v = rpr.find(f"{{{W}}}vanish") if rpr is not None else None
        if v is not None and v.get(f"{{{W}}}val", "true") not in ("false", "0", "off", "none"):
            par = r.getparent()
            if par is not None:
                par.remove(r)
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def prep(src, dst):
    os.makedirs(dst, exist_ok=True)
    out = {}
    for name in sorted(os.listdir(src)):
        if not name.lower().endswith(".docx"):
            continue
        try:
            zin = zipfile.ZipFile(os.path.join(src, name))
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zout:
                for info in zin.infolist():
                    data = zin.read(info.filename)
                    if PARTS.match(info.filename):
                        data = prep_part(data)
                    zout.writestr(info.filename, data)
            open(os.path.join(dst, name), "wb").write(buf.getvalue())
            out[name] = "ok"
        except Exception as e:  # damaged / encrypted fuzz files
            out[name] = f"error {type(e).__name__}: {str(e)[:120]}"
    print(json.dumps(out))


NOTE_HREF = re.compile(r"^#(footnote-|endnote-|fn\d|en\d)")
WS = re.compile(r"\s+")


def norm(s):
    return WS.sub(" ", (s or "").replace("\u00ad", "").replace("\u200b", "")).strip()


BLOCK_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "table", "tr", "td", "th", "blockquote", "div", "section"}


def text_of(el, skip_lists=False):
    """text content, dropping note reference anchors / back-links and (optionally) nested lists"""
    parts = []

    def walk(e):
        if not isinstance(e.tag, str):
            return
        if e.tag == "a" and (NOTE_HREF.match(e.get("href") or "") or e.get("href", "").startswith("#footnote-ref") or e.get("href", "").startswith("#endnote-ref") or (e.get("href") or "").endswith("-ref")):
            if e.tail:
                parts.append(e.tail)
            return
        if skip_lists and e.tag in ("ul", "ol") and e is not el:
            if e.tail:
                parts.append(e.tail)
            return
        if e.tag == "br":
            parts.append("\n")
        block = e is not el and e.tag in BLOCK_TAGS
        if block:  # block boundaries separate words whatever whitespace the serializer put between tags
            parts.append(" ")
        if e.text:
            parts.append(e.text)
        for c in e:
            walk(c)
        if block:
            parts.append(" ")
        if e is not el and e.tail:
            parts.append(e.tail)

    walk(el)
    return norm("".join(parts))


# mammoth's default style map covers list levels 1-5 only; Word numbers levels up to 9 (ilvl 0-8), so levels 6-9 get
# the same mapping pattern as mammoth's own defaults (styles/defaults: "ul|ol > li > ... > ul > li:fresh")
DEEP_LISTS = "\n".join(
    f"p:{kind}-list({n}) => {'ul|ol > li > ' * (n - 1)}{tag} > li:fresh"
    for n in range(6, 10) for kind, tag in (("unordered", "ul"), ("ordered", "ol")))
BOOKMARK = re.compile(r"<a id=\"[^\"]*\"></a>")


def _loosen(li):
    """an item holding block children (code, quote, table, list) gets its loose inline runs wrapped in <p>: a tight
    markdown-it item and the DOCX paragraphs it becomes are then compared paragraph by paragraph"""
    if not any(isinstance(c.tag, str) and (c.tag in BLOCK_TAGS or c.tag == "pre") and c.tag not in ("li",) for c in li):
        return
    runs, cur = [], None
    lead = li.text
    li.text = None
    if lead and lead.strip():
        cur = lhtml.Element("p")
        cur.text = lead
        runs.append((0, cur))
    kids = list(li)
    pos = 0
    for c in kids:
        blockish = isinstance(c.tag, str) and (c.tag in BLOCK_TAGS or c.tag == "pre")
        if blockish:
            cur = None
            tail = c.tail
            c.tail = None
            if tail and tail.strip():
                cur = lhtml.Element("p")
                cur.text = tail
                c.addnext(cur)
            continue
        if cur is None:
            cur = lhtml.Element("p")
            c.addprevious(cur)
        cur.append(c)  # moves c (with its tail) into the paragraph
    if runs:
        li.insert(0, runs[0][1])


def parse(html_text, img_alt=False):
    # mammoth writes bookmarks as empty <a id> anchors, also INSIDE <a href> (invalid nesting that makes an HTML parser
    # close the link early); bookmarks are not text, so they are removed from both sides before parsing
    html_text = BOOKMARK.sub("", html_text)
    doc = lhtml.fromstring(f"<div id='__root'>{html_text}</div>") if html_text.strip() else lhtml.fromstring("<div></div>")
    notes = {"footnote": [], "endnote": []}
    # notes: mammoth <li id="footnote-N"> / ours <li id="fnN">
    for li in list(doc.iter("li")):
        i = li.get("id") or ""
        kind = "footnote" if (i.startswith("footnote-") or re.match(r"^fn\d", i)) else "endnote" if (i.startswith("endnote-") or re.match(r"^en\d", i)) else None
        if kind:
            notes[kind].append(norm(text_of(li).replace("↑", "").replace("↩", "").replace("\ufe0e", "")))
            li.getparent().remove(li)
    for sec in list(doc.iter("section")):
        sec.getparent().remove(sec)
    for sp in [e for e in doc.iter("span") if "img-alt" in (e.get("class") or "")]:  # picture placeholders are not text
        tail = sp.tail
        par = sp.getparent()
        prev = sp.getprevious()
        if tail:
            if prev is not None:
                prev.tail = (prev.tail or "") + tail
            else:
                par.text = (par.text or "") + tail
        par.remove(sp)
    if img_alt:  # the Markdown side: a picture that is not a data: URI is written by the converter as its alt text
        for im in list(doc.iter("img")):
            if (im.get("src") or "").startswith("data:"):
                continue
            alt = im.get("alt") or ""
            par = im.getparent()
            prev = im.getprevious()
            txt = alt + (im.tail or "")
            if prev is not None:
                prev.tail = (prev.tail or "") + txt
            else:
                par.text = (par.text or "") + txt
            par.remove(im)
    for li in list(doc.iter("li")):
        _loosen(li)
    blocks, heads, items, tables, links = [], [], [], [], []
    for e in doc.iter():
        if not isinstance(e.tag, str):
            continue
        if e.tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6", "pre"):
            t = text_of(e)
            if t:
                blocks.append(t)
            if e.tag[0] == "h" and t:
                heads.append([int(e.tag[1]), t])
        elif e.tag == "li":
            t = text_of(e, skip_lists=True)
            first_p = next((c for c in e if c.tag == "p"), None)
            if first_p is not None:  # DOCX has no multi-paragraph list item: an item is compared by its first paragraph
                t = text_of(first_p)
            if not t and any(c.tag in ("ul", "ol") for c in e):
                continue  # a wrapper item that only opens a deeper level
            # mammoth puts <p> in li only for multi-paragraph items; count li text that is not inside a <p>
            own = "".join([e.text or ""] + [(c.tail or "") for c in e]) if not any(c.tag == "p" for c in e) else ""
            if t and first_p is None:
                blocks.append(t)
            depth = sum(1 for a in e.iterancestors() if a.tag in ("ul", "ol")) - 1
            par = e.getparent()
            items.append([par.tag == "ol", depth, t])
        elif e.tag == "td" or e.tag == "th":
            if not any(c.tag in ("p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table") for c in e):
                t = text_of(e)
                if t:
                    blocks.append(t)
        elif e.tag == "table":
            tables.append([len([c for c in tr if c.tag in ("td", "th")]) for tr in e.iter("tr") if next(tr.iterancestors("table")) is e])
        elif e.tag == "a" and e.get("href") and not NOTE_HREF.match(e.get("href")) and not e.get("href").endswith("-ref"):
            if text_of(e):  # a link with no visible content cannot be carried by a document run
                links.append([text_of(e), unquote(e.get("href"))])
    fmt = {}
    for key, tags in (("strong", ("strong", "b")), ("em", ("em", "i")), ("s", ("s", "del", "strike"))):
        fmt[key] = WS.sub("", "".join(text_of(e) for e in doc.iter(*tags) if not any(a.tag in tags for a in e.iterancestors())))
    return {"blocks": blocks, "heads": heads, "items": items, "tables": tables, "links": links, "notes": notes, "fmt": fmt}


def md_compare(d):
    """d holds NAME.md + NAME.md.docx pairs: mammoth(docx) vs markdown-it-py(md), same parser"""
    import mammoth
    from markdown_it import MarkdownIt
    from mdit_py_plugins.footnote import footnote_plugin
    mdi = MarkdownIt("commonmark", {"html": False}).enable("table").enable("strikethrough").use(footnote_plugin)
    report = {}
    for name in sorted(os.listdir(d)):
        if not name.endswith(".md"):
            continue
        try:
            theirs = parse(mdi.render(open(os.path.join(d, name), encoding="utf-8").read()), img_alt=True)
        except Exception as e:
            report[name] = {"oracle_error": f"markdown-it {type(e).__name__}: {str(e)[:160]}"}
            continue
        try:
            with open(os.path.join(d, name + ".docx"), "rb") as f:
                res = mammoth.convert_to_html(f, style_map=DEEP_LISTS)
            ours = parse(res.value)
        except Exception as e:
            report[name] = {"oracle_error": f"mammoth {type(e).__name__}: {str(e)[:160]}"}
            continue
        try:
            import docx as pydocx
            pydocx.Document(os.path.join(d, name + ".docx"))
            opened = True
        except Exception:
            opened = False
        report[name] = {"theirs": theirs, "ours": ours, "python_docx": opened}
    print(json.dumps(report, ensure_ascii=False))


def char_style_map(path):
    """mammoth honours character styles only through its style map ("Strong" by default); Word renders every character
    style's bold / italic / strike (§17.7.2). One map line per such style of this document: r[style-name='X'] => strong"""
    try:
        z = zipfile.ZipFile(path)
        root = etree.fromstring(z.read("word/styles.xml"))
    except Exception:
        return ""
    st = {}
    for s in root.iter(f"{{{W}}}style"):
        if s.get(f"{{{W}}}type") != "character":
            continue
        rpr = s.find(f"{{{W}}}rPr")
        def on(tag):
            e = rpr.find(f"{{{W}}}{tag}") if rpr is not None else None
            return None if e is None else (e.get(f"{{{W}}}val") or "true") not in ("0", "false", "off", "none")
        name = s.find(f"{{{W}}}name")
        based = s.find(f"{{{W}}}basedOn")
        st[s.get(f"{{{W}}}styleId")] = {"name": name.get(f"{{{W}}}val") if name is not None else s.get(f"{{{W}}}styleId"), "based": based.get(f"{{{W}}}val") if based is not None else None, "b": on("b"), "i": on("i"), "s": on("strike")}
    lines = []
    for sid, d in st.items():
        eff, cur, seen = {}, sid, set()
        while cur in st and cur not in seen:
            seen.add(cur)
            for k in ("b", "i", "s"):
                if k not in eff and st[cur][k] is not None:
                    eff[k] = st[cur][k]
            cur = st[cur]["based"]
        tags = [t for k, t in (("b", "strong"), ("i", "em"), ("s", "s")) if eff.get(k)]
        if tags and "'" not in d["name"]:
            lines.append(f"r[style-name='{d['name']}'] => {' > '.join(tags)}")
    return "\n".join(lines)


def compare(prep_dir, ours_dir):
    import mammoth
    report = {}
    for name in sorted(os.listdir(prep_dir)):
        if not name.endswith(".docx"):
            continue
        ours_path = os.path.join(ours_dir, name + ".html")
        if not os.path.exists(ours_path):
            continue
        try:
            with open(os.path.join(prep_dir, name), "rb") as f:
                res = mammoth.convert_to_html(f, style_map=DEEP_LISTS + "\n" + char_style_map(os.path.join(prep_dir, name)))
            theirs = parse(res.value)
        except Exception as e:
            report[name] = {"oracle_error": f"{type(e).__name__}: {str(e)[:160]}"}
            continue
        body = open(ours_path, encoding="utf-8").read()
        m = re.search(r"<body[^>]*>([\s\S]*)</body>", body)
        ours = parse(m.group(1) if m else body)
        report[name] = {"theirs": theirs, "ours": ours}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1] == "prep":
        prep(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "compare":
        compare(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "mdcompare":
        md_compare(sys.argv[2])
    elif sys.argv[1] == "parse":
        print(json.dumps(parse(open(sys.argv[2], encoding="utf-8").read()), ensure_ascii=False))
