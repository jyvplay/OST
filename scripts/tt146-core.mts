/**
 * TT146 — pure contracts for the network policy, the codec probe, the WASM
 * probe, the mail composer, the automation token door, the previous round's
 * drag payload and this round's resampler/relight.
 *
 * Nothing here touches a server, a browser or a database, so the suite runs in
 * the parallel pure lane. The parts that need a real engine (WebCodecs, a real
 * Worker, Chromium) are asserted in e2e-tt146; the parts that need numerical
 * independence (numpy) are in tt146-oracle.
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { encodeHandoff, decodeHandoff, describeHandoff, linkableProps, MAX_WINDOWS, MAX_LINK_BYTES, MAX_PROP_BYTES, FRAGMENT_KEY } from "../src/lib/handoff/continue-link";
import {
  EFFECTIVE_RANK, ThroughputEstimator, TierStabilizer, describeDecision, planQuality, readNetworkFacts,
  tierForBps, type NetworkFacts, type Surface,
} from "../src/lib/net/quality";
import {
  probeCodecMatrix, summarise, chooseVideoEncoder, webCodecsProbe, describeCodecReport,
  VIDEO_CODECS, SIZES, type Probe, type ProbeConfig,
} from "../src/lib/media/codecs";
import { EXPECTED_FIRST_BYTE, planChunks, probeWasm, runThreadProbe, wasmSimdProbeBytes, type WasmEnv } from "../src/lib/wasm/probe";
import {
  buildMailto, checkDraft, parseMailto, planHandoff, sharePayload, validateAddress, TRUNCATION_MARK,
  MAX_URL_BYTES, MAX_BODY_CHARS, encodeHeaderValue,
} from "../src/lib/mail/handoff";
import {
  MAX_ACTIONS, mintToken, parseToken, parseScopes, takeToken, timingSafeEqualHex, validateRequest, settle, vocabulary,
} from "../src/lib/automation/tokens";
import { applyRelight, brightestAt, kernelValue, meanLuma, resample, tapTable, type RgbaImage } from "../src/lib/lens/resample";
import { dragPayloadFor, dropDecision, keyboardAlternative, OS_DRAG_MIME } from "../src/lib/files/drag-payload";
import { sniffEncoding, decodeText, encodeText, planLargeFile } from "../src/lib/editor/encoding";

const { test, finish } = makeHarness("tt146-core");

/* ------------------------------------------------------------------ HW-09 */

await test("HW-09 network facts are normalised, never invented, and bounded", { "HW-09": "full" }, () => {
  const none = readNetworkFacts(undefined, true);
  assert.equal(none.reported, false);
  assert.equal(none.effectiveType, "unknown");
  assert.equal(none.downlinkMbps, null);
  const odd = readNetworkFacts({ effectiveType: "7g", downlink: -4, rtt: 1e9, saveData: "yes" as unknown as boolean }, false);
  assert.equal(odd.effectiveType, "unknown", "an unknown classification must not be guessed");
  assert.equal(odd.downlinkMbps, 0, "a negative estimate is clamped, not trusted");
  assert.equal(odd.rttMs, 600_000, "an absurd RTT is clamped to the documented ceiling");
  assert.equal(odd.saveData, false, "saveData is true only for a real true");
  assert.equal(odd.online, false);
  const real = readNetworkFacts({ effectiveType: "4g", downlink: 9.5, rtt: 50, saveData: false }, true);
  assert.deepEqual([real.effectiveType, real.downlinkMbps, real.rttMs, real.reported], ["4g", 9.5, 50, true]);
});

await test("HW-09 throughput estimator rejects timer noise and cache hits, then tracks an EWMA", { "HW-09": "full" }, () => {
  const est = new ThroughputEstimator({ minBytes: 16 * 1024, alpha: 0.5, maxPlausibleMbps: 1000 });
  assert.equal(est.add({ bytes: 1024, ms: 3 }, 0).accepted, false, "a 1 KiB sample is timer noise");
  assert.equal(est.bps(), null);
  assert.equal(est.add({ bytes: 64_000, ms: 0 }, 1).accepted, false, "zero time is not a bandwidth");
  assert.equal(est.add({ bytes: 64_000, ms: -5 }, 2).accepted, false);
  // 64 KiB in 256 ms = 2 Mbit/s.
  const first = est.add({ bytes: 64 * 1024, ms: 256 }, 10);
  assert.equal(first.accepted, true, first.reason);
  assert.ok(Math.abs((first.bps ?? 0) - 2_048_000) < 1, `got ${first.bps}`);
  // A 1 GiB "download" in 1 ms is a cache or a loopback, not link capacity.
  assert.equal(est.add({ bytes: 1 << 30, ms: 1 }, 20).accepted, false);
  assert.ok(Math.abs((est.bps() ?? 0) - 2_048_000) < 1, "a rejected sample must not move the estimate");
  // 64 KiB in 64 ms = 8 Mbit/s; with alpha 0.5 the estimate lands halfway.
  est.add({ bytes: 64 * 1024, ms: 64 }, 30);
  assert.ok(Math.abs((est.bps() ?? 0) - (2_048_000 + 8_192_000) / 2) < 2, `got ${est.bps()}`);
  assert.equal(est.confidence(30), "medium", "two accepted samples are medium confidence");
  est.add({ bytes: 600_000, ms: 600 }, 40);
  assert.equal(est.confidence(40), "medium");
  est.add({ bytes: 600_000, ms: 600 }, 50);
  assert.ok(est.bytes >= 1_000_000);
  assert.equal(est.confidence(50), "high", "three samples and a megabyte is high confidence");
  assert.equal(est.bps(50 + 60_001), null, "a stale estimate is not reported as current");
  assert.equal(est.confidence(50 + 60_001), "none");
  est.reset();
  assert.equal(est.samples, 0);
  assert.equal(est.bps(), null);
});

