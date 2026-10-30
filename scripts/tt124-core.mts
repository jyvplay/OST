/** TT124 — unit contract for this turn's engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { indentSelection, INDENT } from "../src/lib/editor-indent";
import { worldTimesText } from "../src/lib/world-times";
import { clampPage } from "../src/lib/page-jump";
import { hexHead, HEX_HEAD_BYTES } from "../src/lib/hex-head";
import { pruneFinished, isFinishedJob, inFlightJobs } from "../src/lib/job-prune";
import { goalStatus } from "../src/lib/word-goal";
import { shownFx } from "../src/lib/compare-fx";
import { nextAbState, abLoopSeek, abLabel } from "../src/lib/ab-loop";
import { emailList } from "../src/lib/email-list";
import { conversationText } from "../src/lib/conversation-text";
import { photoInfoText } from "../src/lib/photo-info";
import { resConstraint, RES_OPTIONS } from "../src/lib/res-constraint";
import { newRoomCode } from "../src/lib/room-code";
import { duplicateName } from "../src/lib/routine-dup";
import { familyProgressText } from "../src/lib/family-progress-text";
import { sessionListText } from "../src/lib/session-list-text";
import { connLine } from "../src/lib/conn-line";
import { exportSvg, blankDoc } from "../src/lib/vector/model";

const { test, finish } = makeHarness("tt124-core");

await test("ED-08 indent: block spans selection, dedent removes one step, selection tracks", { "ED-08": "full" }, () => {
  const t = "one\ntwo\nthree\n";
  const r = indentSelection(t, 4, 9, 1); // inside "two".."three"
  assert.equal(r.text, `one\n${INDENT}two\n${INDENT}three\n`);
  assert.equal(r.text.slice(r.selStart, r.selEnd), `${INDENT}two\n${INDENT}three`);
  const back = indentSelection(r.text, r.selStart, r.selEnd, -1);
  assert.equal(back.text, t, "dedent is the exact inverse here");
  const d = indentSelection("  x\n\t y\n", 0, 8, -1);
  assert.equal(d.text, "x\n y\n", "dedent strips two spaces or one tab");
});

await test("CK-08 world times: displayed order kept, offsets in parentheses", { "CK-08": "full" }, () => {
  const rows = [{ zone: "Asia/Tokyo", time: "08:00", offset: "UTC+9" }, { zone: "America/New_York", time: "19:00", offset: "UTC−4" }];
  assert.equal(worldTimesText(rows), "Asia/Tokyo — 08:00 (UTC+9)\nAmerica/New York — 19:00 (UTC−4)");
  assert.equal(worldTimesText([]), "(no zones)");
});

await test("PD-02 page jump: 1-based clamp, garbage refused", { "PD-02": "full" }, () => {
  assert.equal(clampPage("3", 10), 2);
  assert.equal(clampPage("0", 10), 0);
  assert.equal(clampPage("99", 10), 9);
  assert.equal(clampPage("x", 10), null);
  assert.equal(clampPage("1", 0), null);
});

await test("PK-02 hex head: 16-per-line, ascii gutter, truncation stated", { "PK-02": "full" }, () => {
  const b = Uint8Array.from({ length: 70 }, (_, i) => (i * 7) % 256);
  const h = hexHead(b);
  const lines = h.split("\n");
  assert.equal(lines.length, 5, "4 full rows + truncation note");
  assert.match(lines[0], /^00000000  /);
  assert.match(lines[0], /\|.*\|$/);
  assert.match(lines[4], /6 more bytes not shown/);
  assert.equal(hexHead(Uint8Array.from([0x41, 0x00, 0x42])).split("\n")[0].includes("|A.B|"), true, "non-printables dot out");
  assert.equal(HEX_HEAD_BYTES, 64);
});

await test("LN-17/CP-02 resolution pick: one engine, two cameras", { "LN-17": "full", "CP-02": "full" }, () => {
  assert.deepEqual(resConstraint("640"), { width: { ideal: 640 }, height: { ideal: 360 } });
  assert.deepEqual(resConstraint("1920"), { width: { ideal: 1920 }, height: { ideal: 1080 } });
});

await test("MN-02 in-flight view: finished rows filtered, journal untouched", { "MN-02": "full" }, () => {
  const jobs = [{ id: 1, state: "COMPLETE" }, { id: 2, state: "RUNNING" }, { id: 3, state: "FAILED" }, { id: 4, state: "QUEUED" }];
  assert.deepEqual(pruneFinished(jobs).map((j) => j.id), [1, 3]);
  assert.deepEqual(inFlightJobs(jobs).map((j) => j.id), [2, 4]);
  assert.equal(isFinishedJob({ id: 9, state: "RUNNING" }), false);
});

await test("WR-01 word goal: net writing, clamped, done flag", { "WR-01": "full" }, () => {
  assert.deepEqual(goalStatus(100, 150, 40), { written: 50, remaining: 0, done: true });
  assert.deepEqual(goalStatus(100, 90, 40), { written: 0, remaining: 40, done: false }, "deletions never go negative");
  assert.deepEqual(goalStatus(0, 10, 0), { written: 10, remaining: 0, done: false }, "a zero target is not a goal");
});

await test("IE-01 compare: holding shows the original, release restores the edit", { "IE-01": "full" }, () => {
  const edited = { rotate: 90 as const }, original = { rotate: 0 as const };
  assert.equal(shownFx(edited, original, true), original);
  assert.equal(shownFx(edited, original, false), edited);
});

await test("MD-12 A–B loop: A→B→off cycle, B before A re-sets A, seek at B", { "MD-12": "full" }, () => {
  let ab = nextAbState({ a: null, b: null }, 5);
  assert.deepEqual(ab, { a: 5, b: null });
  ab = nextAbState(ab, 3); // before A: re-set A
  assert.deepEqual(ab, { a: 3, b: null });
  ab = nextAbState(ab, 9);
  assert.deepEqual(ab, { a: 3, b: 9 });
  assert.equal(abLoopSeek(ab, 8.9), null);
  assert.equal(abLoopSeek(ab, 8.97), 3, "reaching B jumps back to A");
  assert.match(abLabel(ab), /A–B 0:03–0:09/);
  assert.equal(abLabel(nextAbState(ab, 1)), "A–B loop", "third click disarms");
});

await test("CN-10 email list: deduped, sorted, empties dropped", { "CN-10": "full" }, () => {
  const cs = [{ emails: [{ value: "z@x.io" }, { value: " " }] }, { emails: [{ value: "a@x.io" }, { value: "z@x.io" }] }];
  assert.deepEqual(emailList(cs), ["a@x.io", "z@x.io"]);
  assert.deepEqual(emailList([]), []);
});

await test("MS-06 conversation text: timestamped lines, empty stated", { "MS-06": "full" }, () => {
  const msgs = [{ from: "ada", text: "hi", ts: new Date(2026, 9, 30, 9, 5).getTime() }];
  assert.match(conversationText(msgs), /ada: hi$/);
  assert.match(conversationText(msgs), /^(\d{1,2}:\d{2}:\d{2}\s)/);
  assert.equal(conversationText([]), "(no messages loaded)");
});

await test("PH-08 photo info: absences say 'not in index'", { "PH-08": "full" }, () => {
  const t = photoInfoText({ path: "/a.png", size: 10, mime: "image/png" });
  assert.match(t, /Date: not in index/);
  const t2 = photoInfoText({ path: "/a.png", size: 10, mime: "image/png", index: { date: "2026-01-01", lat: 1.5, lon: 2.5 } });
  assert.match(t2, /Date: 2026-01-01/);
  assert.match(t2, /Place: 1\.5000, 2\.5000/);
  assert.match(t2, /Camera: not in index/);
});

await test("VT-02 SVG markup: existing exporter's output is clipboard-ready", { "VT-02": "full" }, () => {
  const svg = exportSvg(blankDoc("t"));
  assert.match(svg, /<svg/);
  assert.match(svg, /<\/svg>\s*$/);
});

await test("CP-02 resolution: ideals only, max adds nothing", { "CP-02": "full" }, () => {
  assert.deepEqual(resConstraint("1280"), { width: { ideal: 1280 }, height: { ideal: 720 } });
  assert.deepEqual(resConstraint("max"), {});
  assert.equal(RES_OPTIONS.length, 4);
});

await test("TG-01 room code: prefix, length, unambiguous alphabet", { "TG-01": "full" }, () => {
  const c = newRoomCode(() => 0.5);
  assert.match(c, /^ROOM-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.doesNotMatch(newRoomCode(Math.random).slice(5), /[01ILO]/);
  assert.notEqual(newRoomCode(Math.random), newRoomCode(Math.random));
});

await test("RT-03 duplicate name: collisions get numbered copies", { "RT-03": "full" }, () => {
  assert.equal(duplicateName("Backup", []), "Backup copy");
  assert.equal(duplicateName("Backup", ["Backup copy"]), "Backup copy 2");
  assert.equal(duplicateName("Backup", ["Backup copy", "Backup copy 2"]), "Backup copy 3");
});

await test("SP-03 family text: worst first, same engine as the strip", { "SP-03": "full" }, () => {
  const rows = [{ family: "B", status: "built" }, { family: "B", status: "partial" }, { family: "A", status: "built" }];
  assert.equal(familyProgressText(rows), "B 50% (1/2 built)\nA 100% (1/1 built)");
  assert.equal(familyProgressText([]), "(no families)");
});

await test("BM-02 session text: newest first, active rows carry elapsed", { "BM-02": "full" }, () => {
  const now = new Date(2026, 9, 30, 12, 0, 30).getTime();
  const s = [
    { transport: "camera", targetName: "Lens", state: "ended", startedAt: new Date(2026, 9, 30, 10, 0, 0).toISOString() },
    { transport: "screen", targetName: "Beam", state: "active", startedAt: new Date(2026, 9, 30, 11, 59, 30).toISOString() },
  ];
  const t = sessionListText(s, now);
  const lines = t.split("\n");
  assert.match(lines[0], /screen → Beam · active · up 01:00/);
  assert.match(lines[1], /camera → Lens · ended$/);
  assert.equal(sessionListText([], now), "(no sessions)");
});

await test("SSH-02 conn line: default port omitted, state in words", { "SSH-02": "full" }, () => {
  assert.equal(connLine({ user: "u", host: "h", port: "22", state: "connected" }), "u@h · connected");
  assert.equal(connLine({ user: "u", host: "h", port: "2222", state: "failed" }), "u@h:2222 · failed");
  assert.equal(connLine({ user: "", host: "h", port: "22", state: "idle" }), "anonymous@h · idle");
});

finish();
