/**
 * TT41 (WP-17): find the module specifiers of a JavaScript source — `import … from "x"`, `import "x"`,
 * `export … from "x"`, `import("x")` (string or plain template argument), `import.source("x")` / `import.defer("x")`
 * — so the Private proxy can rewrite them to proxied addresses. Inside a proxied page or worker, a module's base URL is
 * the PROXY's, so the browser would resolve "/x.js", "../../x.js" or "https://cdn.example/x.js" to the wrong place
 * (Fusion's own host, past the proxy prefix, or straight to the network). Original code written from ECMAScript
 * (§12 lexical grammar, §16.2 modules); no parser library. Pure, no I/O.
 *
 * Two passes. (1) A tokenizer that resolves the regular-expression / division ambiguity with a context stack: every
 * `(` remembers whether it belongs to if / while / for / with (after its `)` a slash starts a regex), every `{`
 * remembers whether it opened a block or an object literal / template substitution (after a block's `}` a slash
 * starts a regex), and keywords that end in an expression slot (return, typeof, case, export default …) allow one.
 * Names after `.` / `?.` are property names, never keywords. (2) A matcher over the tokens for the import forms.
 *
 * Unbalanced or unterminated input throws (the caller then serves the source unchanged).
 */
export type SpecKind = "static" | "dynamic" | "reexport";
export interface Specifier { start: number; end: number; value: string; kind: SpecKind }
export class JsLexError extends Error {}

type TT = "name" | "punct" | "num" | "str" | "tmpl" | "tmplpart" | "regex" | "priv";
interface Tok { t: TT; v: string; s: number; e: number; prop?: boolean; cooked?: string | null }

const REGEX_AFTER_NAME = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "default", "extends"]);
const EXPR_BRACE_AFTER_NAME = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "yield", "await", "extends"]);
const PAREN_KW = new Set(["if", "while", "for", "with"]);
const PUNCTS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];

