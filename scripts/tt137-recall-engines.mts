/**
 * TT137 pure-suite: Recall visual memory engine (RC-02…RC-33).
 */
import { makeHarness } from "./harness.mts";
import {
  createState, publish, inspectPair, trashMemory, undoTrash, planBatchSave,
  groupByDay, applyCrop, inspectIntegrity, exportMemory, discoverSurfaces,
  timeline, replay, addClipboardMemory, recallByVisual, applyExclusions,
  pasteMedia, dropMedia, checkHalfPairs, checkDurability,
  type Memory,
} from "../src/lib/recall/engine.ts";

const { test, finish } = makeHarness("tt137-recall-engines");

const mkMem = (id: string, now: number, over: Partial<Memory> = {}): Memory => ({
  id, path: `/Mem/${id}.bin`, sha256: id.replace(/[^a-f0-9]/gi, "").padEnd(64, "a").slice(0, 64).toLowerCase(),
  bytes: 1024, createdAt: now, width: 800, height: 600, ...over,
});

// ── RC-22: Atomic memory and receipt publication ─────────────────────────────
await test("RC-22 · publish creates memory and receipt together", { "RC-22": "full" }, () => {
  const s = createState();
  const r = publish(s, mkMem("m-001", 1000), 1000);
  if (!r.ok) throw new Error(`publish failed: ${r.reason}`);
  if (s.memories.length !== 1) throw new Error("memory not added");
  if (s.receipts.length !== 1) throw new Error("receipt not added");
  if (s.receipts[0].seq !== 1) throw new Error("seq should be 1");
});

await test("RC-22 · publish rejects duplicate id", { "RC-22": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  const r = publish(s, mkMem("m-001", 2000), 2000);
  if (r.ok) throw new Error("should reject duplicate id");
});

await test("RC-22 · publish rejects sensitive in Public", { "RC-22": "full" }, () => {
  const s = createState();
  const r = publish(s, mkMem("m-002", 1000, { path: "/Public/secret.bin", sensitive: true }), 1000);
  if (r.ok) throw new Error("should reject sensitive in Public");
});

await test("RC-22 · publish rejects invalid sha", { "RC-22": "full" }, () => {
  const s = createState();
  const r = publish(s, mkMem("m-003", 1000, { sha256: "bad" }), 1000);
  if (r.ok) throw new Error("should reject invalid sha");
});

// ── RC-24: Pair inspection ────────────────────────────────────────────────────
await test("RC-24 · identical memories report identical", { "RC-24": "full" }, () => {
  const a = mkMem("m-001", 1000);
  const b = { ...a };
  const d = inspectPair(a, b);
  if (!d.identical) throw new Error("should be identical");
  if (!d.shaMatch) throw new Error("sha should match");
});

await test("RC-24 · different size reports sizeDelta", { "RC-24": "full" }, () => {
  const a = mkMem("m-001", 1000);
  const b = { ...a, bytes: 2048 };
  const d = inspectPair(a, b);
  if (d.identical) throw new Error("should not be identical");
  if (d.sizeDelta !== -1024) throw new Error(`expected -1024, got ${d.sizeDelta}`);
});

// ── RC-25: Paired trash and undo ──────────────────────────────────────────────
await test("RC-25 · trash pairs two memories", { "RC-25": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  publish(s, mkMem("m-002", 2000), 2000);
  const r = trashMemory(s, "m-001", 3000, "m-002");
  if (!r.ok) throw new Error(`trash failed: ${r.reason}`);
  if (s.memories[0].trashed !== true) throw new Error("m-001 should be trashed");
  if (s.memories[1].trashed !== true) throw new Error("m-002 should be trashed");
  if (!s.trashPairs.has("m-001")) throw new Error("pair not recorded");
});

await test("RC-25 · undo restores trashed memory", { "RC-25": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  trashMemory(s, "m-001", 2000);
  const r = undoTrash(s, "m-001");
  if (!r.ok) throw new Error(`undo failed: ${r.reason}`);
  if (s.memories[0].trashed !== false) throw new Error("should be restored");
});

