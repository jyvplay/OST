/**
 * TT145 engine suite — twenty-two engines, each asked for an acceptance AND a
 * refusal.
 *
 * The pairing rule is the same one TT143 used, and for the same reason: an
 * acceptance alone cannot distinguish an engine from a stub that returns a
 * constant, and a refusal alone cannot distinguish a guard from a bug that refuses
 * everything. Every refusal must also carry a *sentence*, because a blockage with
 * no reason is a dead end rather than a feature.
 *
 * Where the claim is numeric the assertion is numeric (contrast-free here, but:
 * frame budgets, byte totals, occurrence counts, digests, kernel weights). Where
 * the claim is cryptographic the test uses the real WebCrypto primitives in Node —
 * an AES-GCM seal that round-trips and a GCM tag that fails on a swapped record,
 * an Ed25519 signature that verifies and one that does not — rather than a stub.
 *
 * Run: node --no-warnings --import ./scripts/register-hook.mjs scripts/tt145-engines.mts
 */
import { makeHarness } from "./harness.mts";
import { LIMITS as VAULT_LIMITS, makeKey, canSeal, seal, open, aad, rotationPlan, canonicalRecord, describeBacking, KEY_BITS } from "../src/lib/vault-seal.ts";
import { planBlackout, coalesceTouches, cost, IDLE_FPS, OBLIGATIONS } from "../src/lib/blackout-budget.ts";
import { parseGrant, signedBytes, decide, raiseHighWater, mergeRefresh, dueForRefresh, DEFAULT_GRACE_MS, THREAT_MODEL, type Grant, type CacheEntry } from "../src/lib/entitlement-cache.ts";
import { emptyJournal, schedule, flush, recover, compact, previousDistinct, summary as journalSummary, digest as jdigest, MAX_REVISIONS, MAX_BODY_BYTES } from "../src/lib/autosave-journal.ts";
import { parseRules, decide as decideFilter, report as filterReport, LIMITS as FILTER_LIMITS, type Rule } from "../src/lib/content-filter.ts";
import { planOutbound, planInbound, MAX_DROP_ITEMS, LIMITS as DROP_LIMITS } from "../src/lib/drop-claim.ts";
import { checkScheme, checkTemplate, offer, observeLaunch, displayState, guideFor, probeSummary, MAX_HANDLERS, type Claim as HandlerClaim } from "../src/lib/handler-claim.ts";
import { makeChord, register, keydown, release, blur, limitsSentence, RESERVED, type Latch } from "../src/lib/shortcut-latch.ts";
import { estimate, report as audioReport, drift, resample, QUANTUM_FRAMES, type Graph } from "../src/lib/audio-quantum.ts";
import { parse as parseExclusions, EMPTY as NO_EXCLUSIONS, mayCapture, redactUrl, redactText, redactAll, REDACTED, MAX_RULES as MAX_EXCL } from "../src/lib/exclusion-rules.ts";
import { listing, withError, health as volumeHealth, spaceSentence, upsert, MAX_VOLUMES, type Volume } from "../src/lib/volume-access.ts";
import { codecString, judge, planRendition, efficiency, codecsParam, mimeFor } from "../src/lib/codec-probe.ts";
import { makeAlarm, occurrencesBetween, evaluate, snooze, scheduleText, deliverySentence, type PartsOf } from "../src/lib/alarm-due.ts";
import { health as backupHealth, sample as drillSample, interpretDrill, dueSentence, SAMPLE_MIN } from "../src/lib/backup-health.ts";
import { snapshot, verify, verifyCompacted, retain, compactPlan, digestBytes, DEFAULT_KEEP, type FileEntry } from "../src/lib/backup-timeline.ts";
import { emptyTrash, trash, restore, sweep, summary as trashSummary, DEFAULT_RETENTION_DAYS } from "../src/lib/trash-policy.ts";
import { place, adoptionPlan, closeBehaviour, STYLE_BYTE_BUDGET, LIMITS as PIP_LIMITS } from "../src/lib/pip-placement.ts";
import { summarise, storefrontFor, strippedClean, STOREFRONTS, LIMITS as SM7_LIMITS } from "../src/lib/sm7-summary.ts";
import { emptyModel, admit, observe, shouldYield, iterationsPerSlice, costOf, FRAME_MS, RESERVE_MS, type Slice } from "../src/lib/task-budget.ts";
import { emptyBroker, decide as decideLane, observe as observeLane, probeBudgetMs, splitInstruction, matrix, type Attempt } from "../src/lib/workspace-lanes.ts";
import { classify, assertMechanism, expiryNote, FRAGMENT_LIMIT, LIVE_LIMIT, LIMITS as HANDOFF_LIMITS } from "../src/lib/launch-claim.ts";
import { makeRoutine, checkAction, plan, auditEntry, execute, importRoutine, MIN_INTERVAL_MS, MAX_ACTIONS, LIMITS as ROUTINE_LIMITS } from "../src/lib/routine-guard.ts";

const { test, finish } = makeHarness("tt145-engines");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const throws = (fn: () => unknown, match: RegExp, m: string) => {
  try { fn(); } catch (e) { if (!match.test((e as Error).message)) throw new Error(`${m}: wrong refusal “${(e as Error).message}”`); return; }
  throw new Error(`${m}: nothing was thrown`);
};
const utcParts: PartsOf = (ts) => {
  const d = new Date(ts);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), dow: d.getUTCDay() };
};

// ── HW-08 vault seal ────────────────────────────────────────────────────────
await test("HW-08 vault: AES-GCM round-trips, a swapped record fails the AAD, a retired key cannot seal, and backing is never called 'hardware'", { "HW-08": "full" }, async () => {
  ok(KEY_BITS === 256, "256-bit keys");
  const raw = await crypto.subtle.generateKey({ name: "AES-GCM", length: KEY_BITS }, false, ["encrypt", "decrypt"]);
  const k1 = makeKey("k1", 1_000);
  const body = new TextEncoder().encode("the quick brown fox");
  const { env, spec } = await seal(raw, k1, "Notes/One", body);
  ok(spec.seals === 1, "seal counter advances");
  const back = await open(raw, spec, env, body.length);
  eq([...back], [...body], "round trip");
  // The same ciphertext moved to another record must not open: that is what the AAD is for.
  let failure = "";
  try { await open(raw, spec, { ...env, record: "notes/two" }); } catch (e) { failure = (e as Error).message; }
  ok(/does not authenticate/.test(failure), `swapped record refused: ${failure}`);
  // A retired key opens but never seals.
  const retired = { ...k1, retiredAt: 2_000 };
  ok(canSeal(retired).ok === false, "retired key cannot seal");
  let retiredMsg = "";
  try { await seal(raw, retired, "Notes/One", body); } catch (e) { retiredMsg = (e as Error).message; }
  ok(/retired/.test(retiredMsg), retiredMsg);
  ok((await open(raw, retired, env)).length === body.length, "a retired key still opens what it sealed");
  // An empty record and a bad IV are refused rather than producing a degenerate envelope.
  let emptyMsg = "";
  try { await seal(raw, k1, "Notes/Empty", new Uint8Array(0)); } catch (e) { emptyMsg = (e as Error).message; }
  ok(/empty record/.test(emptyMsg), `an empty record is refused: ${emptyMsg}`);
  throws(() => canonicalRecord("a b"), /do not survive/, "non-canonical record id refused");
  ok(canonicalRecord(" Notes/One ") === "notes/one", "a path-shaped id canonicalises");
  throws(() => makeKey("K1", 1), /lowercase/, "key id casing");
  // Rotation is a plan with a stated tail, not a hope.
  const planR = rotationPlan(k1, makeKey("k2", 3_000), 600, 250);
  ok(planR.batches === 3 && planR.keepOld.includes("k1"), `rotation ${planR.batches} batches`);
  throws(() => rotationPlan(k1, k1, 5), /two different keys/, "self-rotation refused");
  const backing = describeBacking({ extractable: false, sameOriginIsolated: false });
  ok(!/hardware/i.test(backing.verdict) || /unobservable/.test(backing.verdict), backing.verdict);
  ok(describeBacking({ extractable: true, sameOriginIsolated: true }).verdict.startsWith("refused"), "extractable refused");
  ok(VAULT_LIMITS.length === 4, "four stated limits");
  ok(VAULT_LIMITS.some((l) => l.includes("no attestation")), "attestation limit stated");
  eq([...aad("k1", "Notes/One")].slice(0, 2), [49, 124], "AAD starts with the schema version");
});

