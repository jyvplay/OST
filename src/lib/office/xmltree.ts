/**
 * TT46 — lossless XML tree for OOXML parts (original, from the XML 1.0 grammar). Parse → serialize reproduces the
 * input exactly for well-formed OOXML (declaration, attribute order and quoting, self-closing tags, whitespace text,
 * comments, CDATA and processing instructions are all kept), so untouched content round-trips byte-for-byte.
 * Entities stay encoded in `attrs`/`text` (raw form); use `xmlText()` / `encText()` to convert.
 */
export interface XEl { k: "el"; name: string; attrs: [string, string][]; quote: string[]; kids: XNode[]; selfClose: boolean; /** original whitespace before each attribute, then before the tag end */ ws?: string[]; /** original "=" spelling per attribute when it had spaces */ eq?: string[]; /** original close tag when it had inner whitespace */ close?: string }
export interface XText { k: "text"; raw: string }
export interface XRaw { k: "raw"; raw: string } // comment, CDATA, PI, doctype — kept verbatim
export type XNode = XEl | XText | XRaw;
export interface XDoc { prolog: string; root: XEl; epilog: string }

const NAME = /[^\s/>=]+/y;
export const MAX_DEPTH = 1500;
export function parseXml(src: string): XDoc {
  let i = 0;
  const n = src.length;
  const prologStart = 0;
  // prolog: declaration, comments, PIs, whitespace up to the root element
  while (i < n) {
    if (src.startsWith("<?", i)) { const j = src.indexOf("?>", i); if (j < 0) throw new Error("xml: unterminated PI"); i = j + 2; continue; }
    if (src.startsWith("<!--", i)) { const j = src.indexOf("-->", i); if (j < 0) throw new Error("xml: unterminated comment"); i = j + 3; continue; }
    if (src.startsWith("<!", i)) { const j = src.indexOf(">", i); i = j + 1; continue; }
    if (src[i] === "<") break;
    i++;
  }
  const prolog = src.slice(prologStart, i);
  const stack: XEl[] = [];
  let root: XEl | null = null;
  while (i < n) {
    if (src[i] !== "<") {
      const j = src.indexOf("<", i);
      const raw = src.slice(i, j < 0 ? n : j);
      if (stack.length) stack[stack.length - 1].kids.push({ k: "text", raw });
      else if (root) break; // epilog text
      i = j < 0 ? n : j; continue;
    }
    if (!stack.length && root) break;
    if (src.startsWith("<!--", i)) { const j = src.indexOf("-->", i); if (j < 0) throw new Error("xml: unterminated comment"); stack[stack.length - 1]?.kids.push({ k: "raw", raw: src.slice(i, j + 3) }); i = j + 3; continue; }
    if (src.startsWith("<![CDATA[", i)) { const j = src.indexOf("]]>", i); if (j < 0) throw new Error("xml: unterminated CDATA"); stack[stack.length - 1]?.kids.push({ k: "raw", raw: src.slice(i, j + 3) }); i = j + 3; continue; }
    if (src.startsWith("<?", i)) { const j = src.indexOf("?>", i); if (j < 0) throw new Error("xml: unterminated PI"); stack[stack.length - 1]?.kids.push({ k: "raw", raw: src.slice(i, j + 2) }); i = j + 2; continue; }
    if (src[i + 1] === "/") {
      const j = src.indexOf(">", i);
      const name = src.slice(i + 2, j).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`xml: mismatched </${name}>`);
      if (j - i - 2 !== name.length) top.close = src.slice(i, j + 1);
      i = j + 1;
      if (!stack.length) root = top;
      continue;
    }
    // start tag
    NAME.lastIndex = i + 1;
    const nm = NAME.exec(src);
    if (!nm) throw new Error(`xml: bad tag at ${i}`);
    const el: XEl = { k: "el", name: nm[0], attrs: [], quote: [], kids: [], selfClose: false };
    let p = NAME.lastIndex;
    const ws: string[] = [];
    for (;;) {
      const w0 = p;
      while (p < n && /\s/.test(src[p])) p++;
      ws.push(src.slice(w0, p));
      if (src[p] === "/" && src[p + 1] === ">") { el.selfClose = true; p += 2; break; }
      if (src[p] === ">") { p++; break; }
      if (p >= n) throw new Error("xml: unterminated tag");
      NAME.lastIndex = p;
      const an = NAME.exec(src);
      if (!an) throw new Error(`xml: bad attribute at ${p}`);
      p = NAME.lastIndex;
      const e0 = p;
      while (/\s/.test(src[p] ?? "")) p++;
      if (src[p] !== "=") throw new Error(`xml: attribute without value at ${p}`);
      p++;
      while (/\s/.test(src[p] ?? "")) p++;
      if (p - e0 !== 1) { el.eq ??= []; el.eq[el.attrs.length] = src.slice(e0, p); }
      const q = src[p];
      if (q !== '"' && q !== "'") throw new Error(`xml: unquoted attribute at ${p}`);
      const e = src.indexOf(q, p + 1);
      el.attrs.push([an[0], src.slice(p + 1, e)]); el.quote.push(q);
      p = e + 1;
    }
    if (ws.some((w, k) => w !== (k < el.attrs.length ? " " : ""))) el.ws = ws;
    i = p;
    if (stack.length) stack[stack.length - 1].kids.push(el);
    if (el.selfClose) { if (!stack.length) root = el; continue; }
    stack.push(el);
    if (stack.length > MAX_DEPTH) throw new Error(`xml: element nesting deeper than ${MAX_DEPTH} (refused as a nesting bomb)`);
  }
  if (!root || stack.length) throw new Error("xml: document not closed");
  return { prolog, root, epilog: src.slice(i) };
}

