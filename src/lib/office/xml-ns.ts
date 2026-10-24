/**
 * TT67: namespace canonicalisation for the Office readers. Original code.
 *
 * Why: XML Namespaces 1.0 makes the prefix a local alias — `<x:c>` with xmlns:x = SpreadsheetML main is the same
 * element as `<c>` under a default SpreadsheetML namespace, and `<a:conditionalFormattings>` bound to the Excel 2009
 * namespace is `<x14:conditionalFormattings>`. Our readers match names literally ("<c ", "w:body", "x14:cfRule"),
 * which is right for what Excel / Word write but rejects valid files from other writers (the OpenXML SDK's
 * `x:` / `s:` SpreadsheetML prefixes are in the Apache POI corpus: those workbooks did not open at all).
 *
 * canonicalizeNs(xml, canon) rewrites every element and prefixed attribute name to the canonical prefix of its
 * RESOLVED namespace (scope-aware: declarations are inherited and may be redeclared at any depth):
 *  - a namespace in `canon` gets its canonical prefix ("" = unprefixed); its declarations move to the root element;
 *  - any other namespace keeps its prefix unless that prefix is one of the canonical ones (or it is the default
 *    namespace while "" is canonical) — then it is renamed to a fresh `ns<k>` alias, so a foreign element can never be
 *    read as one of ours;
 *  - text, attribute values, comments, CDATA, PIs and the DOCTYPE pass through byte-for-byte.
 * Fast path: when every declaration already uses the canonical prefix and no foreign namespace occupies a canonical
 * prefix, the input string is returned unchanged (Excel / Word output costs one regex scan and no copy).
 * The output is for READING: the lossless writers keep the original bytes of every part they do not change.
 */
export type NsCanon = Readonly<Record<string, string>>;

export const NS = {
  sml: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  smlStrict: "http://purl.oclc.org/ooxml/spreadsheetml/main",
  /** pre-standard Excel 2007 beta SpreadsheetML (corpus: sample-beta.xlsx) — same vocabulary as the main namespace */
  smlBeta: "http://schemas.microsoft.com/office/excel/2006/2",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rStrict: "http://purl.oclc.org/ooxml/officeDocument/relationships",
  pkgRels: "http://schemas.openxmlformats.org/package/2006/relationships",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
  x14: "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main",
  xm: "http://schemas.microsoft.com/office/excel/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
  xdr: "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
} as const;

/** SpreadsheetML parts (workbook, sheets, styles, sst, tables, theme, drawings, charts). */
export const SML_CANON: NsCanon = {
  [NS.sml]: "", [NS.smlStrict]: "", [NS.smlBeta]: "", [NS.r]: "r", [NS.rStrict]: "r", [NS.mc]: "mc", [NS.x14]: "x14", [NS.xm]: "xm",
  [NS.a]: "a", [NS.c]: "c", [NS.xdr]: "xdr",
};
/** Package relationship parts (*.rels). */
export const RELS_CANON: NsCanon = { [NS.pkgRels]: "" };
/** WordprocessingML parts. */
export const WML_CANON: NsCanon = {
  [NS.w]: "w", [NS.r]: "r", [NS.mc]: "mc", [NS.a]: "a", [NS.wp]: "wp", [NS.pic]: "pic", [NS.w14]: "w14",
};

/** MCE attributes whose value is a whitespace-separated list of prefixes / of prefix:local QNames. */
const MCE_PREFIX_LISTS = new Set(["Ignorable", "MustUnderstand", "Requires"]);
const MCE_QNAME_LISTS = new Set(["ProcessContent", "PreserveElements", "PreserveAttributes"]);
const DECL = /\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
const ATTR = /(\s+)([^\s=/>]+)(\s*=\s*)("[^"]*"|'[^']*')/g;

/** Real namespace declarations: attributes of start tags only (never text inside an attribute value, a comment, CDATA
 *  or a PI — xmlMaps.xml carries "xmlns:ns1='…'" INSIDE its SelectionNamespaces attribute value). */
