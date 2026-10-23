/**
 * TT59 Writer proofing over the WordprocessingML model (pure, DOM-free; Node-tested in scripts/tt59-writer-spell.mts).
 *
 * spellIssues() walks every body paragraph (tables included) in model offset space — text runs by UTF-16 length,
 * opaque tokens as U+FFFC — and reports misspelled words and repeated words ("the the", Word's "Repeated word").
 * Skipped like Word: tracked deletions (struck text is not part of the document), runs marked "Do not check spelling"
 * (w:noProof), runs in a non-English language (w:lang), URLs / e-mail / paths, words with digits (ordinals excepted),
 * optionally words in UPPERCASE, words the user chose to "Ignore All", and single occurrences ignored once.
 */
import { allParas, type Block, type Para, type WordDoc } from "./wordml";
import { kid, attr, type XEl } from "./xmltree";
import * as E from "./wordedit";
import { tokenize, type Speller } from "../spell/hunspell";

export interface SpellIssue {
  kind: "spell" | "repeat"; pid: string; off: number; len: number; word: string;
  /** TT60: set for issues outside the main text — "hf:<rId>" (header / footer part) or "note:<footnote|endnote>:<id>" */
  story?: string; /** human place name for the pane: "Header", "Footer", "Footnote 2" */ where?: string;
}
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

/** TT65: the text a reader sees — tracked deletions left out (they used to be blanked to a word separator, so "re[ci]ceive"
 *  with struck "ci" was checked as "re" + "ceive", and a tracked word fix left two false squiggles) — with each character's
 *  model offset; other unchecked spans stay U+0000 separators, tokens U+FFFC */
export function visibleProof(p: Para): { s: string; at: number[] } {
  let s = ""; const at: number[] = []; let off = 0;
  for (const i of p.content) {
    const n = i.t === "r" ? i.text.length : 1;
    if (i.t === "r" && i.rev?.kind === "del") { off += n; continue; }
    const t = i.t !== "r" ? "\ufffc" : !checkable(i) ? "\u0000".repeat(n) : i.text;
    for (let k = 0; k < t.length; k++) at.push(off + k);
    s += t; off += n;
  }
  at.push(off);
  return { s, at };
}
/** the visible text of a model span (tracked deletions left out) — what an issue's `word` was read from */
export const visibleSlice = (p: Para, off: number, len: number) => { const v = visibleProof(p); let w = ""; for (let k = 0; k < v.s.length; k++) if (v.at[k] >= off && v.at[k] < off + len) w += v.s[k]; return w; };

