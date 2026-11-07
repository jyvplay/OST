/**
 * TT139 (FF-73) — Markdown → HTML renderer with a strict structural contract.
 *
 * Why this is not marked here: the shell renders user Markdown in Notes, in the
 * Editor preview and in Books annotations, and "we sanitise with innerHTML" is
 * exactly the failure mode that turns a note into an XSS vector. This renderer
 * never emits a raw tag from the source. It builds an *element tree* first, and
 * only a fixed, closed set of element names can ever reach the serialiser, so
 * the escape step is structural rather than a post-hoc regex over a string that
 * already contains markup.
 *
 * Supported (deliberately finite, and stated in the UI):
 *   headings ATX (1–6), fenced code (``` / ~~~ with info string), indented code,
 *   block quotes (nested, with lazy continuation), unordered/ordered lists with
 *   nesting, task lists, tables with alignment, thematic breaks, paragraphs with
 *   hard line breaks, inline code, emphasis/strong (both `*`/`_` delimiters with
 *   the CommonMark flanking rules), strikethrough, links with title and angle
 *   destinations, images (rendered as a link + alt text, never auto-fetched),
 *   autolinks, backslash escapes and numeric/named character references.
 *
 * Not supported, and reported as literal text instead of being guessed at:
 *   raw HTML (it is escaped, never parsed), footnotes, definition lists,
 *   setext headings, reference-style links, and every CommonMark extension that
 *   would need a bracketed parser state machine.
 *
 * Bounds: input ≤ 1 MiB, ≤ 20 000 output nodes, ≤ 32 levels of nesting. Beyond
 * any bound the renderer refuses with an error rather than truncating silently —
 * a preview that silently drops text is worse than one that says "too large".
 */

export const MD_MAX_INPUT = 1 << 20;
export const MD_MAX_NODES = 20_000;
export const MD_MAX_DEPTH = 32;

export type MdNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string; lang: string | null }
  | { type: "em"; children: MdNode[] }
  | { type: "strong"; children: MdNode[] }
  | { type: "del"; children: MdNode[] }
  | { type: "link"; href: string; title: string | null; children: MdNode[] }
  | { type: "break" }
  | { type: "img"; src: string; alt: string; title: string | null };

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MdNode[] }
  | { type: "paragraph"; children: MdNode[] }
  | { type: "code"; text: string; lang: string | null }
  | { type: "blockquote"; blocks: MdBlock[] }
  | { type: "list"; ordered: boolean; start: number; tight: boolean; items: MdBlock[][] }
  | { type: "hr" }
  | { type: "table"; align: (null | "left" | "center" | "right")[]; head: MdNode[][]; rows: MdNode[][][] };

