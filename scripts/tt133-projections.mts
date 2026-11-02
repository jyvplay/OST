/** Finite ownership attacks on the actual Word display projection functions.
 * No alternate document implementation, fabricated device or intercepted API.
 * These are kernel tests, not claims of native Writer end-to-end coverage. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { allParas, blankWord, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { writerDocumentView, writerPaneView, writerToolbarView } from "../src/lib/office/word-ui.ts";
import { setHf } from "../src/lib/office/hdrftr.ts";
const { test, finish } = makeHarness("tt133-projections");
const encode = (value: unknown) => JSON.stringify(value, (_key, v) => v instanceof Set ? [...v] : v instanceof Map ? [...v] : v);
function objects(root: unknown): Set<object> {
  const seen = new Set<object>();
  function visit(v: unknown) {
    if (v === null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (v instanceof Map) { for (const [k, x] of v) { visit(k); visit(x); } }
    else if (v instanceof Set) { for (const x of v) visit(x); }
    else for (const x of Object.values(v)) visit(x);
  }
  visit(root); return seen;
}
function independent(model: WordDoc, view: unknown) {
  const modelObjects = objects(model);
  for (const o of objects(view)) assert.equal(modelObjects.has(o), false, "a mutable document object escaped into a display projection");
}
async function doc() {
  const d = await blankWord("Before");
  const p = allParas(d.blocks)[0];
  E.insertText(d, { pid: p.id, off: 0 }, "Hello compass");
  const range = { a: { pid: p.id, off: 0 }, b: { pid: p.id, off: 5 } };
  E.applyFmt(d, range, { b: true, color: "123456" });
  E.addComment(d, range, "Original comment", "Original author");
  E.insertNote(d, { pid: p.id, off: 6 }, "footnote", "Original note");
  E.setStyle(d, range, "Heading1");
  setHf(d, "header", "default", [{ text: "Header {PAGE}", align: "right" }]);
  return { d, p, range };
}
await test("Document projection owns its page, tracking, style rows and counts; model mutation cannot rewrite an older render", {}, async () => {
  const { d } = await doc(); const view = writerDocumentView(d), before = encode(view);
  independent(d, view); assert.equal(view.title, "Before"); assert.equal(view.counts.words, 2);
  d.title = "After"; d.page.w += 200; d.track.on = !d.track.on;
  for (const s of d.styles.values()) s.name = "MUTATED";
  E.insertText(d, { pid: allParas(d.blocks)[0].id, off: 0 }, "another word ");
  assert.equal(encode(view), before); assert.equal(writerDocumentView(d).title, "After");
});
await test("Toolbar projection owns formatting/mixed flags and paragraph scalars across style, text, list and selection changes", {}, async () => {
  const { d, p, range } = await doc(); const pending = { i: true };
  const view = writerToolbarView(d, range, pending), before = encode(view);
  independent(d, view); assert.equal(view.fmt?.b, true); assert.equal(view.fmt?.i, true); assert.equal(view.fmt?.color, "123456");
  pending.i = false; p.p.line = 777; E.applyFmt(d, range, { b: false, color: "abcdef" }); E.toggleList(d, range, "bullet");
  assert.equal(encode(view), before); assert.equal(writerToolbarView(d, range, null).fmt?.b, false);
});
await test("Comment projection whitelists scalars: comment blocks/XML must not leak through a shallow spread", {}, async () => {
  const { d } = await doc(); const view = writerPaneView(d, "review", "comment"), before = encode(view);
  independent(d, view); assert.equal(view.comments[0].text, "Original comment");
  assert.deepEqual(Object.keys(view.comments[0]).sort(), ["author", "date", "id", "initials", "text"]);
  d.comments[0].text = "New comment"; d.comments[0].author = "New author";
  const cp = allParas(d.comments[0].blocks)[0]; if (cp) { cp.p.line = 999; cp.content.length = 0; }
  assert.equal(encode(view), before); assert.equal(writerPaneView(d, "review", "").comments[0].text, "New comment");
});
await test("Header/footer projection owns paragraph rows across editing and page-setup mutation", {}, async () => {
  const { d } = await doc(); const view = writerPaneView(d, "hf", ""), before = encode(view);
  independent(d, view); assert.equal(view.headers?.header.default[0].text, "Header {PAGE}");
  setHf(d, "header", "default", [{ text: "Replacement", align: "left" }]);
  E.setPageSetup(d, { paper: "A4", landscape: true });
  assert.equal(encode(view), before); assert.equal(writerPaneView(d, "hf", "").headers?.header.default[0].text, "Replacement");
});
await test("Navigation, note and revision panes contain no engine aliases and stay unchanged after real engine edits", {}, async () => {
  const { d, p } = await doc(); E.setTracking(d, true, "Author"); E.insertText(d, { pid: p.id, off: 0 }, "Tracked ");
  const nav = writerPaneView(d, "nav", ""), notes = writerPaneView(d, "notes", ""), review = writerPaneView(d, "review", "");
  const before = encode([nav, notes, review]); independent(d, [nav, notes, review]);
  assert.ok(nav.headings.length > 0); assert.equal(notes.notes[0].text, "Original note"); assert.ok(review.changes.length > 0);
  E.setNoteText(d, "footnote", notes.notes[0].id, "Changed note");
  E.insertText(d, { pid: p.id, off: 0 }, "More ");
  assert.equal(encode([nav, notes, review]), before);
});
await test("Inactive panes remain empty; stale selections do not alias the replacement document", {}, async () => {
  const { d, range } = await doc(); const view = writerPaneView(d, "none", "");
  assert.deepEqual([view.headings, view.notes, view.changes, view.comments, view.headers], [[], [], [], [], null]);
  const replacement = await blankWord("Replacement"); const toolbar = writerToolbarView(replacement, range, null);
  independent(replacement, toolbar); assert.equal(toolbar.inTable, false);
});
finish();
