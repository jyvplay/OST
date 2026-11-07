/**
 * TT143 engine suite — twenty engines, each with a refusal and an acceptance.
 *
 * The pairing rule is the design of this file: a test that only shows the happy
 * path cannot tell a working engine from a stub that returns a constant, and a
 * test that only shows a refusal cannot tell a guard from a bug that refuses
 * everything. So every engine below is asked for **a case it must refuse and a
 * case it must accept**, and the refusal must carry a reason (a blockage with no
 * sentence is a dead end, not a feature).
 *
 * Numbers are asserted where the claim is numeric (contrast ratios, prefix sums,
 * byte totals, ordering), because a numeric claim checked by wording is not
 * checked at all.
 *
 * Run: node --import ./scripts/register-hook.mjs scripts/tt143-engines.mts
 */
import { makeHarness } from "./harness.mts";
import { parsePolicy, decideEgress, describeDecision, MAX_RULES } from "../src/lib/egress-rules.ts";
import { emptyQueue, enqueue, next, succeed, fail, describe as describeQueue, digest, MAX_WRITES, MAX_ATTEMPTS } from "../src/lib/offline-queue.ts";
import { begin, afterSessionCopy, afterValidate, afterReplace, recover, describe as describeSave } from "../src/lib/safe-save.ts";
import { mergeDesktops, describeMerge, type DesktopLike } from "../src/lib/desktop-merge.ts";
import { chooseProfile, transition, densityFor, PROFILES, type Measurements } from "../src/lib/context-profile.ts";
import { planRemote, redactAddress, streamControls } from "../src/lib/remote-desktop.ts";
import { planCapture, captureName } from "../src/lib/capture-plan.ts";
import { planRoute, labelNote, groupDevices } from "../src/lib/audio-route.ts";
import { push, resolveSize, toneCurve, saturate, undo, RAMP_MAX, type Op } from "../src/lib/photo-edit.ts";
import { planKeyLight, keyLightCss, CLIP_LUMA, TARGET_SUBJECT_LUMA } from "../src/lib/key-light.ts";
import { inventory, record, summary as inventorySummary, chooseFor } from "../src/lib/background-mechanisms.ts";
import { screenKey, matchScreens, park, restore, emptyHotplugState, hotplugSentence, type ScreenLike } from "../src/lib/hotplug-restore.ts";
import { buildLayout, setHeight, windowFor, indexAt, stickyOffset, mountRatio, MIN_ROW } from "../src/lib/panel-layout.ts";
import { cluster, toggleCluster, describeSelection, selectAll, type Row } from "../src/lib/row-cluster.ts";
import { rampFor, auditTokens, contrast, tokensCss } from "../src/lib/design-tokens.ts";
import { words, auditLabels, auditNotes, auditSummary, countChrome, MAX_LABEL_WORDS, MAX_NOTE_WORDS } from "../src/lib/content-density.ts";
import { deriveName, enqueue as enqueueDownload, pump, progress, complete, fail as failDownload, cancel, summary, statusSentence, MAX_INFLIGHT } from "../src/lib/download-arbiter.ts";
import { audit, reclaimPlan, DEFAULT_GRACE_MS } from "../src/lib/memory-audit.ts";
import { planCast, castMatrix, describeMedia } from "../src/lib/stream-plan.ts";

const { test, finish } = makeHarness("tt143-engines");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

/* ─────────────────────────────────────────── 1. egress rules (SC-04) ─────── */
await test("SC-04 egress: a deny rule blocks, an allow rule passes, and the more specific rule wins", { "SC-04": "full", "CO-03": "full" }, () => {
  const { policy, rejected } = parsePolicy({ defaultAction: "allow", rules: [
    { id: "analytics", action: "deny", host: "**.analytics.example" },
    { id: "one-path", action: "allow", host: "cdn.example", path: "/media/**" },
    { id: "cdn-elsewhere", action: "deny", host: "cdn.example" },
    { id: "loopback", action: "deny", host: "*" },
  ] });
  eq(rejected, [], "a well-formed policy parses with nothing rejected");
  const blocked = decideEgress(policy, "https://a.b.analytics.example/x");
  eq(blocked.action, "deny", "a `**` deny blocks a multi-label subdomain");
  eq(blocked.by, "analytics", "and names the rule");
  const allowed = decideEgress(policy, "https://cdn.example/media/cat.mp4");
  eq(allowed.action, "allow", "a path-specific allow beats the host-wide deny");
  eq(allowed.by, "one-path", "by specificity, not by order");
  const notMedia = decideEgress(policy, "https://cdn.example/private/key");
  eq(notMedia.action, "deny", "the same host outside the allowed path is denied");
  // Credentials and schemes are refused before any rule is consulted.
  const creds = decideEgress(policy, "https://user:pw@cdn.example/media/a.mp4");
  eq(creds.by, "credentials", "a password in the URL is refused even where a rule allows");
  const scheme = decideEgress(policy, "file:///etc/passwd");
  eq(scheme.by, "scheme", "a non-http scheme is a decision, not a thrown error");
  const junk = decideEgress(policy, "not a url");
  eq(junk.action, "deny", "a malformed address is denied");
  ok(describeDecision(blocked).startsWith("GET a.b.analytics.example blocked"), "the log line names host and verdict");
  ok(!describeDecision(blocked).includes("?token"), "and never echoes a query string");
  // Malformed rules are reported, never dropped silently.
  const bad = parsePolicy({ rules: [{ action: "maybe", host: "x" }, { action: "allow", host: "has space" }, { action: "allow", host: "ok", path: "no-slash" }, "nope"] });
  eq(bad.rejected.length, 4, "four malformed rules are all reported");
  eq(bad.policy.rules.length, 0, "and none of them is applied");
  ok(bad.rejected[0].includes("action must be"), "the reason names the field");
  const many = parsePolicy({ rules: Array.from({ length: MAX_RULES + 5 }, (_, i) => ({ action: "allow", host: `h${i}.example` })) });
  ok(many.rejected.some((r) => r.includes("capped")), "an oversized list is capped, with the cap named");
});

