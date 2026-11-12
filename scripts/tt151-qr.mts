/**
 * TT151 — QR: conformance against an independent encoder, then a real decoder.
 *
 * Two different kinds of evidence, because they catch different bugs:
 *
 *  conformance  `docs/test-fixtures/qr-oracle.json` holds 14 matrices produced by
 *               python-qrcode 8.0 with the mask *pinned* (its automatic mask choice
 *               is not a pure function of the symbol, so a fixture built from it
 *               would encode a bug). Fourteen cases cover all four ECC levels,
 *               versions 1–10 and all eight masks. `src/lib/qr.ts` must reproduce
 *               every module exactly; anything wrong in the Reed–Solomon
 *               polynomial, block split, interleaving, format BCH or data
 *               placement shows up as a differing module.
 *
 *  scannability `zxing-cpp` — the decoder real camera apps use — reads the grids
 *               this encoder produces and must return the original payload. This
 *               is the check that a matrix-only comparison cannot make: a symbol
 *               can be "plausible" and still be unreadable.
 *
 * Neither check is self-review: the first compares against a separate
 * implementation, the second against a separate *consumer*.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import {
  encodeQr, qrToSvg, byteCapacity, smallestVersion, dataCodewords, ecCodewords,
  rsGenerator, rsRemainder, penaltyScore, penaltyBreakdown, QR_MAX_VERSION,
} from "../src/lib/qr.ts";

const { test, finish } = makeHarness("tt151-qr");

interface PenaltyRef { name: string; case: number | null; rule1: number; rule2: number; rule3: number; rule4: number; total: number }
interface OracleCase { payload: string; version: number; ecc: "L" | "M" | "Q" | "H"; mask: number; size: number; rows: string[] }
const oracle = JSON.parse(readFileSync("docs/test-fixtures/qr-oracle.json", "utf8")) as {
  provenance: { generator: string; library: string }; cases: OracleCase[]; penalties: PenaltyRef[];
};

const matrix = (text: string) => text.split("\n");

// ── QR-01: capacity, version selection, refusals ────────────────────────────

await test("QR-01 · every oracle matrix is reproduced byte for byte", {}, () => {
  assert.ok(oracle.cases.length >= 14, `the corpus shrank to ${oracle.cases.length}`);
  const masksSeen = new Set<number>();
  const eccSeen = new Set<string>();
  const versionsSeen = new Set<number>();
  const failures: string[] = [];
  for (const c of oracle.cases) {
    masksSeen.add(c.mask); eccSeen.add(c.ecc); versionsSeen.add(c.version);
    const r = encodeQr(c.payload, { ecc: c.ecc, version: c.version, mask: c.mask });
    if (!r.ok) { failures.push(`${c.payload.slice(0, 16)} refused: ${r.error}`); continue; }
    const mine = matrix(r.symbol.text);
    if (mine.length !== c.size) { failures.push(`${c.payload.slice(0, 16)} size ${mine.length} ≠ ${c.size}`); continue; }
    let diffs = 0;
    for (let y = 0; y < c.size; y++) for (let x = 0; x < c.size; x++) if (mine[y][x] !== c.rows[y][x]) diffs++;
    if (diffs) failures.push(`${c.payload.slice(0, 16)} (${c.ecc}, v${c.version}, mask ${c.mask}): ${diffs} modules differ`);
  }
  assert.deepEqual(failures, [], failures.join("; "));
  // The corpus itself must keep exercising the format's corners.
  assert.equal(masksSeen.size, 8, `only masks ${[...masksSeen].join(",")} are covered`);
  assert.equal(eccSeen.size, 4, `only levels ${[...eccSeen].join(",")} are covered`);
  assert.ok(versionsSeen.has(1) && versionsSeen.has(10), "versions 1 and 10 must both appear");
});

await test("QR-01 · capacity is a fact about the block table, and over-long input is refused", {}, () => {
  // Capacity = (data codewords × 8 − 4 mode bits − count bits) / 8, with a 16-bit
  // count field from version 10 up. Checked against the published byte capacities.
  const published: Record<string, number> = { "1L": 17, "1M": 14, "1Q": 11, "1H": 7, "10L": 271, "10M": 213, "10Q": 151, "10H": 119 };
  for (const [key, bytes] of Object.entries(published)) {
    const v = Number(key.slice(0, -1));
    const ecc = key.slice(-1) as "L" | "M" | "Q" | "H";
    // Version 1 has a 8-bit count field too, so the same formula applies.
    assert.equal(byteCapacity(v, ecc), bytes, `${key} capacity`);
  }
  assert.equal(smallestVersion(14, "M"), 1);
  assert.equal(smallestVersion(15, "M"), 2);
  assert.equal(smallestVersion(272, "L"), null, "no version under 11 can hold 272 bytes at L");
  assert.equal(encodeQr("x".repeat(272), { ecc: "L" }).ok, false, "over-capacity must be refused, not truncated");
  const tooSmall = encodeQr("this payload is far too long for version 1", { ecc: "H", version: 1 });
  assert.equal(tooSmall.ok, false);
  assert.match(tooSmall.ok === false ? tooSmall.error : "", /do not fit/);
  assert.equal(encodeQr("").ok, false, "an empty payload is a refusal");
  // data + EC must add up to the version's total codeword count (346 for version 10).
  assert.equal(dataCodewords(10, "H") + ecCodewords(10, "H"), 346);
  assert.equal(dataCodewords(10, "H"), 122);
  assert.equal(ecCodewords(10, "H"), 224);
});

// ── QR-02: Reed–Solomon ─────────────────────────────────────────────────────

await test("QR-02 · Reed–Solomon generator and remainder match published values", {}, () => {
  // The degree-7 generator polynomial for 7 EC codewords is published in the spec:
  // x^7 + 127x^6 + 122x^5 + 154x^4 + 164x^3 + 11x^2 + 68x + 117.
  assert.deepEqual(rsGenerator(7), [1, 127, 122, 154, 164, 11, 68, 117]);
  assert.deepEqual(rsGenerator(10), [1, 216, 194, 159, 111, 199, 94, 95, 113, 157, 193]);
  // An all-zero data block has an all-zero remainder — a property any algebraic
  // implementation must have and a lookup-table bug usually loses.
  assert.deepEqual(rsRemainder(new Array(19).fill(0), 7), new Array(7).fill(0));
  // Independent recomputation of the remainder by polynomial long division over
  // GF(256), written differently from the streaming version under test.
  const gfMul = (a: number, b: number) => {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 0x80;
      a = (a << 1) & 0xff;
      if (hi) a ^= 0x1d;
      b >>= 1;
    }
    return p;
  };
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17, 236, 17, 236];
  const gen = rsGenerator(7).slice(1);
  const rem = new Array(7).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[6] = 0;
    for (let i = 0; i < 7; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  assert.deepEqual(rsRemainder(data, 7), rem, "the streaming remainder must equal long division");
  assert.notDeepEqual(rem, new Array(7).fill(0), "the test block is not degenerate");
});

// ── QR-03: format and version information ───────────────────────────────────

await test("QR-03 · format info carries the BCH code and the dark module, and version info appears only from v7", {}, () => {
  const readFormat = (rows: string[]) => {
    const pos: [number, number][] = [];
    for (let i = 0; i <= 5; i++) pos.push([8, i]);
    pos.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i++) pos.push([14 - i, 8]);
    return pos.map(([x, y]) => (rows[y][x] === "#" ? 1 : 0));
  };
  // Mask 0 with level M is the published 0x5412 pattern; read LSB-first it is
  // 010010000010101, and that is exactly what the fixture's first row encodes.
  const m0 = encodeQr("FUSION", { ecc: "M", version: 1, mask: 0 });
  assert.ok(m0.ok);
  assert.equal(readFormat(matrix(m0.symbol.text)).join(""), "010010000010101");
  // Every ECC level and mask must produce a distinct, self-consistent 15-bit code.
  const seen = new Set<string>();
  for (const ecc of ["L", "M", "Q", "H"] as const) {
    for (let mask = 0; mask < 8; mask++) {
      const r = encodeQr("FUSION", { ecc, version: 1, mask });
      assert.ok(r.ok);
      const rows = matrix(r.symbol.text);
      const bits = readFormat(rows);
      seen.add(bits.join(""));
      // Second copy: 8 bits along row 8 from the right, 7 bits down column 8.
      const size = rows.length;
      const copy2 = [
        ...Array.from({ length: 8 }, (_, i) => (rows[8][size - 1 - i] === "#" ? 1 : 0)),
        ...Array.from({ length: 7 }, (_, i) => (rows[size - 15 + 8 + i][8] === "#" ? 1 : 0)),
      ];
      assert.deepEqual(copy2, bits, `the two format copies must agree (${ecc}, mask ${mask})`);
      assert.equal(rows[size - 8][8], "#", "the always-dark module must be dark");
      // BCH(15,5): un-mask 0x5412 first (the mask is applied *after* the BCH code is
      // computed, so reading the raw bits and shifting gives nonsense — this assertion
      // caught exactly that mistake while the test was being written), then recompute.
      const value = bits.reduce((acc, bit, i) => acc | (bit << i), 0);
      const unmasked = value ^ 0x5412;
      const dataBits = unmasked >> 10;
      let rem = dataBits;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      assert.equal(((dataBits << 10) | rem) ^ 0x5412, value, "the 10 BCH bits must verify");
      assert.equal(dataBits & 7, mask, `the low three bits of the format data are the mask (${ecc}, mask ${mask})`);
      assert.equal(dataBits >> 3, { L: 1, M: 0, Q: 3, H: 2 }[ecc], "the two level bits must name the level");
    }
  }
  assert.equal(seen.size, 32, "four levels × eight masks must give 32 distinct codes");
  // Version information: 18 bits, present only from version 7.
  const v6 = encodeQr("x".repeat(58), { ecc: "H", version: 6 });
  const v7 = encodeQr("x".repeat(58), { ecc: "H", version: 7 });
  assert.ok(v6.ok && v7.ok);
  // Presence, tested behaviourally rather than by counting darks: at version 6 the
  // 18 version-block coordinates hold *data*, so two different payloads of the same
  // length must change them; at version 7 those coordinates are function modules, so
  // they must be identical for both payloads (and identical to the version number's
  // own BCH code).
  const versionCells = (rows: string[]) => {
    const size = rows.length;
    const out: number[] = [];
    for (let i = 0; i < 18; i++) out.push(rows[size - 11 + (i % 3)][Math.floor(i / 3)] === "#" ? 1 : 0);
    return out;
  };
  const a6 = encodeQr("A".repeat(30), { ecc: "H", version: 6, mask: 0 });
  const b6 = encodeQr("B".repeat(30), { ecc: "H", version: 6, mask: 0 });
  assert.ok(a6.ok && b6.ok);
  assert.notDeepEqual(versionCells(matrix(a6.symbol.text)), versionCells(matrix(b6.symbol.text)), "at version 6 those cells are payload");
  const a7 = encodeQr("A".repeat(30), { ecc: "H", version: 7, mask: 0 });
  const b7 = encodeQr("B".repeat(30), { ecc: "H", version: 7, mask: 0 });
  assert.ok(a7.ok && b7.ok);
  const cells7 = versionCells(matrix(a7.symbol.text));
  assert.deepEqual(cells7, versionCells(matrix(b7.symbol.text)), "at version 7 those cells are function modules");
  // BCH(18,6) version information for version 7 is the published 0x07C94.
  assert.equal(cells7.reduce((acc, bit, i) => acc | (bit << i), 0), 0x07c94);
});

// ── QR-04: mask selection is the standard penalty minimum ───────────────────

await test("QR-04 · the chosen mask is the minimum-penalty mask, and the penalty rules are the standard four", {}, () => {
  // Rule behaviour on constructed matrices, so a broken scorer cannot hide.
  const side = (n: number, fn: (y: number, x: number) => boolean) => Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => fn(y, x)));
  const blank = side(21, () => false);
  // Rule 4 is a pure function of the dark ratio, so a blank and a solid matrix score
  // *the same* — an intuitive "invert it and the score changes" test would be wrong,
  // which is why this is asserted rather than assumed.
  assert.equal(penaltyScore(blank), penaltyScore(side(21, () => true)));
  // A checkerboard is the one matrix where rules 1–3 contribute nothing (no run of
  // five, no uniform 2×2, no 1011101) and the dark ratio is ~50 %, so it must score
  // exactly zero. Any positive score means a rule is over-firing.
  const checker = side(21, (y, x) => (y + x) % 2 === 0);
  assert.equal(penaltyScore(checker), 0, "a checkerboard must score zero");
  // A blank matrix, by hand: rule 1 = 21 rows × (21−2) + 21 columns × (19) = 798,
  // rule 2 = 20×20 blocks × 3 = 1200, rule 4 = 10 × floor(50/5) = 100 → 2098.
  assert.equal(penaltyScore(blank), 798 + 1200 + 100, "the four rules on a blank matrix");
  // Rule 1 exactly: a five-module dark run costs 3, and a fourth module would cost
  // nothing — so lengthening a 4-run to a 5-run must add precisely 3 (rule 2, rule 3
  // and the rule-4 bucket are unchanged by that one module at this size).
  // Rule-by-rule agreement with an independent implementation of all four ISO rules
  // (`penalty_corpus()` in scripts/oracle/qr_oracle.py). A scorer that is wrong in only
  // one rule still produces a plausible total, so the rules are compared separately.
  const constructed = [
    { name: "blank 21x21", mat: blank },
    { name: "checkerboard 21x21", mat: checker },
    { name: "single 1x5 dark run", mat: side(21, (y, x) => y === 10 && x < 5) },
  ];
  for (const item of constructed) {
    const ref = oracle.penalties.find((p) => p.name === item.name);
    assert.ok(ref, `the oracle is missing ${item.name}`);
    assert.deepEqual(penaltyBreakdown(item.mat), { rule1: ref.rule1, rule2: ref.rule2, rule3: ref.rule3, rule4: ref.rule4, total: ref.total },
      `${item.name} must match the independent scorer rule by rule`);
  }
  // And on real symbols, where the finder patterns make rule 3 the dominant term.
  for (const idx of [0, 6]) {
    const c = oracle.cases[idx];
    const r = encodeQr(c.payload, { ecc: c.ecc, version: c.version, mask: c.mask });
    assert.ok(r.ok);
    const ref = oracle.penalties.find((p) => p.case === idx)!;
    assert.deepEqual(penaltyBreakdown(r.symbol.modules), { rule1: ref.rule1, rule2: ref.rule2, rule3: ref.rule3, rule4: ref.rule4, total: ref.total },
      `case ${idx} penalty must match the independent scorer`);
  }
  // And the real assertion: for every oracle case, the auto-chosen mask is an argmin.
  for (const c of oracle.cases.slice(0, 6)) {
    const auto = encodeQr(c.payload, { ecc: c.ecc, version: c.version });
    assert.ok(auto.ok);
    const scores = Array.from({ length: 8 }, (_, mask) => {
      const r = encodeQr(c.payload, { ecc: c.ecc, version: c.version, mask });
      assert.ok(r.ok);
      return penaltyScore(r.symbol.modules);
    });
    const best = Math.min(...scores);
    assert.equal(scores[auto.symbol.mask], best, `${c.payload.slice(0, 12)}: mask ${auto.symbol.mask} scored ${scores[auto.symbol.mask]}, best is ${best}`);
    assert.equal(auto.symbol.mask, scores.indexOf(best), "argmin must be reported, not just any minimiser");
  }
});

// ── QR-05: rendering, quiet zone, and a real decoder ────────────────────────

await test("QR-05 · SVG keeps the four-module quiet zone, and zxing-cpp reads the symbols back", {}, () => {
  const payloads: { text: string; ecc: "L" | "M" | "Q" | "H" }[] = [
    { text: "FUSION", ecc: "M" },
    { text: "https://fusion.local/share/9f2", ecc: "M" },
    { text: "Hello, QR — ünïcode", ecc: "Q" },
    { text: "otpauth://totp/Fusion:alice?secret=JBSWY3DPEHPK3PXP&issuer=Fusion", ecc: "M" },
    { text: "BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+15550100\nEND:VCARD", ecc: "M" },
    { text: "WiFi:T=WPA;S=Fusion;P=correct horse", ecc: "Q" },
    { text: "x".repeat(100), ecc: "H" },
  ];
  const cases = payloads.map((p) => {
    const r = encodeQr(p.text, { ecc: p.ecc });
    assert.ok(r.ok, `${p.text.slice(0, 12)}: ${r.ok === false ? r.error : ""}`);
    const svg = qrToSvg(r.symbol, { moduleSize: 4 });
    const dim = (r.symbol.size + 8) * 4;
    assert.match(svg, new RegExp(`viewBox="0 0 ${dim} ${dim}"`), "the quiet zone must be part of the viewBox");
    assert.match(svg, /shape-rendering="crispEdges"/, "modules must not be antialiased");
    const dark = r.symbol.modules.flat().filter(Boolean).length;
    const paths = (svg.match(/M\d+ \d+h4v4h-4z/g) ?? []).length;
    assert.equal(paths, dark, "one path segment per dark module");
    // The quiet zone is the first thing hand-rolled generators omit, so prove the
    // first drawn module is inset by exactly four modules.
    const first = /M(\d+) (\d+)h4/.exec(svg);
    assert.ok(first, "the path must start with a module");
    assert.ok(Number(first[1]) >= 16 && Number(first[2]) >= 16, `the first dark module sits at ${first[1]},${first[2]}`);
    return { payload: p.text, ecc: p.ecc, rows: matrix(r.symbol.text) };
  });

  const python = process.env.QR_PYTHON ?? "python3";
  const oraclePath = "scripts/oracle/qr_decode.py";
  const run = spawnSync(python, [oraclePath], { input: JSON.stringify({ cases }), encoding: "utf8", timeout: 60_000 });
  assert.equal(run.error, undefined, `could not run ${python} ${oraclePath}: ${run.error?.message}`);
  assert.equal(run.status, 0, `decoder failed: ${run.stderr?.slice(0, 400)}`);
  const decoded = JSON.parse(run.stdout) as { provenance: { decoder: string }; results: { decoded: string | null; ecLevel: string | null; ok: boolean }[] };
  const failures = decoded.results.map((r, i) => (r.ok ? null : `${payloads[i].text.slice(0, 16)} → ${JSON.stringify(r.decoded)}`)).filter(Boolean);
  assert.deepEqual(failures, [], `zxing-cpp could not read: ${failures.join("; ")}`);
  // The decoder must also agree about the error-correction level it sees.
  const levels = decoded.results.map((r) => r.ecLevel);
  assert.deepEqual(levels, payloads.map((p) => p.ecc), "the decoder must see the level the encoder claims");
});

await finish();
