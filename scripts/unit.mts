/**
 * Unit / property suite — pure modules, no mocks.
 * Run: node --experimental-strip-types --no-warnings scripts/unit.mts
 */
import { deflateRawSync } from "node:zlib";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { reduce, initialDesktop, stateHash, MIN_W, MIN_H, TITLEBAR_VISIBLE, type WindowCommand, type DesktopState } from "../src/lib/windowing/state.ts";
import { evaluate } from "../src/lib/calc.ts";
import { parseCsv, toCsv, sanitizeSvg, lossReport, formatFor, toVtt } from "../src/lib/forge.ts";
import { parseIcs, toIcs } from "../src/lib/ics.ts";
import { parseScript } from "../src/lib/routines.ts";
import { readCentralDirectory, readEntry, extractOoxml, extractEpub, readPsdHeader, writeZip, readEntryVerified, crc32 } from "../src/lib/server/zip.ts";
import { osaDistance, fuzzyScore } from "../src/lib/fuzzy.ts";
import { seal, open, sealText, openText } from "../src/lib/crypto.ts";
import { diffCapabilities, memoryPolicy } from "../src/lib/policy.ts";
import { BINDINGS, conflicts, matchChord } from "../src/lib/shortcuts.ts";
import { Workbook, Sheet, writeXlsxWorkbook, readXlsxWorkbook, isError as formulaIsError } from "../src/lib/formula/index.ts";
import { writeDocx, readDocx, docText, type DocModel } from "../src/lib/office/docx.ts";
import { writePptx, readPptx, type DeckModel } from "../src/lib/office/pptx.ts";
import { escapeHtmlText, extractReadable } from "../src/lib/server/webproxy.ts";
import { isPrivateAddress, parsePublicWebUrl } from "../src/lib/server/netguard.ts";

const { test, finish } = makeHarness("unit");

let seed = 0x9e3779b9;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1_000_000) / 1_000_000; };
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
function randomCommand(s: DesktopState, n: number): WindowCommand {
  const ids = s.windows.map((w) => w.id);
  const id = ids.length ? pick(ids) : "none";
  switch (Math.floor(rnd() * 14)) {
    case 0: case 1: return { t: "open", id: `w${n}`, module: "files", title: "t", rect: { x: rnd() * 3000 - 1000, y: rnd() * 2000 - 800, w: rnd() * 3000, h: rnd() * 2000 } };
    case 2: return { t: "close", id };
    case 3: return { t: "move", id, x: rnd() * 6000 - 3000, y: rnd() * 6000 - 3000 };
    case 4: return { t: "resize", id, w: rnd() * 5000 - 500, h: rnd() * 5000 - 500 };
    case 5: return { t: "nudge", id, dx: rnd() * 400 - 200, dy: rnd() * 400 - 200 };
    case 6: return { t: "tile", id, slot: pick(["left", "right", "tl", "br", "third-c", "full", "center"] as const) };
    case 7: return { t: "toggleMax", id };
    case 8: return { t: "minimize", id };
    case 9: return { t: "focus", id };
    case 10: return { t: "viewport", w: 320 + rnd() * 3000, h: 240 + rnd() * 1800 };
    case 11: return { t: "cycle", dir: rnd() > 0.5 ? 1 : -1 };
    case 12: return { t: "setDensity", id, density: pick(["compact", "balanced", "touch"] as const) };
    default: return { t: "grow", id, dw: rnd() * 800 - 400, dh: rnd() * 800 - 400 };
  }
}

function fixtureZip(files: { name: string; data: Buffer; store?: boolean; fakeSize?: number }[]): Buffer {
  const locals: Buffer[] = []; const cens: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const comp = f.store ? f.data : deflateRawSync(f.data); const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(f.store ? 0 : 8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.fakeSize ?? f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(f.store ? 0 : 8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.fakeSize ?? f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); cens.push(ch, name); offset += 30 + name.length + comp.length;
  }
  const cen = Buffer.concat(cens); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cen.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, end]);
}