await test("HW-09 the ladder is monotone, and Save-Data/offline always win", { "HW-09": "full" }, () => {
  const facts = (t: NetworkFacts["effectiveType"], extra: Partial<NetworkFacts> = {}): NetworkFacts =>
    ({ online: true, effectiveType: t, downlinkMbps: null, rttMs: null, saveData: false, reported: true, ...extra });
  const surfaces: Surface[] = ["photoThumb", "photoPreview", "video", "prefetch", "sync"];
  const types: NetworkFacts["effectiveType"][] = ["slow-2g", "2g", "3g", "4g", "5g", "unknown"];

  for (const surface of surfaces) {
    let previous = -1;
    for (const t of types.slice().sort((a, b) => EFFECTIVE_RANK[a] - EFFECTIVE_RANK[b])) {
      const d = planQuality(facts(t), null, "none", surface);
      if (EFFECTIVE_RANK[t] > previousRank(previous, types, facts)) { /* ordering checked below */ }
      const tier = d.tier;
      assert.ok(tier >= previous, `tier went backwards for ${t} on ${surface}`);
      previous = Math.max(previous, tier);
    }
    let lastValue = -1;
    for (const bps of [10, 100_000, 400_000, 1_500_000, 9_000_000, 200_000_000]) {
      const d = planQuality(facts("4g"), bps, "high", surface);
      assert.ok(d.value >= lastValue, `measured value fell as bandwidth rose on ${surface}`);
      lastValue = d.value;
    }
    // Save-Data is the user speaking; it overrides a measured gigabit link.
    const saved = planQuality(facts("5g", { saveData: true }), 1e9, "high", surface);
    assert.equal(saved.tier, 0);
    assert.equal(saved.source, "save-data");
    assert.equal(saved.cappedByUser, true);
    // Offline is not a slow link: nothing is requested at all.
    const off = planQuality({ ...facts("4g"), online: false }, 1e9, "high", surface);
    assert.equal(off.tier, 0);
    assert.equal(off.source, "offline");
    assert.equal(off.rung.prefetchBytes, 0);
    // A ceiling set by the user or the governor is respected and named.
    const capped = planQuality(facts("5g"), 1e9, "high", surface, { maxTier: 1 });
    assert.equal(capped.tier, 1);
    assert.match(capped.reason, /capped/);
  }
  // A low-confidence measurement must not outrank the browser's own estimate.
  const low = planQuality(facts("2g"), 900_000_000, "low", "video", { trustMeasurement: "medium" });
  assert.equal(low.source, "browser estimate");
  assert.equal(low.tier, 0);
  // The bands themselves.
  assert.deepEqual([tierForBps(-1), tierForBps(0), tierForBps(149_999), tierForBps(150_000), tierForBps(999_999), tierForBps(1_000_000), tierForBps(4_999_999), tierForBps(5_000_000)], [0, 0, 0, 1, 1, 2, 2, 3]);
  assert.match(describeDecision(planQuality(facts("4g"), null, "none", "video"), "video"), /browser reports 4g/);
});

// The rank helper is local so the assertion above stays readable.
function previousRank(previous: number, types: NetworkFacts["effectiveType"][], facts: (t: NetworkFacts["effectiveType"], e?: Partial<NetworkFacts>) => NetworkFacts): number {
  void types; void facts; return previous;
}

await test("HW-09 hysteresis: down at once, up only after evidence and dwell", { "HW-09": "full" }, () => {
  const s = new TierStabilizer(2, { upAfter: 3, minDwellMs: 5_000 });
  assert.equal(s.update(3, 0).moved, false, "an upgrade needs evidence");
  assert.equal(s.update(3, 10).moved, false);
  assert.equal(s.update(3, 20).moved, true, "three consistent samples upgrade");
  assert.equal(s.current, 3);
  // Immediately demanded downgrade: no dwell.
  assert.equal(s.update(1, 30).moved, true);
  assert.equal(s.current, 1);
  assert.equal(s.update(2, 40).moved, false, "dwell blocks an immediate rebound");
  assert.equal(s.update(2, 6_000).moved, false, "and evidence still has to accumulate");
  assert.equal(s.update(2, 6_010).moved, false);
  assert.equal(s.update(2, 6_020).moved, true);
  assert.equal(s.current, 2);
  // A wobble resets the count rather than accumulating across different targets.
  const t = new TierStabilizer(1, { upAfter: 2, minDwellMs: 0 });
  assert.equal(t.update(2, 0).moved, false);
  assert.equal(t.update(3, 1).moved, false);
  assert.equal(t.update(2, 2).moved, false, "the count restarted at the new target");
  assert.equal(t.update(2, 3).moved, true);
});

/* ------------------------------------------------------------------ HW-03 */

function fakeProbe(supported: (config: ProbeConfig, direction: "decode" | "encode") => boolean): Probe {
  return async (config, direction) => ({ supported: supported(config, direction) });
}