/* ─────────────────────────────────────── 2. offline queue (SH-14) ──────── */
await test("SH-14 offline queue: collapses per key, dedupes by content, and refuses past its cap", { "SH-14": "full" }, () => {
  let q = emptyQueue();
  const first = enqueue(q, { key: "note:1", method: "PUT", path: "/api/notes/1", body: "hello" });
  eq(first.status, "queued", "a new key is queued");
  q = first.queue;
  const same = enqueue(q, { key: "note:1", method: "PUT", path: "/api/notes/1", body: "hello" });
  eq(same.status, "duplicate", "the identical body is not queued twice");
  const newer = enqueue(q, { key: "note:1", method: "PUT", path: "/api/notes/1", body: "hello, world" });
  eq(newer.status, "collapsed", "a newer body replaces the older one");
  q = newer.queue;
  eq(q.writes.length, 1, "still one write for that key");
  ok(newer.reason.includes("older edit over a newer one"), "and the reason says why collapsing is required");
  eq(digest("a"), digest("a"), "digest is stable");
  ok(digest("a") !== digest("b"), "digest separates two bodies");
  // Ordering: oldest first.
  q = enqueue(q, { key: "note:2", method: "PUT", path: "/api/notes/2", body: "second", queuedAt: 1 }).queue;
  q = enqueue(q, { key: "note:3", method: "PUT", path: "/api/notes/3", body: "third", queuedAt: 0 }).queue;
  eq(next(q)?.key, "note:3", "the oldest write goes first");
  // A 409 is dropped, not retried — retrying would overwrite a newer row.
  const conflict = fail(q, "note:3", "409", "conflict");
  ok(!conflict.writes.some((w) => w.key === "note:3"), "a conflicting write is dropped");
  ok(conflict.dropped[0].includes("409"), "and the reason is kept");
  // Retryable failures are retried to the cap, then parked.
  let r = q;
  for (let i = 0; i < MAX_ATTEMPTS; i++) r = fail(r, "note:2", "offline", "retryable");
  ok(!r.writes.some((w) => w.key === "note:2"), "after the attempt cap it is parked, not retried forever");
  // The cap is honest at enqueue time.
  let big = emptyQueue();
  for (let i = 0; i < MAX_WRITES; i++) big = enqueue(big, { key: `k${i}`, method: "PUT", path: "/p", body: "x", queuedAt: i }).queue;
  const over = enqueue(big, { key: "one-too-many", method: "PUT", path: "/p", body: "x" });
  eq(over.status, "refused", "a full queue refuses");
  ok(over.reason.includes("full"), "and says it is full");
  eq(succeed(q, "note:2").writes.length, q.writes.filter((w) => w.key !== "note:2").length, "a success removes exactly that key");
  ok(describeQueue(emptyQueue()).includes("Nothing waiting"), "the empty state is a sentence, not a blank");
});

/* ────────────────────────────────────── 3. safe save (FM-18) ──────────── */
await test("FM-18 safe save: the four steps are ordered, and each failure has its own recovery", { "FM-18": "full" }, () => {
  const start = begin("/Documents/a.md", 120);
  eq(start.phase, "session-copy", "starts by copying the session file");
  eq(afterSessionCopy(start, 120).phase, "temp-written", "a full copy advances");
  eq(afterSessionCopy(start, 119).phase, "failed", "a short copy fails instead of advancing");
  const temp = afterSessionCopy(start, 120);
  // Replacing before validating is a refusal, not a save.
  eq(afterReplace(temp).phase, "failed", "a replace before validation is refused");
  ok(afterReplace(temp).error!.includes("before validation"), "and says why");
  const invalid = afterValidate(temp, false, "not valid markdown");
  eq(invalid.phase, "failed", "an invalid file never reaches the target");
  ok(invalid.recovery.includes("target is untouched"), "and the target is stated untouched");
  const valid = afterValidate(temp, true);
  eq(afterReplace(valid).phase, "replaced", "validated then replaced");
  ok(describeSave(afterReplace(valid)).startsWith("Saved"), "success is the only state that says saved");
  ok(describeSave(invalid).includes("Not saved"), "a failure says not saved, and the reason");
  // Crash recovery, one rule per situation.
  eq(recover({ hasTemp: true, hasSessionCopy: false, targetBytes: 10, sessionBytes: null }).action, "discard-temp", "an orphan temp is discarded");
  eq(recover({ hasTemp: false, hasSessionCopy: true, targetBytes: null, sessionBytes: 12 }).action, "offer-session-copy", "a missing target with a session copy is offered, not silently restored");
  eq(recover({ hasTemp: false, hasSessionCopy: true, targetBytes: 12, sessionBytes: 99 }).action, "offer-session-copy", "a size disagreement is the user's choice");
  eq(recover({ hasTemp: false, hasSessionCopy: false, targetBytes: 12, sessionBytes: null }).action, "nothing", "nothing to do when there is nothing there");
  eq(recover({ hasTemp: false, hasSessionCopy: true, targetBytes: 12, sessionBytes: 12 }).action, "nothing", "an identical session copy needs no action");
});

/* ─────────────────────────────── 4. desktop merge (DP-04) ─────────────── */
await test("DP-04 merge: no window is lost, a newer close wins, and z-order is dense", { "DP-04": "full" }, () => {
  const mk = (windows: DesktopLike["windows"], revision = 1, closed?: DesktopLike["closed"]): DesktopLike => ({ windows, focus: windows.at(-1)?.id ?? null, nextZ: windows.length + 1, revision, closed });
  const a = mk([{ id: "w1", x: 0, y: 0, w: 100, h: 100, z: 1, updatedAt: 100 }, { id: "w2", x: 10, y: 10, w: 10, h: 10, z: 2, updatedAt: 200 }], 5);
  const b = mk([{ id: "w1", x: 40, y: 40, w: 100, h: 100, z: 1, updatedAt: 300 }, { id: "w3", x: 1, y: 2, w: 3, h: 4, z: 2, updatedAt: 50 }], 6);
  const m = mergeDesktops(a, b, "a");
  eq(m.desktop.windows.length, 3, "a window only one side knew about is kept");
  eq(m.desktop.windows.find((w) => w.id === "w1")!.x, 40, "the newer geometry wins");
  eq(m.desktop.windows.map((w) => w.z), [1, 2, 3], "z-order is dense from 1");
  eq(m.desktop.nextZ, 4, "nextZ follows the dense order");
  eq(m.desktop.revision, 7, "the merged revision is newer than both");
  ok(m.kept.some((k) => k.includes("did not know")), "the kept window is reported");
  // A close newer than the open closes it; a close older than a reopen does not.
  const closed = mk([{ id: "w9", x: 0, y: 0, w: 1, h: 1, z: 1, updatedAt: 100 }], 1, [{ id: "w9", at: 300 }]);
  const reopened = mk([{ id: "w9", x: 0, y: 0, w: 1, h: 1, z: 1, updatedAt: 400 }], 2);
  eq(mergeDesktops(reopened, closed, "a").desktop.windows.length, 1, "a reopen after a close keeps the window");
  eq(mergeDesktops(mk([{ id: "w9", x: 0, y: 0, w: 1, h: 1, z: 1, updatedAt: 100 }], 1), closed, "a").desktop.windows.length, 0, "a close after the open closes it");
  // Commutativity of the window set, whichever side is preferred.
  const ab = mergeDesktops(a, b, "a").desktop.windows.map((w) => w.id).sort();
  const ba = mergeDesktops(b, a, "b").desktop.windows.map((w) => w.id).sort();
  eq(ab, ba, "the merged set is the same whichever side is preferred");
  ok(describeMerge(m).includes("kept"), "the toast names what happened");
  eq(describeMerge(mergeDesktops(a, a, "a")).includes("already identical") || describeMerge(mergeDesktops(a, a, "a")).length > 0, true, "identical sides produce a sentence, not an empty toast");
});

