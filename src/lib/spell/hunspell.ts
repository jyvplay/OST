/**
 * TT59 spell checker: an original implementation of the Hunspell dictionary format (.aff affix rules + .dic word list),
 * written from the published format description (hunspell(5)) — enough of it for the shipped en_US dictionary
 * (SCOWL, MIT/BSD-style licence, public/dict/LICENSE-en_US.txt) and other simple affix dictionaries:
 *
 *   SET UTF-8 · FLAG (char | long | num) · TRY · KEY · REP · ICONV · WORDCHARS · NOSUGGEST · FORBIDDENWORD · KEEPCASE ·
 *   NEEDAFFIX · ONLYINCOMPOUND · COMPOUNDMIN · COMPOUNDRULE (*, ?) · BREAK · PFX / SFX with strip, add, conditions and
 *   cross product (prefix + suffix on one stem).
 *
 * Not supported (refused at load with a reason when present): compounding by COMPOUNDFLAG/BEGIN/MIDDLE/END, two-level
 * suffixes (continuation classes inside affixes), CIRCUMFIX, morphological fields, phonetic (PHONE) suggestions.
 * Nothing leaves the device: the dictionary is a static file and all checking / suggesting runs locally.
 */

export type CapType = "none" | "init" | "all" | "huh";

interface Affix { flag: string; cross: boolean; strip: string; add: string; cond: Cond | null; kind: "pfx" | "sfx" }
type Cond = { neg: boolean; set: string }[];

export interface SpellAff {
  flagMode: "char" | "long" | "num";
  tryChars: string; key: string[]; rep: [string, string][]; iconv: [string, string][];
  wordChars: string; noSuggest?: string; forbidden?: string; keepCase?: string; needAffix?: string; onlyInCompound?: string;
  compoundMin: number; compoundRules: { flag: string; q: "" | "*" | "?" }[][]; breaks: string[];
  pfx: Map<string, Affix[]>; sfx: Map<string, Affix[]>; maxPfx: number; maxSfx: number;
}

const unsupported = ["COMPOUNDFLAG", "COMPOUNDBEGIN", "COMPOUNDMIDDLE", "COMPOUNDLAST", "COMPOUNDEND", "CIRCUMFIX", "PHONE", "AF ", "AM "];

function parseCond(s: string): Cond | null {
  if (s === "." || s === "") return null;
  const out: Cond = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") {
      const j = s.indexOf("]", i); if (j < 0) throw new Error(`bad affix condition ${s}`);
      const body = s.slice(i + 1, j); out.push(body.startsWith("^") ? { neg: true, set: body.slice(1) } : { neg: false, set: body }); i = j;
    } else if (s[i] === ".") out.push({ neg: true, set: "" });
    else out.push({ neg: false, set: s[i] });
  }
  return out;
}
const condOk = (c: Cond | null, w: string, atEnd: boolean): boolean => {
  if (!c) return true;
  if (w.length < c.length) return false;
  const off = atEnd ? w.length - c.length : 0;
  for (let i = 0; i < c.length; i++) { const ch = w[off + i]; const inSet = c[i].set.includes(ch); if (c[i].neg ? inSet : !inSet) return false; }
  return true;
};

export function splitFlags(s: string, mode: SpellAff["flagMode"]): string[] {
  if (!s) return [];
  if (mode === "long") { const o: string[] = []; for (let i = 0; i + 1 < s.length; i += 2) o.push(s.slice(i, i + 2)); return o; }
  if (mode === "num") return s.split(",").filter(Boolean);
  return [...s];
}