export function serializeXml(d: XDoc): string { return d.prolog + serializeEl(d.root) + d.epilog; }
export function serializeEl(e: XEl): string {
  let s = `<${e.name}`;
  const ws = e.ws && e.ws.length === e.attrs.length + 1 ? e.ws : undefined;
  e.attrs.forEach(([k, v], i) => { const q = e.quote[i] ?? '"'; s += `${ws ? ws[i] : " "}${k}${e.eq?.[i] ?? "="}${q}${v}${q}`; });
  if (ws) s += ws[e.attrs.length];
  if (e.selfClose && !e.kids.length) return s + "/>";
  s += ">";
  for (const c of e.kids) s += c.k === "el" ? serializeEl(c) : c.raw;
  return s + (e.close ?? `</${e.name}>`);
}

/* ---------------------------------------------------------------- helpers */
/** Decodes the five predefined entities and character references. Any other entity reference (DTD-declared or external,
 * e.g. an XXE payload) is never resolved and decodes to nothing — the same result as libxml2 with entity loading off. */
export const decText = (s: string) => s.indexOf("&") < 0 ? s : s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z_][\w.-]*);/g, (_, e: string) => {
  if (e === "lt") return "<"; if (e === "gt") return ">"; if (e === "amp") return "&"; if (e === "quot") return '"'; if (e === "apos") return "'";
  if (e[0] !== "#") return "";
  const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
});
export const encText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const encAttr = (s: string) => encText(s).replace(/"/g, "&quot;");
export function attr(e: XEl | undefined, name: string): string | undefined { if (!e) return undefined; const a = e.attrs.find((x) => x[0] === name); return a ? decText(a[1]) : undefined; }
export function setAttr(e: XEl, name: string, value: string | undefined) {
  const i = e.attrs.findIndex((x) => x[0] === name);
  if (i < 0 || value === undefined) { e.ws = undefined; e.eq = undefined; }
  if (value === undefined) { if (i >= 0) { e.attrs.splice(i, 1); e.quote.splice(i, 1); } return; }
  if (i >= 0) e.attrs[i][1] = encAttr(value); else { e.attrs.push([name, encAttr(value)]); e.quote.push('"'); }
}
export const kids = (e: XEl | undefined, name?: string): XEl[] => (e ? (e.kids.filter((k) => k.k === "el" && (!name || k.name === name)) as XEl[]) : []);
export const kid = (e: XEl | undefined, name: string): XEl | undefined => kids(e, name)[0];
export function el(name: string, attrs: Record<string, string | undefined> = {}, children: XNode[] = []): XEl {
  const a = Object.entries(attrs).filter(([, v]) => v !== undefined) as [string, string][];
  return { k: "el", name, attrs: a.map(([k, v]) => [k, encAttr(v)]), quote: a.map(() => '"'), kids: children, selfClose: children.length === 0 };
}
export const textNode = (s: string): XText => ({ k: "text", raw: encText(s) });
export function clone<T extends XNode>(n: T): T { return (n.k === "el" ? { ...n, attrs: n.attrs.map((a) => [a[0], a[1]] as [string, string]), quote: n.quote.slice(), ws: n.ws?.slice(), eq: n.eq?.slice(), kids: n.kids.map(clone) } : { ...n }) as T; }
/** All text content (decoded). */
export function textOf(e: XNode): string { return e.k === "text" ? decText(e.raw) : e.k === "el" ? e.kids.map(textOf).join("") : ""; }
/** Depth-first search. */
export function find(e: XEl, pred: (x: XEl) => boolean): XEl | undefined {
  for (const k of e.kids) if (k.k === "el") { if (pred(k)) return k; const f = find(k, pred); if (f) return f; }
  return undefined;
}
export function findAll(e: XEl, pred: (x: XEl) => boolean, out: XEl[] = []): XEl[] {
  for (const k of e.kids) if (k.k === "el") { if (pred(k)) out.push(k); findAll(k, pred, out); }
  return out;
}