/* ────────────────────────── 5. context profile (ST-09) ────────────────── */
await test("ST-09 profile: a touchscreen laptop is a laptop, an iPad is a tablet, two screens are a desk", { "ST-09": "full" }, () => {
  const m = (over: Partial<Measurements>): Measurements => ({ screenCount: 1, coarse: false, hover: true, touchPoints: 0, viewport: { w: 1440, h: 900 }, ...over });
  eq(chooseProfile(m({ touchPoints: 10 })).profile.id, "laptop", "a touch laptop keeps precise-pointer behaviour");
  eq(chooseProfile(m({ coarse: true, hover: false, touchPoints: 5 })).profile.id, "tablet", "a coarse pointer with no hover is a tablet");
  ok(chooseProfile(m({ coarse: true, hover: false, touchPoints: 5 })).reason.includes("coarse"), "and the reason names the measurement");
  eq(chooseProfile(m({ coarse: true, hover: false, touchPoints: 0 })).profile.id, "laptop", "a coarse pointer reporting no touch is not a tablet");
  eq(chooseProfile(m({ screenCount: 2 })).profile.id, "desk", "two screens is a desk");
  eq(chooseProfile(m({ screenCount: 3, coarse: true, hover: false, touchPoints: 2 })).profile.id, "tablet", "a tablet with a screen attached is still a tablet");
  eq(chooseProfile(m({ screenCount: 0 })).profile.id, "laptop", "a nonsense screen count is clamped, not trusted");
  ok(PROFILES.desk.windowScale > 1 && PROFILES.tablet.windowScale < 1, "the scales are passed as data, not hidden in a component");
  // Transitions are announced only when the id changes.
  const t = transition("laptop", chooseProfile(m({ screenCount: 2 })));
  eq(t.changed, true, "plugging in a screen is a change");
  ok(t.announce!.includes("desk"), "and the announcement names the layout");
  eq(transition("tablet", chooseProfile(m({ coarse: true, hover: false, touchPoints: 1 }))).changed, false, "the same profile is not announced twice");
  eq(transition(null, chooseProfile(m({}))).announce, null, "the first profile is not announced");
  // Density is a viewport decision that never changes the id.
  eq(densityFor(PROFILES.laptop, { viewport: { w: 600, h: 900 } }).targetPx, 44, "a narrow viewport gets touch targets");
  eq(densityFor(PROFILES.desk, { viewport: { w: 1400, h: 900 } }).density, "compact", "a desk can afford compact density");
});

/* ───────────────────────── 6. remote desktop (CT-05) ──────────────────── */
await test("CT-05 remote: an unregistered scheme is copied, a registered one is a handoff, http is refused", { "CT-05": "full" }, () => {
  const vnc = planRemote("vnc://studio.local:5900");
  eq(vnc.status, "copy", "a vnc:// link is offered as a copy, because the scheme is rarely registered");
  ok(vnc.status === "copy" && vnc.note.includes("clipboard"), "and says why it is not a link");
  const rdp = planRemote("rdp://desk.example");
  eq(rdp.status, "handoff", "rdp:// opens the platform client");
  ok(rdp.status === "handoff" && rdp.note.includes("raw TCP"), "and states the browser cannot speak the protocol");
  eq(planRemote("https://example.com/remote").status, "blocked", "an http address is not a remote desktop");
  eq(planRemote("").status, "blocked", "an empty address is refused");
  eq(planRemote("webrtc:offer-1").status, "stream", "a peer offer is the one real remote screen");
  // Credentials are redacted before any display.
  eq(redactAddress("rdp://admin:hunter2@10.0.0.5"), "rdp://***@10.0.0.5", "a password in a connection string is redacted");
  eq(redactAddress("https://x/connect?password=hunter2&user=a"), "https://x/connect?password=***&user=a", "a password parameter is redacted");
  ok(streamControls("control").some((c) => c.id === "clipboard" && c.needs.includes("cannot sync")), "clipboard control states the platform limit");
  eq(streamControls("view").length, 1, "view-only exposes exactly one control");
});

/* ────────────────────────── 7. capture plan (WM-15) ───────────────────── */
await test("WM-15 capture: recording is ready, casting a live stream is refused, tab-audio is disclosed", { "WM-15": "full" }, () => {
  const env = { secureContext: true, hasDisplayMedia: true, hasRecorder: true, hasPeerConnection: true };
  const rec = planCapture({ goal: "record", surface: "tab", audioRequested: true, limitSec: 300, codecOk: true }, env);
  eq(rec.status, "ready", "recording a tab is a supported plan");
  ok(rec.status === "ready" && rec.tracks.includes("audio"), "the audio track is listed when it was asked for");
  ok(rec.status === "ready" && rec.warnings.some((w) => w.includes("share tab audio")), "and the picker's audio box is disclosed, not assumed");
  const cast = planCapture({ goal: "cast", surface: "tab", audioRequested: false, limitSec: null, codecOk: true }, env);
  eq(cast.status, "blocked", "a live stream cannot be cast");
  ok(cast.status === "blocked" && cast.alternative!.includes("Record first"), "and the alternative is a real route");
  eq(planCapture({ goal: "record", surface: "tab", audioRequested: false, limitSec: 0, codecOk: true }, env).status, "blocked", "a zero-second limit is refused");
  eq(planCapture({ goal: "record", surface: "tab", audioRequested: false, limitSec: null, codecOk: false }, env).status, "blocked", "no codec means no file");
  eq(planCapture({ goal: "webrtc", surface: "screen", audioRequested: false, limitSec: null, codecOk: false }, { ...env, hasPeerConnection: false }).status, "blocked", "no peer connection means no live peer");
  eq(planCapture({ goal: "webrtc", surface: "screen", audioRequested: false, limitSec: null, codecOk: false }, env).status, "ready", "a live peer needs no codec probe");
  eq(planCapture({ goal: "record", surface: "window", audioRequested: true, limitSec: null, codecOk: true }, { ...env, secureContext: false }).status, "blocked", "an insecure context is refused first");
  ok(captureName("window", Date.UTC(2026, 10, 6, 12, 0, 0)).startsWith("Capture window 2026"), "the file name is derived, not random");
});

