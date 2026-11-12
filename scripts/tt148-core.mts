/**
 * TT148 — pure contracts for this turn's two engines: byte-accurate container
 * identification for HEIC/AVIF (FF-06) and the chord-capture model (IN-04).
 *
 * Both rows exist because the web lies by omission in the same way: a file
 * extension is treated as a format, and a key press is treated as a global
 * shortcut. Each test therefore checks the boundary — what the bytes really are,
 * and who really receives the key.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { sniffContainer, decodeForeign, describeContainerSupport, probeContainerSupport, MIME_OF } from "../src/lib/image/foreign-container";
import { capturePlan, chordFromEvent, classifyChord, codeLabel, describeChordCapture, RESERVED_CHORDS } from "../src/lib/keyboard/system-keys";

const { test, finish } = makeHarness("tt148-core");

/* ─────────────────────────────────────────────────────────────── FF-06 */

const bytes = (...parts: (number[] | string)[]): Uint8Array => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};
/** A minimal ISO-BMFF header: 16-byte size, `ftyp`, major brand, then compatible brands. */
const ftyp = (major: string, compatible: string[] = []) =>
  bytes([0, 0, 0, 16 + compatible.length * 4], "ftyp", major, [0, 0, 0, 0], ...compatible);

await test("FF-06 the container is identified by its brand, not its extension", { "FF-06": "full" }, () => {
  // The two formats share a container, so the brand is the only discriminator.
  assert.equal(sniffContainer(ftyp("avif")), "avif");
  assert.equal(sniffContainer(ftyp("avis")), "avif");
  assert.equal(sniffContainer(ftyp("heic")), "heic");
  assert.equal(sniffContainer(ftyp("heix")), "heic");
  assert.equal(sniffContainer(ftyp("mif1", ["avif"])), "avif", "a mif1 major brand with an avif compatible brand is an AVIF");
  assert.equal(sniffContainer(ftyp("mif1", ["heic"])), "heic");
  assert.equal(sniffContainer(ftyp("mif1")), "heic", "plain mif1 is HEIF, which is the HEVC family here");
  assert.equal(sniffContainer(ftyp("mp42")), "unknown", "an MP4 is not an image");
  // The classic signatures, each a real one-byte-prefix decision.
  assert.equal(sniffContainer(bytes([0x89], "PNG", [13, 10, 26, 10, 0, 0, 0, 13], "IHDR")), "png");
  assert.equal(sniffContainer(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF", [0, 1])), "jpeg");
  assert.equal(sniffContainer(bytes("RIFF", [0, 0, 0, 0], "WEBP")), "webp");
  assert.equal(sniffContainer(bytes("GIF89a", [1, 0, 1, 0, 0, 0])), "gif");
  assert.equal(sniffContainer(bytes("BM", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "bmp");
  assert.equal(sniffContainer(bytes("<svg xmlns=\"http://www.w3.org/2000/svg\"")), "svg");
  // Refusals: truncated, garbage, and a box whose declared size is a lie.
  assert.equal(sniffContainer(new Uint8Array(0)), "unknown");
  assert.equal(sniffContainer(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), "unknown");
  assert.equal(sniffContainer(bytes([0xff, 0xff, 0xff, 0xff], "ftyp", "avif")), "unknown", "a size beyond the buffer is a malformed box");
  assert.equal(sniffContainer(bytes([0, 0, 0, 4], "ftyp", "avif")), "unknown", "a box smaller than its own header is malformed");
  // MIME is a function of the sniffed kind, and there is no MIME for unknown.
  assert.equal(MIME_OF.avif, "image/avif");
  assert.equal(MIME_OF.heic, "image/heic");
  assert.equal("unknown" in MIME_OF, false);
});

await test("FF-06 decode policy: an engine that refuses HEIC says so; a corrupt AVIF is not called unsupported", {}, async () => {
  const realAvif = ftyp("avif");
  // A decoder that accepts only AVIF, i.e. this Chromium's behaviour.
  const decode = async (blob: Blob) => {
    if (blob.type === "image/avif") return { width: 24, height: 16 };
    throw new Error("EncodingError");
  };
  const ok = await decodeForeign(realAvif, decode);
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.kind, ok.width, ok.height], ["avif", 24, 16]);
  assert.match(ok.reason, /decoded avif at 24×16/);

  const heic = await decodeForeign(ftyp("heic"), decode);
  assert.equal(heic.ok, false);
  assert.equal(heic.unsupportedFormat, true, "HEIC is a format this engine lacks, not a broken file");
  assert.match(heic.reason, /no HEIC decoder/);
  assert.match(heic.reason, /file is intact/);

  // An AVIF the engine chokes on is a corrupt file, not an unsupported format.
  const brokenAvif = await decodeForeign(realAvif, async () => { throw new Error("bad bitstream"); });
  assert.equal(brokenAvif.ok, false);
  assert.equal(brokenAvif.unsupportedFormat, false);
  assert.match(brokenAvif.reason, /could not be decoded: bad bitstream/);

  // Bytes that are no container at all are refused before any decoder runs.
  let calls = 0;
  const unknown = await decodeForeign(bytes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), async () => { calls++; return { width: 1, height: 1 }; });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.kind, "unknown");
  assert.equal(calls, 0, "an unidentified file must not be handed to the decoder");

  // Support description: the four combinations are distinguishable in words.
  assert.match(describeContainerSupport({ avif: true, heic: false }), /AVIF decodes here; HEIC does not/);
  assert.match(describeContainerSupport({ avif: false, heic: false }), /neither AVIF nor HEIC/);
  assert.match(describeContainerSupport({ avif: true, heic: true }), /both decode/);

  // Probing needs a sample: a missing sample is "not supported", never an error.
  const probed = await probeContainerSupport({ avif: realAvif }, decode);
  assert.deepEqual(probed, { avif: true, heic: false });
});