export function parseAff(text: string): SpellAff {
  const aff: SpellAff = { flagMode: "char", tryChars: "", key: ["qwertyuiop", "asdfghjkl", "zxcvbnm"], rep: [], iconv: [], wordChars: "", compoundMin: 3, compoundRules: [], breaks: ["-", "^-", "-$"], pfx: new Map(), sfx: new Map(), maxPfx: 0, maxSfx: 0 };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let breaksSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    for (const u of unsupported) if (line.startsWith(u)) throw new Error(`unsupported .aff directive: ${u.trim()}`);
    const p = line.split(/\s+/);
    switch (p[0]) {
      case "SET": if (p[1].toUpperCase() !== "UTF-8") throw new Error(`only UTF-8 dictionaries are supported (SET ${p[1]})`); break;
      case "FLAG": aff.flagMode = p[1] === "long" ? "long" : p[1] === "num" ? "num" : (() => { throw new Error(`unsupported FLAG ${p[1]}`); })(); break;
      case "TRY": aff.tryChars = p[1] ?? ""; break;
      case "KEY": aff.key = (p[1] ?? "").split("|"); break;
      case "WORDCHARS": aff.wordChars = p[1] ?? ""; break;
      case "NOSUGGEST": aff.noSuggest = p[1]; break;
      case "FORBIDDENWORD": aff.forbidden = p[1]; break;
      case "KEEPCASE": aff.keepCase = p[1]; break;
      case "NEEDAFFIX": aff.needAffix = p[1]; break;
      case "ONLYINCOMPOUND": aff.onlyInCompound = p[1]; break;
      case "COMPOUNDMIN": aff.compoundMin = Math.max(1, Number(p[1]) || 1); break;
      case "REP": case "ICONV": case "COMPOUNDRULE": case "BREAK": {
        if (p.length === 2 && /^\d+$/.test(p[1])) { if (p[0] === "BREAK") { breaksSeen = true; aff.breaks = []; } break; }
        if (p[0] === "REP") aff.rep.push([p[1], (p[2] ?? "").replace(/_/g, " ")]);
        else if (p[0] === "ICONV") aff.iconv.push([p[1], p[2] ?? ""]);
        else if (p[0] === "BREAK") { if (!breaksSeen) { aff.breaks = []; breaksSeen = true; } aff.breaks.push(p[1]); }
        else {
          const rule: { flag: string; q: "" | "*" | "?" }[] = [];
          const src = p[1]; const re = aff.flagMode === "char" ? /(.)([*?]?)/gu : /\(([^)]+)\)([*?]?)/g;
          for (const m of src.matchAll(re)) rule.push({ flag: m[1], q: m[2] as "" | "*" | "?" });
          aff.compoundRules.push(rule);
        }
        break;
      }
      case "PFX": case "SFX": {
        if (p.length === 4 && (p[2] === "Y" || p[2] === "N") && /^\d+$/.test(p[3])) {
          const n = Number(p[3]), cross = p[2] === "Y", kind = p[0] === "PFX" ? "pfx" : "sfx";
          for (let k = 0; k < n; k++) {
            const q = (lines[++i] ?? "").replace(/\s+#.*$/, "").trim().split(/\s+/);
            if (q[0] !== p[0] || q[1] !== p[1]) throw new Error(`affix ${p[1]}: expected ${n} rules, line ${i + 1}`);
            let add = q[3] === "0" ? "" : q[3];
            if (add.includes("/")) throw new Error("two-level affixes (continuation classes) are not supported");
            add = add.replace(/\//g, "");
            const a: Affix = { flag: p[1], cross, strip: q[2] === "0" ? "" : q[2], add, cond: parseCond(q[4] ?? "."), kind };
            const m = kind === "pfx" ? aff.pfx : aff.sfx;
            if (!m.has(add)) m.set(add, []); m.get(add)!.push(a);
            if (kind === "pfx") aff.maxPfx = Math.max(aff.maxPfx, [...add].length); else aff.maxSfx = Math.max(aff.maxSfx, [...add].length);
          }
        }
        break;
      }
      default: break;
    }
  }
  return aff;
}