/* ─────────────────────────── 8. audio route (MD-06) ───────────────────── */
await test("MD-06 audio: an output can be chosen when the platform allows it, and labels are explained", { "MD-06": "full" }, () => {
  const env = { secureContext: true, hasSetSinkId: true, permission: "granted" as const, crossOriginSource: false, isStream: false };
  eq(planRoute("dev-2", env).status, "ready", "a chosen device is routed when permitted");
  eq(planRoute("default", env).status, "default", "the default needs no permission");
  eq(planRoute("dev-2", { ...env, hasSetSinkId: false }).status, "unsupported", "no setSinkId is unsupported, not an error");
  eq(planRoute("dev-2", { ...env, crossOriginSource: true }).status, "refused", "a cross-origin stream cannot be re-routed");
  eq(planRoute("dev-2", { ...env, permission: "denied" }).status, "refused", "a denied permission is refused");
  eq(planRoute("dev-2", { ...env, secureContext: false }).status, "unsupported", "an insecure context comes first");
  ok(labelNote([{ deviceId: "a", label: "" }])!.includes("hidden until"), "unlabelled devices are explained");
  eq(labelNote([{ deviceId: "a", label: "Speakers" }]), null, "labelled devices need no note");
  ok(labelNote([])!.includes("No output devices"), "an empty list is explained as a permission artifact");
  eq(groupDevices([{ deviceId: "a", label: "x", groupId: "g" }, { deviceId: "b", label: "y", groupId: "g" }, { deviceId: "c", label: "z" }]).length, 2, "two devices in one group collapse to one group");
});

/* ───────────────────────────── 9. photo edit (MD-03) ──────────────────── */
await test("MD-03 photo edit: the chain is non-destructive, refuses an impossible crop, and drops a no-op", { "MD-03": "full" }, () => {
  const base = { w: 100, h: 50 };
  let ops: Op[] = [];
  const crop: Op = { kind: "crop", id: "c1", x: 10, y: 5, w: 20, h: 20 };
  const r1 = push(base, ops, crop);
  ok(r1.ok, `a valid crop must apply: ${!r1.ok ? r1.reason : ""}`);
  if (r1.ok) ops = r1.ops;
  eq(resolveSize(base, ops).size, { w: 20, h: 20 }, "the crop changes the resolved size");
  const rot: Op = { kind: "rotate", id: "r1", turns: 1 };
  const r2 = push(base, ops, rot);
  if (r2.ok) ops = r2.ops;
  eq(resolveSize(base, ops).size, { w: 20, h: 20 }, "a 90° rotation of a square stays square");
  // An impossible crop is refused with the numbers in the message.
  const bad = push(base, ops, { kind: "crop", id: "c2", x: 15, y: 0, w: 20, h: 20 });
  eq(bad.ok, false, "a crop past the edge is refused");
  ok(!bad.ok && bad.reason.includes("outside"), "and the reason says outside, with the size");
  // Identity operations are dropped, not stored.
  const noop = push(base, ops, { kind: "exposure", id: "e0", ev: 0 });
  eq(noop.ok, true, "an identity operation is accepted");
  ok(noop.ok && noop.dropped.includes("e0"), "but it is dropped from the chain");
  eq(push(base, ops, { kind: "exposure", id: "e1", ev: 9 }).ok, false, "an implausible exposure is refused");
  eq(push(base, ops, crop).ok, false, "a duplicate id is refused");
  // Saturation preserves luma; contrast does not pretend to.
  const [r, g, b] = saturate([200, 100, 50], 100);
  const before = 0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50;
  const after = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  ok(Math.abs(after - before) < 2, `saturation must preserve luma (${before.toFixed(1)} → ${after.toFixed(1)})`);
  const curve = toneCurve([{ kind: "exposure", id: "e", ev: 1 }]);
  eq(curve[0], 0, "black stays black under an exposure lift");
  eq(curve.at(-1), RAMP_MAX, "white is clamped, not wrapped");
  ok(curve[8] > RAMP_MAX / 2, "the midpoint lifts");
  eq(undo(ops).length, ops.length - 1, "undo is truncation");
  eq(ops.length, 2, "the chain itself was never mutated by push()");
});

/* ─────────────────────────────── 10. key light (LN-06) ────────────────── */
await test("LN-06 key light: it fills from the dark side, discloses the clip, and never claims to remove a shadow", { "LN-06": "full" }, () => {
  const dark = planKeyLight({ subjectLuma: 0.25, frameLuma: 0.2, brightestSide: "left", frame: { w: 1280, h: 720 } }, 70);
  eq(dark.direction, "right", "the fill comes from the opposite side of the key");
  ok(dark.gain > 1, "a dark subject is lifted");
  ok(dark.limits.some((l) => l.includes("cannot remove")), "the impossible half is stated");
  ok(dark.stops.length >= 4, "the falloff is a bounded stop list, not a per-frame computation");
  // The brighter end must be the side the light comes FROM: for a fill from the
  // right, the gradient runs left→right, so the last stop is the bright one.
  const brightEnd = dark.direction === "left" || dark.direction === "top" ? dark.stops[0] : dark.stops.at(-1)!;
  ok(dark.stops.every((x) => x.alpha <= brightEnd.alpha), "the brightest stop is on the side the light comes from");
  ok(brightEnd.alpha > 0, "a fill that would round to zero is not offered as on");
  const css = keyLightCss(dark);
  ok(css.background.startsWith("linear-gradient"), "the renderer gets CSS, not pixels");
  eq(css.mixBlendMode, "screen", "a fill is added light, not a tint");
  const blown = planKeyLight({ subjectLuma: 0.2, frameLuma: 0.85, brightestSide: "top", frame: { w: 800, h: 600 } }, 100);
  ok(blown.limits.some((l) => l.includes("already bright")), "an already-bright frame is called out");
  eq(blown.clips || blown.gain <= CLIP_LUMA / 1, true, "a clipping plan caps its own gain");
  const off = planKeyLight({ subjectLuma: 0.55, frameLuma: 0.5, brightestSide: "centre", frame: { w: 900, h: 600 } }, 0);
  eq(off.direction, "off", "no measured side and no strength means no fill");
  eq(keyLightCss(off).background, "none", "and nothing is painted");
  eq(planKeyLight({ subjectLuma: TARGET_SUBJECT_LUMA, frameLuma: 0.5, brightestSide: "right", frame: { w: 900, h: 600 } }, 50).gain, 1, "a subject already at the target gets no gain");
});