class Bounds {
  nodes = 0;
  bump(n = 1) {
    this.nodes += n;
    if (this.nodes > MD_MAX_NODES) throw new Error(`markdown: more than ${MD_MAX_NODES} nodes`);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "\u00a9", reg: "\u00ae",
  trade: "\u2122", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", laquo: "\u00ab", raquo: "\u00bb",
  lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", times: "\u00d7", divide: "\u00f7",
  deg: "\u00b0", plusmn: "\u00b1", micro: "\u00b5", para: "\u00b6", sect: "\u00a7", middot: "\u00b7",
  bull: "\u2022", dagger: "\u2020", Dagger: "\u2021", permil: "\u2030", prime: "\u2032", Prime: "\u2033",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", larr: "\u2190", uarr: "\u2191",
  rarr: "\u2192", darr: "\u2193", harr: "\u2194", rArr: "\u21d2", lArr: "\u21d0", hArr: "\u21d4",
  infin: "\u221e", ne: "\u2260", le: "\u2264", ge: "\u2265", asymp: "\u2248", equiv: "\u2261",
  sum: "\u2211", prod: "\u220f", radic: "\u221a", part: "\u2202", int: "\u222b", there4: "\u2234",
  frac12: "\u00bd", frac14: "\u00bc", frac34: "\u00be", sup2: "\u00b2", sup3: "\u00b3",
  alpha: "\u03b1", beta: "\u03b2", gamma: "\u03b3", delta: "\u03b4", epsilon: "\u03b5", lambda: "\u03bb",
  mu: "\u03bc", pi: "\u03c0", sigma: "\u03c3", tau: "\u03c4", phi: "\u03c6", omega: "\u03c9",
  Delta: "\u0394", Sigma: "\u03a3", Omega: "\u03a9", check: "\u2713", cross: "\u2717", star: "\u2606",
  hearts: "\u2665", spades: "\u2660", clubs: "\u2663", diams: "\u2666",
};

const CP1252: Record<number, string> = {
  128: "\u20ac", 130: "\u201a", 131: "\u0192", 132: "\u201e", 133: "\u2026", 134: "\u2020",
  135: "\u2021", 136: "\u02c6", 137: "\u2030", 138: "\u0160", 139: "\u2039", 140: "\u0152",
  142: "\u017d", 145: "\u2018", 146: "\u2019", 147: "\u201c", 148: "\u201d", 149: "\u2022",
  150: "\u2013", 151: "\u2014", 152: "\u02dc", 153: "\u2122", 154: "\u0161", 155: "\u203a",
  156: "\u0153", 158: "\u017e", 159: "\u0178",
};

/** Decode one run of character references. Invalid references stay literal. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      if (CP1252[code]) return CP1252[code];
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isPunct = (c: string) => /[!-/:-@[-`{-~\u00a1-\u00bf\u2010-\u2027\u2030-\u205e]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** CommonMark 0.30 §6.2 "flanking" predicates, computed once per delimiter run. */
export function delimiterFlanking(prev: string | null, next: string | null, marker: string) {
  const nextIsSpace = next === null || isSpace(next);
  const prevIsSpace = prev === null || isSpace(prev);
  const nextIsPunct = next !== null && isPunct(next);
  const prevIsPunct = prev !== null && isPunct(prev);
  const left = !nextIsSpace && (!nextIsPunct || prevIsSpace || prevIsPunct);
  const right = !prevIsSpace && (!prevIsPunct || nextIsSpace || nextIsPunct);
  if (marker === "_") return { canOpen: left && (!right || prevIsPunct), canClose: right && (!left || nextIsPunct) };
  return { canOpen: left, canClose: right };
}

// ── inline parser ────────────────────────────────────────────────────────────

interface Delim { pos: number; count: number; orig: number; marker: string; canOpen: boolean; canClose: boolean }

/**
 * Inline parse. Delimiter runs are matched with the CommonMark "look for an
 * opener, then consume min(count)" rule; a run that never finds a partner is
 * emitted as literal text. Nothing here rewrites text in place, so an
 * unmatched `*` can never swallow the rest of the paragraph.
 */
export function parseInline(src: string, bounds = new Bounds(), depth = 0): MdNode[] {
  if (depth > MD_MAX_DEPTH) throw new Error(`markdown: nesting deeper than ${MD_MAX_DEPTH}`);
  const out: MdNode[] = [];
  let buf = "";
  const flush = () => { if (buf) { bounds.bump(); out.push({ type: "text", text: decodeEntities(buf) }); buf = ""; } };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    // backslash escape
    if (ch === "\\" && i + 1 < n) {
      const nxt = src[i + 1];
      if (nxt === "\n") { flush(); bounds.bump(); out.push({ type: "break" }); i += 2; while (src[i] === " " || src[i] === "\t") i++; continue; }
      if (isPunct(nxt) || nxt === " ") { buf += nxt; i += 2; continue; }
      buf += ch; i++; continue;
    }
    // hard line break: two or more trailing spaces then newline
    if (ch === "\n") {
      const trailing = / {2,}$/.test(buf);
      if (trailing) { buf = buf.replace(/ +$/, ""); flush(); bounds.bump(); out.push({ type: "break" }); }
      else { buf = buf.replace(/[ \t]+$/, ""); buf += "\n"; }
      i++; while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }
    // code span
    if (ch === "`") {
      let run = 0; while (src[i + run] === "`") run++;
      const fence = "`".repeat(run);
      const close = src.indexOf(fence, i + run);
      // A closing run must not be part of a longer run.
      let at = close;
      while (at !== -1) {
        let endRun = at; while (src[endRun] === "`") endRun++;
        if (endRun - at === run) break;
        at = src.indexOf(fence, endRun);
      }
      if (at !== -1) {
        let body = src.slice(i + run, at).replace(/\n/g, " ");
        if (/^ .*[^ ].* $/.test(body) || /^ .* $/.test(body)) body = body.slice(1, -1);
        flush(); bounds.bump(); out.push({ type: "code", text: decodeEntities(body), lang: null });
        i = at + run; continue;
      }
      buf += fence; i += run; continue;
    }
    // images and links
    if (ch === "!" && src[i + 1] === "[") { const r = tryLink(src, i + 1, bounds, depth, true); if (r) { flush(); bounds.bump(); out.push(r.node); i = r.next; continue; } }
    if (ch === "[") { const r = tryLink(src, i, bounds, depth, false); if (r) { flush(); bounds.bump(); out.push(r.node); i = r.next; continue; } }
    // autolink
    if (ch === "<") {
      const m = /^<((?:https?|mailto|ftp):[^\s<>]+|[^\s<>@]+@[^\s<>]+\.[A-Za-z]{2,})>/.exec(src.slice(i));
      if (m) {
        const target = m[1];
        const href = target.includes("@") && !/^[a-z]+:/i.test(target) ? `mailto:${target}` : target;
        if (safeHref(href)) {
          flush(); bounds.bump();
          out.push({ type: "link", href, title: null, children: [{ type: "text", text: target }] });
          i += m[0].length; continue;
        }
      }
      const auto = /^(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!'"?]/.exec(src.slice(i));
      if (auto && i === 0) { /* bare autolinks are handled by the text pass below */ }
      buf += ch; i++; continue;
    }
    // emphasis delimiters
    if (ch === "*" || ch === "_" || ch === "~") {
      let run = 0; while (src[i + run] === ch) run++;
      const marker = ch;
      if (marker === "~" && run < 2) { buf += ch; i += 1; continue; }
      const prev = i === 0 ? null : src[i - 1];
      const next = i + run >= n ? null : src[i + run];
      const { canOpen, canClose } = delimiterFlanking(prev, next, marker);
      const minRun = marker === "~" ? 2 : 1;
      if (run < minRun) { buf += marker.repeat(run); i += run; continue; }
      // find a closer for this run (respecting the same marker and the triple rule)
      const want = run >= 2 ? 2 : 1;
      let j = i + run;
      let found = -1, foundLen = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "`") { const r2 = (() => { let k = 0; while (src[j + k] === "`") k++; return k; })(); const e = src.indexOf("`".repeat(r2), j + r2); j = e === -1 ? j + r2 : e + r2; continue; }
        if (src[j] !== marker) { j++; continue; }
        let k = 0; while (src[j + k] === marker) k++;
        if (k < minRun) { j += k; continue; }
        const pPrev = j === 0 ? null : src[j - 1];
        const pNext = j + k >= n ? null : src[j + k];
        const f = delimiterFlanking(pPrev, pNext, marker);
        if (canOpen && f.canClose) { found = j; foundLen = k; break; }
        j += k;
      }
      if (found === -1) { buf += marker.repeat(run); i += run; continue; }
      const inner = src.slice(i + run, found);
      if (inner.length === 0) { buf += marker.repeat(run); i += run; continue; }
      const children = parseInline(inner, bounds, depth + 1);
      flush();
      // `***a***` is <strong><em>a</em></strong>: a run of three on both sides
      // can satisfy both, so the strong node wraps an em node (three stray
      // asterisks would be the wrong answer). A run of three closed by two
      // stays `*<strong>a</strong>`, which is what CommonMark produces.
      const both = run >= 3 && foundLen >= 3;
      const type = marker === "~" ? "del" : want >= 2 || foundLen >= 2 ? "strong" : "em";
      const use = both ? 3 : type === "strong" ? 2 : 1;
      bounds.bump();
      const node: MdNode = { type, children } as MdNode;
      if (both && node.type === "strong") node.children = [{ type: "em", children }];
      out.push(node);
      // leftover delimiter characters stay as text (e.g. ***x** → *<strong>x</strong>)
      const leftoverOpen = run - use, leftoverClose = foundLen - use;
      if (leftoverOpen > 0) out.splice(out.length - 1, 0, { type: "text", text: marker.repeat(leftoverOpen) });
      i = found + use;
      if (leftoverClose > 0) { buf += marker.repeat(leftoverClose); i += leftoverClose; }
      continue;
    }
    buf += ch; i++;
  }
  flush();
  return autolinkBare(out, bounds);
}

