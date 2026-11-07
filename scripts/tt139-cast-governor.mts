/**
 * TT139 (CA-13) — quality governor suite.
 *
 * The tests are written as attacks on the policy, because a governor that
 * passes "it returned a rung" tells you nothing. Each one names the failure
 * mode it would catch in the field.
 */
import { makeHarness } from "./harness.mts";
import {
  LADDER, DEFAULT_POLICY, qualityScore, createGovernor, currentRung, applySample,
  admissibleRungs, governorHud, limitingFactor, governorReport, rungQuality,
  RUNG_QUALITY_MAX,
  type Governor, type QualitySample,
} from "../src/lib/cast/quality-governor.ts";

const { test, finish } = makeHarness("tt139-cast-governor");

/** A link with plenty of everything. */
const GOOD: QualitySample = {
  dropRate: 0, rttMs: 40, availableBitrate: 20_000_000,
  encodedHeight: 1080, fps: 30, contentChangeRate: 1,
};
const BAD: QualitySample = {
  dropRate: 0.2, rttMs: 500, availableBitrate: 300_000,
  encodedHeight: 360, fps: 12, contentChangeRate: 1,
};

/** Feed n samples and return the final governor. */
function feed(g: Governor, s: QualitySample, n: number, src = { width: 1920, height: 1080 }) {
  let cur = g;
  for (let i = 0; i < n; i++) cur = applySample(cur, s, src);
  return cur;
}

await test("CA-13 · score is bounded, monotone in each input, and zero at perfection", { "CA-13": "full" }, () => {
  const rung = LADDER[2];
  const perfect = qualityScore({ dropRate: 0, rttMs: 0, availableBitrate: 1e9, encodedHeight: rung.height, fps: 30, contentChangeRate: 1 }, rung);
  if (perfect !== 0) throw new Error(`a perfect sample scored ${perfect}, want 0`);

  // Each input, worsened alone, must raise the score and never exceed 1.
  const worse = [
    { dropRate: 0.05, rttMs: 0, availableBitrate: 1e9, encodedHeight: rung.height, fps: 30, contentChangeRate: 1 },
    { dropRate: 0, rttMs: 400, availableBitrate: 1e9, encodedHeight: rung.height, fps: 30, contentChangeRate: 1 },
    { dropRate: 0, rttMs: 0, availableBitrate: rung.maxBitrate / 2, encodedHeight: rung.height, fps: 30, contentChangeRate: 1 },
    { dropRate: 0, rttMs: 0, availableBitrate: 1e9, encodedHeight: 360, fps: 30, contentChangeRate: 1 },
    { dropRate: 0, rttMs: 0, availableBitrate: 1e9, encodedHeight: rung.height, fps: 30, contentChangeRate: 1, packetLossRate: 0.02 },
  ];
  for (const s of worse) {
    const v = qualityScore(s, rung);
    if (!(v > 0 && v <= 1)) throw new Error(`score ${v} out of range for ${JSON.stringify(s)}`);
  }
  const unusable = qualityScore({ dropRate: 1, rttMs: 5000, availableBitrate: 1, encodedHeight: 1, fps: 1, contentChangeRate: 1, packetLossRate: 1 }, rung);
  if (unusable !== 1) throw new Error(`an unusable sample scored ${unusable}, want 1`);
  // Dropping one frame in a million is not a problem.
  if (qualityScore({ ...GOOD, dropRate: 0.000001 }, rung) > 0.01) throw new Error("a negligible drop rate was scored as damage");
});

await test("CA-13 · a single bad sample never moves the ladder (the anti-flicker rule)", { "CA-13": "full" }, () => {
  const g = createGovernor();
  // rungQuality grows when things get better, so every comparison below reads
  // forwards. Asserting on rungIndex is how a step-down signs as a step-up.
  const start = rungQuality(g);
  const one = applySample(g, BAD, { width: 1920, height: 1080 });
  if (rungQuality(one) !== start) throw new Error("one bad sample moved the ladder");
  // Climbing afterwards is correct; ending WORSE than the start is the spike
  // having a lasting effect.
  const recovered = feed(one, GOOD, 3);
  if (rungQuality(recovered) < start) throw new Error(`a single spike left quality at ${rungQuality(recovered)}, below ${start}`);
  // Never a downward move across the whole episode.
  let cur = g;
  let downs = 0;
  for (const s of [BAD, GOOD, GOOD, GOOD]) {
    const prev = rungQuality(cur);
    cur = applySample(cur, s, { width: 1920, height: 1080 });
    if (rungQuality(cur) < prev) downs++;
  }
  if (downs) throw new Error(`the ladder stepped down ${downs} time(s) after a one-sample spike`);
});