await test("RC-25 · cannot trash already-trashed", { "RC-25": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  trashMemory(s, "m-001", 2000);
  const r = trashMemory(s, "m-001", 3000);
  if (r.ok) throw new Error("should reject double-trash");
});

// ── RC-31: Batch save ─────────────────────────────────────────────────────────
await test("RC-31 · batch save splits saved and to-save", { "RC-31": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  publish(s, mkMem("m-002", 2000), 2000);
  const plan = planBatchSave(s, ["m-001", "m-002", "m-003"]);
  if (plan.total !== 3) throw new Error(`expected 3 total, got ${plan.total}`);
  if (plan.alreadySaved.length !== 2) throw new Error(`expected 2 saved, got ${plan.alreadySaved.length}`);
  if (plan.skipped.length !== 1) throw new Error(`expected 1 skipped, got ${plan.skipped.length}`);
});

await test("RC-31 · batch save skips trashed", { "RC-31": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  trashMemory(s, "m-001", 2000);
  const plan = planBatchSave(s, ["m-001"]);
  if (plan.skipped[0].reason !== "trashed") throw new Error(`expected trashed reason, got ${plan.skipped[0].reason}`);
});

// ── RC-32: Day-grouped timeline ───────────────────────────────────────────────
await test("RC-32 · groupByDay groups by ISO date", { "RC-32": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", Date.UTC(2026, 0, 1, 12, 0)), 1000);
  publish(s, mkMem("m-002", Date.UTC(2026, 0, 1, 18, 0)), 2000);
  publish(s, mkMem("m-003", Date.UTC(2026, 0, 2, 12, 0)), 3000);
  const groups = groupByDay(s);
  if (groups.length !== 2) throw new Error(`expected 2 groups, got ${groups.length}`);
  if (groups[0].memories.length !== 2) throw new Error(`expected 2 in first group, got ${groups[0].memories.length}`);
});

// ── RC-33: Region crop ─────────────────────────────────────────────────────────
await test("RC-33 · applyCrop sets valid crop", { "RC-33": "full" }, () => {
  const m = mkMem("m-001", 1000);
  const cropped = applyCrop(m, 100, 50, 200, 150);
  if (cropped.crop!.x !== 100) throw new Error("crop x wrong");
  if (cropped.crop!.w !== 200) throw new Error("crop w wrong");
});

await test("RC-33 · applyCrop rejects out-of-bounds", { "RC-33": "full" }, () => {
  const m = mkMem("m-001", 1000);
  try {
    applyCrop(m, 700, 500, 200, 150); // x+w > width
    throw new Error("should reject");
  } catch (e) {
    if (!(e instanceof Error) || !/exceeds/.test(e.message)) throw e;
  }
});

// ── RC-19: Integrity inspection ───────────────────────────────────────────────
await test("RC-19 · integrity all-pass", { "RC-19": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  const r = inspectIntegrity(s, (id) => s.memories.find((m) => m.id === id)!.sha256);
  if (!r.ok) throw new Error(`should be ok: ${r.mismatched.length} mismatched`);
  if (r.verified.length !== 1) throw new Error("should verify 1");
});

await test("RC-19 · integrity detects mismatch", { "RC-19": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  const r = inspectIntegrity(s, () => "0".repeat(64));
  if (r.ok) throw new Error("should detect mismatch");
  if (r.mismatched.length !== 1) throw new Error("should report 1 mismatch");
});

// ── RC-20: Export ──────────────────────────────────────────────────────────────
await test("RC-20 · exportMemory returns payload", { "RC-20": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  const r = exportMemory(s, "m-001");
  if ("error" in r) throw new Error(`export failed: ${r.error}`);
  if (r.memory.id !== "m-001") throw new Error("wrong memory");
  if (!r.receipt) throw new Error("should include receipt");
});

await test("RC-20 · exportMemory rejects missing", { "RC-20": "full" }, () => {
  const s = createState();
  const r = exportMemory(s, "m-999");
  if (!("error" in r)) throw new Error("should return error");
});

// ── RC-21: Surface discovery ───────────────────────────────────────────────────
await test("RC-21 · discoverSurfaces lists non-trashed", { "RC-21": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  publish(s, mkMem("m-002", 2000), 2000);
  trashMemory(s, "m-002", 3000);
  const surfaces = discoverSurfaces(s);
  if (surfaces.length !== 1) throw new Error(`expected 1, got ${surfaces.length}`);
});

