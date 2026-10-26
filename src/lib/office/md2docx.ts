/**
 * Markdown → WordprocessingML (.docx) — FF-02 (convert), original code.
 *
 * Parser: CommonMark block structure (ATX/setext headings, paragraphs, block quotes, bullet/ordered lists with nesting,
 * fenced/indented code, thematic breaks, link reference definitions) + the GFM table and strikethrough extensions +
 * footnotes ([^label] / [^label]: …). Inline: code spans, the CommonMark delimiter-stack emphasis algorithm (flanking
 * rules, rule of 3), links/images (inline, full/collapsed/shortcut references), autolinks, backslash escapes, entities,
 * hard/soft breaks.
 * Raw HTML is NOT interpreted (it is kept as literal text, like markdown-it with html:false) except the tiny inline set
 * this project's own Markdown export emits: <sup> <sub> <br> (option rawHtml:"basic", the default).
 *
 * Writer: a fresh, schema-valid package — styles (Heading1–6, Quote, SourceCode, Hyperlink, Footnote*, TableGrid),
 * one numbering definition per list (bullet / decimal, 9 levels, start values), real footnotes, external hyperlinks
 * via relationships, embedded data: URI pictures. Every lossy step is counted in `loss`.
 */
import { writeZip } from "./zipkit";
import { safeHref } from "./convert-word";

/* ================================================================ AST */
export type Inl =
  | { t: "text"; s: string }
  | { t: "code"; s: string }
  | { t: "em" | "strong" | "del" | "sup" | "sub"; c: Inl[] }
  | { t: "link"; href: string; c: Inl[] }
  | { t: "img"; alt: string; src: string }
  | { t: "br" }
  | { t: "fn"; label: string };
export type MdBlock =
  | { k: "h"; level: number; c: Inl[] }
  | { k: "p"; c: Inl[] }
  | { k: "code"; text: string }
  | { k: "quote"; blocks: MdBlock[] }
  | { k: "list"; ordered: boolean; start: number; items: MdBlock[][] }
  | { k: "hr" }
  | { k: "table"; align: ("l" | "c" | "r" | "")[]; rows: Inl[][][] };
export interface MdDoc { blocks: MdBlock[]; notes: Map<string, MdBlock[]> }
export interface MdOptions { rawHtml?: "basic" | "text"; images?: Map<string, { mime: string; data: Uint8Array }> }

const MAX_NEST = 64;
const MAX_INPUT = 8 * 1024 * 1024;

/* ================================================================ blocks */
interface Ref { href: string }
interface PCtx { refs: Map<string, Ref>; notes: Map<string, MdBlock[]>; noteRaw: Map<string, string[]>; opts: MdOptions; depth: number; rawHtml: number; /** tags left as literal text */ rawLit?: number }
const normLabel = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

function expandTabs(line: string): string {
  if (line.indexOf("\t") < 0) return line;
  let out = ""; let col = 0;
  for (const ch of line) { if (ch === "\t") { const n = 4 - (col % 4); out += " ".repeat(n); col += n; } else { out += ch; col++; } }
  return out;
}
const indentOf = (l: string) => /^ */.exec(l)![0].length;
const isBlank = (l: string) => /^\s*$/.test(l);
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const BULLET = /^( {0,3})([-+*])( {1,4}|[ \t]*$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])( {1,4}|[ \t]*$)/;
const QUOTE = /^ {0,3}> ?/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIM = /^ {0,3}\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;

function startsBlock(l: string): boolean {
  return ATX.test(l) || HR.test(l) || FENCE.test(l) || QUOTE.test(l) || BULLET.test(l) && !isBlank(l.replace(BULLET, "")) || (ORDERED.exec(l)?.[2] === "1" && !isBlank(l.replace(ORDERED, "")));
}