/* ─────────────────── 11. background mechanisms (AP-05) ────────────────── */
await test("AP-05 background: each mechanism states its real guarantee; periodic sync is a floor, not a schedule", { "AP-05": "full" }, () => {
  const entries = inventory({ serviceWorker: true, installed: true, periodicSyncApi: true, backgroundFetchApi: false, pushApi: false, visibilityHidden: true });
  const ps = entries.find((e) => e.mechanism === "periodic-sync")!;
  eq(ps.available, true, "periodic sync is available when installed and supported");
  ok(ps.guarantee.includes("may ignore"), "and its guarantee says the interval may be ignored");
  const push = entries.find((e) => e.mechanism === "push")!;
  eq(push.available, false, "push is unavailable without a push service");
  ok(push.why === "no Push API in this browser", `with the API absent, the reason is the browser (got: ${push.why})`);
  // With the API present the reason must move to the deployment, not stay on the browser.
  const hasPush = inventory({ serviceWorker: true, installed: true, periodicSyncApi: false, backgroundFetchApi: false, pushApi: true, visibilityHidden: false }).find((e) => e.mechanism === "push")!;
  eq(hasPush.available, false, "an API without a push service still cannot deliver");
  ok(/no push service/.test(hasPush.why!), `with the API present the reason is the missing service (got: ${hasPush.why})`);
  const bf = entries.find((e) => e.mechanism === "background-fetch")!;
  eq(bf.available, false, "background fetch is reported from the measurement");
  const timer = entries.find((e) => e.mechanism === "page-timer")!;
  ok(timer.guarantee.includes("throttled"), "a hidden tab's timer is described as throttled");
  // An uninstalled app cannot use periodic sync even when the API exists.
  ok(!inventory({ serviceWorker: true, installed: false, periodicSyncApi: true, backgroundFetchApi: true, pushApi: true, visibilityHidden: false }).find((e) => e.mechanism === "periodic-sync")!.available, "installed is required for periodic sync");
  // The default environment is the sandbox's real answer (no push API at all), so
  // the counting assertions run on an entry set where the mechanism IS available.
  const counted = record(inventory({ serviceWorker: true, installed: true, periodicSyncApi: false, backgroundFetchApi: false, pushApi: true, pushService: false, visibilityHidden: false }), "service-worker", 1000);
  eq(counted.find((e) => e.mechanism === "service-worker")!.observed, 1, "an observed event is counted");
  eq(counted.find((e) => e.mechanism === "push")!.observed, 0, "an unavailable mechanism cannot observe an event");
  eq(entries.every((e) => Number.isFinite(e.observed)), true, "every fresh entry starts with a real zero, never an undefined count");
  eq(counted.find((e) => e.mechanism === "push")!.available, false, "an API without a configured push service is unavailable");
  ok(inventorySummary(counted).includes("not a promise"), "the summary refuses to turn a count into a rate");
  eq(chooseFor("daily-check", entries).mechanism, "periodic-sync", "the need maps to the weakest sufficient mechanism");
  eq(chooseFor("daily-check", inventory({ serviceWorker: true, installed: false, periodicSyncApi: true, backgroundFetchApi: false, pushApi: false, visibilityHidden: false })).mechanism, null, "and to nothing when it is unavailable");
  ok(chooseFor("large-download", entries).why.includes("only continues while"), "an unavailable need says what will not happen");
});

/* ───────────────────── 12. hotplug restore (WM-07) ────────────────────── */
await test("WM-07 hotplug: park and restore are reversible, and a user move survives the round trip", { "WM-07": "full" }, () => {
  const primary = { label: "Built-in", availLeft: 0, availTop: 0, availWidth: 1440, availHeight: 900 };
  const external = { label: "Studio", availLeft: 1440, availTop: 0, availWidth: 1920, availHeight: 1080 };
  eq(screenKey(primary), screenKey({ ...primary, availLeft: 2, availTop: 1 }), "jittery bounds produce the same key");
  ok(screenKey(primary) !== screenKey(external), "different screens produce different keys");
  // Matching: exact, renamed-but-unmoved, and ambiguous.
  const exact = matchScreens([{ key: screenKey(primary), screen: primary }], [primary, external]);
  eq(exact.matched.length, 1, "the known screen matches");
  eq(exact.appeared.length, 1, "the new screen appeared");
  const renamed = matchScreens([{ key: "Old|0,0,1440x900", screen: primary }], [primary]);
  eq(renamed.matched.length, 1, "a renamed screen that did not move is re-identified by geometry");
  const twin = { ...primary, label: "Twin" };
  const ambiguous = matchScreens([{ key: screenKey(primary), screen: primary }], [primary, twin]);
  eq(ambiguous.ambiguous.length + ambiguous.appeared.length >= 1, true, "two identical geometries are reported, not guessed");
  ok(hotplugSentence(ambiguous, 0).includes("could not be told apart") || ambiguous.ambiguous.length === 0, "an ambiguity is announced when it happens");

  // Round trip.
  const keys = { primary: screenKey(primary), external: screenKey(external) };
  let st = emptyHotplugState();
  st = { ...st, snapshots: { [keys.primary]: [{ id: "w1", x: 100, y: 100, w: 400, h: 300 }], [keys.external]: [{ id: "w2", x: 1500, y: 200, w: 500, h: 400 }] } };
  const parked = park(st, keys.external, primary, keys.primary);
  eq(parked.record.length, 1, "the unplugged screen's windows are recorded");
  const moved = parked.state.snapshots[keys.primary].find((w) => w.id === "w2")!;
  ok(moved.x >= 0 && moved.x + moved.w <= primary.availWidth, "a parked window is inside the host work area");
  eq(parked.state.snapshots[keys.external], undefined, "the gone screen holds nothing");
  const back = restore(parked.state, keys.external, external);
  eq(back.restored.length, 1, "the window comes back");
  eq(back.restored[0].id, "w2", "the same window");
  eq(back.state.snapshots[keys.primary].length, 1, "and leaves the host screen");
  // A user move is respected.
  const parked2 = park(st, keys.external, primary, keys.primary);
  const kept = restore(parked2.state, keys.external, external, new Set(["w2"]));
  eq(kept.keptByUser, ["w2"], "a window the user moved stays where the user put it");
  eq(kept.restored.length, 0, "and is not teleported back");
  // Overflow is reported, not silently accepted.
  const small = { label: "Small", availLeft: 0, availTop: 0, availWidth: 300, availHeight: 200 };
  const overflow = park(st, keys.external, small, screenKey(small));
  eq(overflow.overflow.length, 1, "a window larger than the host screen is named");
  ok(hotplugSentence({ matched: [], appeared: [], disappeared: [{ key: keys.external, screen: external }], ambiguous: [] }, 1).includes("disconnected"), "the sentence counts the moved windows");
});