const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95 || c === 92 || (c > 127 && !isSpace(c));
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57) || c === 0x200c || c === 0x200d;
function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 11 || c === 12 || c === 10 || c === 13 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}
const isLineTerm = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/** the value of a string literal's body or a template chunk (escapes resolved); null when an escape is invalid */
function cook(body: string, template: boolean): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += template && ch === "\r" ? (body[i + 1] === "\n" ? "" : "\n") : ch; continue; }
    const n = body[++i];
    if (n === undefined) return null;
    switch (n) {
      case "n": out += "\n"; break; case "t": out += "\t"; break; case "r": out += "\r"; break;
      case "b": out += "\b"; break; case "f": out += "\f"; break; case "v": out += "\v"; break;
      case "\r": if (body[i + 1] === "\n") i++; break; // line continuation
      case "\n": case "\u2028": case "\u2029": break;
      case "x": { const h = body.slice(i + 1, i + 3); if (!/^[0-9a-fA-F]{2}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); i += 2; break; }
      case "u": {
        if (body[i + 1] === "{") { const end = body.indexOf("}", i); const h = body.slice(i + 2, end); if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(h) || parseInt(h, 16) > 0x10ffff) return null; out += String.fromCodePoint(parseInt(h, 16)); i = end; }
        else { const h = body.slice(i + 1, i + 5); if (!/^[0-9a-fA-F]{4}$/.test(h)) return null; out += String.fromCharCode(parseInt(h, 16)); i += 4; }
        break;
      }
      default:
        if (n >= "0" && n <= "9") { if (n === "0" && !(body[i + 1] >= "0" && body[i + 1] <= "9")) { out += "\0"; break; } return null; } // legacy octal: never a module specifier
        out += n;
    }
  }
  return out;
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const parens: boolean[] = []; // per open "(": belongs to if / while / for / with
  const braces: ("block" | "expr" | "tmpl")[] = [];
  let i = 0, lastPopped: "paren-kw" | "paren" | "block" | "expr" | null = null;
  const n = src.length;
  if (src.startsWith("#!")) { while (i < n && !isLineTerm(src.charCodeAt(i))) i++; }
  const last = (): Tok | undefined => toks[toks.length - 1];
  function regexAllowed(): boolean {
    const p = last();
    if (!p) return true;
    if (p.t === "num" || p.t === "str" || p.t === "regex" || p.t === "tmpl" || p.t === "priv") return false;
    if (p.t === "tmplpart") return true; // "${" opens an expression
    if (p.t === "name") return !p.prop && REGEX_AFTER_NAME.has(p.v);
    if (p.v === ")") return lastPopped === "paren-kw";
    if (p.v === "]") return false;
    if (p.v === "}") return lastPopped === "block";
    if (p.v === "++" || p.v === "--") return false; // postfix far more common than prefix-before-regex
    return true;
  }
  function braceKind(): "block" | "expr" {
    const p = last();
    if (!p) return "block";
    if (p.t === "name") return !p.prop && EXPR_BRACE_AFTER_NAME.has(p.v) ? "expr" : "block";
    if (p.t === "punct") return p.v === ")" || p.v === ";" || p.v === "{" || p.v === "}" || p.v === "=>" ? "block" : "expr";
    if (p.t === "tmplpart") return "expr";
    return "block";
  }
  /** a template chunk from i (just after ` or }) → token; pushes "tmpl" brace when it stops at "${" */
  function templateChunk(start: number, opener: boolean): void {
    let j = i;
    for (;;) {
      if (j >= n) throw new JsLexError(`unterminated template at ${start}`);
      const c = src.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 96) { // `
        // the end of a template: a whole no-substitution template (cooked value kept: it can be a specifier), or the
        // last chunk of one with substitutions ("}`", no single value) — either way an expression has just ended
        toks.push({ t: "tmpl", v: opener ? "`end" : "}`", s: start, e: j + 1, cooked: opener ? cook(src.slice(i, j), true) : null });
        i = j + 1; return;
      }
      if (c === 36 && src.charCodeAt(j + 1) === 123) { // ${
        toks.push({ t: "tmplpart", v: opener ? "`${" : "}${", s: start, e: j + 2, cooked: null });
        braces.push("tmpl"); i = j + 2; return;
      }
      j++;
    }
  }
  while (i < n) {
    const c = src.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    if (c === 47) { // /
      const d = src.charCodeAt(i + 1);
      if (d === 47) { i += 2; while (i < n && !isLineTerm(src.charCodeAt(i))) i++; continue; }
      if (d === 42) { const end = src.indexOf("*/", i + 2); if (end < 0) throw new JsLexError(`unterminated comment at ${i}`); i = end + 2; continue; }
      if (regexAllowed()) {
        let j = i + 1, cls = false;
        for (;;) {
          if (j >= n || isLineTerm(src.charCodeAt(j))) throw new JsLexError(`unterminated regular expression at ${i}`);
          const ch = src[j];
          if (ch === "\\") { j += 2; continue; }
          if (ch === "[") cls = true; else if (ch === "]") cls = false; else if (ch === "/" && !cls) break;
          j++;
        }
        j++;
        while (j < n && isIdPart(src.charCodeAt(j))) j++;
        toks.push({ t: "regex", v: src.slice(i, j), s: i, e: j }); i = j; continue;
      }
    }
    if (c === 39 || c === 34) { // ' "
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new JsLexError(`unterminated string at ${i}`);
        const ch = src.charCodeAt(j);
        if (ch === 92) { j += src.charCodeAt(j + 1) === 13 && src.charCodeAt(j + 2) === 10 ? 3 : 2; continue; }
        if (ch === c) break;
        if (ch === 10 || ch === 13) throw new JsLexError(`newline in string at ${i}`);
        j++;
      }
      toks.push({ t: "str", v: src.slice(i, j + 1), s: i, e: j + 1, cooked: cook(src.slice(i + 1, j), false) });
      i = j + 1; continue;
    }
    if (c === 96) { const s = i; i++; templateChunk(s, true); continue; }
    if (c === 125 && braces[braces.length - 1] === "tmpl") { braces.pop(); const s = i; i++; templateChunk(s, false); lastPopped = null; continue; }
    if ((c >= 48 && c <= 57) || (c === 46 && src.charCodeAt(i + 1) >= 48 && src.charCodeAt(i + 1) <= 57)) {
      let j = i + 1;
      const hex = c === 48 && /[xX]/.test(src[i + 1] ?? "");
      while (j < n) {
        const ch = src[j];
        if (/[0-9A-Za-z_.]/.test(ch)) { j++; continue; }
        if ((ch === "+" || ch === "-") && !hex && /[eE]/.test(src[j - 1])) { j++; continue; }
        break;
      }
      toks.push({ t: "num", v: src.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (c === 35 && i + 1 < n && isIdStart(src.charCodeAt(i + 1))) { // #private
      let j = i + 1; while (j < n && isIdPart(src.charCodeAt(j))) j += src.charCodeAt(j) === 92 ? 6 : 1;
      toks.push({ t: "priv", v: src.slice(i, j), s: i, e: j }); i = j; continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdPart(src.charCodeAt(j))) { if (src.charCodeAt(j) === 92) { j += src[j + 2] === "{" ? src.indexOf("}", j) - j + 1 : 6; } else j++; }
      const p = last();
      toks.push({ t: "name", v: src.slice(i, j), s: i, e: j, prop: !!p && p.t === "punct" && (p.v === "." || p.v === "?.") });
      i = j; continue;
    }
    // punctuator
    let v = src[i];
    for (const q of PUNCTS) if (src.startsWith(q, i)) { if (q === "?." && /[0-9]/.test(src[i + 2] ?? "")) continue; v = q; break; }
    if (v === "(") { const p = last(); parens.push(!!p && p.t === "name" && !p.prop && PAREN_KW.has(p.v)); }
    else if (v === ")") { if (!parens.length) throw new JsLexError(`unbalanced ) at ${i}`); lastPopped = parens.pop() ? "paren-kw" : "paren"; }
    else if (v === "{") braces.push(braceKind());
    else if (v === "}") { const b = braces.pop(); if (!b) throw new JsLexError(`unbalanced } at ${i}`); lastPopped = b === "block" ? "block" : "expr"; }
    toks.push({ t: "punct", v, s: i, e: i + v.length }); i += v.length;
  }
  if (parens.length || braces.length) throw new JsLexError("unbalanced brackets at end of input");
  return toks;
}