/** internal pseudo-flag for the upper-case homonyms of mixed-case words */
const ONLYUP = "\u0000UP";
export interface SpellDic { words: Map<string, string[][]>; lowerIndex: string[] }
export function parseDic(text: string, aff: SpellAff): SpellDic {
  const words = new Map<string, string[][]>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    let l = lines[i]; if (!l) continue;
    // a tab starts morphological fields; "\/" is a literal slash in the word
    const tab = l.indexOf("\t"); if (tab >= 0) l = l.slice(0, tab);
    l = l.trim(); if (!l) continue;
    let slash = -1; for (let k = 0; k < l.length; k++) { if (l[k] === "\\") { k++; continue; } if (l[k] === "/") { slash = k; break; } }
    const w = (slash < 0 ? l : l.slice(0, slash)).replace(/\\\//g, "/").split(" ")[0];
    const fl = slash < 0 ? [] : splitFlags(l.slice(slash + 1).split(/\s/)[0], aff.flagMode);
    if (!words.has(w)) words.set(w, []); words.get(w)!.push(fl);
    // like Hunspell, a mixed-case entry (iPhone, McDonald) also gets an upper-case homonym usable only by ALL-CAPS input
    if (capType(w) === "huh" && !(aff.keepCase && fl.includes(aff.keepCase))) { const up = w.toUpperCase(); if (!words.has(up)) words.set(up, []); words.get(up)!.push([...fl, ONLYUP]); }
  }
  return { words, lowerIndex: [] };
}

export function capType(w: string): CapType {
  // Hunspell's classes: no capitals · one capital, first character · every letter capital · mixed (first capital or not)
  let up = 0, letters = 0;
  for (const ch of w) { const u = ch.toUpperCase(), l = ch.toLowerCase(); if (u === l) continue; letters++; if (ch === u) up++; }
  if (up === 0) return "none";
  const c0 = [...w][0] ?? ""; const firstCap = c0 !== c0.toLowerCase() && c0 === c0.toUpperCase();
  if (up === 1 && firstCap) return "init";
  if (up === letters) return "all";
  return "huh";
}
const initCap = (w: string) => { const a = [...w]; return a.length ? a[0].toUpperCase() + a.slice(1).join("").toLowerCase() : w; };

export class Speller {
  readonly aff: SpellAff; readonly dic: SpellDic;
  /** words the user added ("Add to dictionary"); accepted in any letter case pattern the base word allows */
  private user = new Set<string>();
  private ngramPool: string[] | null = null;
  constructor(affText: string, dicText: string) { this.aff = parseAff(affText); this.dic = parseDic(dicText, this.aff); }

  setUserWords(list: Iterable<string>) { this.user = new Set([...list].map((w) => w.trim()).filter(Boolean)); this.ngramPool = null; }
  get userWords(): string[] { return [...this.user]; }