export function issuesInPara(p: Para, sp: Speller, o: SpellOpts, ignoreAll: Set<string>, once: Set<string>, out: SpellIssue[] = []): SpellIssue[] {
  const { s, at } = visibleProof(p);
  const toks = tokenize(s, { skipUpper: o.skipUpper });
  let prev: { word: string; end: number } | null = null;
  for (const t of toks) {
    const w = t.word.replace(/’/g, "'");
    // off / len are MODEL offsets (a word with struck letters inside spans them); word = the visible text
    const iss = (kind: SpellIssue["kind"], c0: number, n: number): SpellIssue => ({ kind, pid: p.id, off: at[c0], len: (n ? at[c0 + n - 1] + 1 : at[c0]) - at[c0], word: s.slice(c0, c0 + n) });
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

/** TT60: headers / footers and footnotes / endnotes are checked too (Word proofs every story). Issues come after the main
 *  text: header / footer parts in relationship order, then notes in document order. */
export function storyIssues(doc: WordDoc, sp: Speller, o: SpellOpts = {}): SpellIssue[] {
  const out: SpellIssue[] = [];
  const ignoreAll = o.ignoreAll ?? new Set<string>(), once = o.ignoreOnce ?? new Set<string>();
  for (const [rid, blocks] of doc.parts) {
    const where = /footer/i.test(doc.hf.xml.get(rid)?.path ?? doc.rels.find((r) => r.id === rid)?.target ?? "") ? "Footer" : "Header";
    for (const p of allParas(blocks)) for (const x of issuesInPara(p, sp, o, ignoreAll, once)) out.push({ ...x, story: `hf:${rid}`, where });
  }
  const n = { footnote: 0, endnote: 0 };
  for (const note of doc.notes) {
    const k = ++n[note.type];
    for (const p of allParas(note.blocks)) for (const x of issuesInPara(p, sp, o, ignoreAll, once)) out.push({ ...x, story: `note:${note.type}:${note.id}`, where: `${note.type === "footnote" ? "Footnote" : "Endnote"} ${k}` });
  }
  return out;
}
/** every story: main text first, then headers / footers and notes */
export const allIssues = (doc: WordDoc, sp: Speller, o: SpellOpts = {}) => [...spellIssues(doc, sp, o), ...storyIssues(doc, sp, o)];

/** the paragraph an issue points at, in whichever story it lives */
export function issuePara(doc: WordDoc, i: SpellIssue): Para | undefined {
  if (!i.story) return E.paraById(doc, i.pid);
  return storyBlocks(doc, i.story).flatMap((b) => allParas(b.blocks)).find((p) => p.id === i.pid);
}
function storyBlocks(doc: WordDoc, story: string): { blocks: Block[]; set: (b: Block[]) => void }[] {
  const h = /^hf:(.+)$/.exec(story);
  if (h) { const b = doc.parts.get(h[1]); return b ? [{ blocks: b, set: (nb) => { doc.parts.set(h[1], nb); doc.hf.dirty.add(h[1]); } }] : []; }
  const m = /^note:(footnote|endnote):(.+)$/.exec(story);
  const k = m ? doc.notes.findIndex((x) => x.type === m[1] && x.id === m[2]) : -1;
  return k < 0 ? [] : [{ blocks: doc.notes[k].blocks, set: (nb) => { doc.notes[k] = { ...doc.notes[k], blocks: nb, dirty: true }; doc.notesTouched = true; } }];
}
/** a fix outside the main text: the story's blocks are copied first (so undo snapshots, which hold the old arrays, still
 *  restore), then the words are replaced inside the runs — run formatting is kept. TT65: with Track Changes on the fix is
 *  tracked like one in the main text (Word tracks header / footer / note edits): w:del of the old word + w:ins of the new,
 *  through the story's own view of the document (E.storyDoc) */
function fixStoryIssue(doc: WordDoc, i: SpellIssue, replacement: string): boolean {
  const st = storyBlocks(doc, i.story!)[0]; if (!st) return false;
  const nb = E.cloneBlocks(st.blocks);
  const p = allParas(nb).find((x) => x.id === i.pid); if (!p) return false;
  if (visibleSlice(p, i.off, i.len) !== i.word) return false;
  if (doc.track?.on) {
    const d = E.storyDoc(doc, nb);
    const r = { a: { pid: i.pid, off: i.off }, b: { pid: i.pid, off: i.off + i.len } };
    const at = replacement === "" ? E.deleteForward(d, r) : E.deleteForReplace(d, r);
    if (replacement) E.insertText(d, at, replacement);
    st.set(d.blocks);
    return true;
  }
  let pos = 0, put = false;
  const a = i.off, b = i.off + i.len;
  p.content = p.content.flatMap((it) => {
    const s0 = pos; pos += E.ilen(it);
    if (it.t !== "r" || pos <= a || s0 >= b) return [it];
    const from = Math.max(a, s0) - s0, to = Math.min(b, pos) - s0;
    const text = it.text.slice(0, from) + (put ? "" : replacement) + it.text.slice(to); put = true;
    return text ? [{ ...it, text }] : [];
  });
  p.dirty = true;
  st.set(nb);
  return true;
}

/** replaces one issue's text (tracked when Track Changes is on); a "repeat" issue with no replacement deletes the
 *  repeated word together with the space before it. Returns the caret position after the change. */
export function fixIssue(doc: WordDoc, i: SpellIssue, replacement: string): E.Pos {
  if (i.story) { fixStoryIssue(doc, i, replacement); return { pid: i.pid, off: i.off + replacement.length }; }
  const r = { a: { pid: i.pid, off: i.off }, b: { pid: i.pid, off: i.off + i.len } };
  const at = replacement === "" ? E.deleteForward(doc, r) : E.deleteForReplace(doc, r);
  return replacement ? E.insertText(doc, at, replacement) : at;
}

/** "Change All": every remaining misspelling equal to `word` (exact text) is replaced; returns the count */
export function changeAll(doc: WordDoc, sp: Speller, word: string, replacement: string, o: SpellOpts = {}): number {
  const hits = allIssues(doc, sp, o).filter((i) => i.kind === "spell" && i.word === word);
  for (const h of hits.slice().reverse()) fixIssue(doc, h, replacement);
  return hits.length;
}

/** the issue (if any) covering a model position — for the right-click menu */
export function issueAt(issues: SpellIssue[], pos: E.Pos): SpellIssue | undefined {
  return issues.find((i) => i.pid === pos.pid && pos.off >= i.off && pos.off <= i.off + i.len);
}