function* declarations(xml: string): Generator<[string, string]> {
  for (const t of xml.matchAll(TOKEN)) {
    if (t[2] === undefined || t[1] || !t[3]) continue;
    for (const a of t[3].matchAll(ATTR)) {
      const an = a[2];
      if (an === "xmlns" || an.startsWith("xmlns:")) yield [an === "xmlns" ? "" : an.slice(6), a[4].slice(1, -1)];
    }
  }
}
const violates = (canon: NsCanon, prefixes: Set<string>, p: string, uri: string) =>
  uri in canon ? canon[uri] !== p : prefixes.has(p) && !(p === "" && uri === "");

/** Namespace of the document element (undefined: no element / unbound prefix / no namespace). */
export function rootNamespace(xml: string): string | undefined {
  for (const t of xml.matchAll(TOKEN)) {
    if (t[2] === undefined || t[1]) continue;
    const q = t[2], c = q.indexOf(":"), pre = c < 0 ? "" : q.slice(0, c);
    for (const a of (t[3] ?? "").matchAll(ATTR)) if (a[2] === (pre ? `xmlns:${pre}` : "xmlns")) { const u = a[4].slice(1, -1); return u || undefined; }
    return undefined;
  }
  return undefined;
}

/** True when canonicalizeNs would change nothing (see the fast path above). */
export function isCanonicalNs(xml: string, canon: NsCanon): boolean {
  const prefixes = new Set(Object.values(canon));
  // cheap over-approximation first: a global scan also sees "declarations" inside values / comments; if even that
  // superset is canonical, the real set is. Only otherwise pay for the exact tokenised scan.
  let suspect = false;
  for (const m of xml.matchAll(DECL)) if (violates(canon, prefixes, m[1] ?? "", m[2] ?? m[3] ?? "")) { suspect = true; break; }
  if (!suspect) return true;
  for (const [p, uri] of declarations(xml)) if (violates(canon, prefixes, p, uri)) return false;
  return true;
}

/**
 * `knownRoot`: the readers pass true — a document whose ROOT element is in a namespace outside `canon` (a dialect we
 * have never seen) is returned unchanged, so it is read exactly as before TT67 (namespace-blind) instead of having
 * every element aliased away. Canonicalising can then only ever add files that open, never lose one.
 */