  private has(fl: string[], f?: string) { return !!f && fl.includes(f); }
  /** true while checking an ALL-CAPS input: enables the ONLYUP homonyms */
  private allCaps = false;
  private upOk(fl: string[]) { return this.allCaps || !fl.includes(ONLYUP); }
  /** dictionary homonyms of `w` that are usable as a whole word with no affix */
  private rootOk(w: string, inCompound = false): boolean {
    if (this.user.has(w)) return true;
    const hs = this.dic.words.get(w); if (!hs) return false;
    return hs.some((fl) => this.upOk(fl) && !this.has(fl, this.aff.forbidden) && !this.has(fl, this.aff.needAffix) && (inCompound || !this.has(fl, this.aff.onlyInCompound)));
  }
  private forbidden(w: string): boolean { const hs = this.dic.words.get(w); return !!hs && !!this.aff.forbidden && hs.some((fl) => fl.includes(this.aff.forbidden!)); }
  private rootWith(stem: string, flags: string[]): boolean {
    const hs = this.dic.words.get(stem); if (!hs) return false;
    return hs.some((fl) => this.upOk(fl) && flags.every((f) => fl.includes(f)) && !this.has(fl, this.aff.forbidden) && !this.has(fl, this.aff.onlyInCompound));
  }
  private suffixForms(w: string, needPfx?: Affix): boolean {
    const a = [...w];
    for (let k = 0; k <= Math.min(this.aff.maxSfx, a.length - 1); k++) {
      const add = a.slice(a.length - k).join(""); const list = this.aff.sfx.get(add); if (!list) continue;
      const base = a.slice(0, a.length - k).join("");
      for (const s of list) {
        if (needPfx && !(s.cross && needPfx.cross)) continue;
        const stem = base + s.strip;
        if (!stem || !condOk(s.cond, stem, true)) continue;
        if (this.rootWith(stem, needPfx ? [s.flag, needPfx.flag] : [s.flag])) return true;
      }
    }
    return false;
  }
  private prefixForms(w: string): boolean {
    const a = [...w];
    for (let k = 1; k <= Math.min(this.aff.maxPfx, a.length - 1); k++) {
      const add = a.slice(0, k).join(""); const list = this.aff.pfx.get(add); if (!list) continue;
      const rest = a.slice(k).join("");
      for (const p of list) {
        const stem = p.strip + rest;
        if (!stem || !condOk(p.cond, stem, false)) continue;
        if (this.rootWith(stem, [p.flag])) return true;
        if (p.cross && this.suffixForms(stem, p)) return true;
      }
    }
    return false;
  }
  private compound(w: string): boolean {
    if (!this.aff.compoundRules.length) return false;
    const a = [...w], n = a.length, min = this.aff.compoundMin;
    const flagsAt = new Map<string, string[][]>();
    const parts = (i: number, j: number) => { const k = `${i},${j}`; let v = flagsAt.get(k); if (!v) { v = (this.dic.words.get(a.slice(i, j).join("")) ?? []).filter((fl) => this.upOk(fl) && !this.has(fl, this.aff.forbidden)); flagsAt.set(k, v); } return v; };
    const match = (rule: SpellAff["compoundRules"][number], ti: number, pos: number, count: number): boolean => {
      if (ti === rule.length) return pos === n && count >= 2;
      const t = rule[ti];
      const takeOne = (next: (p: number) => boolean) => { for (let j = pos + min; j <= n; j++) if (parts(pos, j).some((fl) => fl.includes(t.flag)) && next(j)) return true; return false; };
      if (t.q === "*") return match(rule, ti + 1, pos, count) || takeOne((j) => match(rule, ti, j, count + 1));
      if (t.q === "?") return match(rule, ti + 1, pos, count) || takeOne((j) => match(rule, ti + 1, j, count + 1));
      return takeOne((j) => match(rule, ti + 1, j, count + 1));
    };
    return this.aff.compoundRules.some((r) => match(r, 0, 0, 0));
  }
  /** one case variant, all mechanisms */
  private checkForm(w: string, original = false): boolean {
    // a FORBIDDENWORD entry rejects exactly the typed word; its case variants may still be valid derived forms
    // (Hunspell / spylls: "pastas/!" forbids "pastas" but "Pastas" ← pasta + s is accepted)
    if (original && this.forbidden(w)) return false;
    return this.rootOk(w) || this.suffixForms(w) || this.prefixForms(w) || this.compound(w);
  }
  private keepCaseBlocks(variant: string, original: string): boolean {
    if (!this.aff.keepCase || variant === original) return false;
    const hs = this.dic.words.get(variant); return !!hs && hs.every((fl) => fl.includes(this.aff.keepCase!));
  }
  private checkCased(w: string): boolean {
    const t = capType(w);
    if (t !== "all") return this.checkCasedInner(w, t);
    this.allCaps = true;
    try { return this.checkCasedInner(w, t); } finally { this.allCaps = false; }
  }
  private checkCasedInner(w: string, t: CapType): boolean {
    if (this.forbidden(w)) return false;
    if (this.checkForm(w, true)) return true;
    if (t === "init" || t === "all") {
      const lower = w.toLowerCase();
      if (!this.keepCaseBlocks(lower, w) && this.checkForm(lower)) return true;
      if (t === "all") { const ic = initCap(w); if (!this.keepCaseBlocks(ic, w) && this.checkForm(ic)) return true; }
      // ALL CAPS with an apostrophe: the part after the first apostrophe lower-cased (ACTH'S → ACTH's) or capitalised
      // (O'BRIEN'S → O'Brien's), as Hunspell does
      const ap = w.indexOf("'");
      if (t === "all" && ap > 0 && ap < w.length - 1) {
        const head = w.slice(0, ap + 1), tail = w.slice(ap + 1);
        if (this.checkForm(head + tail.toLowerCase())) return true;
        if (this.checkForm(initCap(head) + initCap(tail))) return true;
      }
    }
    return false;
  }
  /** is `word` correctly spelled? (`word` is one token: no spaces) */
  check(word: string): boolean {
    let w = word;
    for (const [a, b] of this.aff.iconv) w = w.split(a).join(b);
    if (!w) return true;
    if (/^\d+(\.\d+)?$/.test(w)) return true;
    if (this.user.has(w) || this.user.has(w.toLowerCase())) return true;
    if (this.checkCased(w)) return true;
    return this.checkBreaks(w, 0);
  }
  private checkBreaks(w: string, depth: number): boolean {
    if (depth > 10) return false;
    for (const b of this.aff.breaks) {
      if (b.startsWith("^")) { const s = b.slice(1); if (s && w.startsWith(s) && w.length > s.length && this.checkPart(w.slice(s.length), depth)) return true; continue; }
      if (b.endsWith("$")) { const s = b.slice(0, -1); if (s && w.endsWith(s) && w.length > s.length && this.checkPart(w.slice(0, -s.length), depth)) return true; continue; }
      const i = w.indexOf(b);
      if (i > 0 && i + b.length < w.length) { if (this.checkPart(w.slice(0, i), depth) && this.checkPart(w.slice(i + b.length), depth)) return true; }
    }
    return false;
  }
  private checkPart(w: string, depth: number): boolean { return /^\d+(\.\d+)?$/.test(w) || this.checkCased(w) || this.checkBreaks(w, depth + 1); }

