/**
 * TT143 — FM-18 safe-save contract.
 *
 * Session copy → temp → validate → atomic replace.
 *
 * The engine already existed (TT137) but its only test needed a database, so it
 * had never been checked as a state machine. That is exactly the wrong gap to
 * leave: the entire promise of this feature is "the original file is not
 * touched unless the new bytes are good", and that promise is a property of the
 * phase transitions, not of a database round-trip.
 *
 * The adversarial reading of the contract is the one used here: find a sequence
 * of calls that publishes bad bytes, or that leaves the original damaged when a
 * step fails.
 */
import { makeHarness } from "./harness.mts";
import {
  createSafeSave, writeChunk, markTempWritten, validate, markValidated, publish, fail,
  isOriginalSafe, describePhase, SAFE_SAVE_TOKEN,
  type SafeSaveState,
} from "../src/lib/files/safe-save.ts";

const { test, finish } = makeHarness("tt143-safe-save");
const SHA = (c: string) => c.repeat(64).slice(0, 64);
const bytes = (s: string) => new TextEncoder().encode(s);

/** Walk a state to `validated`, the point where publish becomes legal. */
const toValidated = (total = 5): SafeSaveState => {
  let s = createSafeSave("/Session/x", "/Docs/x.txt", total);
  s = writeChunk(s, bytes("hello"));
  s = markTempWritten(s, SHA("a"));
  s = markValidated(s, SHA("b"));
  return s;
};

await test("FM-18 · a fresh save is idle and the original is untouched", { "FM-18": "full" }, () => {
  const s = createSafeSave("/Session/x", "/Docs/x.txt", 5);
  if (s.phase !== "idle") throw new Error(`new state should be idle, got ${s.phase}`);
  if (!isOriginalSafe(s)) throw new Error("the original must be safe before anything happens");
  if (s.tempPath === s.targetPath) throw new Error("the temp path collided with the target — a partial write could destroy the original");
  // The temp lives beside the target (same directory), so the replace is same-FS and atomic.
  if (!s.tempPath.startsWith("/Docs/")) throw new Error(`temp path ${s.tempPath} is not beside the target`);
  // ...and it keeps the extension, so a validator that keys on suffix still works.
  if (!s.tempPath.endsWith(".txt")) throw new Error("temp lost the extension");
});

await test("FM-18 · nothing can be published before it is validated", { "FM-18": "full" }, () => {
  // The attack: skip validation and publish whatever was written.
  const idle = createSafeSave("/Session/x", "/Docs/x.txt", 5);
  for (const bad of [idle, writeChunk(idle, bytes("hello"))]) {
    let threw = false;
    try { publish(bad); } catch { threw = true; }
    if (!threw) throw new Error(`publish succeeded in the ${bad.phase} phase — unvalidated bytes reached the original`);
    if (!isOriginalSafe(bad)) throw new Error("the original was reported unsafe after a refused publish");
  }
  // Writing directly into validated is also refused: validation must read the
  // temp that was actually written.
  let threw = false;
  try { markValidated(writeChunk(idle, bytes("hello")), SHA("b")); } catch { threw = true; }
  if (!threw) throw new Error("a state was marked validated without its temp being written");
});

await test("FM-18 · a size or digest mismatch leaves the original safe", { "FM-18": "full" }, () => {
  // This is the whole feature: bad bytes must stop at the temp.
  let s = createSafeSave("/Session/x", "/Docs/x.txt", 5);
  s = writeChunk(s, bytes("hello"));
  s = markTempWritten(s, SHA("a"));
  const short = validate(s, SHA("a"), 4);
  if (short.ok) throw new Error("a size mismatch validated");
  if (!/size/i.test((short as { reason: string }).reason)) throw new Error("the size failure was not named");
  const wrong = validate(s, SHA("c"), 5);
  if (wrong.ok) throw new Error("a digest mismatch validated");
  // After a failed validation the state is still pre-publish, and the original
  // is still safe — a validator returning a failure must not advance anything.
  if (!isOriginalSafe(s)) throw new Error("a failed validation marked the original unsafe");
  let threw = false;
  try { publish(s); } catch { threw = true; }
  if (!threw) throw new Error("publish was allowed after a failed validation");
});

await test("FM-18 · the temp write cannot exceed the declared size", { "FM-18": "full" }, () => {
  // An unbounded write is how a "safe" save fills the disk and the temp is
  // never completed, so the save can only fail forever.
  let s = createSafeSave("/Session/x", "/Docs/x.txt", 5);
  s = writeChunk(s, bytes("hell"));
  let threw = false;
  try { writeChunk(s, bytes("oworld")); } catch { threw = true; }
  if (!threw) throw new Error("a chunk past the declared total was accepted");
  // Completing the write short of the total is refused too: a truncated temp
  // must not be promoted to "written".
  threw = false;
  try { markTempWritten(s, SHA("a")); } catch { threw = true; }
  if (!threw) throw new Error("an incomplete temp was marked written");
});