console.log("\nWindow engine");
await test("10 000 random commands preserve every invariant", { "WM-01": "full", "WM-02": "partial", "WM-09": "partial", "WM-12": "partial" }, () => {
  seed = 0x9e3779b9;
  let s = initialDesktop();
  for (let i = 0; i < 10_000; i++) {
    s = reduce(s, randomCommand(s, i));
    const zs = new Set<number>();
    for (const w of s.windows) {
      const d = w.density ?? "balanced";
      assert.ok(w.w >= MIN_W[d] && w.h >= MIN_H[d], `min size at ${i}`);
      assert.ok(w.y >= 0 && w.y <= s.viewport.h - TITLEBAR_VISIBLE, `title bar off-screen at ${i}`);
      assert.ok(w.x <= s.viewport.w - TITLEBAR_VISIBLE, `title bar off right edge at ${i}`);
      assert.ok(!zs.has(w.z), `duplicate z at ${i}`); zs.add(w.z);
    }
    assert.ok(s.focus === null || s.windows.some((w) => w.id === s.focus), `dangling focus at ${i}`);
  }
});
await test("command log replay reproduces the identical state hash", { "TD-06": "full", "SH-08": "partial" }, () => {
  seed = 12345;
  const log: WindowCommand[] = []; let a = initialDesktop();
  for (let i = 0; i < 3000; i++) { const c = randomCommand(a, i); log.push(c); a = reduce(a, c); }
  assert.equal(stateHash(a), stateHash(log.reduce(reduce, initialDesktop())));
});
await test("reducer is pure (input not mutated); workspaces filter without unmounting", { "WM-03": "partial" }, () => {
  const s0 = reduce(initialDesktop(), { t: "open", id: "x", module: "files", title: "x" });
  const snap = JSON.stringify(s0);
  const s1 = reduce(reduce(s0, { t: "toWorkspace", id: "x", workspace: 2 }), { t: "switchWorkspace", workspace: 2 });
  assert.equal(JSON.stringify(s0), snap);
  assert.equal(s1.windows.length, 1); assert.equal(s1.windows[0].workspace, 2);
});

console.log("\nEvaluator");
await test("precedence, power associativity, rounding policy", { "PR-09": "full", "SR-06": "partial" }, () => {
  assert.equal(evaluate("2+2*3").text, "8");
  assert.equal(evaluate("2^3^2").text, "512");
  assert.equal(evaluate("0.1+0.2").text, "0.3");
  assert.equal(evaluate("12 in to cm").text, "30.48 cm");
  assert.equal(evaluate("0xff").text, "255");
});
await test("division by zero and code injection rejected", { "PR-09": "full" }, () => {
  assert.equal(evaluate("1/0").ok, false);
  assert.equal(evaluate("constructor.constructor('x')()").ok, false);
  assert.equal(evaluate("1 kg to m").ok, false);
});