  /* ---------------------------------------------------------------- suggestions */
  private suggestable(w: string): boolean {
    if (!this.check(w)) return false;
    // never suggest NOSUGGEST words (e.g. offensive terms): reject when every reading of the word is a NOSUGGEST root
    const ns = this.aff.noSuggest; if (!ns) return true;
    const forms = [w, w.toLowerCase(), initCap(w)];
    for (const f of forms) { const hs = this.dic.words.get(f); if (hs && hs.length && hs.every((fl) => fl.includes(ns))) return false; }
    // derived forms of a NOSUGGEST root (suffix stripped) are rejected too
    for (const [add, list] of this.aff.sfx) if (add && w.toLowerCase().endsWith(add)) for (const s of list) { const stem = w.toLowerCase().slice(0, -add.length) + s.strip; const hs = this.dic.words.get(stem); if (hs && hs.some((fl) => fl.includes(s.flag)) && hs.every((fl) => fl.includes(ns))) return false; }
    return true;
  }
  /** up to `max` suggestions, best first, in the original word's letter case */
  suggest(word: string, max = 8): string[] {
    let w = word; for (const [a, b] of this.aff.iconv) w = w.split(a).join(b);
    if (!w.trim() || w.length > 100) return [];
    const t = capType(w);
    const out: string[] = []; const seen = new Set<string>();
    const push = (s: string) => {
      if (out.length >= max * 3) return;
      if (seen.has(s) || s === w) return;
      if (s.includes(" ")) { if (!s.split(" ").every((p) => p && this.suggestable(p))) return; }
      else if (!this.suggestable(s)) return;
      seen.add(s); out.push(s);
    };
    const base = t === "huh" ? w : w.toLowerCase();
    // 1. letter case only
    for (const v of [w.toLowerCase(), initCap(w), w.toUpperCase()]) if (v !== w && this.check(v)) push(v);
    // candidates carry a category (Hunspell's order of edit kinds): 0 REP table / swapped neighbours, 1 keyboard / swap
    // one apart, 2 extra letter, 3 missing letter, 4 wrong letter, 5 moved letter — ranked by category, then similarity
    const cat = new Map<string, number>();
    const edits = (x: string): string[] => {
      const c: string[] = []; const a = [...x]; const n = a.length;
      let from = 0; const mark = (k: number) => { for (let q = from; q < c.length; q++) if (!cat.has(c[q])) cat.set(c[q], k); from = c.length; };
      // REP table (common misspelling pairs), anywhere in the word
      for (const [from, to] of this.aff.rep) { let i = x.indexOf(from); while (i >= 0) { c.push(x.slice(0, i) + to + x.slice(i + from.length)); i = x.indexOf(from, i + 1); } }
      // swapped neighbours, and one apart
      for (let i = 0; i + 1 < n; i++) { const b = [...a]; [b[i], b[i + 1]] = [b[i + 1], b[i]]; c.push(b.join("")); }
      mark(0);
      for (let i = 0; i + 2 < n; i++) { const b = [...a]; [b[i], b[i + 2]] = [b[i + 2], b[i]]; c.push(b.join("")); }
      // keyboard neighbours (KEY rows)
      mark(1);
      for (let i = 0; i < n; i++) for (const row of this.aff.key) { const j = row.indexOf(a[i].toLowerCase()); if (j < 0) continue; for (const d of [-1, 1]) { const ch = row[j + d]; if (ch) c.push([...a.slice(0, i), a[i] === a[i].toUpperCase() ? ch.toUpperCase() : ch, ...a.slice(i + 1)].join("")); } }
      mark(1);
      // one extra letter / doubled letter
      for (let i = 0; i < n; i++) c.push([...a.slice(0, i), ...a.slice(i + 1)].join(""));
      mark(2);
      // one missing letter (TRY order), one wrong letter
      const tries = [...new Set([...this.aff.tryChars.toLowerCase()])];
      for (let i = 0; i <= n; i++) for (const ch of tries) c.push([...a.slice(0, i), ch, ...a.slice(i)].join(""));
      mark(3);
      for (let i = 0; i < n; i++) for (const ch of tries) if (ch !== a[i]) c.push([...a.slice(0, i), ch, ...a.slice(i + 1)].join(""));
      mark(4);
      // a letter moved by up to 4 places
      for (let i = 0; i < n; i++) for (let d = 2; d <= 4; d++) { if (i + d < n) { const b = [...a]; const [m] = b.splice(i, 1); b.splice(i + d, 0, m); c.push(b.join("")); } }
      mark(5);
      return c;
    };
    // 2. one edit away, ranked: REP/swap/keyboard first (they are listed first), then by a similarity score
    const one = [...edits(base), ...(base !== w ? edits(w) : [])].filter((s) => s.length > 0);
    const goodOne = [...new Set(one)].filter((s) => (s.includes(" ") ? s.split(" ").every((q) => q && this.suggestable(q)) : this.suggestable(s)));
    const score = (s: string) => similarity(base, s.toLowerCase()) + (s === w.toLowerCase() || s.toLowerCase() === base ? 0.2 : 0);
    const firstIdx = new Map<string, number>(); one.forEach((s, i) => { if (!firstIdx.has(s)) firstIdx.set(s, i); });
    const rank = (s: string) => cat.get(s) ?? 5;
    goodOne.sort((x, y) => rank(x) - rank(y) || score(y) - score(x) || firstIdx.get(x)! - firstIdx.get(y)!);
    for (const s of goodOne) push(s);
    // 3. split into two words ("alot" → "a lot"), also with a hyphen
    const a = [...base];
    for (let i = 1; i < a.length; i++) { const l = a.slice(0, i).join(""), r = a.slice(i).join(""); if ((l.length > 1 || /^[ai]$/.test(l)) && this.suggestable(l) && this.suggestable(r)) push(`${l} ${r}`); }
    // 4. nothing close: n-gram similarity over the dictionary roots (and user words)
    if (out.length < 3) for (const s of this.ngram(base, 6)) push(s);
    const cased = (s: string) => (t === "init" ? s[0].toUpperCase() + s.slice(1) : t === "all" ? s.toUpperCase() : s);
    const final: string[] = []; const fin = new Set<string>();
    for (const s of out) { const v = (t === "init" || t === "all") && s === s.toLowerCase() ? cased(s) : s; if (!fin.has(v) && v !== word && (this.check(v) || v.includes(" "))) { fin.add(v); final.push(v); } if (final.length >= max) break; }
    return final;
  }
  private ngram(x: string, n: number): string[] {
    if (!this.ngramPool) {
      const pool: string[] = [];
      for (const [w, hs] of this.dic.words) if (hs.some((fl) => !fl.includes(ONLYUP) && !this.has(fl, this.aff.noSuggest) && !this.has(fl, this.aff.forbidden) && !this.has(fl, this.aff.onlyInCompound) && !this.has(fl, this.aff.needAffix))) pool.push(w);
      for (const w of this.user) pool.push(w);
      this.ngramPool = pool;
    }
    const xl = x.toLowerCase();
    const top = (cands: Iterable<string>, k: number, maxLenDiff: number): [number, string][] => {
      const best: [number, string][] = [];
      for (const w of cands) {
        if (Math.abs(w.length - xl.length) > maxLenDiff) continue;
        const s = similarity(xl, w.toLowerCase());
        if (best.length < k || s > best[best.length - 1][0]) { best.push([s, w]); best.sort((p, q) => q[0] - p[0]); if (best.length > k) best.pop(); }
      }
      return best;
    };
    // roots first, then every affixed form of the best roots (abandnoes → abandon → abandons), re-scored together
    const roots = top(this.ngramPool, 40, 6);
    const forms = new Set<string>();
    for (const [, r] of roots) { forms.add(r); for (const f of this.expand(r)) forms.add(f); }
    return top(forms, n, 4).filter(([sc]) => sc > 0.35).map(([, w]) => w);
  }
  /** all single-affix (and cross-product prefix+suffix) forms of a dictionary root */
  expand(root: string): string[] {
    const out: string[] = [];
    for (const fl of this.dic.words.get(root) ?? []) {
      if (fl.includes(ONLYUP) || this.has(fl, this.aff.noSuggest)) continue;
      const sfx: string[] = [];
      for (const [, list] of this.aff.sfx) for (const s of list) if (fl.includes(s.flag) && root.endsWith(s.strip) && condOk(s.cond, root, true)) { const f = root.slice(0, root.length - s.strip.length) + s.add; out.push(f); if (s.cross) sfx.push(f); }
      for (const [, list] of this.aff.pfx) for (const p of list) if (fl.includes(p.flag) && root.startsWith(p.strip) && condOk(p.cond, root, false)) {
        out.push(p.add + root.slice(p.strip.length));
        if (p.cross) for (const f of sfx) out.push(p.add + f.slice(p.strip.length));
      }
    }
    return out;
  }
}