await test("FM-18 · the happy path publishes and the original becomes replaceable", { "FM-18": "full" }, () => {
  let s = toValidated();
  if (s.phase !== "validated") throw new Error(`expected validated, got ${s.phase}`);
  if (!isOriginalSafe(s)) throw new Error("the original must still be safe right up to publish");
  s = publish(s);
  if (s.phase !== "published") throw new Error(`publish left phase ${s.phase}`);
  // Only now is the original allowed to be replaced.
  if (isOriginalSafe(s)) throw new Error("after publish the original should no longer be protected");
  // The state remembers both digests, so the swap can be undone or audited.
  if (!s.tempSha || !s.originalSha) throw new Error("digests were not retained through publish");
});

await test("FM-18 · failure at any phase is terminal and safe", { "FM-18": "full" }, () => {
  // A failure must not be resumable: a half-understood state that can still
  // publish is worse than a clean abort.
  const states: SafeSaveState[] = [
    createSafeSave("/Session/x", "/Docs/x.txt", 5),
    writeChunk(createSafeSave("/Session/x", "/Docs/x.txt", 5), bytes("hello")),
    markTempWritten(writeChunk(createSafeSave("/Session/x", "/Docs/x.txt", 5), bytes("hello")), SHA("a")),
    toValidated(),
  ];
  for (const st of states) {
    const f = fail(st, "disk full");
    if (f.phase !== "failed") throw new Error(`fail from ${st.phase} produced ${f.phase}`);
    if (!isOriginalSafe(f)) throw new Error(`a failure in ${st.phase} marked the original unsafe`);
    if (!f.error) throw new Error("the failure reason was dropped");
    // Nothing may advance from failed.
    for (const fn of [() => writeChunk(f, bytes("x")), () => markTempWritten(f, SHA("a")), () => publish(f)]) {
      let threw = false;
      try { fn(); } catch { threw = true; }
      if (!threw) throw new Error(`a ${f.phase} state advanced to a later phase`);
    }
  }
  // A long reason is bounded rather than stored whole.
  if (fail(states[0], "x".repeat(5000)).error!.length > 300) throw new Error("the failure reason was not bounded");
});

await test("FM-18 · bad inputs are refused at construction", { "FM-18": "full" }, () => {
  const cases: Array<() => unknown> = [
    () => createSafeSave("relative", "/Docs/x", 1),
    () => createSafeSave("/Session/x", "relative", 1),
    () => createSafeSave("/Session/x", "/Docs/x", -1),
    () => createSafeSave("/Session/x", "/Docs/x", 8 * 1024 * 1024 + 1),
    () => createSafeSave("/Session/x", "/Docs/x", NaN),
    () => createSafeSave("/Session/x", "/Docs/x", 1.5),
    // Saving a file onto itself would truncate the original before validation.
    () => createSafeSave("/Docs/x.txt", "/Docs/x.txt", 1),
  ];
  for (const [i, make] of cases.entries()) {
    let threw = false;
    try { make(); } catch { threw = true; }
    if (!threw) throw new Error(`bad input case ${i} was accepted`);
  }
  // A zero-byte save is legitimate.
  const empty = createSafeSave("/Session/x", "/Docs/x", 0);
  if (empty.total !== 0) throw new Error("a zero-byte save was rejected");
});

await test("FM-18 · a chunk must really be bytes", { "FM-18": "full" }, () => {
  // Passing a string or array would be length-counted but not written, so the
  // total would advance over bytes that never existed.
  const s = createSafeSave("/Session/x", "/Docs/x.txt", 10);
  for (const bad of ["hello", [1, 2, 3], new ArrayBuffer(3), null, undefined]) {
    let threw = false;
    try { writeChunk(s, bad as never); } catch { threw = true; }
    if (!threw) throw new Error(`non-Uint8Array chunk ${String(bad)} was accepted`);
  }
});

await test("FM-18 · every transition is pure and the phase text is honest", { "FM-18": "full" }, () => {
  const s = createSafeSave("/Session/x", "/Docs/x.txt", 5);
  const frozen = JSON.stringify(s);
  writeChunk(s, bytes("hello"));
  if (JSON.stringify(s) !== frozen) throw new Error("writeChunk mutated its input");
  // The description must not claim the original is replaced before it is.
  if (!/safe|untouched|original/i.test(describePhase(s))) throw new Error(`idle description: ${describePhase(s)}`);
  const published = publish(toValidated());
  if (!/replac|publish/i.test(describePhase(published))) throw new Error(`published description: ${describePhase(published)}`);
  if (SAFE_SAVE_TOKEN.length < 3) throw new Error("token missing");
});

finish();