console.log("\nForge");
await test("CSV RFC-4180 round trip", { "FF-09": "full" }, () => {
  const rows = [["a", "b,c", 'd "q"'], ["multi\nline", "", "x"]];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
await test("SVG sanitiser strips script/handlers/foreignObject/javascript:", { "FF-04": "full", "DP-09": "partial" }, () => {
  const r = sanitizeSvg(`<svg onload="x()"><script>alert(1)</script><foreignObject><b/></foreignObject><a href="javascript:evil()">l</a><rect/></svg>`);
  assert.ok(!/script|onload|foreignObject|javascript:/i.test(r.svg)); assert.ok(r.svg.includes("<rect/>"));
});
await test("loss report itemises drops; registry grades", { "FF-11": "full", "FF-01": "partial", "FF-14": "full" }, () => {
  assert.ok(lossReport("a.docx", "md").drops.includes("styles"));
  assert.equal(formatFor("x.epub")?.grade, "C");
  assert.equal(formatFor("x.heic")?.grade, "X");
});
await test("SRT → WebVTT conversion", { "AX-07": "partial" }, () => {
  const v = toVtt("1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n");
  assert.ok(v.startsWith("WEBVTT\n\n") && v.includes("00:00:01.500 --> 00:00:03.000\nHello"));
});

console.log("\nICS / routines / shortcuts");
await test("ICS unfolding, escapes, parameters, VTODO status, round trip", { "PR-04": "full" }, () => {
  const items = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSUMMARY:A\\, b fol\r\n ded\r\nDTSTART:20300105T090000Z\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nUID:u2\r\nSUMMARY:T\r\nDUE;VALUE=DATE:20300106\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR\r\n");
  assert.equal(items[0].title, "A, b folded"); assert.equal(items[1].done, true);
  const start = new Date("2030-02-03T04:05:06Z");
  const out = toIcs([{ uid: "r1", title: "A; b, c\\d", notes: "x\ny", start, end: null, kind: "event", done: false }]);
  assert.ok(out.split("\r\n").every((l) => l.length <= 75));
  const back = parseIcs(out)[0];
  assert.equal(back.title, "A; b, c\\d"); assert.equal(back.start?.getTime(), start.getTime());
});
await test("routine whitelist", { "AU-01": "partial" }, () => {
  assert.equal(parseScript("open files; tile left\ntheme dark").length, 3);
  assert.throws(() => parseScript("open files; rm -rf /"), /whitelist/);
});
await test("shortcut presets have no internal conflicts; chord matcher", { "IN-05": "full", "ST-06": "partial" }, () => {
  for (const p of ["hybrid", "windows", "mac"] as const) assert.deepEqual(conflicts(p), [], p);
  assert.ok(BINDINGS.length >= 15);
  const ev = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: "Space", key: " " } as KeyboardEvent;
  assert.ok(matchChord(ev, "Ctrl+Space")); assert.ok(!matchChord(ev, "Meta+Space"));
});

console.log("\nArchives and format readers");
await test("zip-slip and bomb guards fire before allocation", { "FF-12": "full", "FM-05": "partial" }, () => {
  assert.throws(() => readCentralDirectory(fixtureZip([{ name: "../../etc/passwd", data: Buffer.from("x") }])), /zip-slip/);
  assert.throws(() => readCentralDirectory(fixtureZip([{ name: "b.bin", data: Buffer.alloc(10), store: true, fakeSize: 5000 }])), /bomb/);
});
await test("CRC-32 known-answer vector and writer → reader round trip", { "FM-05": "full" }, () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926); // ITU-T V.42 check value
  const files = [{ name: "a/x.txt", data: Buffer.from("hello ".repeat(500)) }, { name: "b.bin", data: Buffer.from([0, 1, 2, 255]) }];
  const z = writeZip(files);
  const e = readCentralDirectory(z);
  assert.deepEqual(e.map((x) => x.name), ["a/x.txt", "b.bin"]);
  assert.equal(readEntryVerified(z, e[0]).toString(), "hello ".repeat(500));
  assert.equal(e[1].method, 0, "incompressible entry should be stored, not deflated");
});
await test("corrupted archive is detected by CRC, never silently extracted", { "FM-05": "full" }, () => {
  const z = writeZip([{ name: "s.txt", data: Buffer.from("stored payload!") }]); // incompressible → method 0 (stored)
  const e = readCentralDirectory(z)[0];
  const dataStart = e.offset + 30 + Buffer.byteLength(e.name);
  z[dataStart] ^= 0xff;
  assert.throws(() => readEntryVerified(z, e), /CRC mismatch/);
});
await test("docx extraction; EPUB spine order; PSD header", { "FF-02": "full", "FF-10": "full", "FF-08": "full", "PR-11": "partial" }, () => {
  const doc = `<w:document><w:body><w:p><w:r><w:t>First &amp; one</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body></w:document>`;
  assert.equal(extractOoxml(fixtureZip([{ name: "word/document.xml", data: Buffer.from(doc) }])).text, "First & one\n\nSecond");
  const opf = `<package><metadata><dc:title>Book</dc:title></metadata><manifest><item id="c1" href="one.xhtml"/><item id="c2" href="two.xhtml"/></manifest><spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>`;
  const ep = extractEpub(fixtureZip([
    { name: "OEBPS/one.xhtml", data: Buffer.from("<body><p>ONE</p></body>") },
    { name: "META-INF/container.xml", data: Buffer.from(`<rootfile full-path="OEBPS/c.opf"/>`) },
    { name: "OEBPS/two.xhtml", data: Buffer.from("<body><p>TWO</p></body>") },
    { name: "OEBPS/c.opf", data: Buffer.from(opf) },
  ]));
  assert.deepEqual(ep.chapters.map((c) => c.text), ["TWO", "ONE"]);
  const h = Buffer.alloc(44); h.write("8BPS", 0, "ascii"); h.writeUInt16BE(1, 4); h.writeUInt16BE(3, 12); h.writeUInt32BE(600, 14); h.writeUInt32BE(800, 18); h.writeUInt16BE(8, 22); h.writeUInt16BE(3, 24);
  h.writeUInt32BE(6, 34); h.writeUInt32BE(2, 38); h.writeInt16BE(-4, 42);
  const r = readPsdHeader(h);
  assert.deepEqual([r.width, r.height, r.colorMode, r.layers], [800, 600, "RGB", 4]);
  assert.throws(() => readPsdHeader(Buffer.from("x".repeat(40))), /8BPS/);
  void readEntry;
});