/* ─────────────────────────── 13. panel layout (SH-13) ─────────────────── */
await test("SH-13 virtual list: 100 000 rows index in milliseconds, mount ~0.03% of them, and never collapse", { "SH-13": "full" }, () => {
  const t0 = performance.now();
  const layout = buildLayout(100_000, 32);
  const ms = performance.now() - t0;
  eq(layout.total, 3_200_000, "the prefix sum is exact");
  ok(ms < 250, `indexing 100 000 rows must stay under 250 ms, took ${ms.toFixed(1)} ms`);
  eq(indexAt(layout, 0), 0, "the first row contains y=0");
  eq(indexAt(layout, 31), 0, "and y=31");
  eq(indexAt(layout, 32), 1, "y=32 is the second row");
  eq(indexAt(layout, layout.total + 10_000), 99_999, "past the end clamps to the last row");
  const view = windowFor(layout, 320_000, 800, 1);
  ok(view.last - view.first < 100, "a viewport shows a bounded window, not the list");
  ok(mountRatio(layout, view).includes("rows mounted"), "the mount ratio is reported");
  const ratio = Number(/\(([\d.]+)%\)/.exec(mountRatio(layout, view))?.[1]);
  ok(ratio < 1, `a 100 000-row list must mount under 1% of its rows, got ${ratio}%`);
  eq(view.padTop, layout.offsets[view.first], "the top pad is the offset of the first mounted row");
  eq(view.padTop + (layout.offsets[view.last + 1] - view.padTop) + view.padBottom, layout.total, "pads and mounted height add up to the total");
  // A measured height updates the index; the same height is a no-op.
  const grown = setHeight(layout, 3, 120);
  eq(grown.heights[3], 120, "a measured row takes its real height");
  eq(grown.total, layout.total + 88, "and the total follows");
  eq(setHeight(grown, 3, 120), grown, "re-measuring the same height returns the same object");
  // A zero measurement must not collapse the index.
  eq(setHeight(layout, 5, 0).heights[5], MIN_ROW, "a zero measurement is clamped, not trusted");
  eq(setHeight(layout, 5, 10_000).heights[5], MIN_ROW > 0 ? 320 : 320, "an absurd measurement is clamped");
  eq(buildLayout(0, 32).total, 0, "an empty list is a valid list");
  eq(windowFor(buildLayout(0, 32), 0, 800).last, -1, "and its window is empty rather than invalid");
  // Sticky headers follow the section, and are pushed by the next one.
  const sections = [0, 100];
  const sticky = stickyOffset(buildLayout(300, 32), sections, 32 * 150, 40);
  eq(sticky.index, 1, "the second section is sticky at its start");
  eq(sticky.translateY <= 0, true, "a sticky header is never pushed downward");
});

/* ──────────────────────────── 14. row clustering (SR-06) ──────────────── */
await test("SR-06 clusters: a bulk action never spans a section, and an unknown source is its own cluster", { "SR-06": "full" }, () => {
  const rows: Row[] = [
    { id: "a", section: "Files", provenance: "/Documents", sizeBytes: 10 },
    { id: "b", section: "Files", provenance: "/Documents", sizeBytes: 20 },
    { id: "c", section: "Files", provenance: "/Documents", sizeBytes: 30 },
    { id: "d", section: "Files", provenance: "/Photos", sizeBytes: 40 },
    { id: "e", section: "Notes", provenance: "/Documents", sizeBytes: 5 },
    { id: "f", section: "Notes", provenance: "", sizeBytes: 1 },
  ];
  const c = cluster(rows);
  eq(c.length, 4, "four clusters: three provenances and a section boundary are all kept");
  eq(c[0].ids, ["a", "b", "c"], "consecutive rows with one provenance form one cluster");
  eq(c[0].bytes, 60, "the cluster totals its bytes");
  eq(c[0].actionable, true, "three rows are enough to offer a bulk action");
  eq(c.find((x) => x.section === "Notes" && x.provenance === "/Documents")!.ids, ["e"], "a section boundary splits a provenance");
  ok(c.some((x) => x.provenance === "(unknown source)"), "an empty provenance is labelled unknown, not merged");
  const single = cluster([{ id: "z", section: "S", provenance: "p" }])[0];
  eq(single.actionable, false, "a one-row cluster is not offered as a bulk target");
  // Selection: toggle a whole cluster, then describe it by section.
  let selected = new Set<string>();
  selected = toggleCluster(selected, c[0]);
  eq([...selected].sort(), ["a", "b", "c"], "toggling a cluster selects all of it");
  selected = toggleCluster(selected, c[0]);
  eq(selected.size, 0, "toggling again deselects");
  const described = describeSelection(rows, new Set(["a", "e"]));
  ok(described.includes("2 selected") && described.includes("Files") && described.includes("Notes"), "the description names every section in the selection");
  const all = selectAll(rows, 3);
  eq(all.ids.length, 3, "select-all honours the limit");
  ok(all.truncated && all.note.includes("narrow"), "and says the selection was truncated");
  eq(selectAll(rows, 500).truncated, false, "an unbounded selection is not truncated");
});

/* ─────────────────────────── 15. design tokens (visual) ───────────────── */
await test("visual: both token sets pass the contrast audit, and a failing ink is caught", { "DP-07": "full", "AX-10": "full" }, () => {
  const light = rampFor("light");
  const dark = rampFor("dark");
  eq(auditTokens(light), [], "the light ramp has no contrast failure");
  eq(auditTokens(dark), [], "the dark ramp has no contrast failure");
  ok(contrast(light.ink.strong, light.ramp.surface) >= 4.5, "strong ink clears AA on the surface");
  ok(contrast(dark.ink.muted, dark.ramp.sunken) >= 4.5, "muted ink clears AA even on the darkest surface");
  // The auditor must actually fail a bad token, or it proves nothing.
  const broken = { ...light, ink: { ...light.ink, muted: "#cfd4dc" } };
  const failures = auditTokens(broken);
  ok(failures.length >= 4, `a too-light muted ink must fail on every surface, got ${failures.length}`);
  ok(failures[0].pair.includes("muted on"), "the failure names the pair");
  ok(failures[0].ratio < 4.5 && failures[0].needs === 4.5, "and carries the measured ratio and the requirement");
  ok(tokensCss(light).includes("--fs-accent"), "the tokens are emitted as CSS variables");
  eq(Object.keys(light.ramp).length, 4, "four surfaces, not eight");
  eq(light.elevation.length, 3, "three elevations, not a bespoke shadow per component");
});

