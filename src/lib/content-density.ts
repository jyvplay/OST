/**
 * TT143 (visual pass) — measuring "less wordy" instead of asserting it.
 *
 * "Make the UI less wordy" is not reviewable. A word count per module is: the
 * label budget is a number, a violation names the module and the count, and the
 * rule survives being applied to modules nobody has written yet.
 *
 * Two budgets are enforced, both deliberately generous, because the point is to
 * catch a wall of prose, not to ban sentences:
 *   · **control labels** — ≤ 3 words. A button that needs four words is a
 *     button whose action is unclear, or a sentence wearing a button's clothes.
 *   · **explanations** — ≤ 24 words per block. A footnote that needs more is
 *     either two paragraphs (a document, not a tooltip) or a doc link.
 *
 * Acronyms and version numbers do not count as prose; a product name with an
 * internal space does. Punctuation is not a word. The checks are on strings, so
 * they run in a unit suite with no browser and no snapshot.
 */

export const MAX_LABEL_WORDS = 3;
export const MAX_NOTE_WORDS = 24;

/**
 * Words that carry meaning. Punctuation is not a word, an acronym ("WCAG", "AA")
 * is not prose, and a version number ("2.1", "v1.2.3") is one token worth nothing
 * — otherwise a version string alone would blow a label's budget.
 */
export function words(text: string): string[] {
  const cleaned = text
    .replace(/\bv?\d+(?:\.\d+)+\b/gi, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[()[\]{}.,;:!?"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  return cleaned.split(" ").filter((w) => /[A-Za-z]/.test(w) && !/^[A-Z]{2,6}$/.test(w));
}

export interface Violation { kind: "label" | "note"; text: string; count: number; limit: number; fix: string }

export function auditLabels(labels: readonly { text: string; where: string }[]): Violation[] {
  const out: Violation[] = [];
  for (const l of labels) {
    const n = words(l.text).length;
    if (n > MAX_LABEL_WORDS) out.push({ kind: "label", text: `${l.where}: “${l.text}”`, count: n, limit: MAX_LABEL_WORDS, fix: "name the action, and move the reason into the control's description" });
  }
  return out;
}

export function auditNotes(notes: readonly { text: string; where: string }[]): Violation[] {
  const out: Violation[] = [];
  for (const n of notes) {
    const c = words(n.text).length;
    if (c > MAX_NOTE_WORDS) out.push({ kind: "note", text: `${n.where}: ${c} words`, count: c, limit: MAX_NOTE_WORDS, fix: "split into a short note and a document link" });
  }
  return out;
}

/**
 * The module card copy: one line of summary, at most 12 words, and no sentence
 * that repeats the module's own name ("Notes — take notes").
 */
export function auditSummary(id: string, title: string, summary: string): Violation | null {
  const n = words(summary).length;
  if (n > 12) return { kind: "note", text: `${id}: summary is ${n} words`, count: n, limit: 12, fix: "say what it does that another module does not" };
  const titleWords = words(title.toLowerCase());
  const summaryWords = words(summary.toLowerCase());
  if (titleWords.length && titleWords.every((w) => summaryWords.includes(w)) && summaryWords.length <= titleWords.length + 3) {
    return { kind: "note", text: `${id}: the summary only repeats the title`, count: n, limit: 12, fix: "drop the summary; the title already says it" };
  }
  return null;
}

/** The number the visual pass reports: total words of chrome copy, so a turn can prove a decrease. */
export function countChrome(copy: readonly string[]): { total: number; unique: number } {
  const all = copy.flatMap(words);
  return { total: all.length, unique: new Set(all).size };
}
