/**
 * TT59 Writer proofing over the WordprocessingML model (pure, DOM-free; Node-tested in scripts/tt59-writer-spell.mts).
 *
 * spellIssues() walks every body paragraph (tables included) in model offset space — text runs by UTF-16 length,
 * opaque tokens as U+FFFC — and reports misspelled words and repeated words ("the the", Word's "Repeated word").
 * Skipped like Word: tracked deletions (struck text is not part of the document), runs marked "Do not check spelling"
 * (w:noProof), runs in a non-English language (w:lang), URLs / e-mail / paths, words with digits (ordinals excepted),
 * optionally words in UPPERCASE, words the user chose to "Ignore All", and single occurrences ignored once.
 */
import { allParas, type Para, type WordDoc } from "./wordml";
import { kid, attr, type XEl } from "./xmltree";
import * as E from "./wordedit";
import { tokenize, type Speller } from "../spell/hunspell";

export interface SpellIssue { kind: "spell" | "repeat"; pid: string; off: number; len: number; word: string }
export interface SpellOpts { skipUpper?: boolean; ignoreAll?: Set<string>; ignoreOnce?: Set<string> }

/** key of one occurrence for "Ignore once" (stable while the paragraph text before it is unchanged) */
export const issueKey = (i: SpellIssue) => `${i.pid}:${i.off}:${i.word}`;

function checkable(r: { rPr?: XEl }): boolean {
  if (!r.rPr) return true;
  const np = kid(r.rPr, "w:noProof");
  if (np && !/^(0|false|off)$/.test(attr(np, "w:val") ?? "")) return false;
  const lang = attr(kid(r.rPr, "w:lang"), "w:val");
  return !lang || /^en\b/i.test(lang);
}

/** paragraph text in model offset space, with unchecked spans blanked to U+0000 (a word separator) */
export function proofText(p: Para): string {
  return p.content.map((i) => {
    if (i.t !== "r") return "\ufffc";
    if (i.rev?.kind === "del" || !checkable(i)) return "\u0000".repeat(i.text.length);
    return i.text;
  }).join("");
}

export function spellIssues(doc: WordDoc, sp: Speller, o: SpellOpts = {}): SpellIssue[] {
  const out: SpellIssue[] = [];
  const ignoreAll = o.ignoreAll ?? new Set<string>(), once = o.ignoreOnce ?? new Set<string>();
  for (const p of allParas(doc.blocks)) issuesInPara(p, sp, o, ignoreAll, once, out);
  return out;
}

export function issuesInPara(p: Para, sp: Speller, o: SpellOpts, ignoreAll: Set<string>, once: Set<string>, out: SpellIssue[] = []): SpellIssue[] {
  const s = proofText(p);
  const toks = tokenize(s, { skipUpper: o.skipUpper });
  let prev: { word: string; end: number } | null = null;
  for (const t of toks) {
    const w = t.word.replace(/’/g, "'");
    const iss = (kind: SpellIssue["kind"], off: number, len: number): SpellIssue => ({ kind, pid: p.id, off, len, word: s.slice(off, off + len) });
    // repeated word: same word (case-insensitive), separated only by spaces / tabs
    if (prev && prev.word.toLowerCase() === w.toLowerCase() && /^[ \t\u00a0]+$/.test(s.slice(prev.end, t.start)) && !/^\d/.test(w)) {
      const i = iss("repeat", prev.end, t.end - prev.end);
      if (!once.has(issueKey(i))) out.push(i);
    } else if (!ignoreAll.has(w) && !ignoreAll.has(w.toLowerCase()) && !sp.check(w)) {
      const i = iss("spell", t.start, t.end - t.start);
      if (!once.has(issueKey(i))) out.push(i);
    }
    prev = { word: w, end: t.end };
  }
  return out;
}

/** replaces one issue's text (tracked when Track Changes is on); a "repeat" issue with no replacement deletes the
 *  repeated word together with the space before it. Returns the caret position after the change. */
export function fixIssue(doc: WordDoc, i: SpellIssue, replacement: string): E.Pos {
  const r = { a: { pid: i.pid, off: i.off }, b: { pid: i.pid, off: i.off + i.len } };
  const at = replacement === "" ? E.deleteForward(doc, r) : E.deleteForReplace(doc, r);
  return replacement ? E.insertText(doc, at, replacement) : at;
}

/** "Change All": every remaining misspelling equal to `word` (exact text) is replaced; returns the count */
export function changeAll(doc: WordDoc, sp: Speller, word: string, replacement: string, o: SpellOpts = {}): number {
  const hits = spellIssues(doc, sp, o).filter((i) => i.kind === "spell" && i.word === word);
  for (const h of hits.slice().reverse()) fixIssue(doc, h, replacement);
  return hits.length;
}

/** the issue (if any) covering a model position — for the right-click menu */
export function issueAt(issues: SpellIssue[], pos: E.Pos): SpellIssue | undefined {
  return issues.find((i) => i.pid === pos.pid && pos.off >= i.off && pos.off <= i.off + i.len);
}