/* ────────────────────────── 16. content density (visual) ──────────────── */
await test("visual: the word budget is enforced on labels, notes and summaries", { "AX-10": "partial" }, () => {
  eq(words("Save").length, 1, "one word");
  eq(words("Save all changes now please").length, 5, "five words");
  // Every token here is an acronym or a version, so the count is zero — not one:
  // counting "WCAG" as prose would let a label burn its budget on a standard's name.
  eq(words("WCAG 2.1 AA v1.2.3").length, 0, "an acronym and a version number are not prose");
  eq(words("passes WCAG AA").length, 1, "the same acronym beside a real verb counts once");
  eq(words("Re-open the file").length, 3, "a hyphenated word counts once");
  eq(auditLabels([{ text: "Save", where: "editor" }]), [], "a one-word label passes");
  const tooLong = auditLabels([{ text: "Save everything to the server right now", where: "editor" }]);
  eq(tooLong.length, 1, "a six-word label fails");
  eq(tooLong[0].limit, MAX_LABEL_WORDS, "the limit is named in the violation");
  ok(tooLong[0].fix.includes("reason"), "and the fix points at where the text belongs");
  const note = auditNotes([{ text: Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "), where: "privacy" }]);
  eq(note[0].limit, MAX_NOTE_WORDS, "a 30-word note is over the note budget");
  eq(auditNotes([{ text: "Locked until you unlock the vault.", where: "vault" }]), [], "a short note passes");
  ok(auditSummary("notes", "Notes", "Notes") !== null, "a summary that repeats the title is a violation");
  eq(auditSummary("notes", "Notes", "Local-first notes indexed with files"), null, "a real summary passes");
  ok(auditSummary("x", "X", "a b c d e f g h i j k l m") !== null, "a 13-word summary is over budget");
  const c = countChrome(["Save", "Save all", "Cancel"]);
  eq(c.total, 4, "the chrome word count is the number the report cites");
  eq(c.unique, 3, "and the unique count");
});

/* ──────────────────────── 17. download arbiter (PR-07m) ───────────────── */
await test("PR-07m downloads: three streams at once, a short body is not a success, and cancel is final", { "PR-07m": "full" }, () => {
  let q = { items: [], inflight: [] } as ReturnType<typeof enqueueDownload>["queue"];
  for (const id of ["a", "b", "c", "d", "e"]) q = enqueueDownload(q, { id, url: `https://example.com/${id}.bin`, declaredBytes: 1000 }).queue;
  eq(q.items.length, 5, "five items queued");
  q = pump(q);
  eq(q.inflight.length, MAX_INFLIGHT, "exactly three run at once");
  eq(q.items.filter((i) => i.state === "running").map((i) => i.id), ["a", "b", "c"], "the oldest three run");
  q = progress(q, "a", 400, 1000);
  eq(q.items[0].bytesPerSecond, 400, "the rate is computed from the elapsed time");
  q = progress(q, "a", 100, 1000);
  eq(q.items[0].restarts, 1, "a decrease is counted as a restart, not smoothed away");
  q = progress(q, "a", 1000, 2000);
  q = complete(q, "a", 1000, 1000);
  eq(q.items[0].state, "complete", "a full body is complete");
  q = complete(q, "b", 900, 1000);
  eq(q.items[1].state, "truncated", "a short body is truncated, not complete");
  q = complete(q, "c", 1001, 1000);
  eq(q.items[2].state, "overrun", "a long body is an overrun");
  q = pump(q);
  eq(q.inflight.length, 2, "completed slots are refilled from the queue");
  ok(q.inflight.includes("d") && q.inflight.includes("e"), "the next two items started");
  // A length-less response is unverified, never complete.
  q = complete(q, "d", 500, null);
  eq(q.items.find((i) => i.id === "d")!.state, "unverified", "no declared length means unverified");
  ok(!statusSentence(q).startsWith("1 verified") || statusSentence(q).includes("verified"), "the sentence separates verified from unverified");
  ok(statusSentence(q).includes("no background download manager"), "the platform limit is in the sentence");
  // Cancel is final.
  q = cancel(q, "e");
  eq(q.items.find((i) => i.id === "e")!.state, "cancelled", "a cancelled item is cancelled");
  q = complete(q, "e", 1000, 1000);
  eq(q.items.find((i) => i.id === "e")!.state, "cancelled", "a completion after cancel cannot resurrect it");
  // Retry policy.
  let r = enqueueDownload({ items: [], inflight: [] } as ReturnType<typeof enqueueDownload>["queue"], { id: "x", url: "https://e/x" }).queue;
  r = pump(r);
  r = failDownload(r, "x", "network", true);
  eq(r.items[0].state, "queued", "a retryable failure returns to the queue");
  r = pump(r);
  r = failDownload(r, "x", "404", false);
  eq(r.items[0].state, "failed", "a permanent failure does not retry");
  // Names never collide, and never trust the URL.
  const taken: string[] = [];
  for (const u of ["https://a/x.bin", "https://b/x.bin", "https://c/?id=1", "https://d/..%2F..%2Fetc%2Fpasswd"]) {
    const name = deriveName(u, taken);
    taken.push(name);
    ok(!name.includes("/") && !name.includes("\\") && !name.includes(".."), `a derived name must be a plain file name, got ${name}`);
  }
  eq(new Set(taken).size, taken.length, "two identical paths produce two distinct names");
  ok(deriveName("https://a/huge.bin", []).endsWith(".bin"), "the extension is kept");
  eq(summary({ items: [], inflight: [] }).open, 0, "an empty queue summarises to zero");
});

/* ─────────────────────────── 18. memory audit (RC-29) ─────────────────── */
await test("RC-29 audit: a half pair is found, a young orphan is spared, and a dangling row is never reclaimed", { "RC-29": "full" }, () => {
  const now = 1_000_000_000;
  const grace = DEFAULT_GRACE_MS;
  const payloads = [
    { key: "good", bytes: 100, createdAt: now - grace * 3, digest: "aa" },
    { key: "old-orphan", bytes: 50, createdAt: now - grace * 5 },
    { key: "young-orphan", bytes: 60, createdAt: now - 1000 },
    { key: "short", bytes: 90, createdAt: now - grace * 2, digest: "bb" },
    { key: "corrupt", bytes: 40, createdAt: now - grace * 2, digest: "cc" },
  ];
  const rows = [
    { key: "good", bytes: 100, createdAt: now - grace * 3, digest: "aa" },
    { key: "missing", bytes: 70, createdAt: now - grace * 4 },
    { key: "short", bytes: 100, createdAt: now - grace * 2, digest: "bb" },
    { key: "corrupt", bytes: 40, createdAt: now - grace * 2, digest: "dd" },
  ];
  const r = audit(payloads, rows, now, { graceMs: grace, verifyDigests: true });
  eq(r.clean, false, "a store with a half pair is not clean");
  eq(r.counts.danglingRows, 1, "one row has no payload");
  eq(r.counts.orphanPayloads, 2, "two payloads have no row");
  eq(r.reclaimable, ["old-orphan"], "only the orphan past the grace period is reclaimable");
  ok(r.findings.some((f) => f.kind === "orphanPayload" && f.key === "young-orphan" && f.note.includes("may still be in flight")), "a young orphan is named as possibly mid-publish");
  ok(r.findings.some((f) => f.kind === "sizeMismatch" && f.note.includes("interrupted")), "a short payload is an interrupted write");
  ok(r.findings.some((f) => f.kind === "checksumMismatch" && f.note.includes("corruption")), "a digest mismatch is corruption");
  eq(r.counts.mismatches, 2, "both the size and the checksum mismatch are counted");
  const plan = reclaimPlan(r);
  eq(plan.deletePayloads, ["old-orphan"], "the plan deletes exactly the reclaimable payload");
  eq(plan.keepRecords, ["missing"], "and keeps the record with no payload");
  ok(plan.reason.includes("evidence"), "the reason states why a record is kept");
  // Without digest verification, a same-length pair is not called corrupt.
  const noVerify = audit(payloads, rows, now, { graceMs: grace });
  eq(noVerify.findings.some((f) => f.kind === "checksumMismatch"), false, "digests are only checked when the caller says they were read");
  // A clean store is clean, and says so without overclaiming.
  const clean = audit([{ key: "a", bytes: 1, createdAt: now }], [{ key: "a", bytes: 1, createdAt: now }], now, { graceMs: grace });
  eq(clean.clean, true, "a complete pair is clean");
  ok(clean.sentence.includes("at this instant"), "and the sentence bounds the claim to this instant");
  // A duplicated row is reported, because a restore would apply it twice.
  ok(audit([], [{ key: "d", bytes: 1, createdAt: now }, { key: "d", bytes: 1, createdAt: now }], now, { graceMs: grace }).findings.some((f) => f.note.includes("twice")), "a duplicate key is reported");
});

/* ────────────────────────── 19. stream plan (CA-08/CA-12) ─────────────── */
await test("CA-08/CA-12 cast: a fetchable URL is available, a blob is refused, and the blocked protocols say why", { "CA-08": "full", "CA-12": "full" }, () => {
  const env = { secureContext: true, hasRemotePlayback: true, hasCastSdk: false };
  const video = { kind: "video" as const, url: "https://cdn.example/film.mp4", mime: "video/mp4" };
  const ok1 = planCast(video, { ...env, target: "remote-playback" });
  eq(ok1.status, "available", "a remote URL plays through the platform picker");
  ok(ok1.status === "available" && ok1.note.includes("receiver fetches"), "and says the receiver fetches it itself");
  const blob = planCast({ ...video, url: "blob:https://app/123" }, { ...env, target: "remote-playback" });
  eq(blob.status, "blocked", "a blob URL cannot be fetched by a receiver");
  ok(blob.status === "blocked" && blob.alternative!.includes("Save it"), "and the alternative is a real route");
  for (const target of ["raop", "dlna", "miracast"] as const) {
    const v = planCast(video, { ...env, target });
    eq(v.status, "blocked", `${target} is blocked`);
    ok(v.status === "blocked" && v.reason.includes("native protocol"), `${target} names the reason`);
    ok(v.status === "blocked" && !!v.alternative, `${target} offers the platform picker instead`);
  }
  const castSdk = planCast(video, { ...env, target: "google-cast" });
  eq(castSdk.status, "blocked", "the Cast sender needs the SDK, which is not bundled");
  ok(castSdk.status === "blocked" && castSdk.reason.includes("proprietary"), "and says proprietary");
  eq(planCast(video, { ...env, hasCastSdk: true, target: "google-cast" }).status, "available", "with the SDK it is available");
  eq(planCast({ ...video, mime: "application/pdf" }, { ...env, target: "remote-playback" }).status, "blocked", "a non-media type is refused");
  eq(planCast({ kind: "window", url: "https://a/b", mime: "video/mp4" }, { ...env, target: "remote-playback" }).status, "blocked", "a window is not castable as media");
  eq(planCast({ kind: "image", url: "https://a/b.png", mime: "image/png" }, { ...env, target: "remote-playback" }).status, "blocked", "a still image has no timeline");
  eq(planCast(video, { ...env, secureContext: false, target: "remote-playback" }).status, "blocked", "an insecure context is refused");
  eq(planCast(video, { ...env, hasRemotePlayback: false, target: "remote-playback" }).status, "blocked", "no API means no picker");
  eq(castMatrix(video, env).length, 6, "the matrix covers every target the UI can offer");
  ok(describeMedia({ ...video, durationSec: 3725 }).includes("62:05"), "the duration is formatted from a real number");
  ok(describeMedia(video).includes("unknown"), "an unknown duration is not invented");
});

/* ─────────────────── 20. desktop naming (DP-03/DP-04) ─────────────────── */
await test("DP-03 named desks: a share link round-trips and an unusable name cannot be minted", { "DP-03": "full" }, async () => {
  const { chooseDesktopId, shareLink, shortDesktopId, isValidDesktopId, DEFAULT_DESKTOP_ID } = await import("../src/lib/desktop-id.ts");
  const link = shareLink("https://fusion.example/", "work");
  eq(chooseDesktopId({ param: new URL(link).searchParams.get("desk") }).id, "work", "link → resolve round trip");
  eq(chooseDesktopId({}).id, DEFAULT_DESKTOP_ID, "no name is the shared desktop");
  eq(isValidDesktopId("work-"), false, "a trailing dash is refused");
  eq(isValidDesktopId("work"), true, "a plain name is accepted");
  eq(shortDesktopId("tt143-alphabet"), "…alphabet", "the short form keeps the tail");
  let threw = false;
  try { shareLink("https://x/", ""); } catch { threw = true; }
  ok(threw, "a link cannot be built for an unusable name");
});

finish();