// ── SH-10 blackout ─────────────────────────────────────────────────────────
await test("SH-10 blackout: a flat single layer draws 1 fps instead of 60, every other fill is refused with a reason, and touches coalesce no faster than the display", { "SH-10": "full" }, () => {
  const good = planBlackout({ fill: "flat", ownsLayer: true, animated: false, hidden: false, refreshHz: 60 });
  ok(good.fps === IDLE_FPS && good.refuses.length === 0, `fps ${good.fps}`);
  ok(Math.abs(good.presentsRemoved - 59 / 60) < 1e-9, "98.3 % of presents avoided");
  const gradient = planBlackout({ fill: "gradient", ownsLayer: true, animated: false, hidden: false });
  ok(gradient.refuses.length === 1 && /GPU layer/.test(gradient.refuses[0]), gradient.refuses[0]);
  const animated = planBlackout({ fill: "flat", ownsLayer: true, animated: true, hidden: false });
  ok(animated.refuses.some((r) => /animation/.test(r)), "animation refused");
  const hidden = planBlackout({ fill: "flat", ownsLayer: true, animated: false, hidden: true });
  ok(hidden.refuses.some((r) => /release the wake lock/.test(r)), "hidden tab refused");
  // A 120 Hz display halves the relative saving; the engine uses the reported rate.
  ok(Math.abs(planBlackout({ fill: "flat", ownsLayer: true, animated: false, hidden: false, refreshHz: 120 }).presentsRemoved - 119 / 120) < 1e-9, "120 Hz");
  // Coalescing: keep the LAST move in each window, and refuse a window shorter than a frame.
  const moves = [{ at: 0, x: 1, y: 1 }, { at: 4, x: 2, y: 2 }, { at: 9, x: 3, y: 3 }, { at: 20, x: 4, y: 4 }];
  const coalesced = coalesceTouches(moves, 1000 / 60, 60);
  ok(coalesced.length === 2 && coalesced[0].x === 3 && coalesced[1].x === 4, JSON.stringify(coalesced));
  throws(() => coalesceTouches(moves, 8, 60), /faster than/, "sub-frame window refused");
  ok(coalesceTouches(moves, 1000 / 60, 60).length === 2, "a window of exactly one frame period is allowed");
  const c = cost(good, 8);
  ok(/counted/.test(c.measured) && /estimate/.test(c.estimated), "measured and estimated are separate strings");
  ok(OBLIGATIONS.length === 5, "five obligations printed");
});

// ── BL-02 entitlement cache ────────────────────────────────────────────────
await test("BL-02 entitlement: a signed grant opens offline, tampering/rollback/expiry each refuse with their own verdict, and a stale refresh cannot shorten a grant", { "BL-02": "full" }, async () => {
  const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const grant: Grant = { v: 1, product: "fusion-pro", features: ["recall.archive", "backup.timeline"], seats: 2, issuedAt: 1_000_000, expiresAt: 1_000_000 + 30 * 86400000, reference: "order-42" };
  const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, signedBytes(grant));
  const b64 = Buffer.from(new Uint8Array(sig)).toString("base64");
  const good = await crypto.subtle.verify("Ed25519", kp.publicKey, Buffer.from(b64, "base64"), signedBytes(grant));
  ok(good, "real Ed25519 signature verifies");
  const tampered = { ...grant, seats: 99 };
  ok(!(await crypto.subtle.verify("Ed25519", kp.publicKey, Buffer.from(b64, "base64"), signedBytes(tampered))), "tampered grant fails the signature");
  const now = 1_000_000 + 86400000;
  const base = { highWater: now, signatureValid: true, knownProducts: ["fusion-pro"] };
  const entry: CacheEntry = { grant, signature: b64, confirmedAt: 1_000_000 };
  const granted = decide(entry, "recall.archive", now, base);
  ok(granted.verdict === "granted" && granted.allowed && granted.msLeft! > 0, granted.why);
  const notIncluded = decide(entry, "music.hires", now, base);
  ok(!notIncluded.allowed && notIncluded.verdict === "granted", "a real grant for another feature is not a grant for this one");
  eq(decide(null, "x", now, base).verdict, "absent", "absent");
  eq(decide({ ...entry, signature: "AAAA" }, "recall.archive", now, { ...base, signatureValid: false }).verdict, "bad-signature", "bad signature");
  eq(decide(entry, "recall.archive", now, { ...base, highWater: now + 3600_000 }).verdict, "clock-rollback", "clock rollback");
  const expiry = grant.expiresAt + DEFAULT_GRACE_MS + 1;
  eq(decide(entry, "recall.archive", expiry, { ...base, highWater: expiry }).verdict, "expired", "expired past grace");
  const inGrace = decide(entry, "recall.archive", grant.expiresAt + 86400000, { ...base, highWater: grant.expiresAt + 86400000 });
  ok(inGrace.verdict === "grace" && inGrace.allowed, inGrace.why);
  eq(decide(entry, "recall.archive", now, { ...base, knownProducts: ["fusion-lite"] }).verdict, "unknown-product", "unknown product");
  // Structural validation before crypto.
  ok(!parseGrant({ ...grant, expiresAt: grant.issuedAt }).ok, "expiry before issue refused");
  ok(!parseGrant({ ...grant, v: 2 }).ok, "wrong version refused");
  ok(!parseGrant({ ...grant, features: [""] }).ok, "empty feature id refused");
  // A stale replica must not shorten an entitlement.
  const older: CacheEntry = { grant: { ...grant, issuedAt: 999_000, expiresAt: 999_000 + 86400000 }, signature: b64, confirmedAt: now };
  const merged = mergeRefresh(entry, older, now);
  ok(merged.entry.grant.issuedAt === grant.issuedAt && /older grant/.test(merged.note), merged.note);
  const newer: CacheEntry = { grant: { ...grant, issuedAt: 1_500_000, expiresAt: 1_500_000 + 86400000 }, signature: b64, confirmedAt: now };
  ok(mergeRefresh(entry, newer, now).entry.grant.issuedAt === 1_500_000, "a newer grant replaces");
  ok(raiseHighWater(now, now - 5000) === now, "high water only moves forward");
  ok(dueForRefresh(entry, 1_000_000 + 7 * 3600_000), "due after the recheck interval");
  ok(THREAT_MODEL.length === 5, "five threat-model statements");
});

// ── PR-01 autosave journal ─────────────────────────────────────────────────
await test("PR-01 journal: a no-op save creates no revision, a second writer forks a conflict instead of overwriting, a pending save survives a crash, and body compression never drops the last distinct version", { "PR-01": "full" }, () => {
  let j = emptyJournal("doc-a");
  const s1 = schedule(j, "hello", 1_000);
  eq(recover(s1.journal).dirty, true, "a scheduled save is dirty before it flushes");
  j = flush(s1.journal, null, "hello", 1_100).journal;
  ok(j.revs.length === 1 && j.revs[0].kind === "flush" && j.pending === null, "one flush revision");
  const noop = schedule(j, "hello", 1_200);
  ok(/nothing scheduled/.test(noop.note) && noop.journal.revs.length === 1, "identical body is not journalled");
  j = flush(j, j.revs[0].id, "hello there", 1_300).journal;
  ok(j.revs.length === 2, "second distinct body appended");
  // Another tab flushed on top of the same parent: this flush must fork.
  const raced = flush(j, j.revs[0].id, "hello again", 1_400);
  ok(raced.conflicted && raced.revision.kind === "conflict" && raced.revision.other === "hello there", `conflict carries the other body: ${raced.revision.kind}`);
  j = raced.journal;
  const prev = previousDistinct(j);
  ok(prev !== null && prev.body === "hello there", `previous distinct is the pre-conflict body: ${prev?.body}`);
  // Crash recovery: a scheduled-but-unflushed body is what comes back.
  const crash = schedule(j, "draft after the crash", 1_500).journal;
  const rec = recover(crash);
  ok(rec.dirty && rec.body === "draft after the crash", rec.why);
  // Compaction: identical adjacent bodies collapse, and the last distinct version survives.
  let many = emptyJournal("doc-b");
  for (let i = 0; i < 60; i++) many = flush(many, many.revs[many.revs.length - 1]?.id ?? null, i < 30 ? "same" : `v${i}`, 2_000 + i).journal;
  ok(many.revs.length <= MAX_REVISIONS, `${many.revs.length} ≤ ${MAX_REVISIONS}`);
  const distinct = new Set(many.revs.map((r) => r.digest)).size;
  ok(distinct >= 2, `${distinct} distinct bodies survive compaction`);
  ok(previousDistinct(many) !== null, "a previous version is still offered");
  throws(() => schedule(many, "x".repeat(MAX_BODY_BYTES + 1), 9_000), /journals at most/, "oversize body refused");
  ok(jdigest("abc") === jdigest("abc") && jdigest("abc") !== jdigest("abd"), "digest is stable and discriminating");
  ok(/revisions ·/.test(journalSummary(many)), journalSummary(many));
});