await test("HW-03 verdicts follow the probe's answers and never claim silicon", { "HW-03": "full" }, async () => {
  // H.264 1080p: plain yes, prefer-hardware yes, prefer-software yes → either-way.
  // AV1 4K: plain yes, prefer-hardware no → software-only.
  // HEVC: plain no → unavailable.
  const report = await probeCodecMatrix(fakeProbe((c) => {
    if (c.codedHeight > 1080) return false;
    if (c.codec === "hvc1.1.6.L120.B0") return false;
    // AV1: refused when hardware is asked for → software only.
    if (c.codec.startsWith("av01")) return !(c.hardwareAcceleration === "prefer-hardware");
    // H.264: refused when software is forced → the hardware preference is honoured.
    if (c.codec.startsWith("avc1")) return !(c.hardwareAcceleration === "prefer-software");
    return true;
  }), 1);
  const cell = (codec: string, direction: string, size: string) =>
    report.cells.find((c) => c.codec === codec && c.direction === direction && c.size === size)!;
  assert.equal(cell("h264", "encode", "1080p").verdict, "hardware-preferred");
  assert.equal(cell("av1", "encode", "1080p").verdict, "software-only");
  assert.equal(cell("av1", "encode", "4K").verdict, "unavailable");
  assert.equal(cell("hevc", "decode", "720p").verdict, "unavailable");
  assert.equal(report.cells.length, VIDEO_CODECS.length * 2 * SIZES.length);

  const rows = summarise(report);
  assert.equal(rows.find((r) => r.codec === "hevc")!.decode, "unavailable");
  assert.equal(rows.find((r) => r.codec === "h264")!.maxHeight, 1080, "the largest supported decode size is reported");
  assert.equal(rows.find((r) => r.codec === "av1")!.maxHeight, 1080);
  const choice = chooseVideoEncoder(report, { width: 1920, height: 1080 }, { prefer: ["av1", "h264"] });
  assert.equal(choice?.codec, "h264", "AV1 is software-only here, so the hardware-preferred H.264 wins even though AV1 was listed first");
  assert.equal(choice?.hardwarePreferred, true);
  const hwOnly = chooseVideoEncoder(report, { width: 1920, height: 1080 }, { prefer: ["av1", "h264"], allowSoftware: false });
  assert.equal(hwOnly?.codec, "h264", "with software refused, only the hardware-preferred configuration may be returned");
  assert.equal(chooseVideoEncoder(report, { width: 3840, height: 2160 }, { prefer: ["av1", "h264"], allowSoftware: false }), null, "nothing at 4K is hardware-preferred here, so the honest answer is no");
  // A hardware-accepted configuration is reported as a preference, not a proof.
  const hwReport = await probeCodecMatrix(fakeProbe((c) => c.hardwareAcceleration !== "prefer-software"), 2);
  const picked = chooseVideoEncoder(hwReport, { width: 1280, height: 720 }, { prefer: ["av1"] });
  assert.equal(picked?.codec, "av1");
  assert.equal(picked?.hardwarePreferred, true);
  assert.match(picked!.reason, /hardware preference accepted/);

  // A probe that throws is a rejection, never an exception.
  const throwing = webCodecsProbe({
    VideoDecoder: { isConfigSupported: async () => { throw new TypeError("unsupported"); } },
    VideoEncoder: { isConfigSupported: async () => ({ supported: true }) },
  });
  assert.equal(throwing.reason, undefined);
  const answer = await throwing.probe({ codec: "made-up", codedWidth: 16, codedHeight: 16 }, "decode");
  assert.equal(answer.supported, false);
  assert.equal(answer.reason, "TypeError");
  const none = webCodecsProbe({});
  assert.match(none.reason ?? "", /not exposed/);
  assert.match(describeCodecReport(none ? { at: 0, cells: [], unavailableReason: none.reason } : { at: 0, cells: [] }), /not exposed/);
});

await test("HW-03 a probe that never answers cannot hang the matrix", { "HW-03": "full" }, async () => {
  const t0 = Date.now();
  const report = await probeCodecMatrix(async () => new Promise(() => {}) as never, 3, {
    codecs: [VIDEO_CODECS[0]], sizes: [SIZES[0]], batch: 8, answerTimeoutMs: 60,
  });
  const ms = Date.now() - t0;
  assert.equal(report.cells.length, 2, "one codec × two directions");
  assert.equal(report.cells[0].verdict, "unavailable");
  assert.match(report.cells[0].plain?.reason ?? "", /timed out/);
  assert.ok(ms < 2_000, `matrix took ${ms} ms — the guard must fire, not wait for a real timeout`);
});

/* ------------------------------------------------------------------ HW-10 */

await test("HW-10 the assembled module is real SIMD and reproduces its own constant", { "HW-10": "full" }, () => {
  const bytes = wasmSimdProbeBytes();
  assert.equal(WebAssembly.validate(Buffer.from(bytes)), true, "the hand-assembled module must validate in this engine");
  const env: WasmEnv = {
    validate: (b) => WebAssembly.validate(Buffer.from(b)),
    instantiate: (b) => {
      const m = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(b)), {});
      const memory = new Uint8Array((m.exports.mem as WebAssembly.Memory).buffer);
      return { probe: () => (m.exports.probe as () => number)(), memory };
    },
    sharedArrayBuffer: true, crossOriginIsolated: true, atomics: true,
  };
  const r = probeWasm(env, 1);
  assert.equal(r.simd, true, r.simdReason);
  assert.equal(r.strategy, "simd");
  assert.equal(EXPECTED_FIRST_BYTE, 1);
  // The stored pattern is the whole little-endian constant, not just the first byte.
  const inst = env.instantiate(bytes);
  inst.probe();
  assert.deepEqual([...inst.memory.slice(0, 16)], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

await test("HW-10 absence is reported with its reason, and threads need isolation", { "HW-10": "full" }, async () => {
  const noSimd: WasmEnv = {
    validate: () => false,
    instantiate: () => { throw new Error("should not be called"); },
    sharedArrayBuffer: false, crossOriginIsolated: false, atomics: false,
  };
  const r = probeWasm(noSimd, 1);
  assert.equal(r.simd, false);
  assert.match(r.simdReason, /rejected/);
  assert.equal(r.sharedMemory, false);
  assert.equal(r.threads, false);
  assert.equal(r.strategy, "scalar");
  const after = await runThreadProbe(noSimd, r);
  assert.equal(after.threads, false);

  // Shared memory present but no isolation: SAB cannot even be constructed.
  const half = probeWasm({ ...noSimd, sharedArrayBuffer: true }, 2);
  assert.equal(half.sharedMemory, false);
  assert.match(half.sharedMemoryReason, /isolat/);

  // Shared memory and a worker that actually handshakes.
  const good: WasmEnv = {
    validate: (b) => WebAssembly.validate(Buffer.from(b)),
    instantiate: (b) => {
      const m = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(b)), {});
      return { probe: () => (m.exports.probe as () => number)(), memory: new Uint8Array((m.exports.mem as WebAssembly.Memory).buffer) };
    },
    sharedArrayBuffer: true, crossOriginIsolated: true, atomics: true,
    spawnSharedWorker: async () => true,
  };
  const withWorker = await runThreadProbe(good, probeWasm(good, 3));
  assert.equal(withWorker.threads, true);
  assert.equal(withWorker.strategy, "threads");
  const broken = await runThreadProbe({ ...good, spawnSharedWorker: async () => false }, probeWasm(good, 4));
  assert.equal(broken.threads, false);
  assert.match(broken.threadsReason, /handshake/);
  const threw = await runThreadProbe({ ...good, spawnSharedWorker: async () => { throw new Error("no worker"); } }, probeWasm(good, 5));
  assert.equal(threw.threads, false);
  assert.match(threw.threadsReason, /no worker/);
});