/** the module specifiers of `src`, in source order */
export function findImportSpecifiers(src: string): Specifier[] { return findModuleRefs(src).specs; }

/** specifiers, plus every `import.meta.url` read (start / end of the whole expression) */
export function findModuleRefs(src: string): { specs: Specifier[]; metaUrls: { start: number; end: number }[]; metaResolves: { start: number; end: number }[] } {
  const toks = tokenize(src), out: Specifier[] = [], metaUrls: { start: number; end: number }[] = [], metaResolves: { start: number; end: number }[] = [];
  const lit = (k: Tok | undefined) => !!k && (k.t === "str" || k.t === "tmpl") && typeof k.cooked === "string";
  const add = (k: Tok, kind: SpecKind) => out.push({ start: k.s, end: k.e, value: k.cooked as string, kind });
  /** from token j, find `from "<str>"` before anything that cannot be in an import / export clause */
  const fromClause = (j: number, kind: SpecKind): void => {
    let depth = 0;
    for (; j < toks.length; j++) {
      const k = toks[j];
      if (k.t === "punct" && k.v === "{") { depth++; continue; }
      if (k.t === "punct" && k.v === "}") { if (--depth < 0) return; continue; }
      if (k.t === "name" && k.v === "from" && depth === 0 && toks[j + 1]?.t === "str") { add(toks[j + 1], kind); return; }
      if (k.t === "name" || k.t === "str" || (k.t === "punct" && (k.v === "," || k.v === "*"))) continue;
      return;
    }
  };
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    if (k.t !== "name" || k.prop) continue;
    const nx = toks[i + 1];
    if (!nx) break;
    if (k.v === "import") {
      if (nx.t === "punct" && nx.v === "(") {
        const a = toks[i + 2], b = toks[i + 3];
        if (lit(a) && b && b.t === "punct" && (b.v === ")" || b.v === ",")) {
          // `import(` after a class / object member position would be a METHOD named import, not a call:
          // `import("x") {` cannot be a method (its parameters must be bindings), so a string argument is a call
          add(a, "dynamic");
        }
      } else if (nx.t === "punct" && nx.v === ".") {
        const ph = toks[i + 2], op = toks[i + 3], a = toks[i + 4], b = toks[i + 5];
        // import.meta.url (read, never assigned: `import.meta.url = …` is not touched)
        if (ph?.t === "name" && ph.v === "meta" && op?.t === "punct" && op.v === "." && a?.t === "name" && a.v === "url" && !(b?.t === "punct" && /^(=|\+\+|--|[-+*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=)$/.test(b.v))) { metaUrls.push({ start: k.s, end: a.e }); continue; }
        // import.meta.resolve (the function itself, called or not; never an assignment target)
        if (ph?.t === "name" && ph.v === "meta" && op?.t === "punct" && op.v === "." && a?.t === "name" && a.v === "resolve" && !(b?.t === "punct" && /^(=|\+\+|--|[-+*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=)$/.test(b.v))) { metaResolves.push({ start: k.s, end: a.e }); continue; }
        if (ph?.t === "name" && (ph.v === "source" || ph.v === "defer") && op?.v === "(" && lit(a) && b && (b.v === ")" || b.v === ",")) add(a, "dynamic");
      } else if (nx.t === "str") {
        add(nx, "static"); // `import "x"` — only valid as a statement
      } else if (nx.t === "name" || (nx.t === "punct" && (nx.v === "{" || nx.v === "*"))) {
        // a declaration: `import x`, `import {`, `import *`, `import defer * as`, `import source x` …
        if (nx.t === "name" && toks[i + 2]?.t === "punct" && (toks[i + 2].v === ":" || toks[i + 2].v === "(" || toks[i + 2].v === "=")) continue;
        fromClause(i + 1, "static");
      }
    } else if (k.v === "export" && nx.t === "punct" && (nx.v === "*" || nx.v === "{")) {
      fromClause(i + 1, "reexport");
    }
  }
  return { specs: out, metaUrls, metaResolves };
}

/**
 * Rewrite every specifier for which `map` returns a string (others untouched). The new value is written as a
 * double-quoted string literal. Returns the source unchanged when it cannot be lexed.
 */
export function rewriteSpecifiers(src: string, map: (spec: string, kind: SpecKind) => string | null): { code: string; rewritten: number; error?: string } {
  return rewriteModule(src, map, null);
}

/** specifiers through `map`, and — when `metaUrl` is given — every `import.meta.url` read replaced by that string */
export function rewriteModule(src: string, map: (spec: string, kind: SpecKind) => string | null, metaUrl: string | null, resolveWrap: string | null = null): { code: string; rewritten: number; metaUrls: number; error?: string } {
  let refs: ReturnType<typeof findModuleRefs>;
  try { refs = findModuleRefs(src); } catch (e) { return { code: src, rewritten: 0, metaUrls: 0, error: (e as Error).message }; }
  const edits: { start: number; end: number; text: string }[] = [];
  let count = 0;
  for (const sp of refs.specs) {
    const nv = map(sp.value, sp.kind);
    if (nv === null || nv === sp.value) continue;
    edits.push({ start: sp.start, end: sp.end, text: JSON.stringify(nv) }); count++;
  }
  if (metaUrl !== null) for (const m of refs.metaUrls) edits.push({ start: m.start, end: m.end, text: JSON.stringify(metaUrl) });
  if (metaUrl !== null && resolveWrap !== null) for (const m of refs.metaResolves) edits.push({ start: m.start, end: m.end, text: resolveWrap });
  if (!edits.length) return { code: src, rewritten: 0, metaUrls: 0 };
  edits.sort((a, b) => a.start - b.start);
  let out = "", at = 0;
  for (const e of edits) { out += src.slice(at, e.start) + e.text; at = e.end; }
  return { code: out + src.slice(at), rewritten: count, metaUrls: metaUrl !== null ? refs.metaUrls.length : 0 };
}