// ── PR-07p content filter ──────────────────────────────────────────────────
await test("PR-07p filter: a suffix rule cannot swallow a look-alike host, allow beats block at equal specificity, embeds are scoped separately, and malformed rules are reported not dropped", { "PR-07p": "full" }, () => {
  const parsed = parseRules([
    "block host ads.example # ads",
    "block host *.tracker.example category=tracking embeds",
    "allow host cdn.tracker.example",
    "block path *autoplay=1 category=media embeds",
    "block query utm_source category=tracking",
    "block host bad host name",
    "block bogus nope",
    "deny host elsewhere.example",
  ].join("\n"));
  ok(parsed.ok, "parse succeeded");
  if (!parsed.ok) return;
  ok(parsed.rejected.length === 3, `three malformed lines reported: ${JSON.stringify(parsed.rejected.map((r) => r.why))}`);
  const rules = parsed.rules;
  const blocked = decideFilter(rules, "https://ads.example/pixel.gif", { kind: "navigate" });
  ok(blocked.effect === "block" && blocked.rule?.id === "r1", blocked.why);
  eq(decideFilter(rules, "https://x.tracker.example/y", { kind: "embed" }).rule?.category, "tracking", "a declared category is carried");
  // The look-alike host is the over-blocking failure: `example` must not match `notexample`.
  eq(decideFilter(rules, "https://notads.example/x", { kind: "navigate" }).effect, "allow", "look-alike host allowed");
  // Strict wildcard: `*.tracker.example` matches one label, not two.
  eq(decideFilter(rules, "https://a.b.tracker.example/x", { kind: "navigate" }).effect, "allow", "two labels not matched by *.");
  eq(decideFilter(rules, "https://a.tracker.example/x", { kind: "navigate" }).effect, "block", "one label matched");
  // An allow at the same specificity wins.
  eq(decideFilter(rules, "https://cdn.tracker.example/x", { kind: "navigate" }).effect, "allow", "allow wins");
  // Embed scope: a path rule with `embeds` applies, the host rule without it does not.
  eq(decideFilter(rules, "https://ads.example/x", { kind: "embed" }).effect, "allow", "host rule without embeds does not apply to embeds");
  const embed = decideFilter(rules, "https://player.example/v?autoplay=1", { kind: "embed" });
  ok(embed.effect === "block" && embed.rule?.scope === "path", embed.why);
  // Query scope, and a scheme that is not fetched at all.
  eq(decideFilter(rules, "https://shop.example/p?utm_source=x", { kind: "navigate" }).effect, "block", "query rule");
  eq(decideFilter(rules, "javascript:alert(1)", { kind: "navigate" }).effect, "allow", "javascript: is not fetched by the reader");
  eq(decideFilter(rules, "not a url", { kind: "navigate" }).effect, "allow", "unparseable url");
  ok(/block · .* allow · .* categories · 3 rejected/.test(filterReport(parsed)), filterReport(parsed));
  ok(FILTER_LIMITS.some((l) => l.includes("cross-origin iframe")), "iframe limit stated");
});

// ── FM-14 drop claim ───────────────────────────────────────────────────────
await test("FM-14 drop: a real download wins, a browser without DownloadURL gets an explicit button, a hidden tab and a 51-file drop are refused, and a file drop never pretends to carry text", { "FM-14": "full" }, () => {
  const dl = planOutbound({ name: "report.pdf", mime: "application/pdf", bytes: 2048, canBlob: true, downloadUrl: true, sameOrigin: false });
  ok(dl.kind === "download" && /download/.test(dl.sentence), dl.sentence);
  const noDl = planOutbound({ name: "report.pdf", mime: "application/pdf", bytes: 2048, canBlob: true, downloadUrl: false, sameOrigin: false });
  ok(noDl.kind === "handoff" && noDl.badge === "use Download", noDl.sentence);
  eq(planOutbound({ name: "x", mime: "text/plain", bytes: 3, canBlob: false, downloadUrl: false, sameOrigin: false, readOnly: true }).kind, "refuse", "read-only refuses");
  eq(planOutbound({ name: "bad/name", mime: "text/plain", bytes: 3, canBlob: true, downloadUrl: true, sameOrigin: true }).kind, "refuse", "illegal filename refuses");
  eq(planOutbound({ name: "a.bin", mime: "application/octet-stream", bytes: 3, canBlob: false, downloadUrl: false, sameOrigin: true }).kind, "refuse", "a binary with no blob refuses");
  eq(planOutbound({ name: "a.txt", mime: "text/plain", bytes: 3, canBlob: false, downloadUrl: false, sameOrigin: false }).kind, "refuse", "text with no blob and no same-origin target refuses");
  ok(planOutbound({ name: "link", mime: "text/uri-list", bytes: 0, canBlob: false, downloadUrl: false, sameOrigin: true }).kind === "copy", "uri-list copies");
  eq(planInbound({ types: [], fileCount: 1, largestBytes: 10, textLength: 0, visible: false, accepts: ["files"] }).kind, "refuse", "hidden tab refuses");
  eq(planInbound({ types: [], fileCount: 0, largestBytes: null, textLength: 0, visible: true, accepts: ["files"] }).kind, "refuse", "empty datatransfer refuses");
  const tooMany = planInbound({ types: ["Files"], fileCount: MAX_DROP_ITEMS + 1, largestBytes: 10, textLength: 0, visible: true, accepts: ["files"] });
  ok(tooMany.kind === "refuse" && tooMany.sentence.includes(String(MAX_DROP_ITEMS)), tooMany.sentence);
  const files = planInbound({ types: ["Files"], fileCount: 3, largestBytes: 10, textLength: 0, visible: true, accepts: ["files"] });
  ok(files.kind === "files" && files.count === 3 && !/text/.test(files.sentence), files.sentence);
  eq(planInbound({ types: ["Files"], fileCount: 1, largestBytes: 10, textLength: 0, visible: true, accepts: [] }).kind, "refuse", "surface with no file acceptance refuses");
  eq(planInbound({ types: ["text/plain"], fileCount: 0, largestBytes: null, textLength: 12, visible: true, accepts: [] }).kind, "text", "text");
  eq(planInbound({ types: ["text/uri-list"], fileCount: 0, largestBytes: null, textLength: 0, visible: true, accepts: [] }).kind, "url", "url");
  ok(DROP_LIMITS.some((l) => l.includes("string types are empty")), "the files/text distinction is stated");
});

// ── ST-03 handler claim ────────────────────────────────────────────────────
await test("ST-03 handlers: two %s placeholders are refused, a scheme outside web+ needs to be browser-known, a resolved call is only 'offered', and no state ever prints 'default'", { "ST-03": "full" }, () => {
  ok(checkScheme("mailto").ok && checkScheme("web+fusion").ok, "known and web+ schemes accepted");
  ok(!checkScheme("web+").ok && !checkScheme("ftp").ok && !checkScheme("1mail").ok, "invalid schemes refused");
  ok(checkTemplate("/compose?to=%s", "https://app.example").ok, "same-origin template");
  ok(!checkTemplate("/compose?to=%s&cc=%s", "https://app.example").ok, "two placeholders refused");
  ok(!checkTemplate("https://evil.example/x?to=%s", "https://app.example").ok, "cross-origin template refused");
  ok(!checkTemplate("/compose", "https://app.example").ok, "no placeholder refused");
  const probe = { registerApi: true, launchQueueApi: true, now: 5_000 };
  const offered: HandlerClaim = offer("mailto", "/compose?to=%s", "https://app.example", probe, true);
  ok(offered.state === "offered" && /does not report/.test(offered.evidence), offered.evidence);
  eq(offer("mailto", "/compose?to=%s", "https://app.example", probe, false).state, "unknown", "rejected call is not registered");
  eq(offer("mailto", "/compose?to=%s", "https://app.example", { ...probe, registerApi: false }, false).state, "unsupported", "absent API");
  const launched = observeLaunch(offered, { ...probe, launchedSchemes: ["mailto"] });
  ok(launched.state === "pending" && /at least once/.test(launched.evidence), launched.evidence);
  ok(observeLaunch(offered, { ...probe, launchedSchemes: ["tel"] }).state === "offered", "a launch for another scheme proves nothing about this one");
  for (const state of ["unsupported", "offered", "pending", "unknown"] as const) {
    const text = displayState({ ...offered, state });
    // The word may appear only to say it cannot be read. "is the default"/"set as
    // default" are the claims that must never be reachable.
    ok(!/is the default|set as default|you are the default/.test(text), `“${text}” must not claim the default setting`);
    if (/default/.test(text)) ok(/cannot read|does not report/.test(text), `“${text}” mentions the default only as unobservable`);
  }
  throws(() => offer("ftp", "/x?to=%s", "https://app.example", probe, true), /web\+/, "ftp refused");
  ok(guideFor("Linux").some((s) => s.includes("xdg-settings")), "Linux guide has the real command");
  ok(guideFor("BeOS")[0].includes("no recorded steps"), "unknown platform is honest");
  ok(/launchQueue present/.test(probeSummary(probe)), probeSummary(probe));
  ok(MAX_HANDLERS === 20, "handler cap");
});