await test("HW-10 the chunk planner covers every item exactly once", { "HW-10": "full" }, () => {
  const check = (total: number, workers: number, minChunk: number) => {
    const chunks = planChunks(total, workers, minChunk);
    let sum = 0;
    for (let i = 0; i < chunks.length; i++) {
      assert.ok(chunks[i].end > chunks[i].start, "no empty chunk");
      if (i) assert.equal(chunks[i].start, chunks[i - 1].end, "chunks are contiguous");
      sum += chunks[i].end - chunks[i].start;
    }
    assert.equal(sum, total, "every item belongs to exactly one chunk");
    assert.ok(chunks.length <= Math.max(1, workers), "never more chunks than workers");
    return chunks;
  };
  assert.deepEqual(planChunks(0, 4), []);
  assert.equal(check(1000, 4, 16).length, 4);
  assert.equal(check(3, 8, 16).length, 1, "a tiny range collapses to one chunk");
  assert.equal(check(64, 8, 16).length, 4, "the minimum chunk size caps the worker count");
  for (let i = 0; i < 400; i++) {
    const total = Math.floor(Math.random() * 5000);
    const workers = 1 + Math.floor(Math.random() * 16);
    check(total, workers, 1 + Math.floor(Math.random() * 64));
  }
  assert.throws(() => planChunks(-1, 2), /non-negative/);
  assert.throws(() => planChunks(10, 0), /positive/);
  assert.throws(() => planChunks(10, 2, 0), /positive/);
});

/* ------------------------------------------------------------------ PR-06 */

await test("PR-06 RFC 6068: percent-encoding, CRLF bodies, literal plus, unicode", { "PR-06": "full" }, () => {
  const built = buildMailto({
    to: ["alice@example.com"], cc: [], bcc: [], subject: "A & B", body: "line one\nline two",
  });
  assert.equal(built.truncated, false);
  // `&` in a header value is %26, never a separator.
  assert.match(built.url, /[?&]subject=A%20%26%20B(&|$)/);
  // A newline becomes CRLF-encoded, not a raw %0A.
  assert.match(built.url, /body=line%20one%0D%0Aline%20two/);
  // A literal plus is a plus; a space is %20 (not form-encoding's `+`).
  const plus = buildMailto({ to: ["a@b.co"], cc: [], bcc: [], subject: "1+1 = 2", body: "c++ > c" });
  assert.equal(encodeHeaderValue("1+1 = 2"), "1%2B1%20%3D%202");
  assert.match(plus.url, /1%2B1/);
  assert.match(plus.url, /c%2B%2B/);
  // Unicode goes out as UTF-8 percent escapes.
  const uni = buildMailto({ to: ["a@b.co"], cc: [], bcc: [], subject: "café ☕", body: "" });
  assert.match(uni.url, /caf%C3%A9%20%E2%98%95/);
  // No recipients is a refusal, not an empty link.
  assert.throws(() => buildMailto({ to: [], cc: [], bcc: [], subject: "", body: "" }), /no recipient/);
});

await test("PR-06 refusals: header injection, whitespace, non-ASCII addresses, NUL", { "PR-06": "full" }, () => {
  assert.match(validateAddress("a@b.co") ?? "", /^$/);
  assert.match(validateAddress("a b@c.co") ?? "", /space/);
  assert.match(validateAddress("a@b") ?? "", /dot/);
  assert.match(validateAddress("a..b@c.co") ?? "", /dot-atom/);
  assert.match(validateAddress("ä@b.co") ?? "", /ASCII/);
  assert.match(validateAddress("a@b.c0m") ?? "", /top-level/);
  assert.match(validateAddress("a@b.co\nBcc: evil@example.com") ?? "", /control|line break/);
  // A subject with a line break would inject a header; it is refused, not escaped.
  assert.throws(() => buildMailto({ to: ["a@b.co"], subject: "hi\r\nBcc: evil@example.com" }), /inject a header/);
  assert.throws(() => buildMailto({ to: ["a@b.co"], subject: "nul\u0000here" }), /control character/);
  assert.throws(() => buildMailto({ to: ["a@b.co"], body: "nul\u0000here" }), /NUL/);
  // Duplicates are dropped with a warning; 21 recipients is an error.
  const dup = checkDraft({ to: ["a@b.co", "A@B.co", "c@d.co"] });
  assert.deepEqual(dup.draft.to, ["a@b.co", "c@d.co"]);
  assert.match(dup.warnings.join(" "), /duplicate/);
  const many = checkDraft({ to: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) });
  assert.match(many.errors.map((e) => e.message).join(" "), /limit is 20/);
});

