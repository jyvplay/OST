/**
 * TT146 — HW-09 network-aware quality, the pure half.
 *
 * The companion suite `e2e-tt146` checks the browser end: a real probe, a real
 * gallery, a real thumbnail request. This one checks the part that must be
 * exactly right and cannot be judged by eye — the ladder, the rejection rules,
 * and the order of authority between "the browser guessed", "we measured" and
 * "the user said no".
 *
 * Every assertion is written against a *quantity*: a number the UI will act on.
 * "The estimator prefers recent samples" is not testable; "after samples of
 * 8 Mbit/s then 2 Mbit/s the estimate lands between them and above the latter"
 * is, and it is what a plan reads.
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import {
  readNetworkFacts, ThroughputEstimator, TierStabilizer, planQuality, tierForBps, tierForFacts,
  describeDecision, EFFECTIVE_RANK, RUNGS, TIER_LABEL,
  type Confidence, type EffectiveType, type NetworkFacts, type Surface, type Tier,
} from "../src/lib/net/quality.ts";

const { test, finish } = makeHarness("tt146-net-quality");

const facts = (o: Partial<NetworkFacts> = {}): NetworkFacts => ({
  online: true, effectiveType: "4g", downlinkMbps: 10, rttMs: 50, saveData: false, reported: true, ...o,
});

await test("facts: absent API is reported as absent; hostile values are clamped, never trusted", {}, () => {
  const none = readNetworkFacts(undefined, true);
  assert.equal(none.reported, false);
  assert.equal(none.effectiveType, "unknown");
  assert.equal(none.downlinkMbps, null, "a missing API must not invent a speed");
  // An object that exists but says nonsense is a different case: keep `reported`,
  // drop the value rather than clamping a string into a number.
  const junk = readNetworkFacts({ effectiveType: "warp", downlink: Number.NaN, rtt: -5 }, false);
  assert.equal(junk.effectiveType, "unknown");
  assert.equal(junk.downlinkMbps, null);
  assert.equal(junk.online, false);
  // Out-of-range numbers are clamped to what the API can mean.
  assert.equal(readNetworkFacts({ downlink: 1e9 }, true).downlinkMbps, 100_000);
  assert.equal(readNetworkFacts({ rtt: -1 }, true).rttMs, 0);
  // Save-Data is only on when it is literally true.
  assert.equal(readNetworkFacts({ saveData: true }, true).saveData, true);
  assert.equal(readNetworkFacts({ saveData: 1 as unknown as boolean }, true).saveData, false);
});

await test("estimator: three rejection rules, exact EWMA, and staleness that changes the answer", {}, () => {
  const e = new ThroughputEstimator({ alpha: 0.5, minBytes: 10_000, maxPlausibleMbps: 1_000, staleMs: 1_000 });
  // 1. too few bytes to time
  assert.equal(e.add({ bytes: 9_999, ms: 10 }, 0).accepted, false);
  // 2. faster than any link: a cache hit
  assert.equal(e.add({ bytes: 10_000_000, ms: 1 }, 0).accepted, false);
  assert.equal(e.bps(), null, "rejected samples must leave no estimate at all");
  // 3. nonsensical pairs
  assert.equal(e.add({ bytes: 0, ms: 100 }, 0).accepted, false);
  assert.equal(e.add({ bytes: 100_000, ms: 0 }, 0).accepted, false);

  // 100 KiB in 100 ms = 8.192 Mbit/s exactly.
  const first = e.add({ bytes: 102_400, ms: 100 }, 10);
  assert.equal(first.accepted, true);
  assert.equal(first.bps, 8_192_000);
  // EWMA with alpha 0.5: (8.192 + 2.048) / 2, i.e. a halving link is believed halfway.
  const second = e.add({ bytes: 25_600, ms: 100 }, 20);
  assert.equal(second.bps, (8_192_000 + 2_048_000) / 2);
  assert.equal(e.samples, 2);
  assert.equal(e.bytes, 128_000);

  // Staleness is a claim about time, so it is a different answer at a later `now`.
  assert.equal(e.bps(500), 5_120_000);
  assert.equal(e.bps(20 + 1_001), null, "an estimate older than staleMs is not an estimate");
  assert.equal(e.confidence(20 + 1_001), "none");
  e.reset();
  assert.equal(e.bps(), null);
  assert.equal(e.samples, 0);
});

await test("estimator: confidence follows the evidence, not the speed", {}, () => {
  const fast = new ThroughputEstimator({ alpha: 1, minBytes: 1, maxPlausibleMbps: 100_000, staleMs: 10_000_000 });
  const slow = new ThroughputEstimator({ alpha: 1, minBytes: 1, maxPlausibleMbps: 100_000, staleMs: 10_000_000 });
  const seq: [number, number][] = [[400_000, 40], [400_000, 40], [400_000, 40]];
  for (const [i, [bytes, ms]] of seq.entries()) { fast.add({ bytes, ms }, i * 10); slow.add({ bytes, ms: ms * 100 }, i * 10); }
  // Same number of samples, 100× different rates, identical confidence: the
  // rule counts evidence (n and bytes), and 3 × 400 KB clears it.
  assert.equal(fast.confidence(), "high");
  assert.equal(slow.confidence(), "high");
  // Three samples that are individually too small for the byte rule stop at medium.
  const thin = new ThroughputEstimator({ alpha: 1, minBytes: 1_000 });
  for (let i = 0; i < 3; i++) thin.add({ bytes: 100_000, ms: 20 }, i);
  assert.ok((slow.bps() ?? 0) < (fast.bps() ?? 0) / 50);
  assert.equal(thin.confidence(), "medium");
  // One sample, tiny: low, even if it happened to be fast.
  const one = new ThroughputEstimator({ alpha: 1, minBytes: 1_000 });
  one.add({ bytes: 20_000, ms: 2 }, 0);
  assert.equal(one.confidence(), "low");
});

await test("ladder: bps → rung bands are exact at every boundary", {}, () => {
  const cases: [number, Tier][] = [
    [0, 0], [-1, 0], [Number.NaN, 0],
    [149_999, 0], [150_000, 1], [999_999, 1], [1_000_000, 2],
    [4_999_999, 2], [5_000_000, 3], [1e9, 3], [Number.POSITIVE_INFINITY, 0],
  ];
  for (const [bps, tier] of cases) assert.equal(tierForBps(bps), tier, `${bps} bps`);
  // The rungs themselves must increase in every dimension: a "higher" rung that
  // asks for a smaller thumbnail is the bug that makes a slow link load more.
  for (let i = 1; i < RUNGS.length; i++) {
    const a = RUNGS[i - 1], b = RUNGS[i];
    assert.ok(b.photoThumb > a.photoThumb && b.photoPreview > a.photoPreview && b.videoHeight > a.videoHeight && b.prefetchBytes > a.prefetchBytes);
  }
  // Browser classification maps to a rung without ever going down.
  const order: EffectiveType[] = ["slow-2g", "2g", "3g", "4g", "5g"];
  let prev = -1;
  for (const t of order) {
    const tier = tierForFacts(facts({ effectiveType: t }));
    assert.ok(tier >= prev, `${t} ranked below its slower neighbour`);
    prev = tier;
  }
  assert.ok(EFFECTIVE_RANK["5g"] > EFFECTIVE_RANK["4g"]);
});

await test("authority: offline beats Save-Data beats measurement beats estimate beats assumption", {}, () => {
  const fast = 40_000_000; // measured 40 Mbit/s
  // 1. offline wins over everything, including a measurement
  const off = planQuality(facts({ online: false, saveData: true }), fast, "high", "photoThumb");
  assert.equal(off.tier, 0); assert.equal(off.source, "offline");
  assert.equal(off.value, RUNGS[0].photoThumb);
  // 2. Save-Data wins over a trusted measurement, and is labelled as a user cap
  const save = planQuality(facts({ saveData: true, effectiveType: "5g" }), fast, "high", "photoThumb");
  assert.equal(save.tier, 0); assert.equal(save.source, "save-data"); assert.equal(save.cappedByUser, true);
  // 3. a trusted measurement wins over the browser's capped estimate — this is
  //    the whole point: Chromium says 10 Mbit/s, we measured 40.
  const measured = planQuality(facts({ downlinkMbps: 10 }), fast, "high", "photoThumb");
  assert.equal(measured.tier, 3); assert.equal(measured.source, "measured");
  assert.equal(measured.value, RUNGS[3].photoThumb);
  // ...but an untrusted one does not.
  const unsure = planQuality(facts({ downlinkMbps: 10 }), 40_000_000, "low", "photoThumb");
  assert.equal(unsure.source, "browser estimate");
  // 4. browser estimate when nothing was measured
  const est = planQuality(facts({ effectiveType: "3g", downlinkMbps: 1.5 }), null, "none", "video");
  assert.equal(est.source, "browser estimate"); assert.equal(est.tier, 1); assert.equal(est.value, 480);
  // 5. assumed middle rung when the API is missing entirely
  const assumed = planQuality(readNetworkFacts(undefined, true), null, "none", "prefetch");
  assert.equal(assumed.source, "assumed"); assert.equal(assumed.tier, 2);
  assert.equal(assumed.value, 1024 * 1024);
});

await test("ceiling: a governor cap is respected for every surface and every source", {}, () => {
  const bps = 80_000_000;
  const surfaces: Surface[] = ["photoThumb", "photoPreview", "video", "prefetch", "sync"];
  for (const maxTier of [0, 1, 2, 3] as Tier[]) {
    for (const surface of surfaces) {
      const d = planQuality(facts({ effectiveType: "5g" }), bps, "high", surface, { maxTier });
      assert.equal(d.tier, maxTier);
      assert.equal(d.value, RUNGS[maxTier][surface === "photoThumb" ? "photoThumb" : surface === "photoPreview" ? "photoPreview" : surface === "video" ? "videoHeight" : surface === "prefetch" ? "prefetchBytes" : "parallelTransfers"]);
      // A cap is a cap: the decision says it was capped, except at the top rung.
      assert.equal(d.cappedByUser, maxTier < 3);
      if (maxTier < 3) assert.match(d.reason, /capped at .* by the quality ceiling/);
    }
  }
});

await test("fuzz: 20 000 random inputs never leave the ladder, never invert it, never pick a value off the rung", {}, () => {
  let seed = 0x5eed1234;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 0x1_0000_0000; };
  const types: EffectiveType[] = ["slow-2g", "2g", "3g", "4g", "5g", "unknown"];
  const confidences: Confidence[] = ["none", "low", "medium", "high"];
  const surfaces: Surface[] = ["photoThumb", "photoPreview", "video", "prefetch", "sync"];
  for (let i = 0; i < 20_000; i++) {
    const f = facts({
      online: rnd() > 0.1,
      saveData: rnd() > 0.8,
      reported: rnd() > 0.2,
      effectiveType: types[Math.floor(rnd() * types.length)],
      downlinkMbps: rnd() > 0.3 ? rnd() * 20 : null,
    });
    const measured = rnd() > 0.5 ? rnd() * 200_000_000 : null;
    const conf = confidences[Math.floor(rnd() * confidences.length)];
    const maxTier = Math.floor(rnd() * 4) as Tier;
    const surface = surfaces[Math.floor(rnd() * surfaces.length)];
    const d = planQuality(f, measured, conf, surface, { maxTier });
    assert.ok(d.tier >= 0 && d.tier <= maxTier, `tier ${d.tier} above ceiling ${maxTier}`);
    assert.equal(d.label, TIER_LABEL[d.tier]);
    const rung = RUNGS[d.tier];
    const expected = surface === "photoThumb" ? rung.photoThumb : surface === "photoPreview" ? rung.photoPreview : surface === "video" ? rung.videoHeight : surface === "prefetch" ? rung.prefetchBytes : rung.parallelTransfers;
    assert.equal(d.value, expected, `surface ${surface} at tier ${d.tier} did not take the rung's value`);
    if (!f.online) assert.equal(d.source, "offline");
    else if (f.saveData) assert.equal(d.source, "save-data");
    // Monotone in bandwidth when the measurement is the authority.
    if (d.source === "measured" && measured !== null) {
      const higher = planQuality(f, measured * 2, conf, surface, { maxTier });
      assert.ok(higher.tier >= d.tier, "twice the bandwidth produced a lower rung");
    }
  }
});

await test("descriptions: one line, the unit of the surface, and the reason it won", {}, () => {
  const d = planQuality(facts({ effectiveType: "3g", downlinkMbps: 1.5 }), null, "none", "photoThumb");
  assert.match(describeDecision(d, "photoThumb"), /^low \(160 px\) — browser reports 3g/);
  assert.match(describeDecision(planQuality(facts({ effectiveType: "3g" }), null, "none", "video"), "video"), /\(480p\) —/);
  assert.match(describeDecision(planQuality(facts(), null, "none", "prefetch"), "prefetch"), /\(1048576 B\) —/);
  assert.match(describeDecision(planQuality(facts(), null, "none", "sync"), "sync"), /^standard \(2\) — /);
  // No surface description may contain a newline: it goes on one settings row.
  for (const s of ["photoThumb", "photoPreview", "video", "prefetch", "sync"] as Surface[]) {
    assert.ok(!describeDecision(planQuality(facts(), null, "none", s), s).includes("\n"));
  }
});

await test("stabiliser: down immediately, up only with repeated evidence and dwell", {}, () => {
  const st = new TierStabilizer(2, { upAfter: 3, minDwellMs: 1_000 });
  assert.equal(st.current, 2);
  // Down is immediate: a dying link must not wait for three samples.
  assert.deepEqual([st.update(0, 100).tier, st.update(0, 100).moved], [0, false]);
  // Up needs three consistent suggestions...
  assert.equal(st.update(3, 2_000).moved, false);
  assert.match(st.update(3, 2_000).reason, /needs 3 consistent samples \(2 so far\)/);
  assert.equal(st.update(3, 2_000).moved, true);
  assert.equal(st.current, 3);
  // ...and the dwell blocks a jump right after a move even with evidence.
  const held = st.update(3, 2_100);
  assert.equal(held.tier, 3);
  const st2 = new TierStabilizer(1, { upAfter: 2, minDwellMs: 1_000 });
  st2.update(0, 0); // step down, which sets lastMoveAt
  assert.equal(st2.update(3, 1).moved, false);
  assert.match(st2.update(3, 1).reason, /holding .* for 1000 ms/);
  assert.equal(st2.update(3, 1_001).moved, false, "first sample after dwell restarts the count");
  assert.equal(st2.update(3, 1_002).moved, true);
  // An unchanged suggestion clears a partial upgrade: intermittent evidence is not evidence.
  const st3 = new TierStabilizer(0, { upAfter: 2, minDwellMs: 0 });
  st3.update(3, 0); assert.equal(st3.update(0, 1).reason, "unchanged");
  assert.equal(st3.update(3, 2).moved, false, "the half-collected upgrade was discarded");
  assert.equal(st3.update(3, 3).moved, true);
});

finish();