export function canonicalizeNs(xml: string, canon: NsCanon, opts: { knownRoot?: boolean } = {}): string {
  if (isCanonicalNs(xml, canon)) return xml;
  if (opts.knownRoot) {
    const root = rootNamespace(xml);
    if (root === undefined || !(root in canon)) return xml;
  }
  const prefixes = new Set(Object.values(canon));
  // canonical namespaces used anywhere → declared once, on the root element
  const usedMap = new Map<string, string>();
  for (const [, uri] of declarations(xml)) if (uri in canon && !usedMap.has(canon[uri])) usedMap.set(canon[uri], uri);
  const used = [...usedMap]; // output is canonical, so a second pass takes the fast path: idempotent without sorting
  const aliases = new Map<string, string>();
  const aliasOf = (uri: string) => {
    let a = aliases.get(uri);
    if (!a) { let k = aliases.size + 1; while (xml.includes(`ns${k}:`) || xml.includes(`xmlns:ns${k}`) || prefixes.has(`ns${k}`)) k++; a = `ns${k}`; aliases.set(uri, a); }
    return a;
  };
  /** output prefix for a resolved namespace ("" = unprefixed); `orig` is the source prefix */
  const outPrefix = (uri: string | undefined, orig: string): string => {
    if (uri === undefined) return orig; // unbound prefix (malformed) or no namespace: unchanged
    if (uri in canon) return canon[uri];
    if (uri === "") return orig;
    return !prefixes.has(orig) ? orig : aliasOf(uri); // "" stays unprefixed when "" is not a canonical prefix
  };
  type Scope = Map<string, string>;
  const stack: { parent: Scope; out: string; outDef: string }[] = [];
  let scope: Scope = new Map([["xml", "http://www.w3.org/XML/1998/namespace"]]);
  let rootDone = false;
  // the namespace an UNPREFIXED name means in the OUTPUT ("" = none). Original default declarations are all dropped;
  // an element whose unprefixed output name would resolve wrongly gets exactly the xmlns="…" it needs (incl. xmlns="")
  let outDef = "";
  return xml.replace(TOKEN, (tok, close: string | undefined, qname: string | undefined, attrs: string | undefined, selfClose: string | undefined) => {
    if (qname === undefined) return tok; // comment / CDATA / PI / DOCTYPE
    if (close) {
      const top = stack.pop();
      if (!top) return tok; // stray end tag (malformed): unchanged
      scope = top.parent;
      outDef = top.outDef;
      return `</${top.out}>`;
    }
    const parent = scope;
    const next: Scope = new Map(parent);
    for (const a of (attrs ?? "").matchAll(ATTR)) { const an = a[2]; if (an === "xmlns" || an.startsWith("xmlns:")) next.set(an === "xmlns" ? "" : an.slice(6), a[4].slice(1, -1)); }
    const colon = qname.indexOf(":");
    const pre = colon < 0 ? "" : qname.slice(0, colon), local = colon < 0 ? qname : qname.slice(colon + 1);
    const uri = pre === "" ? next.get("") : next.get(pre);
    const ep = pre === "xml" ? "xml" : outPrefix(uri === "" ? undefined : uri, pre);
    const name = ep ? `${ep}:${local}` : local;
    let outAttrs = "";
    const parentOutDef = outDef;
    if (!ep && pre !== "xml") {
      const need = uri === undefined || uri === "" ? "" : uri; // what this unprefixed name must mean
      if (need !== outDef) { outAttrs += need.includes('"') ? ` xmlns='${need}'` : ` xmlns="${need}"`; outDef = need; } // raw source text: no re-escaping
    }
    for (const a of (attrs ?? "").matchAll(ATTR)) {
      const [, ws, an, eq, val] = a;
      if (an === "xmlns" || an.startsWith("xmlns:")) {
        const p = an === "xmlns" ? "" : an.slice(6), u = val.slice(1, -1);
        if (p === "") { // default declarations are emitted exactly where needed (above) — except a foreign default that
          // must be aliased because "" is canonical: its elements become alias:local, so the alias is declared here
          if (u !== "" && !(u in canon) && prefixes.has("")) outAttrs += `${ws}xmlns:${aliasOf(u)}${eq}${val}`;
          continue;
        }
        if (u in canon) continue; // re-declared canonically on the root
        const op = outPrefix(u, p);
        if (op) outAttrs += `${ws}xmlns:${op}${eq}${val}`;
        continue;
      }
      const c = an.indexOf(":");
      // Markup Compatibility (ECMA-376 Part 3): these attribute VALUES name prefixes, so they follow the renaming
      const mceList = (local: string) => {
        if (!MCE_PREFIX_LISTS.has(local) && !MCE_QNAME_LISTS.has(local)) return val;
        const q = val[0], body = val.slice(1, -1);
        const mapped = body.split(/(\s+)/).map((t) => {
          if (!t || /^\s+$/.test(t)) return t;
          const k = t.indexOf(":"), tp = k < 0 ? t : t.slice(0, k), rest = k < 0 ? "" : t.slice(k);
          const tu = next.get(tp);
          if (tu === undefined || tu === "") return t;
          return outPrefix(tu, tp) + rest;
        }).join("");
        return q + mapped + q;
      };
      if (c < 0) { outAttrs += ws + an + eq + (an === "Requires" && uri === NS.mc && local === "Choice" ? mceList("Requires") : val); continue; }
      const ap = an.slice(0, c), al = an.slice(c + 1);
      const au = ap === "xml" ? undefined : next.get(ap);
      const op = ap === "xml" ? "xml" : outPrefix(au, ap);
      outAttrs += `${ws}${op ? `${op}:${al}` : al}${eq}${au === NS.mc ? mceList(al) : val}`;
    }
    if (!rootDone) {
      rootDone = true;
      for (const [p, u] of used) if (p) outAttrs += ` xmlns:${p}="${u}"`;
    }
    if (selfClose) { outDef = parentOutDef; return `<${name}${outAttrs}/>`; }
    stack.push({ parent, out: name, outDef: parentOutDef });
    scope = next;
    return `<${name}${outAttrs}>`;
  });
}