console.log("\nFuzzy search");
await test("OSA distance counts adjacent transposition as 1", { "SR-03": "partial" }, () => {
  assert.equal(osaDistance("noets", "notes"), 1);
  assert.equal(osaDistance("calculater", "calculator"), 1);
  assert.equal(osaDistance("kitten", "sitting"), 3);
  assert.equal(osaDistance("abcdef", "uvwxyz", 1), 2); // early exit returns max+1
});
await test("fuzzy scoring: typos match, short words exact only, junk rejected", { "SR-03": "full" }, () => {
  assert.notEqual(fuzzyScore("noets", "Notes"), null);
  assert.notEqual(fuzzyScore("calculater", "Calculator"), null);
  assert.equal(fuzzyScore("cat", "Car"), null, "3-letter words must match exactly");
  assert.equal(fuzzyScore("zzzzqq", "Notes"), null);
});

console.log("\nCrypto envelope (runs on Node's WebCrypto — same code as the browser)");
await test("seal/open round trip; wrong passphrase and ciphertext tamper fail", { "SC-07": "full", "SC-01": "partial", "BK-01": "partial", "BK-06": "partial" }, async () => {
  const env = await sealText("top secret ✓", "correct horse", 100_000);
  assert.equal(await openText(env, "correct horse"), "top secret ✓");
  await assert.rejects(openText(env, "wrong horse"), /authentication failed/);
  const d = Buffer.from(env.data, "base64"); d[0] ^= 1;
  await assert.rejects(openText({ ...env, data: d.toString("base64") }, "correct horse"), /authentication failed/);
});
await test("header downgrade (iterations) is detected via AAD; policy floor enforced", { "SC-07": "full" }, async () => {
  const env = await seal(new TextEncoder().encode("x"), "pw-123456", 100_000);
  await assert.rejects(open({ ...env, iterations: 100_001 }, "pw-123456"), /authentication failed/);
  await assert.rejects(open({ ...env, iterations: 1 }, "pw-123456"), /policy floor/);
  const a = await sealText("same", "pw-123456", 100_000); const b = await sealText("same", "pw-123456", 100_000);
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.salt, b.salt);
});

console.log("\nPolicies");
await test("BK-04 capability diff reports lost/gained with degrade text", { "BK-04": "full" }, () => {
  const mk = (ids: Record<string, boolean>) => ({ capabilities: Object.entries(ids).map(([id, available]) => ({ id, label: id, group: "g", available, detail: "", degrade: `no ${id}` })) });
  const d = diffCapabilities(mk({ a: true, b: false, c: true }), mk({ a: false, b: true, c: true }));
  assert.deepEqual(d.lost.map((x) => x.id), ["a"]); assert.equal(d.lost[0].degrade, "no a");
  assert.deepEqual(d.gained.map((x) => x.id), ["b"]); assert.equal(d.unchanged, 1);
});
await test("RG-06 memory policy: absence is not low memory", { "RG-06": "full" }, () => {
  assert.equal(memoryPolicy(undefined).tier, "unknown"); assert.equal(memoryPolicy(undefined).maxWindows, 24);
  assert.equal(memoryPolicy(1).maxWindows, 6); assert.equal(memoryPolicy(1).effects, false);
  assert.equal(memoryPolicy(4).maxWindows, 12); assert.equal(memoryPolicy(8).maxWindows, 24);
  assert.equal(memoryPolicy(Number.NaN).tier, "unknown");
});

finish();