await test("FF-06 the committed AVIF fixture is real: the oracle's file sniffs as AVIF and carries its dimensions", {}, () => {
  // Written by Pillow (libavif) in the test setup and kept out of the app; this
  // asserts the fixture is what the other tests claim it is.
  let parsed: { bytes: string; width: number; height: number } | null = null;
  try { parsed = JSON.parse(readFileSync("/tmp/tt148-avif.json", "utf8")); } catch { parsed = null; }
  if (!parsed) {
    // The fixture is produced by scripts/oracle/avif_fixture.py; when it is
    // absent the case is skipped loudly rather than silently passing.
    console.log("    (no /tmp/tt148-avif.json: run scripts/oracle/avif_fixture.py — this case asserted nothing about a real file)");
    return;
  }
  const raw = new Uint8Array(Buffer.from(parsed.bytes, "base64"));
  assert.equal(sniffContainer(raw), "avif");
  // The ISOBMFF `ispe` box carries the display size; the fixture records what
  // Pillow says the image is, and the box must agree.
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let found: { w: number; h: number } | null = null;
  for (let i = 0; i + 12 < raw.length; i++) {
    if (String.fromCharCode(...raw.subarray(i, i + 4)) === "ispe") {
      found = { w: view.getUint32(i + 8), h: view.getUint32(i + 12) };
      break;
    }
  }
  assert.ok(found, "an AVIF must carry an ispe property");
  assert.deepEqual([found!.w, found!.h], [parsed.width, parsed.height]);
});

await test("FF-06 a real HEIC (libheif/HEVC) is refused as a missing decoder, not as a broken file", { "FF-06": "full" }, async () => {
  // The counterpart to the AVIF fixture: genuine HEVC-in-HEIF bytes from
  // pillow-heif, with the same `.heic` name a mislabelled AVIF often carries.
  // The two fixtures are the whole point — one decodes, the other cannot, and
  // the app has to say which is which without being told the extension.
  let parsed: { bytes: string; brand: string; encoder: string } | null = null;
  try { parsed = JSON.parse(readFileSync("/tmp/tt148-heic.json", "utf8")); } catch { parsed = null; }
  if (!parsed) {
    console.log("    (no /tmp/tt148-heic.json: run scripts/oracle/heic_fixture.py — this case asserted nothing about a real file)");
    return;
  }
  const raw = new Uint8Array(Buffer.from(parsed.bytes, "base64"));
  assert.equal(parsed.brand, "heic", `expected the encoder to write the heic brand, got ${parsed.brand}`);
  assert.equal(sniffContainer(raw), "heic");
  // A decoder that handles AVIF and refuses HEVC — this browser, stated as a rule.
  const avifOnly = async (blob: Blob) => {
    if (blob.type === "image/avif") return { width: 1, height: 1 };
    throw new Error("EncodingError");
  };
  const verdict = await decodeForeign(raw, avifOnly);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.kind, "heic");
  assert.equal(verdict.unsupportedFormat, true, "a real HEIC must be reported as a missing decoder");
  assert.match(verdict.reason, /no HEIC decoder/);
  // And the same policy, applied to the AVIF fixture, succeeds — so the refusal
  // above is a property of the file, not of the decode path.
  const avif = new Uint8Array(Buffer.from(JSON.parse(readFileSync("/tmp/tt148-avif.json", "utf8")).bytes, "base64"));
  assert.equal((await decodeForeign(avif, avifOnly)).ok, true);
});

/* ─────────────────────────────────────────────────────────────── IN-04 */