await test("CA-13 · a sustained problem does move it, and catastrophic samples skip a rung", { "CA-13": "full" }, () => {
  const g = createGovernor();
  const slow = feed(g, BAD, 4);
  if (rungQuality(slow) >= rungQuality(g)) throw new Error("sustained badness did not step down");
  // A collapse (score > 0.75) takes two rungs at once, so recovery starts sooner.
  const collapsed = applySample(applySample(g, BAD, { width: 1920, height: 1080 }), BAD, { width: 1920, height: 1080 });
  const drop = rungQuality(g) - rungQuality(collapsed);
  if (drop < 2) throw new Error(`a collapse only moved ${drop} rung(s)`);
});

await test("CA-13 · the ladder never oscillates on a constant link", { "CA-13": "full" }, () => {
  // The classic bug: drop, recover, drop, recover on a link that never changed.
  // A borderline sample scores between upAt and downAt, so it must be inert.
  const borderline: QualitySample = { ...GOOD, dropRate: 0.035, rttMs: 200, availableBitrate: 3_000_000 };
  const g = createGovernor();
  const after = feed(g, borderline, 12);
  if (after.state.moves > 1) throw new Error(`a constant borderline link caused ${after.state.moves} moves`);
  // And on a clearly good link it climbs monotonically, never rocks.
  let cur = createGovernor();
  const seen: number[] = [];
  for (let i = 0; i < 10; i++) {
    cur = applySample(cur, GOOD, { width: 1920, height: 1080 });
    seen.push(rungQuality(cur));
  }
  for (let i = 1; i < seen.length; i++) {
    if (seen[i] < seen[i - 1]) throw new Error(`ladder went backwards on a good link: ${seen.join(",")}`);
  }
  if (seen[seen.length - 1] !== RUNG_QUALITY_MAX) throw new Error(`never reached the top rung: ${seen.join(",")}`);
});

await test("CA-13 · scaleResolutionDownBy is a divisor of the source, not a height", { "CA-13": "full" }, () => {
  // This is the expensive mistake: writing 720 into scaleResolutionDownBy
  // produces a 2-pixel-tall video. The value must be source/height.
  let g = createGovernor();
  g = feed(g, BAD, 6);
  const app = applySample(g, BAD, { width: 2560, height: 1440 });
  if (!app.application) return; // no change needed is also acceptable
  const d = app.application.scaleResolutionDownBy;
  if (!(d >= 1)) throw new Error(`divisor ${d} below 1 would upscale`);
  const producedHeight = 1440 / d;
  if (Math.abs(producedHeight - app.rung.height) > 1) {
    throw new Error(`divisor ${d} on a 1440p source produces ${producedHeight}p, not ${app.rung.height}p`);
  }
  // A source already smaller than the rung must not be upscaled.
  const small = applySample(createGovernor(), GOOD, { width: 640, height: 360 });
  if (small.application && small.application.scaleResolutionDownBy < 1) throw new Error("upscaled a small source");
});

await test("CA-13 · bitrate keeps 15% headroom under the measured link", { "CA-13": "full" }, () => {
  const g = createGovernor();
  const measured = 1_000_000;
  const s: QualitySample = { ...GOOD, availableBitrate: measured };
  let cur = g;
  let app: ReturnType<typeof applySample>["application"] = null;
  for (let i = 0; i < 6; i++) {
    const r = applySample(cur, s, { width: 1920, height: 1080 });
    cur = r;
    app = r.application ?? app;
  }
  if (!app) {
    // No application means the rung cap is already under the measured budget.
    if (currentRung(cur).maxBitrate > measured) throw new Error("rung exceeds the measured link with no application");
    return;
  }
  if (app.maxBitrate > measured * DEFAULT_POLICY.headroom + 1) {
    throw new Error(`applied ${app.maxBitrate} on a ${measured} bps link: no headroom`);
  }
  if (app.maxBitrate > currentRung(cur).maxBitrate) throw new Error("applied more than the rung allows");
});