// ── RC-07/RC-08: Timeline and replay ──────────────────────────────────────────
await test("RC-07 · timeline is chronological", { "RC-07": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-002", 2000), 2000);
  publish(s, mkMem("m-001", 1000), 1000);
  const t = timeline(s);
  if (t[0].id !== "m-001") throw new Error("should be chronological");
});

await test("RC-08 · replay returns timeline", { "RC-08": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  const r = replay(s);
  if (r.length !== 1) throw new Error("should replay 1");
});

// ── RC-02/RC-03: Clipboard and visual recall ───────────────────────────────────
await test("RC-02 · clipboard memory is published", { "RC-02": "full" }, () => {
  const s = createState();
  const r = addClipboardMemory(s, mkMem("m-001", 1000), 1000);
  if (!r.ok) throw new Error(`clipboard failed: ${r.reason}`);
});

await test("RC-03 · recall by visual properties", { "RC-03": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000, { width: 800, height: 600 }), 1000);
  publish(s, mkMem("m-002", 2000, { width: 1920, height: 1080 }), 2000);
  const r = recallByVisual(s, 800, 600);
  if (r.length !== 1) throw new Error(`expected 1, got ${r.length}`);
});

// ── RC-15: Sensitive-content exclusions ───────────────────────────────────────
await test("RC-15 · exclusions hide sensitive by default", { "RC-15": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000, { sensitive: false }), 1000);
  publish(s, mkMem("m-002", 2000, { sensitive: true }), 2000);
  const r = applyExclusions(s, false);
  if (r.visible.length !== 1) throw new Error(`expected 1 visible, got ${r.visible.length}`);
  if (r.excluded.length !== 1) throw new Error(`expected 1 excluded, got ${r.excluded.length}`);
});

await test("RC-15 · showSensitive reveals all", { "RC-15": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000, { sensitive: false }), 1000);
  publish(s, mkMem("m-002", 2000, { sensitive: true }), 2000);
  const r = applyExclusions(s, true);
  if (r.visible.length !== 2) throw new Error(`expected 2 visible, got ${r.visible.length}`);
});

// ── RC-16/RC-17: Paste and drop ───────────────────────────────────────────────
await test("RC-16 · paste media creates memory", { "RC-16": "full" }, () => {
  const s = createState();
  const r = pasteMedia(s, 50000, 800, 600, 1000);
  if (!r.ok) throw new Error(`paste failed: ${r.reason}`);
});

await test("RC-16 · paste rejects oversized", { "RC-16": "full" }, () => {
  const s = createState();
  const r = pasteMedia(s, 9 * 1024 * 1024, 800, 600, 1000);
  if (r.ok) throw new Error("should reject oversized paste");
});

await test("RC-17 · drop media creates memory", { "RC-17": "full" }, () => {
  const s = createState();
  const r = dropMedia(s, 50000, 800, 600, 1000, "/Documents/img.png");
  if (!r.ok) throw new Error(`drop failed: ${r.reason}`);
});

// ── RC-29/RC-30: Crash durability ─────────────────────────────────────────────
await test("RC-29 · no half pairs after normal operations", { "RC-29": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  publish(s, mkMem("m-002", 2000), 2000);
  trashMemory(s, "m-001", 3000, "m-002");
  const check = checkHalfPairs(s);
  if (check.hasHalfPair) throw new Error("should not have half pairs");
});

await test("RC-30 · durability check passes with receipt", { "RC-30": "full" }, () => {
  const s = createState();
  publish(s, mkMem("m-001", 1000), 1000);
  const r = checkDurability(s, "m-001");
  if (!r.ok) throw new Error(`should be durable: ${r.reason}`);
});

await test("RC-30 · durability check fails without receipt", { "RC-30": "full" }, () => {
  const s = createState();
  s.memories.push(mkMem("m-001", 1000)); // No receipt
  const r = checkDurability(s, "m-001");
  if (r.ok) throw new Error("should not be durable without receipt");
});

finish();