await test("PR-06 truncation is visible, bounded, and loses nothing silently", { "PR-06": "full" }, () => {
  const long = "x".repeat(MAX_BODY_CHARS + 500);
  const built = buildMailto({ to: ["a@b.co"], cc: [], bcc: [], subject: "long", body: long });
  assert.equal(built.truncated, true);
  assert.ok(built.droppedChars >= 500);
  assert.ok(built.url.length <= MAX_URL_BYTES, `url is ${built.url.length} bytes`);
  const parsed = parseMailto(built.url);
  assert.ok(parsed.body.includes(TRUNCATION_MARK), "the marker must survive encoding");
  assert.match(parsed.body, /\[truncated by Fusion/);
  assert.ok(parsed.body.length < long.length);

  // A subject alone that cannot fit is a refusal, not a half-written link.
  const hugeSubject = "s".repeat(1900);
  assert.throws(() => buildMailto({ to: ["a".repeat(64) + "@" + "b".repeat(60) + ".com"], subject: hugeSubject, body: "y".repeat(1800) }), /2000-byte mailto limit/);
});

await test("PR-06 round-trips through parseMailto, and the channel plan is explicit", { "PR-06": "full" }, () => {
  const draft = { to: ["a@b.co", "c@d.co"], cc: ["e@f.co"], bcc: [], subject: "Q3 & Q4", body: "Hello,\n\n  indented line\n" + "z".repeat(100) };
  const parsed = parseMailto(buildMailto(draft).url);
  assert.deepEqual(parsed.to, draft.to);
  assert.deepEqual(parsed.cc, draft.cc);
  assert.equal(parsed.subject, draft.subject);
  assert.equal(parsed.body, draft.body.replace(/\n/g, "\n"));
  assert.throws(() => parseMailto("https://example.com"), /not a mailto/);
  // Unknown headers are ignored, not crashed on.
  assert.equal(parseMailto("mailto:a@b.co?subject=hi&x-fusion=tap").subject, "hi");

  const caps = (o: Partial<Record<"shareApi" | "canShareText" | "canShareFiles" | "canRegisterProtocol", boolean>>) =>
    ({ shareApi: false, canShareText: false, canShareFiles: false, canRegisterProtocol: false, ...o });
  assert.equal(planHandoff(caps({ shareApi: true, canShareFiles: true, canShareText: true }), draft, true).primary, "share");
  const withFileNoShare = planHandoff(caps({}), draft, true);
  assert.equal(withFileNoShare.primary, "mailto");
  assert.match(withFileNoShare.cannot.join(" "), /attachment cannot be sent/);
  const quiet = planHandoff(caps({ shareApi: true, canShareText: true }), draft, false);
  assert.equal(quiet.primary, "mailto");
  assert.ok(quiet.alternates.includes("share"));
  assert.match(quiet.cannot.join(" "), /no copy is kept in Sent/);
  assert.deepEqual(sharePayload({ subject: "S", body: "B" }), { title: "S", text: "S\n\nB" });
});

/* ------------------------------------------------------------------ AU-03 */

await test("AU-03 tokens: strict shape, hashed comparison, scopes", { "AU-03": "full" }, () => {
  const deterministic = (n: number) => new Uint8Array(n).fill(7);
  const minted = mintToken(deterministic);
  assert.match(minted.token, /^fsa1\.[0-9a-z]{8}\.[A-Za-z0-9_-]{43}$/);
  const parsed = parseToken(minted.token)!;
  assert.equal(parsed.id, minted.id);
  assert.equal(parsed.secret, minted.secret);
  // Every near-miss is refused rather than coerced.
  for (const bad of ["", "fsa1", "fsa2.aaaaaaaa." + minted.secret, "fsa1.AAAAAAAA." + minted.secret,
    "fsa1.aaaaaaaa.short", `${minted.token}.extra`, "fsa1.aaaaaaaa." + minted.secret.slice(0, -1)]) {
    assert.equal(parseToken(bad), null, `accepted ${bad.slice(0, 24)}`);
  }
  assert.equal(timingSafeEqualHex("abcd", "abcd"), true);
  assert.equal(timingSafeEqualHex("abcd", "abce"), false);
  assert.equal(timingSafeEqualHex("abcd", "abcde"), false, "a length mismatch is false, never a throw");
  assert.deepEqual(parseScopes(["run", "nope", "read", "run"]), ["run", "read"]);
  assert.deepEqual(parseScopes("run"), []);
});

await test("AU-03 the rate limiter is a fixed window with an honest retry time", { "AU-03": "full" }, () => {
  let state = null as ReturnType<typeof takeToken>["state"] | null;
  const results = [];
  for (let i = 0; i < 4; i++) {
    const r = takeToken(state, 1_000 + i * 10, 3, 60_000);
    state = r.state;
    results.push(r);
  }
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(results[2].remaining, 0);
  assert.equal(results[3].retryAfterMs, 60_000 - 30);
  // A new window starts after the window length, anchored at the first request.
  const fresh = takeToken(state, 61_001, 3, 60_000);
  assert.equal(fresh.allowed, true);
  assert.equal(fresh.state.count, 1);
  // A clock that goes backwards resets rather than locking the caller out forever.
  assert.equal(takeToken(state, 5, 3, 60_000).allowed, true);
  assert.throws(() => takeToken(null, 0, 0, 1000), /positive/);
  assert.throws(() => takeToken(null, 0, 1, 0), /positive/);
});

await test("AU-03 requests: whitelist only, one spelling of the payload, bounded length", { "AU-03": "full" }, () => {
  const ok = validateRequest({ commands: "open files; tile left; theme dark" });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.request.actions.map((a) => a.cmd), ["open", "tile", "theme"]);
  const both = validateRequest({ actions: [{ cmd: "open" }], commands: "open files" });
  assert.equal(both.ok, false);
  assert.match(both.ok === false ? both.errors[0].message : "", /not both/);
  const unknown = validateRequest({ actions: [{ cmd: "eval", arg: "fetch('/etc/passwd')" }] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok === false ? unknown.errors[0].message : "", /whitelist/);
  assert.equal(validateRequest({}).ok, false);
  assert.equal(validateRequest({ actions: [] }).ok, false);
  const tooMany = validateRequest({ actions: Array.from({ length: MAX_ACTIONS + 1 }, () => ({ cmd: "open", arg: "files" })) });
  assert.equal(tooMany.ok, false);
  const vocabularyDoc = vocabulary();
  assert.ok(vocabularyDoc.commands.includes("open"));
  assert.match(vocabularyDoc.note, /does not run while no shell window is open/);
});

await test("AU-03 a settled run cannot be rewritten", { "AU-03": "full" }, () => {
  const run = { id: 1, tokenId: "abc", actions: [{ cmd: "open", arg: "files" }], status: "queued" as const, createdAt: 0, finishedAt: null, result: "" };
  const done = settle(run, true, "executed 1 action", 10);
  assert.equal(done.status, "done");
  assert.equal(done.finishedAt, 10);
  const again = settle({ ...done, status: "done" }, false, "late failure", 20);
  assert.equal(again.status, "done", "a late report must not rewrite history");
  assert.equal(again.result, "executed 1 action");
  const failed = settle(run, false, "x".repeat(900), 11);
  assert.equal(failed.status, "failed");
  assert.equal(failed.result.length, 500, "reported text is bounded");
});

/* ------------------------------------------------------------------ LN-05 / LN-06 */

const image = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): RgbaImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = f(x, y);
    const p = (y * w + x) * 4;
    data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = a;
  }
  return { data, width: w, height: h };
};