/** shared n-grams (1..3) + common prefix − length difference, normalised to 0..1 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  let sc = 0, tot = 0;
  for (let n = 1; n <= 3; n++) {
    const grams = new Map<string, number>();
    for (let i = 0; i + n <= b.length; i++) { const g = b.slice(i, i + n); grams.set(g, (grams.get(g) ?? 0) + 1); }
    for (let i = 0; i + n <= a.length; i++) { const g = a.slice(i, i + n); const c = grams.get(g) ?? 0; if (c) { sc += n; grams.set(g, c - 1); } }
    tot += n * Math.max(a.length - n + 1, b.length - n + 1, 1);
  }
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  return Math.max(0, (sc / tot) + Math.min(pre, 3) * 0.05 - Math.abs(a.length - b.length) * 0.05);
}

/* -------------------------------------------------------------------- tokenizer */
export interface SpellToken { word: string; start: number; end: number }
/**
 * Words of a text for checking: letters, apostrophes inside a word, the dictionary's WORDCHARS (digits for ordinals);
 * URLs, e-mail addresses, file paths and words containing digits (other than ordinals) are skipped, as are words in
 * ALL CAPS when `skipUpper` (Word's default "Ignore words in UPPERCASE").
 */
export function tokenize(text: string, opts: { skipUpper?: boolean; wordChars?: string } = {}): SpellToken[] {
  const out: SpellToken[] = [];
  const skip: [number, number][] = [];
  for (const m of text.matchAll(/(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:[A-Za-z]:)?[\\/][\w.-]+(?:[\\/][\w.-]+)+/g)) skip.push([m.index!, m.index! + m[0].length]);
  const re = /[\p{L}\p{M}\d]+(?:['’][\p{L}\p{M}]+)*/gu;
  for (const m of text.matchAll(re)) {
    const s = m.index!, e = s + m[0].length, w = m[0];
    if (skip.some(([a, b]) => s >= a && s < b)) continue;
    if (/\d/.test(w) && !/^\d+(?:st|nd|rd|th)$/i.test(w)) continue;
    if (opts.skipUpper && w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase()) continue;
    out.push({ word: w, start: s, end: e });
  }
  return out;
}