// ── IN-04 shortcut latch ───────────────────────────────────────────────────
await test("IN-04 chords: a bare printable key and an OS-reserved chord are refused, a held chord latches and advances, Escape cancels, and focus loss cannot leave a modifier stuck", { "IN-04": "full" }, () => {
  throws(() => makeChord("switcher", [], "k"), /would swallow/, "no modifier refused");
  throws(() => makeChord("switcher", ["ctrl"], "Control"), /is a modifier/, "modifier-only refused");
  const chords = register([], makeChord("switcher", ["alt"], "Tab")).chords;
  throws(() => register(chords, makeChord("other", ["alt"], "tab")), /already bound/, "duplicate chord refused");
  throws(() => makeChord("close", ["ctrl"], "w"), /cannot be registered/, "Ctrl+W refused as reserved");
  throws(() => makeChord("quit", ["meta"], "q"), /OS quits/, "Meta+Q refused");
  const field = makeChord("save", ["ctrl"], "s", "field");
  const appOnly = makeChord("switcher2", ["alt"], "s");
  const open = keydown(null, [field, ...chords, appOnly], { key: "s", ctrl: true, alt: false, shift: false, meta: false, repeat: false, inField: true });
  ok(open.action === "open" && open.latch?.chord.id === "save", "a field-scoped chord fires inside a text field");
  const refused = keydown(null, [appOnly], { key: "s", ctrl: false, alt: true, shift: false, meta: false, repeat: false, inField: true });
  ok(refused.action === "ignore" && /text field/.test(refused.note), refused.note);
  let latch = keydown(null, chords, { key: "Tab", ctrl: false, alt: true, shift: false, meta: false, repeat: false, inField: false }).latch;
  ok(latch !== null, "latch opens");
  const advanced = keydown(latch, chords, { key: "Tab", ctrl: false, alt: true, shift: false, meta: false, repeat: true, inField: false });
  ok(advanced.action === "advance" && advanced.latch!.presses === 2, "repeat advances");
  const committed = release(advanced.latch);
  ok(committed.commit && committed.chordId === "switcher" && /2 presses/.test(committed.note), committed.note);
  const cancelled = keydown(latch, chords, { key: "Escape", ctrl: false, alt: true, shift: false, meta: false, repeat: false, inField: false });
  ok(cancelled.action === "cancel" && release(cancelled.latch).commit === false, "escape cancels and commits nothing");
  const releasedMod = keydown(latch, chords, { key: "Tab", ctrl: false, alt: false, shift: false, meta: false, repeat: false, inField: false });
  ok(releasedMod.latch === null && /released/.test(releasedMod.note), releasedMod.note);
  ok(blur().latch === null, "blur closes the latch");
  ok(/cannot register a system-wide hotkey/.test(limitsSentence()), limitsSentence());
  ok(RESERVED.some((r) => r.label === "Ctrl+W"), "reserved list is data, not prose");
  void (null as Latch | null);
});

// ── HW-05 audio quantum ────────────────────────────────────────────────────
await test("HW-05 audio: a convolver overruns an interactive budget and is refused, a suspended context reports nothing measured, drift beyond a quantum is a failure, and 44.1→48 kHz is exact enough", { "HW-05": "full" }, () => {
  const light: Graph = { nodes: [{ kind: "gain", latencyFrames: 0, costUs: 120 }, { kind: "limiter", latencyFrames: 128, costUs: 900 }], sampleRate: 48000, budgetUs: 2000 };
  const okPlan = estimate(light);
  ok(okPlan.ok && Math.abs(okPlan.declaredDelayMs - (128 / 48000) * 1000) < 1e-9, okPlan.why);
  ok(Math.abs(okPlan.quantumMs - (QUANTUM_FRAMES / 48000) * 1000) < 1e-12, "quantum arithmetic");
  const heavy: Graph = { ...light, nodes: [...light.nodes, { kind: "convolver", latencyFrames: 1024, costUs: 4000 }] };
  const bad = estimate(heavy);
  ok(!bad.ok && /exceeds the .* budget/.test(bad.why), bad.why);
  throws(() => estimate({ ...light, sampleRate: 12345 }), /not one of the rates/, "unsupported rate refused");
  ok(resample(44100, 48000).ok, "44.1→48 is exact to sub-sample");
  ok(!resample(44100, 47999).ok || resample(44100, 47999).errorSamplesPerMinute < 1, "adjacent rate either exact or reported");
  const suspended = audioReport({ state: "suspended", sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02, worklet: true });
  ok(suspended.verdict === "not-running" && suspended.measuredTotalMs === null, suspended.sentence);
  const running = audioReport({ state: "running", sampleRate: 48000, baseLatency: 0.01, outputLatency: 0.02, worklet: true });
  ok(running.verdict === "measured" && Math.abs(running.measuredTotalMs! - 30) < 1e-6, running.sentence);
  const unknown = audioReport({ state: "running", sampleRate: 48000, baseLatency: 0.01, outputLatency: null, worklet: false });
  ok(unknown.verdict === "unmeasured" && unknown.measuredTotalMs === null, "a null field is never read as zero");
  const d = drift([0, 16, 32, 48], 16);
  ok(d.ok, d.why);
  ok(!drift([0, 40, 80], 16).ok, "40 ms against 16 ms is a stutter");
  throws(() => drift([1], 16), /at least two ticks/, "one tick refused");
});

// ── RC-15 exclusions ───────────────────────────────────────────────────────
await test("RC-15 exclusions: a bank host stops a capture, query tokens are redacted in the address, and redaction is closed under concatenation so a split token is still caught", { "RC-15": "full" }, () => {
  const parsed = parseExclusions([
    "host bank.example",
    "path /account/*",
    'title "Online Banking"',
    "param sessionid",
    "literal 4111",
    "literal ab",
    "nonsense host x.example",
  ].join("\n"));
  ok(parsed.rejected.length === 2, `two rejections: ${JSON.stringify(parsed.rejected)}`);
  const r = parsed.rules;
  ok(!mayCapture(r, { url: "https://bank.example/pay", title: "x" }).allowed, "host rule stops the capture");
  ok(!mayCapture(r, { url: "https://shop.example/account/settings" }).allowed, "path rule stops the capture");
  ok(!mayCapture(r, { url: "https://shop.example/x", title: "Welcome to Online Banking" }).allowed, "title rule stops the capture");
  ok(mayCapture(r, { url: "https://shop.example/list", title: "Shop" }).allowed, "an unrelated page is allowed");
  ok(!mayCapture(r, { url: "" }).allowed, "an unparseable address is refused");
  // Redaction in an address: the value is replaced and the fragment is dropped entirely.
  const url = redactUrl(r, "https://shop.example/p?sessionid=SECRET&keep=1#token=abc");
  ok(url.includes(REDACTED) && !url.includes("SECRET") && !url.includes("#token"), `redacted marker must survive encoding: ${url}`);
  ok(url.includes("keep=1"), "other parameters survive");
  // Closed under concatenation: a token split across two label parts is still caught.
  const parts = ["prefix longhex ", "0123456789abcdef0123456789abcdef", " suffix"];
  const redacted = redactAll(r, parts);
  ok(!redacted.join("").includes("0123456789abcdef0123456789abcdef"), `split token caught: ${JSON.stringify(redacted)}`);
  ok(redacted[1] === REDACTED, "the token part itself is replaced");
  ok(redactText(r, "card 4111 1111").includes(REDACTED), "literals apply");
  ok(redactText(r, "an ordinary sentence about the weather") === "an ordinary sentence about the weather", "ordinary prose is untouched");
  // A JWT and a GitHub token are structural shapes, not just literals.
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij";
  ok(redactText(NO_EXCLUSIONS, jwt) === REDACTED, "JWT shape redacted");
  ok(redactText(NO_EXCLUSIONS, "ghp_0123456789abcdefghijKLMNOPqrstuv") === REDACTED, "github token shape redacted");
  ok(MAX_EXCL === 500, "rule cap");
  ok(NO_EXCLUSIONS.queryParams.includes("token"), "the default parameter list is not empty");
});