await test("LN-05 windowed-sinc resampling: normalised weights, exact identity, no alpha halo", { "LN-05": "full" }, () => {
  for (const kernel of ["linear", "cubic", "lanczos3"] as const) {
    const t = tapTable(64, 96, kernel);
    for (let i = 0; i < 96; i++) {
      let sum = 0;
      for (let k = 0; k < t.taps; k++) sum += t.weights[i * t.taps + k];
      assert.ok(Math.abs(sum - 1) < 1e-12, `${kernel} row ${i} sums to ${sum}`);
      assert.ok(t.start[i] >= 0 && t.start[i] + t.taps <= 64, `${kernel} row ${i} reads outside the image`);
    }
    // Upscaling widens nothing; downscaling widens the kernel (no aliasing).
    assert.equal(tapTable(64, 128, kernel).filterScale, 1);
    assert.ok(tapTable(512, 64, kernel).filterScale > 1);
    // The kernel is symmetric and zero outside its support.
    assert.equal(kernelValue(kernel, 0), 1);
    assert.equal(kernelValue(kernel, 3.5), 0);
    assert.ok(Math.abs(kernelValue(kernel, 0.75) - kernelValue(kernel, -0.75)) < 1e-12);
  }
  // Identity resample: same size, same bytes.
  const src = image(8, 8, (x, y) => [x * 30, y * 30, (x + y) * 15, 255]);
  const same = resample(src, 8, 8, "lanczos3");
  assert.deepEqual([...same.data], [...src.data], "a 1:1 resample must be the identity");

  // A constant colour stays that colour at any scale (weights normalised).
  const flat = image(16, 16, () => [40, 80, 120, 255]);
  const up = resample(flat, 37, 23, "lanczos3");
  for (let p = 0; p < up.data.length; p += 4) {
    assert.ok(Math.abs(up.data[p] - 40) <= 1 && Math.abs(up.data[p + 1] - 80) <= 1 && Math.abs(up.data[p + 2] - 120) <= 1,
      `flat colour drifted at ${p}: ${up.data[p]},${up.data[p + 1]},${up.data[p + 2]}`);
  }

  // Premultiplied alpha: a transparent red stripe must not bleed red into white.
  const halos = image(8, 1, (x) => (x < 4 ? [255, 0, 0, 0] : [255, 255, 255, 255]));
  const scaled = resample(halos, 32, 1, "lanczos3");
  let painted = 0;
  for (let x = 0; x < 32; x++) {
    const p = x * 4;
    if (scaled.data[p + 3] === 0) continue;
    painted++;
    // Every visible sample came from an opaque white source pixel; premultiplied
    // filtering means the transparent red contributes no chroma at all.
    assert.ok(scaled.data[p] >= 250 && scaled.data[p + 1] >= 250 && scaled.data[p + 2] >= 250,
      `colour bled at x=${x}: ${scaled.data[p]},${scaled.data[p + 1]},${scaled.data[p + 2]}`);
  }
  assert.ok(painted >= 14, `only ${painted} samples were painted`);
  assert.equal(scaled.data[3], 0, "transparent input stays transparent");
  // Refusals.
  assert.throws(() => resample({ data: new Uint8ClampedArray(12), width: 4, height: 1 }, 4, 1), /length does not match/);
  assert.throws(() => resample(src, 0, 4), /positive integer/);
  assert.throws(() => resample(src, 5000, 5000), /pixel cap/);
});

