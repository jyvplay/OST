import { F, type SpecRow } from "./row";

/**
 * TT65 register additions + changes. USER-DIRECTED EXTENSION ROW (Class A Writer): the TT64 ledger's Writer gap was that Track
 * Changes covered only the main text — revisions in headers, footers, footnotes and endnotes were neither listed nor resolvable
 * (Accept All left them in the file), and edits there were never recorded (a note holding revisions was even rebuilt as plain
 * text, silently resolving them). TT65 makes every story reviewable and every story edit trackable.
 */
export const tt65Features: SpecRow[] = [
  F("FF-49", "FF", "Writer Track Changes in every story: Review lists and resolves revisions in headers, footers, footnotes and endnotes (one by one, or Accept / Reject All); with Track Changes on, header & footer Apply, Notes panel edits and spelling Change / Change All in those stories are recorded as w:ins / w:del",
    "A", "P2", "src/lib/office/wordedit.ts (stories, storyDoc, revisions / resolveOne / resolveChanges story routing, ParaView + viewEdit, editNoteText tracked path, joinNext) + hdrftr.ts (lineView, tracked setHf / removeHf, putHf) + wordspell.ts (tracked fixStoryIssue) + wordml.ts (ids reserved / renumbered across parts) + Writer Review / Notes / Header & footer panels",
    "Every story is edited through its own view of the document (the same styles, ids and author; the story's blocks copied first, so undo restores them): a story edit is the minimal diff of the reader's text applied with the ordinary editing operations — under Track Changes a w:del of what went and a w:ins of what came (the author's own pending insertions just vanish), untracked a plain edit that keeps other reviewers' pending revisions. Review names the place (Header, Footer, Footnote 2, Endnote 1) after the main text's items; Next / Previous step through them after the body. Header lines: an edited line changes in place (alignment = w:pPrChange), a new line is a tracked insertion (text and paragraph mark, separate ids), a removed line a tracked deletion — its page fields included — kept struck until reviewed; at the end of a header the change lands on the paragraph mark before it (the final mark cannot be inserted or deleted, as in Word). Typing {PAGE} / {NUMPAGES} while tracking inserts real tracked fields. Remove header while tracking strikes its text (Accept → empty header, Reject → the original). Fixed with it: (1) ids already used in header / footer parts were not reserved on open, so a new body revision could repeat one; (2) the duplicate-id renumbering ran on document.xml only — now one pass over every part written in a save; (3) note editing counted struck text as live text and flattened revisions; (4) header lines read struck text back as plain text; (5) a merged paragraph kept the first paragraph's properties even when that paragraph was deleted as a whole (Word keeps the next one's then); (6) found in the visual check: the spelling checker read struck letters as word breaks (\"re~~ci~~ceive\" checked as \"re\" + \"ceive\"), so every tracked fix left false squiggles — it reads the visible text now, in every story and the main text. Limits: comment text is not a reviewable story here; while tracking, an edit that cuts INTO a page field / tab (header) or a field / content control (note) is refused with a message and nothing changes (edits around them work); a header emptied while tracking keeps its last line's alignment after Accept; not opened in Word here (none in the sandbox) — the XSDs and the independent lxml oracle are the check.",
    "built", "tt65-writer-stories.mts (8 vs the lxml oracle docx_stories.py per-story Accept / Reject views + ECMA-376 XSDs: tracked header & footer Apply, tracked Notes edits (+ untracked edits keep others' revisions), tracked spelling Change / Change All in stories (+ no false issues from struck letters), one-by-one review in random orders = Accept / Reject All, mixed review per story, ids unique across parts (reserved on open, renumbered on save, untouched parts byte-identical), refusals byte-identical, typed {PAGE} = tracked field, tracked Remove header; 80 random sessions — 33 + 40 verified against the untracked edit / the original, 7 refused unchanged; 19 of 20 mutants killed, 1 equivalent (the frozen-character guard: the post-edit verification refuses the same edits)); e2e-tt65.mts FF-49"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-22": { note: "TT65: Track Changes covers headers, footers, footnotes and endnotes too — listed, resolved and recorded there (FF-49).", test: "tt65-writer-stories.mts; e2e-tt65.mts" },
};

const OLD_FF42 = "Header / footer / note fixes are not recorded as tracked changes (main-text fixes are).";
const NEW_FF42 = "TT65: with Track Changes on, header / footer / note fixes are recorded as tracked changes like main-text fixes (FF-49).";
const OLD_FF43 = "A note holding tracked changes, or an edit that cuts into a field / content control, falls back to plain text — and the status line says so.";
const NEW_FF43 = "TT65: a note holding tracked changes is edited in place (its pending revisions are kept), and with Track Changes on the edit is tracked (FF-49); an untracked edit that cuts into a field / content control falls back to plain text — and the status line says so.";

export function patchTT65(f: SpecRow): SpecRow {
  if (f.code === "FF-42" && f.nuance.includes(OLD_FF42)) f = { ...f, nuance: f.nuance.replace(OLD_FF42, NEW_FF42), test: `${f.test}; tt65-writer-stories.mts` };
  if (f.code === "FF-43" && f.nuance.includes(OLD_FF43)) f = { ...f, nuance: f.nuance.replace(OLD_FF43, NEW_FF43), test: `${f.test}; tt65-writer-stories.mts` };
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