await test("CA-13 · the height cap is a hard ceiling and never empties the ladder", { "CA-13": "full" }, () => {
  const capped = createGovernor({ maxHeight: 480 });
  const adm = admissibleRungs(capped.policy);
  if (adm.some((r) => r.height > 480)) throw new Error(`admissible rungs exceed the cap: ${adm.map((r) => r.name)}`);
  // Climbing with a cap must stop at the best admissible rung, not at 1080p.
  const climbed = feed(capped, GOOD, 10);
  if (currentRung(climbed).height > 480) throw new Error(`climbed past the cap to ${currentRung(climbed).name}`);
  // A cap below every rung still leaves something runnable.
  const tiny = createGovernor({ maxHeight: 100 });
  if (admissibleRungs(tiny.policy).length === 0) throw new Error("the ladder became empty");
  const ran = feed(tiny, GOOD, 4);
  if (!Number.isInteger(ran.state.rungIndex)) throw new Error("no usable rung under a tiny cap");
});

await test("CA-13 · static content trades frame rate for detail", { "CA-13": "full" }, () => {
  const g = createGovernor();
  const staticSample: QualitySample = { ...GOOD, contentChangeRate: 0.01, fps: 30 };
  const r = applySample(g, staticSample, { width: 1920, height: 1080 });
  if (!r.application) throw new Error("static content produced no decision");
  if (r.application.maxFps > 5) throw new Error(`static content kept ${r.application.maxFps} fps`);
  if (!/static/i.test(r.reason)) throw new Error(`reason must say why: ${r.reason}`);
  // Moving content must not be throttled.
  const moving = applySample(createGovernor(), GOOD, { width: 1920, height: 1080 });
  if (moving.application && moving.application.maxFps <= 5) throw new Error("moving content was treated as static");
});

await test("CA-13 · nothing is re-applied for a rounding difference", { "CA-13": "full" }, () => {
  // Applying setParameters every sample is a real cost on the encoder.
  let g = feed(createGovernor(), GOOD, 10);
  // At the top rung with a huge link, repeated identical samples must be inert.
  let applications = 0;
  for (let i = 0; i < 20; i++) {
    const r = applySample(g, GOOD, { width: 1920, height: 1080 });
    if (r.application) applications++;
    g = r;
  }
  if (applications > 2) throw new Error(`${applications} needless re-applications while steady`);
});

await test("CA-13 · invalid policy is refused at construction", { "CA-13": "full" }, () => {
  const bads = [
    { headroom: 0 },
    { headroom: 1.5 },
    { upAt: 0.5, downAt: 0.3 },
    { dwell: 0 },
    { dwell: 1.5 },
  ];
  for (const b of bads) {
    let threw = false;
    try { createGovernor(b); } catch { threw = true; }
    if (!threw) throw new Error(`policy ${JSON.stringify(b)} accepted`);
  }
});

await test("CA-13 · HUD, limiting factor and report stay consistent", { "CA-13": "full" }, () => {
  const g = feed(createGovernor(), BAD, 4);
  const hud = governorHud(g, BAD);
  if (!/\d+%/.test(hud)) throw new Error(`HUD has no quality figure: ${hud}`);
  if (!hud.includes("ms")) throw new Error(`HUD has no latency: ${hud}`);
  if (limitingFactor(BAD, currentRung(g)) !== "bandwidth") throw new Error("a starved link must name bandwidth first");
  if (limitingFactor(GOOD, LADDER[0]) !== "nothing measurable") throw new Error("a perfect link must not invent a cause");
  const rep = governorReport(g, BAD);
  if (rep.samples !== g.state.samples) throw new Error("report sample count drifted");
  if (!rep.ladder.length) throw new Error("report ladder empty");
  for (const row of rep.ladder) {
    if (row.viable && row.rung.maxBitrate > BAD.availableBitrate) throw new Error(`claimed ${row.rung.name} viable on ${BAD.availableBitrate} bps`);
  }
});

await test("CA-13 · feeding a decision back is type- and value-stable", { "CA-13": "full" }, () => {
  // Regression: applySample returned a bare state, so the next call lost the
  // policy and silently reverted to the defaults.
  const g = createGovernor({ maxHeight: 480, headroom: 0.5 });
  const r = applySample(g, GOOD, { width: 1920, height: 1080 });
  if (!r.policy) throw new Error("the decision dropped the policy");
  if (r.policy.maxHeight !== 480) throw new Error("the decision lost the caller's cap");
  const next = applySample({ state: r.state, policy: r.policy }, GOOD, { width: 1920, height: 1080 });
  if (next.policy.headroom !== 0.5) throw new Error("the policy mutated between samples");
});

finish();