await test("LN-06 the key light is a direction, not a brightness knob", { "LN-06": "full" }, () => {
  const grad = image(32, 32, (x, y) => {
    // A sphere-ish luminance bump so the gradient has a real slope.
    const cx = x - 15.5, cy = y - 15.5;
    const v = Math.max(0, 1 - Math.hypot(cx, cy) / 16) * 180 + 40;
    return [v, v, v, 255];
  });
  const base = meanLuma(grad);
  // Intensity 0 is the exact identity.
  const off = applyRelight(grad, { azimuthDeg: 45, elevationDeg: 30, intensity: 0 });
  assert.deepEqual([...off.data], [...grad.data], "intensity 0 must be bit-exact");
  // Deterministic.
  const a = applyRelight(grad, { azimuthDeg: 0, elevationDeg: 35, intensity: 0.8 });
  const b = applyRelight(grad, { azimuthDeg: 0, elevationDeg: 35, intensity: 0.8 });
  assert.deepEqual([...a.data], [...b.data]);
  // Brighter with more intensity, monotone in the middle of the range.
  const lumas = [0.2, 0.5, 0.9].map((i) => meanLuma(applyRelight(grad, { azimuthDeg: 90, elevationDeg: 40, intensity: i })));
  assert.ok(lumas[0] < lumas[1] && lumas[1] < lumas[2], `not monotone: ${lumas.join(", ")}`);
  // Direction matters: the brightest point moves when the azimuth does.
  const right = applyRelight(grad, { azimuthDeg: 0, elevationDeg: 45, intensity: 1 });
  const left = applyRelight(grad, { azimuthDeg: 180, elevationDeg: 45, intensity: 1 });
  const halfMean = (img: RgbaImage, side: "left" | "right") => {
    const copy: RgbaImage = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const keep = side === "left" ? x < img.width / 2 : x >= img.width / 2;
      const p = (y * img.width + x) * 4;
      if (!keep) { copy.data[p] = copy.data[p + 1] = copy.data[p + 2] = 0; }
    }
    return meanLuma(copy);
  };
  assert.ok(halfMean(right, "right") > halfMean(right, "left"), "a light from +x must brighten the right half most");
  assert.ok(halfMean(left, "left") > halfMean(left, "right"), "a light from -x must brighten the left half most");
  assert.notEqual(brightestAt(right).x, brightestAt(left).x, "the highlight position must move with the light");
  // A flat image has no normal, so the effect is a uniform frontal gain.
  const flat = image(16, 16, () => [100, 100, 100, 255]);
  const uniform = applyRelight(flat, { azimuthDeg: 33, elevationDeg: 50, intensity: 0.5 });
  const values = new Set([...uniform.data.filter((_, i) => i % 4 !== 3)]);
  assert.equal(values.size, 1, "a flat surface must shade uniformly");
  assert.ok(meanLuma(uniform) > meanLuma(flat));
  // Bounds: a hostile intensity is clamped, not honoured.
  const clamped = applyRelight(flat, { azimuthDeg: 0, elevationDeg: 900, intensity: 1e6 });
  assert.ok(clamped.data[0] <= 255);
  assert.throws(() => applyRelight(flat, { azimuthDeg: Number.NaN, elevationDeg: 0, intensity: 1 }), /azimuth/);
  void base;
});

/* ------------------------------------------------------------------ FM-14 */

await test("FM-14 drag payloads: types we publish, drops we accept, keyboard alternative", { "FM-14": "full" }, () => {
  const payload = dragPayloadFor({ items: [{ path: "/Documents/a.md", name: "a.md", kind: "file" }], origin: "files" });
  assert.ok(payload.types.includes("text/plain"));
  assert.ok(payload.types.includes("text/uri-list"));
  assert.equal(payload.uriList, "fusion:///Documents/a.md", "a private scheme, so no other app can be tricked into fetching it");
  assert.match(payload.browserDownloadUrl, /^https?:\/\//, "a DownloadURL needs an absolute URL");
  assert.ok(payload.types.includes(OS_DRAG_MIME));
  const accepted = dropDecision({ types: ["text/uri-list"], uriList: "fusion:///Pictures/x.png" });
  assert.deepEqual(accepted, { accept: true, fromFusion: true, paths: ["/Pictures/x.png"], fileCount: 0, reason: "1 path(s) from another Fusion window" });
  const foreign = dropDecision({ types: ["text/uri-list"], uriList: "https://example.com/x.png" });
  assert.equal(foreign.accept, false, "a cross-origin URL is not silently downloaded into the VFS");
  const files = dropDecision({ types: ["Files"], fileCount: 2, fileNames: ["a.txt", "b.txt"] });
  assert.equal(files.accept, true);
  assert.equal(files.fileCount, 2);
  const empty = dropDecision({ types: [], fileCount: 0 });
  assert.equal(empty.accept, false);
  assert.match(empty.reason, /nothing/);
  // WCAG 2.5.7: every pointer drag has a keyboard route.
  const move = keyboardAlternative({ action: "move", paths: ["/a"] });
  assert.match(move!.join(" "), /Ctrl\+X|cut/i);
  const copyK = keyboardAlternative({ action: "copy", paths: ["/a"] });
  assert.match(copyK!.join(" "), /Ctrl\+C|copy/i);
  assert.equal(keyboardAlternative({ action: "drag-out", paths: ["/a"] })!.join(" ").includes("Download"), true);
});

/* ------------------------------------------------------------------ PR-01 */

await test("PR-01 encodings: BOM, UTF-16 without BOM, invalid UTF-8, and large-file policy", { "PR-01": "full" }, () => {
  const bom8 = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xc3, 0xa9]);
  assert.equal(sniffEncoding(bom8), "utf-8");
  const bom16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
  assert.equal(sniffEncoding(bom16), "utf-16le");
  // No BOM: a NUL in every other byte is the reliable tell.
  assert.equal(sniffEncoding(new Uint8Array([0x41, 0x00, 0x42, 0x00])), "utf-16le");
  assert.equal(sniffEncoding(new Uint8Array([0x00, 0x41, 0x00, 0x42])), "utf-16be");
  // Valid UTF-8 wins over a windows-1252 guess.
  assert.equal(sniffEncoding(new TextEncoder().encode("héllo wörld")), "utf-8");
  // 0xE9 alone is not valid UTF-8; it is windows-1252 "é".
  assert.equal(sniffEncoding(new Uint8Array([0x68, 0xe9, 0x6c])), "windows-1252");
  const dec = decodeText(new Uint8Array([0x68, 0xe9]), "windows-1252");
  assert.equal(dec.text, "hé");
  assert.equal(dec.encoding, "windows-1252");
  const enc = encodeText("hé", "windows-1252");
  assert.equal(enc.lossy, false);
  assert.deepEqual([...enc.bytes], [0x68, 0xe9]);
  const lossy = encodeText("héllo ☕", "windows-1252");
  assert.equal(lossy.lossy, true, "a character the encoding cannot represent must be reported");
  assert.equal(lossy.replaced, 1);
  // Large files get a plan, not a freeze.
  const plan = planLargeFile(12 * 1024 * 1024);
  assert.equal(plan.strategy, "chunked");
  assert.ok(plan.chunkBytes <= 2 * 1024 * 1024);
  assert.equal(planLargeFile(4096).strategy, "whole");
  assert.throws(() => planLargeFile(-1), /size/);
});