// ── FM-08 volumes ──────────────────────────────────────────────────────────
await test("FM-08 volumes: an unplugged directory reads as partial, not empty; a lapsed grant is listed but marked; a snapshot is read-only; a quota is never called free disk", { "FM-08": "full" }, () => {
  const partial = listing(["a.txt", "b.txt"], "NotFoundError", "granted", "directory");
  ok(partial.kind === "partial" && /not the whole folder/.test(partial.sentence), partial.sentence);
  const empty = listing([], null, "granted", "directory");
  ok(empty.kind === "complete" && /folder is empty \(the handle was readable/.test(empty.sentence), empty.sentence);
  eq(listing([], null, "prompt", "directory").kind, "refused", "lapsed permission refuses");
  eq(listing([], null, "denied", "directory").kind, "refused", "denied permission refuses");
  eq(listing(["x"], null, "granted", "snapshot").kind, "refused", "a snapshot has no directory");
  const base: Volume = { id: "vol-1", label: "Work USB", kind: "directory", permission: "granted", lastSeenAt: 1_000, entries: 12, lastError: null };
  eq(volumeHealth(base, 2_000).status, "ok", "healthy volume");
  eq(volumeHealth(withError(base, "NotFoundError"), 2_000).status, "broken", "a moved volume is broken, not gone");
  ok(/still on the device/.test(volumeHealth({ ...base, permission: "prompt" }, 2_000).why), "lapsed keeps the files");
  eq(volumeHealth(base, 40 * 86400000).status, "stale", "stale by age");
  eq(volumeHealth({ ...base, kind: "snapshot" }, 2_000).status, "read-only", "snapshot read-only");
  ok(/quota, not disk/.test(spaceSentence({ usage: 5e8, quota: 2e9 })), "quota vs disk");
  ok(/unknown, not as zero/.test(spaceSentence({ usage: null, quota: 2e9 })), "missing field is unknown");
  ok(/no storage estimate/.test(spaceSentence(null)), "absent estimate");
  throws(() => upsert([], { ...base, id: "/Volumes/Work" }), /not an OS path/, "an OS path is not an id");
  const added = upsert([], base);
  ok(added.list.length === 1 && /granted/.test(added.note), added.note);
  const replaced = upsert(added.list, { ...base, entries: 20, lastSeenAt: 5_000 });
  ok(replaced.list.length === 1 && replaced.list[0].entries === 20, "upsert replaces by id");
  let many: Volume[] = [];
  for (let i = 0; i < MAX_VOLUMES; i++) many = upsert(many, { ...base, id: `vol-${i}` }).list;
  throws(() => upsert(many, { ...base, id: "vol-extra" }), /is the limit/, "volume cap");
});

// ── HW-03 codecs ───────────────────────────────────────────────────────────
await test("HW-03 codecs: a bare family name is not turned into a profile, a mismatched profile is refused, 'maybe' keeps a fallback loaded, and an absent mediaCapabilities is unmeasured rather than guessed", { "HW-03": "full" }, () => {
  ok(mimeFor("mp4") === "video/mp4" && mimeFor(".WEBM") === "video/webm" && mimeFor("flv") === null, "container mapping");
  const bare = codecString({ container: "mp4", codec: "h264" });
  ok(bare.ok && bare.codec === "avc1", "bare family maps to the family prefix, not to a level");
  const full = codecString({ container: "mp4", codec: "hevc", profile: "hvc1.2.4.L120.B0" });
  ok(full.ok && full.codec === "hvc1.2.4.L120.B0", "explicit profile passes through");
  ok(!codecString({ container: "mp4", codec: "h264", profile: "hvc1.1.6.L93" }).ok, "a HEVC profile on an h264 family refused");
  ok(!codecString({ container: "mp4", codec: "h264", profile: "avc1" }).ok, "a bare family as a profile refused");
  ok(!codecString({ container: "flv", codec: "h264" }).ok, "unknown container refused");
  ok(!codecString({ container: "mp4", codec: "theora" }).ok, "unknown codec refused");
  eq(judge("probably"), "probably"); eq(judge("MAYBE"), "maybe"); eq(judge(""), "no"); eq(judge("garbage"), "no");
  const maybe = planRendition({ name: "720p", spec: { container: "webm", codec: "vp9" }, answer: "maybe", efficiency: "unmeasured" });
  ok(maybe.action === "play-with-fallback" && /lower rendition stays loaded/.test(maybe.sentence), maybe.sentence);
  const none = planRendition({ name: "4k", spec: { container: "mp4", codec: "av1" }, answer: "", efficiency: "unmeasured" });
  ok(none.action === "transcode" && none.support === "no", none.sentence);
  const refused = planRendition({ name: "x", spec: { container: "flv", codec: "h264" }, answer: "probably", efficiency: "unmeasured" });
  ok(refused.action === "refuse" && refused.sentence.startsWith("refused:"), refused.sentence);
  ok(efficiency(null).efficiency === "unmeasured" && /absent/.test(efficiency(null).sentence), "absent API is unmeasured");
  ok(efficiency({ supported: true, smooth: true, powerEfficient: true }).efficiency === "hardware-likely", "powerEfficient → hardware-likely");
  ok(efficiency({ supported: true, smooth: false, powerEfficient: true }).efficiency === "software-likely", "not smooth → software");
  ok(codecsParam(["avc1.640028", "avc1.640028"]).ok, "duplicates collapse");
  ok(!codecsParam([]).ok, "an empty codecs parameter is refused");
});

// ── CK-01 alarms ───────────────────────────────────────────────────────────
await test("CK-01 alarms: a weekly alarm with no days is refused, a closed window reports every missed occurrence, a backwards clock fires nothing, and a snooze cannot skip the next occurrence", { "CK-01": "full" }, () => {
  throws(() => makeAlarm("a1", "x", "07:00", "weekly", { days: [] }), /never fires/, "no days refused");
  throws(() => makeAlarm("a1", "x", "07:00", "weekdays", { days: [0, 6] }), /excludes Saturday and Sunday/, "weekend in weekdays refused");
  throws(() => makeAlarm("a1", "x", "25:00", "daily"), /24-hour/, "bad time refused");
  throws(() => makeAlarm("a1", "x", "07:00", "once"), /YYYY-MM-DD/, "once needs a date");
  const daily = makeAlarm("a1", "Morning", "07:00", "daily");
  const since = Date.UTC(2026, 0, 1, 0, 0);
  const now = Date.UTC(2026, 0, 3, 12, 0);
  const times = occurrencesBetween(daily, since, now, utcParts);
  eq(times.length, 3, "three 07:00 occurrences in 2.5 days");
  ok(times.every((t) => utcParts(t).h === 7 && utcParts(t).min === 0), "all at 07:00");
  const ev = evaluate(daily, since, now, utcParts);
  ok(ev.outcome === "due" && ev.due.length === 3 && ev.missed === 2, ev.sentence);
  ok(/missed/.test(ev.sentence), ev.sentence);
  const back = evaluate(daily, now, since, utcParts);
  ok(back.outcome === "clock-backwards" && back.due.length === 0, back.sentence);
  eq(evaluate({ ...daily, enabled: false }, since, now, utcParts).outcome, "disabled", "disabled");
  eq(evaluate({ ...daily, snoozedUntil: now + 60_000 }, since, now, utcParts).outcome, "snoozed", "snoozed");
  // Snooze past the next natural occurrence would skip it.
  const nearSix = Date.UTC(2026, 0, 4, 6, 30);
  const tooLong = 60;
  let snoozeErr = "";
  try { snooze(daily, nearSix, tooLong, utcParts); } catch (e) { snoozeErr = (e as Error).message; }
  ok(/would run past the next occurrence/.test(snoozeErr), snoozeErr);
  const fine = snooze(daily, nearSix, 10, utcParts);
  ok(fine.alarm.snoozedUntil === nearSix + 600000, fine.note);
  // A once alarm is spent after it fires; it is not resurrected by a reload.
  const once = makeAlarm("a2", "Renew", "09:00", "once", { date: "2026-01-02" });
  const fired = { ...once, lastFiredAt: Date.UTC(2026, 0, 2, 9, 0) };
  eq(evaluate(fired, since, now, utcParts).outcome, "spent", "once is spent");
  // Weekly on Wednesday only: exactly one occurrence in the window.
  const weekly = makeAlarm("a3", "Standup", "09:30", "weekly", { days: [3] });
  const w = occurrencesBetween(weekly, Date.UTC(2025, 11, 29, 0, 0), Date.UTC(2026, 0, 15, 0, 0), utcParts);
  ok(w.length >= 2 && w.every((t) => utcParts(t).dow === 3), `${w.length} Wednesdays`);
  ok(scheduleText(weekly).startsWith("Wed"), scheduleText(weekly));
  ok(/while this app is running/.test(deliverySentence()) && /closed page fires nothing/.test(deliverySentence()), deliverySentence());
});

// ── BK-05 backup health ────────────────────────────────────────────────────
await test("BK-05 health: a future-dated archive and an unknown status are unhealthy, a zero-file drill is vacuous, and the sampler is deterministic but spreads across the manifest", { "BK-05": "full" }, () => {
  const now = 1_800_000_000_000;
  eq(backupHealth(null, now).verdict, "never", "no record");
  eq(backupHealth({ writtenAt: now - 3600_000, verifiedAt: now - 3600_000, drilledAt: now - 3600_000, files: 100, drillRestored: 5, rawStatus: "weird" }, now).verdict, "unreadable", "unknown status");
  eq(backupHealth({ writtenAt: now + 3 * 86400000, verifiedAt: now, drilledAt: now, files: 1, drillRestored: 1, rawStatus: "ok" }, now).verdict, "unreadable", "future dated");
  eq(backupHealth({ writtenAt: now - 10 * 86400000, verifiedAt: now, drilledAt: now, files: 1, drillRestored: 1, rawStatus: "ok" }, now).verdict, "stale", "stale");
  eq(backupHealth({ writtenAt: now, verifiedAt: null, drilledAt: null, files: 1, drillRestored: 0, rawStatus: "ok" }, now).verdict, "unproven", "never verified");
  eq(backupHealth({ writtenAt: now, verifiedAt: now, drilledAt: null, files: 1, drillRestored: 0, rawStatus: "ok" }, now).verdict, "unproven", "never drilled");
  eq(backupHealth({ writtenAt: now, verifiedAt: now, drilledAt: now, files: 10, drillRestored: 0, rawStatus: "ok" }, now).verdict, "vacuous", "zero files restored");
  eq(backupHealth({ writtenAt: now, verifiedAt: now, drilledAt: now, files: 10, drillRestored: 11, rawStatus: "ok" }, now).verdict, "unreadable", "impossible counts");
  const healthy = backupHealth({ writtenAt: now, verifiedAt: now, drilledAt: now - 86400000, files: 400, drillRestored: 8, rawStatus: "ok" }, now);
  ok(healthy.verdict === "healthy" && healthy.drillDueInDays! > 28, healthy.sentence);
  const paths = Array.from({ length: 900 }, (_, i) => `dir/${i}/file.bin`);
  const a = drillSample(paths, 42), b = drillSample(paths, 42), c = drillSample(paths, 43);
  eq(a, b, "deterministic for a seed");
  ok(a.length >= SAMPLE_MIN && a.length <= 60, `${a.length} sampled`);
  ok(new Set(a).size === a.length, "no duplicates");
  ok(JSON.stringify(a) !== JSON.stringify(c), "a different seed samples differently");
  const spread = new Set(a.map((p) => p.split("/")[1]));
  ok(spread.size > 3, `sample spreads over ${spread.size} directories, not just the first N`);
  eq(drillSample([], 1), [], "empty manifest");
  ok(interpretDrill(0, 0, []).verdict === "vacuous", "vacuous drill");
  ok(interpretDrill(3, 4, []).verdict === "fail", "partial restore is a failure");
  ok(interpretDrill(4, 4, ["oops"]).verdict === "fail", "any error is a failure");
  ok(interpretDrill(4, 4, []).verdict === "pass", "a full read-back passes");
  ok(dueSentence(healthy).startsWith("a drill is due in"), dueSentence(healthy));
});

// ── BK-01 timeline ─────────────────────────────────────────────────────────
await test("BK-01 timeline: a broken ancestor chain fails verification, an edited manifest fails its root, and compaction keeps every ancestor of a retained snapshot", { "BK-01": "full" }, () => {
  const files = (n: number): FileEntry[] => Array.from({ length: n }, (_, i) => ({ path: `a/${i}.txt`, bytes: 10 + i, digest: i * 2654435761 % 4294967296 }));
  throws(() => snapshot("s1", null, 1, "k1", [{ path: "/abs", bytes: 1, digest: 1 }]), /not a relative path/, "absolute path refused");
  throws(() => snapshot("S1", null, 1, "k1", []), /lowercase id/, "an uppercase snapshot id is refused");
  throws(() => snapshot("s1", null, 1, "k1", [{ path: "a", bytes: 1, digest: 1 }, { path: "a", bytes: 2, digest: 2 }]), /duplicate path/, "duplicate path refused");
  const s1 = snapshot("s1", null, 1_000, "k1", files(3));
  const s2 = snapshot("s2", "s1", 2_000, "k1", files(4));
  const s3 = snapshot("s3", "s2", 3_000, "k1", files(5));
  const chain = [s1, s2, s3];
  const present = new Set(chain.flatMap((s) => s.chunks));
  const good = verify(chain, "s3", present);
  ok(good.ok && good.chain === "intact" && good.rootMatch, good.sentence);
  const gapped = verify([s1, s3], "s3", present);
  ok(!gapped.ok && gapped.chain === "gap" && /ancestor snapshot is missing/.test(gapped.sentence), gapped.sentence);
  const edited = { ...s3, root: s3.root ^ 1 };
  const rootBad = verify([s1, s2, edited], "s3", present);
  ok(!rootBad.ok && !rootBad.rootMatch && /edited after/.test(rootBad.sentence), rootBad.sentence);
  const missing = verify(chain, "s3", new Set([...present].filter((c) => c !== s3.chunks[0])));
  ok(!missing.ok && missing.missingChunks.length === 1, missing.sentence);
  ok(digestBytes(files(3)) === digestBytes([...files(3)].reverse()), "the root is order-independent");
  // Retention: 30 hourly snapshots, then compaction must not orphan a retained one.
  // 90 snapshots, three a day for 30 days: the hourly-around-now fixture from the
  // first draft fell entirely inside the daily window, so nothing was ever
  // droppable and the test proved nothing about compaction.
  const DAY = 86400000;
  const many = Array.from({ length: 90 }, (_, i) => snapshot(`s${i}`, i ? `s${i - 1}` : null, 1_000 + Math.floor(i / 3) * DAY + (i % 3) * 3600_000, "k1", files(2)));
  const nowTs = 1_000 + 31 * DAY;
  const kept = retain(many, nowTs, DEFAULT_KEEP);
  ok(kept.has("s0"), "the root is always retained");
  ok(kept.has("s89"), "the newest is always retained");
  ok(kept.size < many.length, `${kept.size} of ${many.length} snapshots retained`);
  const plan = compactPlan(many, nowTs, DEFAULT_KEEP);
  // A linear chain can only be tombstoned: the newest snapshot is retained, so every
  // ancestor is somebody's link. The test asserts that property rather than a number
  // that would only be true of a fixture.
  eq(plan.drop.length, 0, "a linear chain has nothing fully droppable");
  ok(plan.tombstone.length > 0, `${plan.tombstone.length} ancestors keep only their link`);
  // …and a branched chain, where an abandoned branch is an ancestor of nothing
  // retained, drops the whole branch.
  // The fork has to be old enough that its branches are outside the "keep the last
  // 24 / newest day" window, otherwise the abandoned branch is retained by recency and
  // this would assert nothing. So the fork is placed in the past, before the newest.
  const forkAt = 1_000 + 2 * DAY;
  const fork = snapshot("f0", "s5", forkAt, "k1", [{ path: "x", bytes: 1, digest: 1 }]);
  const branchA = snapshot("fa", "f0", forkAt + 3600_000, "k1", [{ path: "x", bytes: 1, digest: 1 }]);
  const branchB = snapshot("fb", "f0", forkAt + 7200_000, "k1", [{ path: "y", bytes: 1, digest: 2 }]);
  const branched = [...many, fork, branchA, branchB];
  const bPlan = compactPlan(branched, nowTs, DEFAULT_KEEP);
  // Both ends of the abandoned branch go, including its head: a branch that no
  // retained snapshot descends from is not a restore point, and keeping its head
  // "just in case" is how a backup set grows without ever being restorable.
  ok(bPlan.drop.includes("fa") && bPlan.drop.includes("fb"), `the abandoned branch is dropped: drop=${bPlan.drop.join(",")}`);
  ok(bPlan.keep.includes("s89") && !bPlan.drop.includes("s89"), "the live chain is untouched");
  ok(bPlan.freedChunks.length === bPlan.freedFiles, "branch chunks are freed with their records");
  ok(plan.freedFiles === (plan.drop.length + plan.tombstone.length) * 2, `${plan.freedFiles} file records freed`);
  ok(plan.freedChunks.length === plan.freedFiles, "every freed file record frees its chunk");
  // The property compaction must not break: every retained snapshot still reaches the
  // root through links that exist, whether or not those links carry a payload.
  const links = new Set<string>(many.map((s) => s.id));
  for (const id of plan.keep) {
    let cur = many.find((s) => s.id === id)?.parent ?? null;
    let guard = 0;
    while (cur && guard++ <= many.length) { ok(links.has(cur), `link ${cur} must survive for retained ${id}`); cur = many.find((s) => s.id === cur)?.parent ?? null; }
  }
  // A tombstoned snapshot is not a restore point, and says so rather than failing root validation.
  const tomb = verifyCompacted(many, plan.tombstone[0], present, new Set(plan.tombstone));
  ok(!tomb.ok && /compacted to a link/.test(tomb.sentence), tomb.sentence);
  const live = verifyCompacted(many, plan.keep[0], new Set(many.flatMap((s) => s.chunks)), new Set(plan.tombstone));
  ok(live.ok || /manifest does not match/.test(live.sentence), live.sentence);
  ok(plan.keep.every((id) => !plan.drop.includes(id)), "keep and drop are disjoint");
});

// ── FM-11 trash ────────────────────────────────────────────────────────────
await test("FM-11 trash: the sweep never empties the only copy of a digest, a re-trashed item gets double the window, a taken origin restores beside it, and the summary reports bytes still on the volume", { "FM-11": "full" }, () => {
  let t = emptyTrash(DEFAULT_RETENTION_DAYS);
  const now = 1_800_000_000_000;
  const oldFile = (id: string, copy: boolean, at: number) => ({ id, origin: `home/${id}.txt`, name: `${id}.txt`, bytes: 1_000, digest: 7, deletedAt: at, kind: "file" as const, copyElsewhere: copy });
  t = trash(t, oldFile("a", false, now - 40 * 86400000)).trash;
  t = trash(t, oldFile("b", true, now - 40 * 86400000)).trash;
  const sweep1 = sweep(t, now);
  eq(sweep1.remove.length, 1, "only the one with another copy is emptied");
  ok(sweep1.remove[0].item.id === "b" && /another live path/.test(sweep1.remove[0].why), sweep1.remove[0].why);
  ok(sweep1.keep.some((i) => i.id === "a"), "the only copy is kept whatever its age");
  ok(sweep1.freedBytes === 1_000, `freed ${sweep1.freedBytes}`);
  // A bounce doubles the window: 40 days is inside 60 for a re-trashed item.
  t = trash(t, oldFile("c", true, now - 50 * 86400000)).trash;
  t = trash(t, oldFile("c", true, now - 40 * 86400000)).trash;
  ok(t.items.find((i) => i.id === "c")!.bounces === 1, "bounce counted");
  ok(!sweep(t, now).remove.some((r) => r.item.id === "c"), "a bounced item inside the doubled window survives");
  // Restore into a taken origin.
  const aside = restore(t, "a", false);
  ok(aside.action === "restore-aside" && aside.path === "home/a.txt.restored1", aside.path);
  const plain = restore(t, "b", true);
  ok(plain.action === "restore" && plain.path === "home/b.txt", plain.path);
  eq(restore(t, "nope", true).action, "refuse", "unknown id");
  t = trash(t, oldFile("d", true, now)).trash;
  ok(/MB still on the volume/.test(trashSummary(t, now)), trashSummary(t, now));
  ok(trashSummary(emptyTrash(), now) === "the trash is empty", "empty sentence");
  throws(() => emptyTrash(0), /retention must be/, "retention floor");
  throws(() => trash(t, { ...oldFile("e", true, now), origin: "" }), /origin path/, "an item without an origin cannot be restored");
});

// ── WM-11 PiP placement ────────────────────────────────────────────────────
await test("WM-11 PiP: a request outside the usable range clamps to the content aspect, an oversized stylesheet clone is refused, an empty adoption produces nothing, and a hidden tab closes the window instead of keeping it", { "WM-11": "full" }, () => {
  const p = place({ w: 320, h: 900 }, { pip: true, styleBytes: 100_000 });
  ok(p.ok && p.width <= 1200 && p.height <= 900, `${p.width}×${p.height}`);
  ok(Math.abs(p.width / p.height - 16 / 9) < 0.05, `aspect preserved to within a rounding step: ${(p.width / p.height).toFixed(3)}`);
  ok(p.surface === "pip" && p.aboveOtherApps === false, "a PiP window is not above other apps");
  const big = place({ w: 5000, h: 5000 }, { pip: true, styleBytes: 100_000 });
  ok(big.width <= 1200 && big.height <= 900, "clamped to the max");
  const heavy = place({ w: 640, h: 360 }, { pip: true, styleBytes: STYLE_BYTE_BUDGET + 1 });
  ok(!heavy.ok && /exceeds the .* clone budget/.test(heavy.sentence), heavy.sentence);
  const fallback = place({ w: 640, h: 360 }, { pip: false, styleBytes: 1_000 });
  ok(fallback.surface === "floating" && /not always on top/.test(fallback.sentence), fallback.sentence);
  const fourThree = place({ w: 400, h: 400 }, { pip: true, styleBytes: 1_000, aspect: 4 / 3 });
  ok(Math.abs(fourThree.width / fourThree.height - 4 / 3) < 0.02, "4:3 honoured");
  const empty = adoptionPlan({ sheets: [], inline: [] });
  ok(!empty.ok && /unstyled/.test(empty.sentence), empty.sentence);
  const adoption = adoptionPlan({ sheets: [{ href: "https://app.example/a.css", bytes: 100_000 }], inline: [{ bytes: 20_000 }] });
  ok(adoption.ok && adoption.order[0].includes("inline") && adoption.totalBytes === 120_000, adoption.order.join(" | "));
  ok(closeBehaviour("tab-hidden").returnsToDesktop === false, "a hidden tab closes rather than returning content");
  ok(closeBehaviour("user-closed").returnsToDesktop, "a user close returns the content");
  ok(PIP_LIMITS.some((l) => l.includes("above other applications")), "limit stated");
});

// ── SM-07 Amazon Music summary ─────────────────────────────────────────────
await test("SM-07 Amazon Music: all twelve storefronts resolve with their own marketplace id, affiliate and utm parameters never survive, and a non-Amazon host is refused rather than guessed", { "SM-07": "full" }, () => {
  ok(STOREFRONTS.length === 12, "twelve storefronts");
  eq(new Set(STOREFRONTS.map((s) => s.marketplace)).size, 12, "twelve distinct marketplace ids");
  ok(storefrontFor("music.amazon.co.uk")?.tld === "co.uk", "longest tld wins over .uk and .com");
  ok(storefrontFor("music.amazon.com.au")?.locale === "en-AU", ".com.au");
  eq(storefrontFor("music.amazon.co"), null, "a tld that is not in the table is not mapped to one that is");
  eq(storefrontFor("amazon.com"), null, "the store is not the music service");
  const album = summarise("https://music.amazon.com/albums/B000000001?tag=affiliate-20&utm_source=x&ref=cm_sw_r");
  ok(album.kind === "album" && album.id === "B000000001" && album.storefront?.marketplace === "ATVPDKIKX0DER", album.sentence);
  ok(album.stripped.length === 3 && album.stripped.includes("tag"), JSON.stringify(album.stripped));
  ok(strippedClean(album.embedUrl!), album.embedUrl!);
  ok(!album.embedUrl!.includes("tag=") && !album.embedUrl!.includes("utm_"), "nothing survives into the embed");
  ok(album.confidence === "unverified" && /30-second preview/.test(album.sentence), album.sentence);
  const track = summarise("https://music.amazon.de/tracks/B000000002?trackAsin=B000000002");
  ok(track.kind === "track" && track.embedUrl!.includes("marketplaceId=A1PA6795UKMFR9"), track.embedUrl!);
  const playlist = summarise("https://music.amazon.co.jp/playlists/P.abc123");
  ok(playlist.kind === "playlist" && playlist.embedUrl!.includes("playlists/P.abc123"), playlist.embedUrl!);
  eq(summarise("https://open.spotify.com/album/x").confidence, "refused", "another service refused");
  eq(summarise("http://music.amazon.com/albums/B000000001").confidence, "refused", "insecure address refused");
  eq(summarise("https://music.amazon.com/").confidence, "refused", "store home is not embeddable");
  eq(summarise("nonsense").confidence, "refused", "not an address");
  ok(SM7_LIMITS.some((l) => l.includes("partner-only")), "API limit stated");
});

// ── RG-02 task budget ──────────────────────────────────────────────────────
await test("RG-02 budget: user-blocking slices are admitted before background ones, a non-resumable slice that does not fit is deferred whole, an overrun changes the next estimate, and an absent isInputPending is labelled a downgrade", { "RG-02": "full" }, () => {
  const m = emptyModel();
  const slices: Slice[] = [
    { id: "background-index", priority: "background", expectedMs: 10, resumable: true },
    { id: "keystroke", priority: "user-blocking", expectedMs: 2, resumable: false },
    { id: "paint-status", priority: "user-visible", expectedMs: 3, resumable: false },
  ];
  const frame = admit(slices, m);
  eq(frame.admitted[0].slice.id, "keystroke", "user-blocking runs first despite being listed last");
  ok(frame.budgetMs === FRAME_MS - RESERVE_MS, "the reserve is subtracted");
  // The background index does NOT fit (5 ms + 10 ms > 11.67 ms) and, being resumable,
  // it runs partially instead of being dropped: a run is not also a non-run.
  const partial = frame.admitted.find((a) => a.slice.id === "background-index");
  ok(partial !== undefined && partial.partial, frame.sentence);
  ok(Math.abs(partial!.grantedMs - (frame.budgetMs - 5)) < 1e-6, `granted ${partial!.grantedMs.toFixed(2)} ms of 10 ms`);
  ok(!frame.deferred.some((d) => d.slice.id === "background-index"), "a partially-run slice is not also deferred");
  // A frame with no room at all defers everything.
  const none = admit([{ id: "a", priority: "user-blocking", expectedMs: 20, resumable: false }, { id: "b", priority: "background", expectedMs: 2, resumable: true }], m);
  // A deferred slice does not cascade: the smaller background slice still runs, which
  // is what keeps one oversized task from starving the whole frame.
  ok(none.admitted.length === 1 && none.admitted[0].slice.id === "b" && none.deferred[0].slice.id === "a", none.sentence);
  // A non-resumable slice that does not fit is deferred whole.
  const tight = admit([{ id: "big", priority: "background", expectedMs: 12, resumable: false }], m);
  ok(tight.admitted.length === 0 && /does not fit/.test(tight.deferred[0].why), tight.deferred[0].why);
  // An overrun teaches the model, and the cost used is never lower than declared.
  const obs = observe(m, { id: "background-index", priority: "background", expectedMs: 2, resumable: true }, 9);
  ok(obs.overrun && obs.model.overruns.get("background-index") === 1, obs.sentence);
  ok(costOf(obs.model, { id: "background-index", priority: "background", expectedMs: 2, resumable: true }) > 2, "measured cost is used");
  ok(costOf(obs.model, { id: "unseen", priority: "background", expectedMs: 2, resumable: true }) === 2, "unknown slices use the declared cost");
  const under = observe(m, { id: "quick", priority: "background", expectedMs: 5, resumable: true }, 1);
  ok(!under.overrun && costOf(under.model, { id: "quick", priority: "background", expectedMs: 5, resumable: true }) >= 1, "a fast slice still keeps the worst of the two");
  // Yielding.
  ok(shouldYield({ elapsedMs: 1, budgetMs: 11, priority: "background", inputPending: true }).yield, "pending input yields");
  ok(!shouldYield({ elapsedMs: 1, budgetMs: 11, priority: "user-blocking", inputPending: true }).yield, "user-blocking does not yield to input");
  ok(shouldYield({ elapsedMs: 11, budgetMs: 11, priority: "background", inputPending: false }).yield, "budget exhausted");
  const downgrade = shouldYield({ elapsedMs: 1, budgetMs: 11, priority: "background", inputPending: null });
  ok(!downgrade.yield && /downgrade, not parity/.test(downgrade.why), downgrade.why);
  ok(iterationsPerSlice(0.001, 11) === 11_000 && iterationsPerSlice(100, 11) === 1, "at least one iteration always admitted");
  throws(() => observe(m, { id: "x", priority: "background", expectedMs: 1, resumable: false }, -1), /negative/, "negative cost refused");
});

// ── WM-06 lanes ────────────────────────────────────────────────────────────
await test("WM-06 broker: a blocking origin is probed once then remembered, silence is treated as blocked, a handoff is chosen for a running app, and only S1/S2/S3 claim to bring the other app in", { "WM-06": "full" }, () => {
  const b = emptyBroker();
  const first = decideLane(b, { origin: "https://frames.example/app", userHasApp: false, preferSplit: false });
  ok(first.lane === "S1" && first.needsProbe && first.fallback === "S3", first.why);
  ok(probeBudgetMs("S1") === 4000 && probeBudgetMs("S3") === 0, "probe budgets");
  const attempt: Attempt = { origin: "https://frames.example", lane: "S1", at: 1_000, outcome: null };
  const timedOut = observeLane(b, attempt, "timeout");
  ok(timedOut.lane === "S3" && /silence is not consent/.test(timedOut.sentence), timedOut.sentence);
  ok(timedOut.broker.blocked.has("https://frames.example"), "the attempt is remembered by origin, not by path");
  const second = decideLane(timedOut.broker, { origin: "https://frames.example/x", userHasApp: false, preferSplit: false });
  ok(second.lane === "S3" && /will not retry|refused framing earlier/.test(second.why), second.why);
  const painted = observeLane(emptyBroker(), attempt, "painted");
  ok(painted.lane === "S1" && painted.broker.blocked.size === 0, painted.sentence);
  ok(decideLane(emptyBroker(), { origin: "https://x.example", userHasApp: true, preferSplit: false }).lane === "S4", "a running app goes to PiP");
  ok(decideLane(emptyBroker(), { origin: "https://x.example", userHasApp: false, preferSplit: true }).lane === "S2", "split on request");
  ok(decideLane(emptyBroker(), { origin: "not a url", userHasApp: false, preferSplit: false }).lane === "S3", "unparseable origin");
  const split = splitInstruction(900, 1600);
  ok(split.width === 800 && /placed by you/.test(split.instruction), split.instruction);
  const m = matrix();
  ok(m.find((r) => r.lane === "S4")!.bringsOtherApp === false, "PiP brings nothing foreign in");
  ok(m.filter((r) => r.bringsOtherApp).length === 3, "three lanes genuinely bring the other app");
  const retro = observeLane(timedOut.broker, { ...attempt, at: 900 }, "painted");
  ok(retro.lane === "S3" && retro.broker.blocked.has("https://frames.example"), "a blocked origin is not retro-painted by a later pass");
});

// ── CT-03 handoff claim ────────────────────────────────────────────────────
await test("CT-03 handoff: only a connected same-origin channel is called live, a fragment is a link the user carries, an over-budget fragment is impossible rather than truncated, and a fragment can never be presented as live", { "CT-03": "full" }, () => {
  const live = classify({ sameOrigin: true, receiverOpen: true, channel: true, urlFragment: false, bytes: 20_000 });
  ok(live.mechanism === "live" && live.userAction === "none", live.sentence);
  const linked = classify({ sameOrigin: true, receiverOpen: false, channel: false, urlFragment: true, bytes: 3_000 });
  ok(linked.mechanism === "linked" && linked.userAction === "copy a link", linked.sentence);
  const huge = classify({ sameOrigin: false, receiverOpen: false, channel: false, urlFragment: true, bytes: FRAGMENT_LIMIT + 1 });
  ok(huge.mechanism === "impossible" && /never truncate/.test(huge.sentence), huge.sentence);
  const exported = classify({ sameOrigin: false, receiverOpen: false, channel: false, urlFragment: false, bytes: 10 });
  ok(exported.mechanism === "exported", exported.sentence);
  const bigFile = classify({ sameOrigin: true, receiverOpen: true, channel: true, urlFragment: false, bytes: LIVE_LIMIT + 1 });
  ok(bigFile.mechanism === "exported" && /not a transfer/.test(bigFile.sentence), bigFile.sentence);
  throws(() => assertMechanism(linked, "live"), /cannot present linked as live/, "a link cannot be advertised as live");
  ok(assertMechanism(live, "live").mechanism === "live", "a real live handoff passes its own assertion");
  const expired = expiryNote(1_000, 1_000 + 25 * 3600_000);
  ok(expired.expired && /ask for a fresh one/.test(expired.sentence), expired.sentence);
  ok(!expiryNote(1_000, 1_000 + 3600_000).expired, "fresh link is valid");
  ok(HANDOFF_LIMITS.some((l) => l.includes("two devices cannot be connected live")), "the cross-device refusal is stated");
});

// ── AU-01 routines ─────────────────────────────────────────────────────────
await test("AU-01 routines: an action outside the closed vocabulary is refused at construction, a rehearsal and a run produce the same plan but only one is executable, and their audit entries differ", { "AU-01": "full" }, () => {
  // The function takes `Action`, so `as never` would be a type-safety hole *and* the
  // compiler would erase the check; a wire payload is `unknown` and is validated.
  ok(!checkAction({ kind: "run-shell", text: "rm -rf /" } as never).ok, "a shell action is refused, not cast away");
  ok(!checkAction({ kind: "open", module: "notamodule" }).ok, "unknown module refused");
  ok(!checkAction({ kind: "open" }).ok, "open without a module refused");
  ok(!checkAction({ kind: "notify", text: "" }).ok, "empty notify refused");
  ok(!checkAction({ kind: "set-theme", value: "purple" }).ok, "unknown theme refused");
  ok(!checkAction({ kind: "focus-workspace", value: "10" }).ok, "workspace 10 refused");
  ok(checkAction({ kind: "lock" }).ok, "lock is in the vocabulary");
  const r = makeRoutine("morning", "Morning", { kind: "interval", everyMs: 3_600_000 }, [{ kind: "open", module: "notes" }, { kind: "notify", text: "stand up" }]);
  ok(r.rehearsedAt === null && r.enabled, "a new routine is unrehearsed");
  throws(() => makeRoutine("r1", "No actions", { kind: "manual" }, []), /no actions/, "empty routine refused");
  throws(() => makeRoutine("r2", "Too fast", { kind: "interval", everyMs: 1_000 }, [{ kind: "lock" }]), /below the .* floor/, "sub-minute interval refused");
  throws(() => makeRoutine("r3", "Bad time", { kind: "time-of-day", at: "7am" }, [{ kind: "lock" }]), /24-hour/, "bad time refused");
  throws(() => makeRoutine("BAD ID", "x", { kind: "manual" }, [{ kind: "lock" }]), /lowercase id/, "a non-id is refused");
  const dry = plan(r, true, 1_000);
  const real = plan(r, false, 1_000);
  eq(dry.effects.map((e) => e.effect), real.effects.map((e) => e.effect), "a rehearsal describes exactly what a run would do");
  ok(dry.effects.length === 2 && dry.unknowns.some((u) => /tab that is asleep/.test(u)), dry.unknowns.join(" | "));
  const run = execute(real, (a) => a.kind);
  eq(run.performed, ["open", "notify"], "a real plan executes");
  const refused = execute(dry, (a) => a.kind);
  ok(refused.performed.length === 0 && refused.refused !== null, refused.refused!);
  eq(auditEntry(dry, 2_000).action, "routine.dryrun", "rehearsal audit entry");
  eq(auditEntry(real, 2_000).action, "routine.run", "run audit entry");
  ok(auditEntry(real, 2_000).detail.includes("ran"), auditEntry(real, 2_000).detail);
  const imported = importRoutine({ id: "shared", name: "Shared", trigger: { kind: "manual" }, actions: [{ kind: "lock" }, { kind: "exec", cmd: "x" }] });
  ok(imported.routine !== null && imported.rejected.length === 1 && /not an action/.test(imported.rejected[0]), imported.rejected.join(" | "));
  eq(importRoutine({ id: "x", name: "y", trigger: { kind: "manual" }, actions: [{ kind: "evil" }] }).routine, null, "a routine with no valid action is refused");
  ok(importRoutine("nope").routine === null, "a non-object is refused");
  ok(MAX_ACTIONS === 40 && MIN_INTERVAL_MS === 60_000, "caps are constants a test can cite");
  ok(ROUTINE_LIMITS.some((l) => l.includes("vocabulary is closed")), "limit stated");
});

await finish();