await test("IN-04 chords are physical keys in a fixed order, so a layout switch cannot move a shortcut", { "IN-04": "full" }, () => {
  // The same physical key on three layouts: `key` differs, `code` does not.
  for (const key of ["k", "œ", "л"]) {
    const c = chordFromEvent({ code: "KeyK", key, ctrlKey: true, shiftKey: true });
    assert.equal(c.chord, "Ctrl+Shift+K", `layout produced ${c.chord} for key ${key}`);
  }
  // Modifier order is canonical regardless of the order the events arrive in.
  assert.equal(chordFromEvent({ code: "Space", metaKey: true, altKey: true, shiftKey: true }).chord, "Meta+Alt+Shift+Space");
  assert.equal(chordFromEvent({ code: "Digit1", ctrlKey: true }).chord, "Ctrl+1");
  assert.equal(chordFromEvent({ code: "F5" }).chord, "F5");
  assert.equal(chordFromEvent({ code: "NumpadAdd" }).chord, "Num+");
  assert.equal(chordFromEvent({ code: "BracketLeft", ctrlKey: true }).chord, "Ctrl+[");
  // A bare modifier press is not a chord: capturing "Ctrl" alone would bind
  // every Ctrl combination.
  for (const code of ["ControlLeft", "ShiftRight", "AltLeft", "MetaLeft"]) {
    assert.equal(chordFromEvent({ code }).modifierOnly, true, `${code} must be modifier-only`);
  }
  assert.equal(chordFromEvent({ code: "ShiftLeft", shiftKey: true }).chord, "Shift");
  // Labels are for people; unknown codes pass through rather than being dropped.
  assert.equal(codeLabel("KeyZ"), "Z");
  assert.equal(codeLabel("Digit7"), "7");
  assert.equal(codeLabel("Numpad3"), "Num3");
  assert.equal(codeLabel("IntlBackslash"), "IntlBackslash");
});

await test("IN-04 the reserved list is named with a reason, and an app binding is a separate clash", {}, () => {
  const ctrlW = classifyChord("Ctrl+W");
  assert.equal(ctrlW.usable, false);
  assert.equal(ctrlW.reserved, "closes the tab");
  assert.match(ctrlW.reason, /the browser consumes Ctrl\+W/);
  // Case-insensitive: an engine may report either spelling.
  assert.equal(classifyChord("ctrl+w").usable, false);

  // This app's own bindings are a different kind of collision, and both are
  // reported separately so a person can tell which one to change.
  const own = classifyChord("Ctrl+Space", ["Ctrl+Space", "Meta+ArrowLeft"]);
  assert.equal(own.usable, false);
  assert.equal(own.conflict, "Ctrl+Space");
  assert.equal(own.reserved, null);
  assert.match(own.reason, /already this app's own binding/);

  const free = classifyChord("Ctrl+Alt+K", ["Ctrl+Space"]);
  assert.equal(free.usable, true);
  assert.match(free.reason, /reaches the page while it has focus/);
  assert.equal(classifyChord("").usable, false);
  assert.match(classifyChord("").reason, /waiting for a key/);

  // Every reserved entry is a real chord with a real reason and no duplicates.
  const seen = new Set<string>();
  for (const r of RESERVED_CHORDS) {
    assert.ok(r.chord.includes("+") || r.chord === "Escape");
    assert.ok(r.why.length > 3);
    assert.equal(seen.has(r.chord), false, `${r.chord} listed twice`);
    seen.add(r.chord);
  }
  assert.ok(RESERVED_CHORDS.length >= 20, "the list is meant to be more than a token few");
});

await test("IN-04 capture plans: no focus means no capture; Keyboard Lock is the only path to reserved keys", {}, () => {
  const noFocus = capturePlan({ keyboardLockAvailable: true, fullscreen: false, hasPageFocus: false });
  assert.equal(noFocus.canCapture, false);
  assert.match(noFocus.reason, /no focus/);

  const plain = capturePlan({ keyboardLockAvailable: false, fullscreen: false, hasPageFocus: true });
  assert.equal(plain.canCapture, true);
  assert.deepEqual(plain.lockedKeys, []);
  assert.match(plain.reason, /no Keyboard Lock/);

  const fullscreenOnly = capturePlan({ keyboardLockAvailable: true, fullscreen: false, hasPageFocus: true });
  assert.deepEqual(fullscreenOnly.lockedKeys, []);
  assert.match(fullscreenOnly.reason, /not in fullscreen/);

  const locked = capturePlan({ keyboardLockAvailable: true, fullscreen: true, hasPageFocus: true });
  assert.ok(locked.lockedKeys.includes("Escape"));
  assert.match(locked.reason, /stops consuming the locked keys/);

  // The description never claims OS-wide reach, in any branch.
  for (const plan of [plain, locked]) {
    const text = describeChordCapture("Ctrl+Alt+K", plan);
    assert.ok(!/global|system-wide|anywhere|always/i.test(text), `a capture description must not claim global reach: ${text}`);
  }
  assert.equal(describeChordCapture("", plain), plain.reason);
});

finish();