function safeHref(href: string): boolean {
  const h = href.trim().toLowerCase();
  if (/^(javascript|vbscript|data|file|blob):/.test(h)) return false;
  return true;
}

function tryLink(src: string, open: number, bounds: Bounds, depth: number, image: boolean): { node: MdNode; next: number } | null {
  // scan for the matching ] honouring nesting and escapes
  let level = 0, j = open;
  const n = src.length;
  for (; j < n; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") { let k = 0; while (src[j + k] === "`") k++; const e = src.indexOf("`".repeat(k), j + k); if (e !== -1) { j = e + k - 1; continue; } }
    if (c === "[") level++;
    else if (c === "]") { level--; if (level === 0) break; }
  }
  if (j >= n) return null;
  const label = src.slice(open + 1, j);
  if (src[j + 1] !== "(") {
    if (image) return null;
    return null; // reference-style links are not supported: leave as text
  }
  // destination: <...> or a run without spaces, then an optional "title"
  let k = j + 2;
  while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  let dest = "";
  if (src[k] === "<") {
    const end = src.indexOf(">", k + 1);
    if (end === -1) return null;
    dest = src.slice(k + 1, end); k = end + 1;
  } else {
    let paren = 0;
    const start = k;
    for (; k < n; k++) {
      const c = src[k];
      if (c === "\\") { k++; continue; }
      if (c === "(") paren++;
      else if (c === ")") { if (paren === 0) break; paren--; }
      else if (c === " " || c === "\t" || c === "\n") break;
    }
    dest = src.slice(start, k);
  }
  while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  let title: string | null = null;
  const q = src[k];
  if (q === '"' || q === "'" || q === "(") {
    const closeCh = q === "(" ? ")" : q;
    let t = k + 1, tbuf = "";
    for (; t < n; t++) { if (src[t] === "\\") { tbuf += src[t + 1] ?? ""; t++; continue; } if (src[t] === closeCh) break; tbuf += src[t]; }
    if (t >= n) return null;
    title = decodeEntities(tbuf); k = t + 1;
    while (src[k] === " " || src[k] === "\t" || src[k] === "\n") k++;
  }
  if (src[k] !== ")") return null;
  if (!safeHref(dest)) return null;
  const children = parseInline(label, bounds, depth + 1);
  return {
    node: image
      ? { type: "img", src: dest, alt: plainText(children), title }
      : { type: "link", href: dest, title, children },
    next: k + 1,
  };
}