function splitRow(l: string): string[] {
  let s = l.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = []; let cur = ""; let code = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "`") code = code ? 0 : 1;
    if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseBlocksMd(lines: string[], cx: PCtx): MdBlock[] {
  const out: MdBlock[] = [];
  if (++cx.depth > MAX_NEST) { cx.depth--; return [{ k: "p", c: [{ t: "text", s: lines.join("\n") }] }]; }
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    let text = para.join("\n");
    // link reference definitions at the start of a paragraph
    for (;;) {
      const m = /^ {0,3}\[((?:[^\]\\]|\\.){1,999})\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)(?:[ \t]*\n?[ \t]*("[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*(?:\n|$)/.exec(text);
      if (!m || m[1].startsWith("^")) break;
      const label = normLabel(m[1]);
      if (label && !cx.refs.has(label)) cx.refs.set(label, { href: unescapeMd(m[2].replace(/^<|>$/g, "")) });
      text = text.slice(m[0].length);
    }
    para = [];
    if (text.trim()) out.push({ k: "p", c: [{ t: "text", s: "\u0000P" + text.replace(/^[ \t]+/gm, "") }] });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { flush(); i++; continue; }
    const ind = indentOf(line);
    if (ind >= 4 && !para.length) { // indented code
      const code: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || isBlank(lines[i]))) { code.push(lines[i].slice(Math.min(4, indentOf(lines[i])))); i++; }
      while (code.length && isBlank(code[code.length - 1])) code.pop();
      out.push({ k: "code", text: code.join("\n") }); continue;
    }
    let m: RegExpExecArray | null;
    if ((m = FENCE.exec(line)) && !(m[2][0] === "`" && m[3].includes("`"))) {
      flush();
      const fenceInd = m[1].length; const fence = m[2]; const code: string[] = []; i++;
      while (i < lines.length) {
        const l = lines[i];
        if (new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`).test(l)) { i++; break; }
        code.push(l.replace(new RegExp(`^ {0,${fenceInd}}`), "")); i++;
      }
      out.push({ k: "code", text: code.join("\n") }); continue;
    }
    if ((m = ATX.exec(line))) { flush(); out.push({ k: "h", level: m[1].length, c: [{ t: "text", s: "\u0000P" + (m[2] ?? "").trim() }] }); i++; continue; }
    if (para.length && (m = SETEXT.exec(line)) && !(para.length && QUOTE.test(para[0]))) {
      const text = para.join("\n"); para = [];
      out.push({ k: "h", level: m[1][0] === "=" ? 1 : 2, c: [{ t: "text", s: "\u0000P" + text.replace(/^[ \t]+/gm, "").trim() }] }); i++; continue;
    }
    if (HR.test(line)) { flush(); out.push({ k: "hr" }); i++; continue; }
    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE.test(l)) { inner.push(l.replace(QUOTE, "")); i++; continue; }
        // lazy continuation of a paragraph inside the quote
        if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) && !startsBlock(l) && !FENCE.test(inner[inner.length - 1])) { inner.push(l); i++; continue; }
        break;
      }
      out.push({ k: "quote", blocks: parseBlocksMd(inner, cx) }); continue;
    }
    // GFM table: header row + delimiter row
    if (!para.length && line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line); const delim = splitRow(lines[i + 1]);
      if (head.length === delim.length) {
        flush();
        const align = delim.map((d) => (d.startsWith(":") && d.endsWith(":") ? "c" : d.endsWith(":") ? "r" : d.startsWith(":") ? "l" : "") as "l" | "c" | "r" | "");
        const rows: Inl[][][] = [head.map((c) => [{ t: "text", s: "\u0000P" + c } as Inl])];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
          const cells = splitRow(lines[i]); const row: Inl[][] = [];
          for (let k = 0; k < head.length; k++) row.push([{ t: "text", s: "\u0000P" + (cells[k] ?? "") }]);
          rows.push(row); i++;
        }
        out.push({ k: "table", align, rows }); continue;
      }
    }
    // footnote definition
    if (!para.length && (m = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]?(.*)$/.exec(line))) {
      const label = normLabel(m[1]); const body = [m[2]]; i++;
      while (i < lines.length && (isBlank(lines[i]) ? i + 1 < lines.length && indentOf(lines[i + 1]) >= 4 : indentOf(lines[i]) >= 4 || !startsBlock(lines[i]) && !isBlank(body[body.length - 1]) && !/^ {0,3}\[\^/.test(lines[i]))) {
        body.push(lines[i].slice(Math.min(4, indentOf(lines[i])))); i++;
      }
      if (!cx.noteRaw.has(label)) cx.noteRaw.set(label, body);
      continue;
    }
    const bm = BULLET.exec(line); const om = ORDERED.exec(line);
    if ((bm || om) && !(para.length && (bm ? isBlank(line.replace(BULLET, "")) : om![2] !== "1" || isBlank(line.replace(ORDERED, ""))))) {
      flush();
      const ordered = !bm; const marker = bm ? bm[2] : om![3];
      const start = om ? Number(om[2]) : 1;
      const items: MdBlock[][] = [];
      while (i < lines.length) {
        const l = lines[i];
        const b2 = BULLET.exec(l); const o2 = ORDERED.exec(l);
        const mm = ordered ? (o2 && o2[3] === marker ? o2 : null) : (b2 && b2[2] === marker && !HR.test(l) ? b2 : null);
        if (!mm) break;
        const pre = mm[1].length + (ordered ? mm[2].length + 1 : 1);
        const rest = l.slice(pre);
        const restBlank = isBlank(rest);
        const gap = restBlank ? 1 : Math.min(indentOf(rest), 4) || 1;
        const w = pre + (indentOf(rest) > 4 ? 1 : gap);
        const first = restBlank ? "" : l.slice(Math.min(l.length, indentOf(rest) > 4 ? pre + 1 : w));
        const body = [first]; i++;
        while (i < lines.length) {
          const n = lines[i];
          if (isBlank(n)) {
            // blank line: the item continues only if the next non-blank line is indented to the content column
            let j = i; while (j < lines.length && isBlank(lines[j])) j++;
            if (j < lines.length && indentOf(lines[j]) >= w && !(restBlank && body.length === 1 && !first)) { for (; i < j; i++) body.push(""); continue; }
            break;
          }
          if (indentOf(n) >= w) { body.push(n.slice(w)); i++; continue; }
          if (BULLET.test(n) || ORDERED.test(n)) break; // a sibling (or outer) list item ends this item
          // lazy paragraph continuation
          const lastLine = body[body.length - 1];
          if (!isBlank(lastLine) && !startsBlock(n) && !HR.test(n) && !FENCE.test(body[0])) { body.push(n.trimStart()); i++; continue; }
          break;
        }
        items.push(parseBlocksMd(body, cx));
        // blank lines between items stay inside the list
        let j = i; while (j < lines.length && isBlank(lines[j])) j++;
        const nb = j < lines.length ? lines[j] : "";
        const n2b = BULLET.exec(nb); const n2o = ORDERED.exec(nb);
        if (j > i && (ordered ? n2o && n2o[3] === marker : n2b && n2b[2] === marker && !HR.test(nb))) i = j;
      }
      out.push({ k: "list", ordered, start, items }); continue;
    }
    para.push(line); i++;
  }
  flush();
  cx.depth--;
  return out;
}

/* ================================================================ inlines */
const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", times: "×", divide: "÷", deg: "°", plusmn: "±", middot: "·",
  bull: "•", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  iexcl: "¡", iquest: "¿", shy: "\u00ad", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009", zwj: "\u200d", zwnj: "\u200c", check: "✓",
  hearts: "♥", star: "☆", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", alpha: "α", beta: "β", pi: "π",
};
function decodeEntity(e: string): string | null {
  if (e[0] === "#") {
    const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(n)) return null;
    return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "\ufffd" : String.fromCodePoint(n);
  }
  return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : null;
}
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
function unescapeMd(s: string): string {
  return s.replace(/\\([!-/:-@[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (all, esc: string | undefined, ent: string | undefined) => esc ?? decodeEntity(ent!) ?? all);
}
const isWs = (c: string) => c === "" || /\s/.test(c);
const isPunct = (c: string) => c !== "" && (ASCII_PUNCT.includes(c) || /[\u00a1-\u00bf\u2010-\u2027\u2030-\u205e\u3000-\u303f\uff01-\uff0f\uff1a-\uff20]/.test(c));

interface Delim { t: "delim"; ch: string; n: number; open: boolean; close: boolean; orig: number }
interface Brk { t: "brk"; img: boolean; active: boolean; pos: number }
type Node = Inl | Delim | Brk;

function parseInline(src: string, cx: PCtx): Inl[] {
  const nodes: Node[] = [];
  const brackets: number[] = []; // indices into nodes of open bracket markers
  let text = "";
  const pushText = () => { if (text) { nodes.push({ t: "text", s: text }); text = ""; } };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      const d = src[i + 1];
      if (d === "\n") { pushText(); nodes.push({ t: "br" }); i += 2; while (src[i] === " ") i++; continue; }
      if (d !== undefined && ASCII_PUNCT.includes(d)) { text += d; i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === "&") {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      const v = m ? decodeEntity(m[1]) : null;
      if (m && v !== null) { text += v; i += m[0].length; continue; }
      text += c; i++; continue;
    }
    if (c === "`") {
      let k = i; while (src[k] === "`") k++;
      const run = k - i;
      let j = k; let found = -1;
      while (j < n) {
        const q = src.indexOf("`", j); if (q < 0) break;
        let e = q; while (src[e] === "`") e++;
        if (e - q === run) { found = q; break; }
        j = e;
      }
      if (found < 0) { text += src.slice(i, k); i = k; continue; }
      let code = src.slice(k, found).replace(/\n/g, " ");
      if (/^ .*[^ ].* $/.test(code) || /^ [^ ] $/.test(code)) code = code.slice(1, -1);
      else if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      pushText(); nodes.push({ t: "code", s: code }); i = found + run; continue;
    }
    if (c === "*" || c === "_" || c === "~") {
      let k = i; while (src[k] === c) k++;
      const run = k - i;
      const before = i > 0 ? src[i - 1] : ""; const after = k < n ? src[k] : "";
      const lf = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const rf = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let open = lf, close = rf;
      if (c === "_") { open = lf && (!rf || isPunct(before)); close = rf && (!lf || isPunct(after)); }
      if (c === "~" && run !== 2) { text += src.slice(i, k); i = k; continue; }
      pushText(); nodes.push({ t: "delim", ch: c, n: run, open, close, orig: run }); i = k; continue;
    }
    if (c === "!" && src[i + 1] === "[") { pushText(); brackets.push(nodes.length); nodes.push({ t: "brk", img: true, active: true, pos: i + 2 }); i += 2; continue; }
    if (c === "[") {
      const fm = /^\[\^([^\]\s]+)\]/.exec(src.slice(i, i + 200));
      if (fm && cx.noteRaw.has(normLabel(fm[1]))) { pushText(); nodes.push({ t: "fn", label: normLabel(fm[1]) }); i += fm[0].length; continue; }
      pushText(); brackets.push(nodes.length); nodes.push({ t: "brk", img: false, active: true, pos: i + 1 }); i++; continue;
    }
    if (c === "]") {
      const bi = brackets.length ? brackets[brackets.length - 1] : -1;
      if (bi < 0) { text += c; i++; continue; }
      const b = nodes[bi] as Brk;
      if (!b.active) { brackets.pop(); text += c; i++; continue; }
      pushText();
      // destination: inline "(...)" or reference "[label]" / "[]" / shortcut
      let href: string | null = null; let end = i + 1;
      const rest = src.slice(i + 1);
      const im = /^\(\s*(<[^<>\n]*>|(?:[^\s()\\]|\\.|\((?:[^\s()\\]|\\.)*\))*)(?:\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?\s*\)/.exec(rest);
      const label = src.slice(b.pos, i); // reference labels match on the raw source text (CommonMark §4.7)
      if (im) { href = unescapeMd(im[1].replace(/^<|>$/g, "")); end = i + 1 + im[0].length; }
      else {
        const rm = /^\[((?:[^\]\\]|\\.){0,999})\]/.exec(rest);
        const key = rm ? normLabel(rm[1] || label) : normLabel(label);
        const ref = key ? cx.refs.get(key) : undefined;
        if (ref) { href = ref.href; end = i + 1 + (rm ? rm[0].length : 0); }
      }
      if (href === null) { brackets.pop(); nodes[bi] = { t: "text", s: b.img ? "![" : "[" }; text = "]"; i++; continue; }
      processEmphasis(nodes, bi + 1);
      const inner = finish(nodes.splice(bi + 1));
      nodes.pop(); brackets.pop();
      if (b.img) nodes.push({ t: "img", alt: plain(inner), src: href });
      else { nodes.push({ t: "link", href, c: inner }); for (const k of brackets) (nodes[k] as Brk).img || ((nodes[k] as Brk).active = false); }
      i = end; continue;
    }
    if (c === "<") {
      const am = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(src.slice(i, i + 2000)) ?? /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(src.slice(i, i + 2000));
      if (am) { pushText(); const u = am[1]; nodes.push({ t: "link", href: u.includes(":") ? u : `mailto:${u}`, c: [{ t: "text", s: u }] }); i += am[0].length; continue; }
      const hm = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*)?\/?>/.exec(src.slice(i, i + 500));
      if (hm) {
        cx.rawHtml++;
        const tag = hm[1].toLowerCase();
        if (cx.opts.rawHtml !== "text" && (tag === "br")) { pushText(); nodes.push({ t: "br" }); i += hm[0].length; continue; }
        if (cx.opts.rawHtml !== "text" && (tag === "sup" || tag === "sub")) {
          const close = src.toLowerCase().indexOf(`</${tag}>`, i + hm[0].length);
          if (!hm[0].startsWith("</") && close > 0) { pushText(); nodes.push({ t: tag, c: parseInline(src.slice(i + hm[0].length, close), cx) }); i = close + tag.length + 3; continue; }
        }
        cx.rawLit = (cx.rawLit ?? 0) + 1;
      }
      text += c; i++; continue;
    }
    if (c === "\n") {
      // hard break: two+ trailing spaces
      if (/ {2,}$/.test(text)) { text = text.replace(/ +$/, ""); pushText(); nodes.push({ t: "br" }); }
      else { text = text.replace(/ +$/, ""); text += " "; }
      i++; while (src[i] === " ") i++; continue;
    }
    text += c; i++;
  }
  pushText();
  processEmphasis(nodes, 0);
  return finish(nodes);
}
function processEmphasis(nodes: Node[], lo: number) {
  for (let ci = lo; ci < nodes.length; ci++) {
    const cl = nodes[ci];
    if (cl.t !== "delim" || !cl.close) continue;
    let oi = ci - 1;
    for (; oi >= lo; oi--) {
      const op = nodes[oi];
      if (op.t !== "delim" || !op.open || op.ch !== cl.ch) continue;
      if (cl.ch !== "~" && (op.close || cl.open) && (op.orig + cl.orig) % 3 === 0 && !(op.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
      if (cl.ch === "~" && op.n !== cl.n) continue;
      break;
    }
    if (oi < lo) { if (!cl.open) { /* cannot open either */ } continue; }
    const op = nodes[oi] as Delim;
    const use = cl.ch === "~" ? 2 : op.n >= 2 && cl.n >= 2 ? 2 : 1;
    const inner = finish(nodes.slice(oi + 1, ci).map((x) => (x.t === "delim" ? { t: "text", s: x.ch.repeat(x.n) } as Inl : x.t === "brk" ? { t: "text", s: x.img ? "![" : "[" } as Inl : x)));
    const el: Inl = { t: cl.ch === "~" ? "del" : use === 2 ? "strong" : "em", c: inner };
    op.n -= use; cl.n -= use;
    const repl: Node[] = [];
    if (op.n > 0) repl.push(op);
    repl.push(el);
    if (cl.n > 0) repl.push(cl);
    nodes.splice(oi, ci - oi + 1, ...repl);
    ci = oi + (op.n > 0 ? 1 : 0) + (cl.n > 0 ? 1 : 0) - 1;
  }
}
function finish(nodes: Node[]): Inl[] {
  const out: Inl[] = [];
  for (const x of nodes) {
    const v: Inl = x.t === "delim" ? { t: "text", s: x.ch.repeat(x.n) } : x.t === "brk" ? { t: "text", s: x.img ? "![" : "[" } : x;
    const last = out[out.length - 1];
    if (v.t === "text" && last?.t === "text") last.s += v.s; else if (!(v.t === "text" && !v.s)) out.push(v.t === "text" ? { t: "text", s: v.s } : v);
  }
  return out;
}
export function plain(c: Inl[]): string {
  return c.map((x) => (x.t === "text" || x.t === "code" ? x.s : x.t === "img" ? x.alt : x.t === "br" ? "\n" : x.t === "fn" ? "" : plain(x.c))).join("");
}

function resolveInlines(blocks: MdBlock[], cx: PCtx) {
  const res = (c: Inl[]): Inl[] => (c.length === 1 && c[0].t === "text" && c[0].s.startsWith("\u0000P") ? parseInline(c[0].s.slice(2).replace(/[ \t]+$/, ""), cx) : c);
  for (const b of blocks) {
    if (b.k === "p" || b.k === "h") b.c = res(b.c);
    else if (b.k === "quote") resolveInlines(b.blocks, cx);
    else if (b.k === "list") for (const it of b.items) resolveInlines(it, cx);
    else if (b.k === "table") b.rows = b.rows.map((r) => r.map(res));
  }
}

export function parseMarkdown(md: string, opts: MdOptions = {}): MdDoc & { rawHtml: number; rawLiteral: number } {
  if (md.length > MAX_INPUT) throw new Error(`markdown larger than ${MAX_INPUT} bytes`);
  const lines = md.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "\ufffd").split("\n").map(expandTabs);
  const cx: PCtx = { refs: new Map(), notes: new Map(), noteRaw: new Map(), opts, depth: 0, rawHtml: 0 };
  const blocks = parseBlocksMd(lines, cx);
  for (const [label, raw] of cx.noteRaw) cx.notes.set(label, parseBlocksMd(raw, cx));
  resolveInlines(blocks, cx);
  for (const nb of cx.notes.values()) resolveInlines(nb, cx);
  return { blocks, notes: cx.notes, rawHtml: cx.rawHtml, rawLiteral: cx.rawLit ?? 0 };
}

/* ================================================================ DOCX writer */
const xe = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
interface RunFmt { b?: boolean; i?: boolean; s?: boolean; sup?: boolean; sub?: boolean; code?: boolean; link?: boolean }
interface WCtx {
  rels: { id: string; type: string; target: string; external?: boolean }[];
  media: { name: string; mime: string; data: Uint8Array }[];
  nums: { ordered: boolean; start: number; depth: number }[];
  noteIds: Map<string, number>; noteOrder: string[];
  doc: MdDoc; opts: MdOptions;
  loss: Map<string, number>; pic: number;
}
const lose = (w: WCtx, what: string) => w.loss.set(what, (w.loss.get(what) ?? 0) + 1);
function runXml(text: string, f: RunFmt): string {
  const rpr = [f.link ? '<w:rStyle w:val="Hyperlink"/>' : f.code ? '<w:rStyle w:val="VerbatimChar"/>' : "", f.b ? "<w:b/>" : "", f.i ? "<w:i/>" : "", f.s ? "<w:strike/>" : "", f.sup ? '<w:vertAlign w:val="superscript"/>' : f.sub ? '<w:vertAlign w:val="subscript"/>' : ""].join("");
  const parts = text.split("\t").map((t) => (t ? `<w:t xml:space="preserve">${xe(t)}</w:t>` : "")).join("<w:tab/>");
  return parts ? `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}${parts}</w:r>` : "";
}
function imageDims(d: Uint8Array, mime: string): [number, number] | null {
  if (mime === "image/png" && d.length > 24) return [(d[16] << 24 | d[17] << 16 | d[18] << 8 | d[19]) >>> 0, (d[20] << 24 | d[21] << 16 | d[22] << 8 | d[23]) >>> 0];
  if (mime === "image/gif" && d.length > 10) return [d[6] | d[7] << 8, d[8] | d[9] << 8];
  if (mime === "image/jpeg") {
    let p = 2;
    while (p + 9 < d.length) {
      if (d[p] !== 0xff) { p++; continue; }
      const mk = d[p + 1]; const len = d[p + 2] << 8 | d[p + 3];
      if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return [d[p + 7] << 8 | d[p + 8], d[p + 5] << 8 | d[p + 6]];
      p += 2 + len;
    }
  }
  return null;
}
function dataUri(src: string): { mime: string; data: Uint8Array } | null {
  const m = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(src.trim());
  if (!m) return null;
  try { const bin = atob(m[2].replace(/\s+/g, "")); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k); return { mime: m[1].toLowerCase(), data: u }; } catch { return null; }
}
function picture(w: WCtx, img: { mime: string; data: Uint8Array }, alt: string): string | null {
  const dims = imageDims(img.data, img.mime);
  if (!dims || !dims[0] || !dims[1] || dims[0] > 65535 || dims[1] > 65535) return null;
  const ext = img.mime === "image/jpeg" ? "jpeg" : img.mime.split("/")[1];
  const name = `image${w.media.length + 1}.${ext}`;
  w.media.push({ name, mime: img.mime, data: img.data });
  const rid = `rId${w.rels.length + 10}`;
  w.rels.push({ id: rid, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image", target: `media/${name}` });
  const maxW = 5486400; let cx = dims[0] * 9525; let cy = dims[1] * 9525;
  if (cx > maxW) { cy = Math.round(cy * maxW / cx); cx = maxW; }
  const id = ++w.pic;
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${xe(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}" descr="${xe(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}
function inlXml(w: WCtx, c: Inl[], f: RunFmt): string {
  let out = "";
  for (const x of c) {
    switch (x.t) {
      case "text": out += runXml(x.s.replace(/\n/g, " "), f); break;
      case "code": out += runXml(x.s, { ...f, code: true }); break;
      case "br": out += "<w:r><w:br/></w:r>"; break;
      case "em": out += inlXml(w, x.c, { ...f, i: true }); break;
      case "strong": out += inlXml(w, x.c, { ...f, b: true }); break;
      case "del": out += inlXml(w, x.c, { ...f, s: true }); break;
      case "sup": out += inlXml(w, x.c, { ...f, sup: true, sub: false }); break;
      case "sub": out += inlXml(w, x.c, { ...f, sub: true, sup: false }); break;
      case "fn": {
        let id = w.noteIds.get(x.label);
        if (id === undefined) { id = w.noteIds.size + 1; w.noteIds.set(x.label, id); w.noteOrder.push(x.label); }
        out += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`; break;
      }
      case "img": {
        const img = dataUri(x.src) ?? w.opts.images?.get(x.src) ?? null;
        const pic = img ? picture(w, img, x.alt) : null;
        if (pic) { out += pic; break; }
        lose(w, img ? "pictures in a format DOCX cannot embed (alt text kept)" : "pictures not embedded — remote/relative sources are never fetched (alt text kept)");
        out += runXml(x.alt, f); break;
      }
      case "link": {
        const href = safeHref(x.href);
        if (!href) { lose(w, "links with an unsafe or invalid target (text kept)"); out += inlXml(w, x.c, f); break; }
        const inner = inlXml(w, x.c, { ...f, link: true });
        if (!inner) { lose(w, "links with no visible content (e.g. a badge picture that was not embedded)"); break; }
        if (href.startsWith("#")) { out += `<w:hyperlink w:anchor="${xe(href.slice(1))}">${inner}</w:hyperlink>`; break; }
        let rel = w.rels.find((r) => r.external && r.target === href);
        if (!rel) { rel = { id: `rId${w.rels.length + 10}`, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", target: uriTarget(href), external: true }; w.rels.push(rel); }
        out += `<w:hyperlink r:id="${rel.id}">${inner}</w:hyperlink>`; break;
      }
    }
  }
  return out;
}
const JC: Record<string, string> = { l: "left", c: "center", r: "right" };
function blocksXml(w: WCtx, blocks: MdBlock[], env: { quote: number; list?: { num: number; depth: number; first: boolean } } = { quote: 0 }): string {
  let out = "";
  const pPr = (extra = "", style?: string) => {
    const st = style ?? (env.quote ? "Quote" : env.list ? "ListParagraph" : "");
    const ind = env.quote && env.list ? "" : env.quote > 1 ? `<w:ind w:left="${720 * env.quote}"/>` : "";
    const num = env.list && env.list.first ? `<w:numPr><w:ilvl w:val="${env.list.depth}"/><w:numId w:val="${env.list.num}"/></w:numPr>` : "";
    const cont = env.list && !env.list.first ? `<w:ind w:left="${720 * (env.list.depth + 1)}"/>` : "";
    const inner = `${st ? `<w:pStyle w:val="${st}"/>` : ""}${num}${extra}${ind || cont}`;
    if (env.list) env.list.first = false;
    return inner ? `<w:pPr>${inner}</w:pPr>` : "";
  };
  for (const b of blocks) {
    switch (b.k) {
      case "h": out += `<w:p>${pPr("", `Heading${b.level}`)}${inlXml(w, b.c, {})}</w:p>`; break;
      case "p": out += `<w:p>${pPr()}${inlXml(w, b.c, {})}</w:p>`; break;
      case "code": out += `<w:p>${pPr("", "SourceCode")}${b.text.split("\n").map((l, k) => (k ? "<w:r><w:br/></w:r>" : "") + runXml(l, {})).join("")}</w:p>`; break;
      case "hr": out += `<w:p>${pPr('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>')}</w:p>`; break;
      case "quote": out += blocksXml(w, b.blocks, { quote: env.quote + 1, list: env.list }); break;
      case "list": {
        const depth = env.list ? Math.min(8, env.list.depth + 1) : 0;
        if (env.list && env.list.depth >= 8) lose(w, "list levels deeper than 9 (kept at level 9)");
        w.nums.push({ ordered: b.ordered, start: b.start, depth });
        const num = w.nums.length;
        for (const it of b.items) {
          const first = it.length ? it[0] : null;
          const lenv = { quote: env.quote, list: { num, depth, first: true } };
          if (!first || (first.k !== "p" && first.k !== "h")) { // an item that starts with code / a quote / a list: its marker gets an empty numbered paragraph
            out += `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${depth}"/><w:numId w:val="${num}"/></w:numPr></w:pPr></w:p>`;
            lenv.list.first = false;
          }
          out += blocksXml(w, it, lenv);
        }
        break;
      }
      case "table": {
        const cols = Math.max(1, ...b.rows.map((r) => r.length));
        const width = Math.floor(9000 / cols);
        out += `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>`;
        b.rows.forEach((r, ri) => {
          out += `<w:tr>${ri === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}`;
          for (let k = 0; k < cols; k++) {
            const jc = JC[b.align[k] ?? ""];
            out += `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p>${jc ? `<w:pPr><w:jc w:val="${jc}"/></w:pPr>` : ""}${inlXml(w, r[k] ?? [], {})}</w:p></w:tc>`;
          }
          out += "</w:tr>";
        });
        out += "</w:tbl>";
        if (env.list || env.quote) lose(w, "tables inside lists or quotes (written at body level)");
        break;
      }
    }
  }
  return out;
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
function stylesXml(): string {
  const h = [32, 26, 24, 22, 22, 22].map((sz, k) => `<w:style w:type="paragraph" w:styleId="Heading${k + 1}"><w:name w:val="heading ${k + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${k < 2 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${k}"/></w:pPr><w:rPr><w:b/>${k >= 3 ? "<w:i/>" : ""}<w:color w:val="1F3864"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`).join("");
  return `${HEAD}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${h}`
    + `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="A5A5A5"/></w:pBdr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>`
    + `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>`
    + `<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>`
    + `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`
    + `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>`
    + `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`
    + `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr></w:tblStylePr></w:style>`
    + `</w:styles>`;
}
const BULLETS = ["•", "◦", "▪"];
function numberingXml(nums: WCtx["nums"]): string {
  const abs = nums.map((n, k) => {
    const lvls = Array.from({ length: 9 }, (_, l) => `<w:lvl w:ilvl="${l}"><w:start w:val="${l === n.depth ? Math.max(0, n.start) : 1}"/><w:numFmt w:val="${n.ordered ? "decimal" : "bullet"}"/><w:lvlText w:val="${n.ordered ? `%${l + 1}.` : BULLETS[l % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr>${n.ordered ? "" : '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr>'}</w:lvl>`).join("");
    return `<w:abstractNum w:abstractNumId="${k}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
  }).join("");
  return `${HEAD}<w:numbering ${NS}>${abs}${nums.map((_, k) => `<w:num w:numId="${k + 1}"><w:abstractNumId w:val="${k}"/></w:num>`).join("")}</w:numbering>`;
}

export interface MdToDocxResult { bytes: Uint8Array; loss: string[]; stats: { blocks: number; notes: number; pictures: number; links: number; lists: number } }
/** A relationship Target must be an xs:anyURI (RFC 3986): characters URIs disallow are percent-encoded (existing %XX
 *  kept), and a relative reference whose first segment holds ":" gets "./" so it cannot read as a scheme. */
export function uriTarget(h: string): string {
  const enc = (c: string) => { try { return encodeURIComponent(c); } catch { return "%EF%BF%BD"; } };
  let s = h.replace(/%(?![0-9A-Fa-f]{2})/g, "%25").replace(/[\ud800-\udbff][\udc00-\udfff]|[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, enc);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && s.split(/[/?#]/)[0].includes(":")) s = `./${s}`;
  return s;
}
export async function markdownToDocx(md: string, opts: MdOptions = {}): Promise<MdToDocxResult> {
  const doc = parseMarkdown(md, opts);
  const w: WCtx = { rels: [], media: [], nums: [], noteIds: new Map(), noteOrder: [], doc, opts, loss: new Map(), pic: 0 };
  if (doc.rawHtml && opts.rawHtml === "text") w.loss.set("raw HTML tags (kept as literal text, never interpreted)", doc.rawHtml);
  else if (doc.rawLiteral) w.loss.set("raw HTML tags other than <sup> <sub> <br> (kept as literal text, never interpreted)", doc.rawLiteral);
  let body = blocksXml(w, doc.blocks);
  if (!body) body = "<w:p/>";
  // footnotes: written in first-reference order; a note referenced only from another note is appended as it is met
  let notes = "";
  for (let k = 0; k < w.noteOrder.length; k++) {
    const label = w.noteOrder[k]; const id = w.noteIds.get(label)!;
    const nb = doc.notes.get(label) ?? [];
    let inner = blocksXml(w, nb);
    const ref = `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>`;
    inner = inner.startsWith("<w:p>") ? inner.replace(/^<w:p>(<w:pPr>.*?<\/w:pPr>)?/, (m0, pp: string | undefined) => `<w:p>${pp ? pp.replace("<w:pPr>", '<w:pPr><w:pStyle w:val="FootnoteText"/>').replace(/<w:pStyle w:val="FootnoteText"\/><w:pStyle w:val="[^"]*"\/>/, '<w:pStyle w:val="FootnoteText"/>') : '<w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>'}${ref}`) : `<w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${ref}</w:p>${inner}`;
    notes += `<w:footnote w:id="${id}">${inner}</w:footnote>`;
  }
  const unused = [...doc.notes.keys()].filter((l) => !w.noteIds.has(l)).length;
  if (unused) w.loss.set("footnote definitions never referenced (omitted, as in CommonMark renderers)", unused);
  const hasNotes = w.noteOrder.length > 0;
  const rels = [
    { id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml" },
    { id: "rId2", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering", target: "numbering.xml" },
    { id: "rId3", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", target: "settings.xml" },
    ...(hasNotes ? [{ id: "rId4", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes", target: "footnotes.xml" }] : []),
    ...w.rels,
  ];
  const sect = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const files: { name: string; data: string | Uint8Array }[] = [
    { name: "[Content_Types].xml", data: `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...new Set(w.media.map((m) => m.name.split(".").pop()!))].map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join("")}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${hasNotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : ""}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: "_rels/.rels", data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: "docProps/core.xml", data: `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>OST Writer</dc:creator></cp:coreProperties>` },
    { name: "word/_rels/document.xml.rels", data: `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xe(r.target)}"${(r as { external?: boolean }).external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>` },
    { name: "word/document.xml", data: `${HEAD}<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>` },
    { name: "word/styles.xml", data: stylesXml() },
    { name: "word/numbering.xml", data: numberingXml(w.nums.length ? w.nums : [{ ordered: false, start: 1, depth: 0 }]) },
    { name: "word/settings.xml", data: `${HEAD}<w:settings ${NS}>${hasNotes ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : ""}<w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>` },
    ...(hasNotes ? [{ name: "word/footnotes.xml", data: `${HEAD}<w:footnotes ${NS}><w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes}</w:footnotes>` }] : []),
    ...w.media.map((m) => ({ name: `word/media/${m.name}`, data: m.data })),
  ];
  const bytes = await writeZip(files);
  const countB = (bs: MdBlock[]): number => bs.reduce((a, b) => a + (b.k === "quote" ? countB(b.blocks) : b.k === "list" ? b.items.reduce((s, it) => s + countB(it), 0) : 1), 0);
  return {
    bytes,
    loss: [...w.loss].map(([k, v]) => `${v} ${k}`),
    stats: { blocks: countB(doc.blocks), notes: w.noteOrder.length, pictures: w.media.length, links: w.rels.filter((r) => r.external).length, lists: w.nums.length },
  };
}