await test("CT-03 handoff links: round trip, secret-stripped, tamper-refused, size-capped", { "CT-03": "full" }, () => {
  const known = (m: string) => ["files", "editor", "photos", "notes"].includes(m);
  const win = (over: Record<string, unknown>) => ({
    id: String(over.id ?? "w1"), module: "files", title: "Files", x: 10, y: 20, w: 800, h: 600,
    z: 10, minimized: false, maximized: false, workspace: 1, host: "tab" as const, props: {}, ...over,
  });
  const state = {
    windows: [
      win({ id: "w1", props: { path: "/Documents", query: "report", apiToken: "fsa1.leak", nested: { sessionKey: "x", ok: 1 } } }),
      win({ id: "w2", module: "editor", title: "Draft", props: { path: "/Documents/a.md", body: "x".repeat(4000) } }),
      win({ id: "w3", module: "retired-thing", title: "Ghost", props: {} }),
    ],
    focus: "w2",
    activeWorkspace: 1,
  } as never;

  const enc = encodeHandoff(state, "https://fusion.example", known);
  assert.equal(enc.ok, true, enc.reason);
  const url = enc.url!;
  assert.ok(url.startsWith(`https://fusion.example/#${FRAGMENT_KEY}=`));
  // The fragment is the only carrier: nothing before the # contains the layout.
  assert.ok(!url.split("#")[0].includes("Documents"));
  assert.match(enc.dropped.join(" "), /retired-thing/);
  assert.match(describeHandoff(enc), /characters/);

  // Round trip preserves geometry, order and the focus index.
  const dec = decodeHandoff(url, known);
  assert.equal(dec.ok, true, dec.reason);
  assert.equal(dec.state!.windows.length, 2);
  assert.equal(dec.state!.windows[0].module, "files");
  assert.equal(dec.state!.windows[0].x, 10);
  assert.equal(dec.state!.windows[1].title, "Draft");
  assert.equal(dec.state!.focus, 1, "focus follows the window, not the position");

  // Secrets never leave the machine: a credential-named key is absent from both
  // the decoded props and the literal link text, at any nesting depth.
  const files = dec.state!.windows[0].props;
  assert.equal(files.path, "/Documents");
  assert.equal(files.query, "report");
  assert.equal("apiToken" in files, false);
  assert.equal(JSON.stringify(dec.state).includes("sessionKey"), false);
  // An over-long value is not carried at all rather than truncated into a lie.
  assert.equal("body" in dec.state!.windows[1].props, false);

  // Tampering: every hostile shape is refused as a whole, with a reason.
  const tamper = (payload: string) => `https://fusion.example/#${FRAGMENT_KEY}=${payload}`;
  const bad = [
    ["not a url", /not a URL/],
    [tamper("!!!!"), /base64url/],
    [tamper("bm90IGpzb24"), /JSON/],
    [tamper(btoa("[]").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")), /not an object/],
  ] as const;
  for (const [input, want] of bad) {
    const r = decodeHandoff(input as string, known);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", want as RegExp, String(input));
  }
  // A version from the future is refused, not best-effort parsed.
  const future = Buffer.from(JSON.stringify({ version: 99, windows: [] })).toString("base64url");
  assert.match(decodeHandoff(tamper(future), known).reason ?? "", /version 99/);
  // An edited geometry is clamped, not trusted.
  const hostile = Buffer.from(JSON.stringify({ version: 1, focus: 7, windows: [
    { module: "files", title: "x", x: -5000, y: 9e99, w: 1, h: 1e9, workspace: 0, props: { ok: 1 } },
    { module: "not-installed", title: "y" },
  ] })).toString("base64url");
  const clamped = decodeHandoff(tamper(hostile), known);
  assert.equal(clamped.ok, true, clamped.reason);
  assert.deepEqual([clamped.state!.windows[0].x, clamped.state!.windows[0].y], [0, 20_000]);
  assert.deepEqual([clamped.state!.windows[0].w, clamped.state!.windows[0].h], [120, 20_000]);
  assert.equal(clamped.state!.windows[0].workspace, 1);
  assert.equal(clamped.state!.windows.length, 1, "an uninstalled module is dropped, not rendered as an empty frame");
  assert.equal(clamped.state!.focus, 0, "an out-of-range focus falls back to the first window");
  assert.match(clamped.ignored.join(" "), /not-installed/);

  // Too many windows in the payload is a refusal, not a slow page.
  const flood = Buffer.from(JSON.stringify({ version: 1, windows: Array.from({ length: MAX_WINDOWS + 1 }, () => ({ module: "files" })) })).toString("base64url");
  assert.match(decodeHandoff(tamper(flood), known).reason ?? "", new RegExp(String(MAX_WINDOWS)));

  // Size: a layout that cannot fit in a link says so instead of emitting one.
  const huge = { windows: Array.from({ length: MAX_WINDOWS }, (_, i) => win({ id: `h${i}`, title: "T".repeat(60), props: { note: "N".repeat(MAX_PROP_BYTES) } })), focus: "h0", activeWorkspace: 1 } as never;
  const big = encodeHandoff(huge, "https://fusion.example", known);
  assert.equal(big.ok, false);
  assert.match(big.reason ?? "", new RegExp(String(MAX_LINK_BYTES)));

  // An empty desktop has nothing to carry and does not produce a useless link.
  assert.equal(encodeHandoff({ windows: [], focus: null, activeWorkspace: 1 } as never, "https://x", known).ok, false);

  // Props are filtered identically when called directly (the decoder's second line of defence).
  assert.deepEqual(linkableProps({ a: 1, b: [1, "two"], password: "no", fn: () => 1 }), { a: 1, b: [1, "two"] });
});

finish();