/** Turn bare http(s) URLs in text nodes into links, without touching code spans. */
function autolinkBare(nodes: MdNode[], bounds: Bounds): MdNode[] {
  const re = /(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>().,;:!'"?])/;
  const out: MdNode[] = [];
  for (const node of nodes) {
    if (node.type !== "text") { out.push(node); continue; }
    let rest = node.text;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
      const lead = m[1], url = m[2];
      const idx = m.index + lead.length;
      if (idx > 0) out.push({ type: "text", text: rest.slice(0, idx) });
      bounds.bump(2);
      out.push({ type: "link", href: url, title: null, children: [{ type: "text", text: url }] });
      rest = rest.slice(idx + url.length);
    }
    if (rest) out.push({ type: "text", text: rest });
  }
  return out;
}

export function plainText(nodes: MdNode[]): string {
  let s = "";
  for (const n of nodes) {
    if (n.type === "text" || n.type === "code") s += n.text;
    else if (n.type === "break") s += "\n";
    else if (n.type === "img") s += n.alt;
    else s += plainText(n.children);
  }
  return s;
}

// ── block parser ─────────────────────────────────────────────────────────────

interface Line { text: string; no: number }

const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*[^`]*)?$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const HR_RE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const UL_RE = /^( {0,3})([-+*])([ \t]+)(.*)$/;
const OL_RE = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

export function parseMarkdown(src: string): MdBlock[] {
  if (typeof src !== "string") throw new TypeError("markdown: input must be a string");
  if (src.length > MD_MAX_INPUT) throw new Error(`markdown: input ${src.length} bytes exceeds ${MD_MAX_INPUT}`);
  const text = src.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\uFFFD");
  const lines: Line[] = text.split("\n").map((t, no) => ({ text: t, no }));
  const bounds = new Bounds();
  return parseBlocks(lines, bounds, 0);
}

function parseBlocks(lines: Line[], bounds: Bounds, depth: number): MdBlock[] {
  if (depth > MD_MAX_DEPTH) throw new Error(`markdown: block nesting deeper than ${MD_MAX_DEPTH}`);
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].text;
    if (/^\s*$/.test(line)) { i++; continue; }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0].repeat(fence[2].length);
      const indent = fence[1].length;
      const lang = (fence[3] ?? "").trim().split(/\s+/)[0] || null;
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const l = lines[i].text;
        const close = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
        if (close.test(l)) { closed = true; i++; break; }
        body.push(l.slice(Math.min(indent, l.length - l.trimStart().length)));
        i++;
      }
      bounds.bump(1 + body.length);
      out.push({ type: "code", text: body.join("\n"), lang });
      void closed; // an unclosed fence still ends at EOF, per CommonMark
      continue;
    }

    if (HR_RE.test(line)) { bounds.bump(); out.push({ type: "hr" }); i++; continue; }

    const atx = ATX_RE.exec(line);
    if (atx) {
      bounds.bump();
      out.push({ type: "heading", level: atx[1].length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline((atx[2] ?? "").trim(), bounds, depth + 1) });
      i++; continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: Line[] = [];
      while (i < lines.length) {
        const l = lines[i].text;
        const q = /^ {0,3}>[ \t]?(.*)$/.exec(l);
        if (q) { inner.push({ text: q[1], no: lines[i].no }); i++; continue; }
        if (/^\s*$/.test(l)) {
          // a blank line ends the quote unless the next non-blank line is also quoted
          let j = i + 1;
          while (j < lines.length && /^\s*$/.test(lines[j].text)) j++;
          if (j < lines.length && /^ {0,3}>/.test(lines[j].text)) { inner.push({ text: "", no: lines[i].no }); i++; continue; }
          break;
        }
        if (inner.length && !/^\s*$/.test(inner[inner.length - 1].text)) { inner.push({ text: l, no: lines[i].no }); i++; continue; } // lazy continuation
        break;
      }
      bounds.bump();
      out.push({ type: "blockquote", blocks: parseBlocks(inner, bounds, depth + 1) });
      continue;
    }

    // table: header row, delimiter row, then body rows until a blank line
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM_RE.test(lines[i + 1].text) && lines[i + 1].text.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1].text).map((c) => {
        const l = c.trim();
        const left = l.startsWith(":"), right = l.endsWith(":");
        return left && right ? "center" : left ? "left" : right ? "right" : null;
      });
      if (head.length === align.length) {
        const rows: MdNode[][][] = [];
        i += 2;
        while (i < lines.length && lines[i].text.includes("|") && !/^\s*$/.test(lines[i].text)) {
          const cells = splitRow(lines[i].text);
          if (cells.length === 0) break;
          const row: MdNode[][] = [];
          for (let c = 0; c < align.length; c++) row.push(parseInline((cells[c] ?? "").trim(), bounds, depth + 1));
          rows.push(row); bounds.bump(1 + align.length);
          i++;
        }
        bounds.bump(1 + align.length);
        out.push({ type: "table", align: align as (null | "left" | "center" | "right")[], head: head.map((c) => parseInline(c.trim(), bounds, depth + 1)), rows });
        continue;
      }
    }

    const ul = UL_RE.exec(line), ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const start = ordered ? Number(ol![2]) : 1;
      const markerChar = ordered ? ol![3] : ul![2];
      const items: MdBlock[][] = [];
      let tight = true;
      while (i < lines.length) {
        const m = (ordered ? OL_RE : UL_RE).exec(lines[i].text);
        if (!m) break;
        const sameMarker = (ordered ? m[3] : m[2]) === markerChar || (!ordered && "+-*".includes(m[2]));
        if (!sameMarker) break;
        const contentIndent = m[0].length - m[m.length - 1].length;
        const firstLine = m[m.length - 1];
        const itemLines: Line[] = [{ text: " ".repeat(contentIndent) + firstLine, no: lines[i].no }];
        i++;
        // continuation: any further line until a blank line followed by a new item or a non-indented block
        let sawBlank = false;
        while (i < lines.length) {
          const l = lines[i].text;
          if (/^\s*$/.test(l)) {
            const nextItem = i + 1 < lines.length && ((ordered ? OL_RE : UL_RE).test(lines[i + 1].text));
            const indented = i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1].text);
            if (nextItem || !indented) break;
            sawBlank = true; itemLines.push({ text: "", no: lines[i].no }); i++; continue;
          }
          if (/^\s{1,}\S/.test(l) || !((ordered ? OL_RE : UL_RE).test(l))) {
            const strip = Math.min(contentIndent, l.length - l.trimStart().length);
            itemLines.push({ text: l.slice(strip), no: lines[i].no }); i++;
            continue;
          }
          break;
        }
        if (sawBlank) tight = false;
        items.push(dedupeTask(parseBlocks(itemLines, bounds, depth + 1), lines));
      }
      bounds.bump(1 + items.length);
      out.push({ type: "list", ordered, start, tight, items });
      continue;
    }

    // indented code block (4 spaces) — only when not inside a list continuation
    if (/^ {4}/.test(line) && !/^ {4}\s*$/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^ {4}/.test(lines[i].text) || /^\s*$/.test(lines[i].text))) {
        body.push(lines[i].text.slice(4)); i++;
      }
      while (body.length && /^\s*$/.test(body[body.length - 1])) body.pop();
      bounds.bump(1 + body.length);
      out.push({ type: "code", text: body.join("\n"), lang: null });
      continue;
    }

    // paragraph
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i].text)) {
      const l = lines[i].text;
      if (para.length && (FENCE_RE.test(l) || ATX_RE.test(l) || HR_RE.test(l) || /^ {0,3}>/.test(l) || UL_RE.test(l) || OL_RE.test(l))) break;
      para.push(l.replace(/^ {0,3}/, ""));
      i++;
    }
    if (!para.length) { i++; continue; }
    bounds.bump();
    out.push({ type: "paragraph", children: parseInline(para.join("\n").replace(/[ \t]+$/gm, ""), bounds, depth + 1) });
  }
  return out;
}

/** Task-list markers become a leading checkbox character; the list itself is a normal list. */
function dedupeTask(blocks: MdBlock[], _lines: Line[]): MdBlock[] {
  return blocks.map((b) => {
    if (b.type !== "paragraph") return b;
    const first = b.children[0];
    if (first?.type !== "text") return b;
    const m = TASK_RE.exec(first.text);
    if (!m) return b;
    const checked = m[1] !== " ";
    const rest = m[2];
    return { type: "paragraph", children: [{ type: "text", text: `${checked ? "\u2611" : "\u2610"} ${rest}` } as MdNode, ...b.children.slice(1)] };
  });
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buf = "", esc = false;
  for (const c of t) {
    if (esc) { buf += c; esc = false; continue; }
    if (c === "\\") { buf += c; esc = true; continue; }
    if (c === "|") { cells.push(buf); buf = ""; continue; }
    buf += c;
  }
  cells.push(buf);
  return cells;
}

// ── serialiser ───────────────────────────────────────────────────────────────

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Serialise to HTML. Every attribute value passes through `escapeHtml` and every
 * URL through `safeHref`; the tag names are literals in this file, so no source
 * character can ever become tag syntax.
 */
export function renderMarkdownHtml(src: string, opts: { breaks?: boolean } = {}): string {
  const blocks = parseMarkdown(src);
  return blocks.map((b) => renderBlock(b, opts)).join("\n");
}

function renderNodes(nodes: MdNode[]): string {
  return nodes.map((n) => {
    switch (n.type) {
      case "text": return escapeHtml(n.text).replace(/\n/g, "<br>");
      case "code": return `<code>${escapeHtml(n.text)}</code>`;
      case "em": return `<em>${renderNodes(n.children)}</em>`;
      case "strong": return `<strong>${renderNodes(n.children)}</strong>`;
      case "del": return `<del>${renderNodes(n.children)}</del>`;
      case "break": return "<br>";
      case "img": return `<span class="md-img" title="${escapeHtml(n.title ?? "")}">${escapeHtml(n.alt || n.src)}</span>`;
      case "link": {
        if (!safeHref(n.href)) return renderNodes(n.children);
        const t = n.title ? ` title="${escapeHtml(n.title)}"` : "";
        return `<a href="${escapeHtml(n.href)}" rel="noopener noreferrer nofollow"${t}>${renderNodes(n.children)}</a>`;
      }
    }
  }).join("");
}

function renderBlock(b: MdBlock, opts: { breaks?: boolean }): string {
  switch (b.type) {
    case "heading": return `<h${b.level}>${renderNodes(b.children)}</h${b.level}>`;
    case "paragraph": return `<p>${renderNodes(b.children)}</p>`;
    case "code": {
      const cls = b.lang && /^[A-Za-z0-9_+-]{1,32}$/.test(b.lang) ? ` class="language-${b.lang}"` : "";
      return `<pre><code${cls}>${escapeHtml(b.text)}</code></pre>`;
    }
    case "blockquote": return `<blockquote>${b.blocks.map((x) => renderBlock(x, opts)).join("\n")}</blockquote>`;
    case "hr": return "<hr>";
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
      const items = b.items.map((blocks) => `<li>${blocks.map((x) => renderBlock(x, opts)).join(b.tight ? "" : "\n")}</li>`).join("\n");
      return `<${tag}${startAttr}>${items}</${tag}>`;
    }
    case "table": {
      const head = `<thead><tr>${b.head.map((c, idx) => `<th${b.align[idx] ? ` style="text-align:${b.align[idx]}"` : ""}>${renderNodes(c)}</th>`).join("")}</tr></thead>`;
      const rows = b.rows.map((r) => `<tr>${r.map((c, idx) => `<td${b.align[idx] ? ` style="text-align:${b.align[idx]}"` : ""}>${renderNodes(c)}</td>`).join("")}</tr>`).join("");
      return `<table>${head}<tbody>${rows}</tbody></table>`;
    }
  }
}

/** A flat outline of the document, for the Editor's heading navigator. */
export function markdownOutline(src: string): { level: number; text: string }[] {
  const blocks = parseMarkdown(src);
  const out: { level: number; text: string }[] = [];
  const walk = (bs: MdBlock[]) => {
    for (const b of bs) {
      if (b.type === "heading") out.push({ level: b.level, text: plainText(b.children) });
      else if (b.type === "blockquote") walk(b.blocks);
      else if (b.type === "list") b.items.forEach(walk);
    }
  };
  walk(blocks);
  return out;
}

/** Plain text of a document — used by search indexing and word count. */
export function markdownText(src: string): string {
  const out: string[] = [];
  const walk = (bs: MdBlock[]) => {
    for (const b of bs) {
      switch (b.type) {
        case "heading": out.push(plainText(b.children)); break;
        case "paragraph": out.push(plainText(b.children)); break;
        case "code": out.push(b.text); break;
        case "blockquote": walk(b.blocks); break;
        case "list": b.items.forEach(walk); break;
        case "table": out.push(b.head.map(plainText).join("\t")); b.rows.forEach((r) => out.push(r.map(plainText).join("\t"))); break;
        default: break;
      }
    }
  };
  walk(parseMarkdown(src));
  return out.join("\n");
}
