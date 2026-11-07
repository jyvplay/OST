/**
 * TT139 suite: PR-07n find, PR-10/CK-01 clock+timer+alarms,
 * SC-05/SC-07 privacy dashboard + containers, RG-01/02/04/06 load governor,
 * HW-02/HW-05 worker pool + audio budget, AX-07 captions.
 */
import { makeHarness } from "./harness.mts";
import {
  createFind, setQuery, cycleMode, findAll, nextMatch, prevMatch, currentMatch, setCurrentIndex,
  describeFind, replaceAll, replaceOne, highlightRanges, highlightSegments, MAX_QUERY_LENGTH,
} from "../src/lib/find/page-find.ts";
import {
  createClock, startClock, pauseClock, toggleClock, tickClock, lapClock, resetClock,
  setTimerDuration, extendTimer, timerRemaining, timerProgress, formatTime,
  getLapDiffs, getFastestLap, getSlowestLap, describeClock,
  createAlarmState, addAlarm, fireDueAlarms, snoozeAlarm, setAlarmEnabled, removeAlarm,
  nextFireTime, upcomingAlarms, MAX_DURATION_MS,
} from "../src/lib/timers/timer-engine.ts";
import {
  createPrivacyDashboard, addPrivacyEntry, setPrivacyAllowed, setGlobalOptOut,
  effectiveAllowed, privacyReport, privacyAudit, DATA_TYPES,
  createContainer, unlockContainer, lockContainer, autoLock, sealContainer,
  destroyContainer, containerStatus, containerCaveats, MAX_FAILED_ATTEMPTS,
} from "../src/lib/privacy/dashboard.ts";
import {
  createLoadGovernor, applyLoadSample, compositePressure, throttlePolicy, isThrottled,
  schedulingHint, resourceReport, memoryPolicy, describeGovernor, DEFAULT_THRESHOLDS,
} from "../src/lib/governor/load-governor.ts";
import {
  planPool, audioBudget, createPoolStats, recordEnqueue, recordStart, recordCompletion,
  statsSummary, MAX_WORKERS,
} from "../src/lib/workers/pool-planner.ts";
import {
  createCaptionTrack, addCue, removeCue, updateCue, activeCue, wrapCue, auditTrack,
  autoTime, toWebVtt, fromWebVtt, READING_RATE, MIN_CUE_MS,
} from "../src/lib/a11y/captions.ts";

const { test, finish } = makeHarness("tt139-systems");

const SAMPLE = "The quick brown fox jumps over the lazy dog. The QUICK fox naps. café naïve quick.";

// ══ PR-07n · find in page ════════════════════════════════════════════════

await test("PR-07n · literal mode is case-insensitive and wraps", { "PR-07n": "full" }, () => {
  let s = createFind(SAMPLE, "quick", "literal");
  if (s.matches.length !== 3) throw new Error(`expected 3, got ${s.matches.length}`);
  s = nextMatch(s);
  if (s.currentIndex !== 1) throw new Error("next did not advance");
  s = nextMatch(setCurrentIndex(s, 2));
  if (s.currentIndex !== 0) throw new Error("next did not wrap");
  if (prevMatch(s).currentIndex !== 2) throw new Error("prev did not wrap");
});

await test("PR-07n · whole-word uses Unicode boundaries, not \\b", { "PR-07n": "full" }, () => {
  // With \b, "naïve" splits at ï and "café" at é. Both must be single words.
  const uni = "a café, naïve idea";
  const cafe = findAll(uni, "café", "whole-word");
  if (cafe.length !== 1) throw new Error(`café whole-word → ${cafe.length}`);
  const naive = findAll(uni, "naïve", "whole-word");
  if (naive.length !== 1) throw new Error(`naïve whole-word → ${naive.length}`);
  // A prefix of a word must not match in whole-word mode.
  if (findAll(SAMPLE, "qu", "whole-word").length !== 0) throw new Error("'qu' matched inside 'quick'");
  if (findAll(SAMPLE, "quick", "whole-word").length !== 3) throw new Error("whole-word quick");
});

await test("PR-07n · regex mode; an invalid pattern is reported, not thrown", { "PR-07n": "full" }, () => {
  // Regex mode is case-sensitive, so the two lowercase "quick" match and the
  // uppercase "QUICK" does not. Asserting 3 here would have hidden the rule.
  const r = findAll(SAMPLE, "q[a-z]+k", "regex");
  if (r.length !== 2) throw new Error(`regex q[a-z]+k → ${r.length}, want 2 (case-sensitive)`);
  // Case-insensitivity in regex mode is spelled by the pattern itself. Note
  // that [Qq]uick is NOT enough: "QUICK" is fully uppercase, so every letter
  // needs a class. Spelling it correctly finds all three.
  const insensitive = findAll(SAMPLE, "[Qq][Uu][Ii][Cc][Kk]", "regex");
  if (insensitive.length !== 3) throw new Error(`spelled-out class → ${insensitive.length}, want 3`);
  const halfSpelled = findAll(SAMPLE, "[Qq]uick", "regex");
  if (halfSpelled.length !== 2) throw new Error("a partially-classed pattern must not match the all-caps word");
  let s = createFind(SAMPLE, "([unclosed", "regex");
  if (s.error === undefined) throw new Error("invalid regex must set error");
  if (s.matches.length !== 0) throw new Error("invalid regex must yield zero matches");
  if (!describeFind(s).includes("(")) throw new Error(`describeFind should surface the error: ${describeFind(s)}`);
  // A zero-length pattern must terminate, not spin.
  s = createFind("abc", "x*", "regex");
  if (s.error !== undefined) throw new Error(`zero-length pattern errored: ${s.error}`);
  // A query that was invalid, then fixed, must stop reporting the old error.
  let fixed = createFind(SAMPLE, "([bad", "regex");
  if (!fixed.error) throw new Error("invalid pattern did not error");
  fixed = setQuery(fixed, SAMPLE, "fox");
  if (fixed.error !== undefined) throw new Error(`stale error after fix: ${fixed.error}`);
  // "fox" appears twice in SAMPLE ("fox" and "fox"). A wrong count here would
  // mean the matcher silently skipped or double-counted a hit.
  if (fixed.matches.length !== 2) throw new Error(`fixed query → ${fixed.matches.length} matches, want 2`);
});

await test("PR-07n · cycleMode rotates through all four modes", { "PR-07n": "full" }, () => {
  let s = createFind(SAMPLE, "quick", "literal");
  const seen: string[] = [s.mode];
  for (let i = 0; i < 4; i++) {
    s = cycleMode(s, SAMPLE);
    seen.push(s.mode);
  }
  if (seen.join(",") !== "literal,case-sensitive,whole-word,regex,literal") {
    throw new Error(`mode cycle → ${seen.join(",")}`);
  }
  const cs = createFind(SAMPLE, "quick", "case-sensitive");
  if (cs.matches.length !== 2) throw new Error(`case-sensitive → ${cs.matches.length}, want 2`);
});

await test("PR-07n · matches never overlap and stay ordered", { "PR-07n": "full" }, () => {
  const m = findAll("aaa", "aa", "literal");
  if (m.length !== 1) throw new Error(`'aa' in 'aaa' → ${m.length} matches, want 1 (no overlap)`);
  const many = findAll(SAMPLE, "o", "literal");
  for (let i = 1; i < many.length; i++) {
    if (many[i].start < many[i - 1].end) throw new Error("overlapping matches");
  }
  let threw = false;
  try { findAll(SAMPLE, "x".repeat(MAX_QUERY_LENGTH + 1), "literal"); } catch { threw = true; }
  if (!threw) throw new Error("findAll must refuse an over-long query");
});

await test("PR-07n · an over-long query is refused with a reason", { "PR-07n": "full" }, () => {
  const s = createFind(SAMPLE, "x".repeat(MAX_QUERY_LENGTH + 1), "literal");
  if (!s.error) throw new Error("over-long query must be reported");
  if (s.matches.length) throw new Error("over-long query must yield no matches");
});

await test("PR-07n · replaceAll is literal: $& is not special", { "PR-07n": "full" }, () => {
  const res = replaceAll("price: X and Y", "X", "$5", "literal");
  if (res.text !== "price: $5 and Y") throw new Error(`replacement was interpreted: ${res.text}`);
  if (res.count !== 1) throw new Error("count wrong");
  const two = replaceAll("a a a", "a", "b", "literal");
  if (two.text !== "b b b" || two.count !== 3) throw new Error(`replaceAll → ${two.text} (${two.count})`);
  let threw = false;
  try { replaceAll("abc", "", "x", "literal"); } catch { threw = true; }
  if (!threw) throw new Error("empty query must be refused");
  const one = replaceOne("a a a", "a", "Z", "literal", 1);
  if (one.text !== "a Z a") throw new Error(`replaceOne → ${one.text}`);
  if (replaceOne("a", "a", "Z", "literal", 9).count !== 0) throw new Error("out-of-range replace must be a no-op");
});

await test("PR-07n · highlight segments reconstruct the original text exactly", { "PR-07n": "full" }, () => {
  const s = setCurrentIndex(createFind(SAMPLE, "fox", "literal"), 1);
  const segs = highlightSegments(SAMPLE, s);
  if (segs.map((x) => x.text).join("") !== SAMPLE) throw new Error("segments do not reconstruct the text");
  const active = segs.filter((x) => x.active);
  if (active.length !== 1) throw new Error(`expected exactly one active highlight, got ${active.length}`);
  const ranges = highlightRanges(s);
  if (ranges.filter((r) => r.active).length !== 1) throw new Error("highlightRanges active flag wrong");
  if (!describeFind(s).match(/^\d+ of \d+$/)) throw new Error(`describeFind format: ${describeFind(s)}`);
});

// ══ PR-10 · timer / stopwatch ════════════════════════════════════════════

await test("PR-10 · timer runs to completion and latches alarm", { "PR-10": "full" }, () => {
  let c = createClock("timer", 5000);
  c = startClock(c);
  c = tickClock(c, 3000, 0);
  if (timerRemaining(c) !== 2000) throw new Error(`remaining ${timerRemaining(c)}`);
  c = tickClock(c, 6000, 3000);
  if (!c.alarmed) throw new Error("alarm did not latch");
  if (c.running) throw new Error("a finished timer must stop");
  if (timerRemaining(c) !== 0) throw new Error("remaining must floor at 0");
  if (startClock(c).running) throw new Error("an alarmed timer must not restart without reset");
  const reset = resetClock(c);
  if (reset.alarmed || reset.elapsed !== 0) throw new Error("reset did not clear the latch");
});

await test("PR-10 · a resumed tab catches up exactly (no drift)", { "PR-10": "full" }, () => {
  // The browser suspends the tab for 30 s; one tick on resume must account for it.
  let c = startClock(createClock("stopwatch"));
  c = tickClock(c, 100, 0);
  c = tickClock(c, 30100, 100);
  if (c.elapsed !== 30100) throw new Error(`elapsed ${c.elapsed}, want 30100`);
  // A clock that goes backwards must clamp, not go negative.
  const back = tickClock(c, 20000, 30100);
  if (back.elapsed !== 30100) throw new Error("backwards tick produced negative elapsed");
});

await test("PR-10 · pause freezes; lap splits are exact", { "PR-10": "full" }, () => {
  let c = startClock(createClock("stopwatch"));
  c = tickClock(c, 1500, 0);
  c = lapClock(c);
  c = tickClock(c, 4000, 1500);
  c = lapClock(c);
  c = pauseClock(c);
  const frozen = c.elapsed;
  c = tickClock(c, 9000, 4000);
  if (c.elapsed !== frozen) throw new Error("paused clock advanced");
  const diffs = getLapDiffs(c);
  if (diffs[0] !== 1500 || diffs[1] !== 2500) throw new Error(`splits ${diffs}`);
  const fast = getFastestLap(c);
  if (fast?.index !== 0 || fast.ms !== 1500) throw new Error(`fastest ${JSON.stringify(fast)}`);
  if (getSlowestLap(c)?.index !== 1) throw new Error("slowest lap wrong");
  // 100 lap cap.
  let many = startClock(createClock("stopwatch"));
  for (let i = 0; i < 120; i++) many = lapClock(many);
  if (many.lapTimes.length !== 100) throw new Error(`lap cap → ${many.lapTimes.length}`);
});

await test("PR-10 · duration bounds and extend", { "PR-10": "full" }, () => {
  for (const bad of [0, -1, MAX_DURATION_MS + 1]) {
    let threw = false;
    try { createClock("timer", bad); } catch { threw = true; }
    if (!threw) throw new Error(`duration ${bad} accepted`);
  }
  let c = startClock(createClock("timer", 60000));
  c = extendTimer(c, 60000);
  if (c.duration !== 120000) throw new Error("extend did not add");
  let threw = false;
  try { extendTimer(c, -120000); } catch { threw = true; }
  if (!threw) throw new Error("extending to a non-positive duration must throw");
  if (toggleClock(startClock(createClock("stopwatch"))).running) throw new Error("toggle did not pause");
});

await test("PR-10 · formatTime is exact at boundaries", { "PR-10": "full" }, () => {
  const cases: Array<[number, string]> = [
    [0, "0:00.00"],
    [999, "0:00.99"],
    [1000, "0:01.00"],
    [59999, "0:59.99"],
    [60000, "1:00.00"],
    [3661500, "1:01:01.50"],
    [-1500, "-0:01.50"],
  ];
  for (const [ms, want] of cases) {
    if (formatTime(ms) !== want) throw new Error(`formatTime(${ms}) → ${formatTime(ms)}, want ${want}`);
  }
  if (!describeClock(startClock(createClock("timer", 5000))).includes("running")) throw new Error("describeClock");
  if (timerProgress(createClock("timer", 1000)) !== 0) throw new Error("progress at 0");
});

// ══ CK-01 · recurring alarms ═════════════════════════════════════════════

await test("CK-01 · daily alarm computes the next local wall-clock occurrence", { "CK-01": "full" }, () => {
  // 2024-01-01T10:00:00Z. Alarm at 09:00 local with a 0 offset has passed today.
  const base = Date.UTC(2024, 0, 1, 10, 0, 0);
  const next = nextFireTime({ kind: "daily", hour: 9, minute: 0 }, base, 0);
  if (next !== Date.UTC(2024, 0, 2, 9, 0, 0)) throw new Error(`daily next → ${new Date(next!).toISOString()}`);
  // At 08:00 the same alarm is later today.
  const early = Date.UTC(2024, 0, 1, 8, 0, 0);
  const soon = nextFireTime({ kind: "daily", hour: 9, minute: 0 }, early, 0);
  if (soon !== Date.UTC(2024, 0, 1, 9, 0, 0)) throw new Error("daily today → wrong");
  // A negative offset (UTC-5) must shift the wall clock, not the UTC hour.
  // 10:00Z is 05:00 local at UTC-5, so 09:00 local is still TODAY, at 14:00Z.
  // (Getting this backwards is the classic DST/offset sign error.)
  const tzNext = nextFireTime({ kind: "daily", hour: 9, minute: 0 }, base, -300);
  if (tzNext !== Date.UTC(2024, 0, 1, 14, 0, 0)) throw new Error(`tz daily → ${new Date(tzNext!).toISOString()}`);
  // Sanity: the result, converted back to local, is 09:00.
  const localHour = new Date(tzNext! - 5 * 3600000).getUTCHours();
  if (localHour !== 9) throw new Error(`tz result is local hour ${localHour}, want 9`);
});

await test("CK-01 · weekly alarm respects the day set", { "CK-01": "full" }, () => {
  // 2024-01-01 is a Monday (dow 1). Ask for Wednesday (3) and Friday (5) at 07:30.
  const base = Date.UTC(2024, 0, 1, 12, 0, 0);
  const next = nextFireTime({ kind: "weekly", hour: 7, minute: 30, days: [3, 5] }, base, 0);
  const d = new Date(next!);
  if (d.getUTCDay() !== 3 || d.getUTCHours() !== 7) throw new Error(`weekly next → ${d.toISOString()}`);
  if (nextFireTime({ kind: "weekly", hour: 7, minute: 30, days: [] }, base, 0) !== null) {
    throw new Error("an empty day set can never fire");
  }
  let threw = false;
  try { nextFireTime({ kind: "weekly", hour: 7, minute: 0, days: [9] }, base, 0); } catch { threw = true; }
  if (!threw) throw new Error("day 9 must be rejected");
});

await test("CK-01 · a slept-through schedule fires once, not N times", { "CK-01": "full" }, () => {
  let st = addAlarm(createAlarmState(), { id: "a", label: "wake", recurrence: { kind: "daily", hour: 7, minute: 0 } }, Date.UTC(2024, 0, 1, 0, 0, 0));
  // Device asleep for three days; check whether it fires at t = day 3.
  const threeDaysLater = Date.UTC(2024, 0, 4, 8, 0, 0);
  const once = fireDueAlarms(st, threeDaysLater);
  if (once.fired.length !== 1) throw new Error(`fired ${once.fired.length} times, want 1`);
  const again = fireDueAlarms(once.state, threeDaysLater);
  if (again.fired.length !== 0) throw new Error("alarm fired twice for the same due time");
  if (once.state.alarms[0].nextAt! <= threeDaysLater) throw new Error("daily alarm did not reschedule forward");
  if (once.state.log.length !== 1) throw new Error("fire log not recorded");
  void st;
});

await test("CK-01 · once alarms finish; snooze re-arms; disable clears", { "CK-01": "full" }, () => {
  const t0 = 1_000_000;
  let st = addAlarm(createAlarmState(), { id: "once", label: "ping", recurrence: { kind: "once", at: t0 + 1000 } }, t0);
  const due = fireDueAlarms(st, t0 + 2000);
  if (due.fired.length !== 1) throw new Error("once alarm did not fire");
  if (due.state.alarms[0].enabled) throw new Error("a once alarm must disable after firing");
  if (due.state.alarms[0].nextAt !== null) throw new Error("a fired once alarm has no next time");

  st = addAlarm(createAlarmState(), { id: "d", label: "daily", recurrence: { kind: "daily", hour: 7, minute: 0 } }, t0);
  const snoozed = snoozeAlarm(st, "d", 10, t0);
  if (snoozed.alarms[0].snoozedUntil !== t0 + 600000) throw new Error("snooze did not set +10 min");
  const fired = fireDueAlarms(snoozed, t0 + 600001);
  if (fired.fired.length !== 1) throw new Error("snoozed alarm did not fire");
  if (fired.state.alarms[0].snoozedUntil !== undefined) throw new Error("snooze not cleared after firing");

  const off = setAlarmEnabled(st, "d", false, t0);
  if (off.alarms[0].nextAt !== null) throw new Error("disabled alarm kept a next time");
  if (fireDueAlarms(off, t0 + 10 * 86400000).fired.length !== 0) throw new Error("disabled alarm fired");
  if (removeAlarm(st, "d").alarms.length !== 0) throw new Error("removeAlarm");
  if (upcomingAlarms(st).length !== 1) throw new Error("upcomingAlarms");
});

await test("CK-01 · adversarial: duplicate id, bad label, bad snooze", { "CK-01": "full" }, () => {
  let st = addAlarm(createAlarmState(), { id: "a", label: "x", recurrence: { kind: "daily", hour: 1, minute: 0 } }, 0);
  let threw = false;
  try { addAlarm(st, { id: "a", label: "y", recurrence: { kind: "daily", hour: 2, minute: 0 } }, 0); } catch { threw = true; }
  if (!threw) throw new Error("duplicate id accepted");
  threw = false;
  try { addAlarm(createAlarmState(), { id: "b", label: "z".repeat(200), recurrence: { kind: "daily", hour: 1, minute: 0 } }, 0); } catch { threw = true; }
  if (!threw) throw new Error("over-long label accepted");
  for (const bad of [0, -5, 24 * 60 + 1]) {
    threw = false;
    try { snoozeAlarm(st, "a", bad, 0); } catch { threw = true; }
    if (!threw) throw new Error(`snooze ${bad} accepted`);
  }
  threw = false;
  try { nextFireTime({ kind: "daily", hour: 24, minute: 0 }, 0); } catch { threw = true; }
  if (!threw) throw new Error("hour 24 accepted");
});

// ══ SC-05 · privacy dashboard ════════════════════════════════════════════

await test("SC-05 · ledger records modules with real reasons", { "SC-05": "full" }, () => {
  let d = createPrivacyDashboard();
  d = addPrivacyEntry(d, "Notes", ["local-storage"], true, "Stores notes on this device");
  d = addPrivacyEntry(d, "Photos", ["file-handles", "local-storage"], true, "Reads images the user picks");
  let threw = false;
  try { addPrivacyEntry(d, "X", ["local-storage"], true, "   "); } catch { threw = true; }
  if (!threw) throw new Error("a blank reason must be refused");
  threw = false;
  try { addPrivacyEntry(d, "X", ["telepathy" as never], true, "r"); } catch { threw = true; }
  if (!threw) throw new Error("an unknown data class must be refused");
  if (DATA_TYPES.length < 10) throw new Error("data class list too short to be useful");
  const rep = privacyReport(d);
  if (rep.totalModules !== 2 || rep.allowedModules !== 2) throw new Error(`report ${JSON.stringify(rep)}`);
});

await test("SC-05 · global opt-out is reversible and non-destructive", { "SC-05": "full" }, () => {
  let d = createPrivacyDashboard();
  d = addPrivacyEntry(d, "Camera", ["camera"], true, "Video calls");
  d = addPrivacyEntry(d, "Notes", ["local-storage"], true, "Local notes");
  const off = setGlobalOptOut(d, true);
  if (effectiveAllowed(off, "Camera")) throw new Error("opt-out did not deny");
  const back = setGlobalOptOut(off, false);
  if (!effectiveAllowed(back, "Camera")) throw new Error("per-module grant was destroyed by the master switch");
  if (privacyReport(off).allowedModules !== 0) throw new Error("opt-out report wrong");
  const revoked = setPrivacyAllowed(d, "Camera", false);
  if (effectiveAllowed(revoked, "Camera")) throw new Error("revoke did not apply");
  let threw = false;
  try { setPrivacyAllowed(d, "Nope", true); } catch { threw = true; }
  if (!threw) throw new Error("granting an unknown module must throw");
});

await test("SC-05 · audit finds sole holders and blocked capabilities", { "SC-05": "full" }, () => {
  let d = createPrivacyDashboard();
  d = addPrivacyEntry(d, "Calls", ["microphone", "camera"], true, "Video calls");
  d = addPrivacyEntry(d, "Notes", ["local-storage"], true, "Local notes");
  const a = privacyAudit(d);
  const mic = a.entries.find((e) => e.dataType === "microphone");
  if (!mic) throw new Error("microphone missing from audit");
  if (mic.grantedTo.join() !== "Calls") throw new Error("grantedTo wrong");
  const sole = privacyReport(d).soleHolders;
  if (sole.length !== 3) throw new Error(`sole holders → ${JSON.stringify(sole)}`);
  if (!sole.every((x) => x.module === "Calls" || x.module === "Notes")) throw new Error("wrong sole holder module");
  const blocked = privacyAudit(setGlobalOptOut(d, true));
  if (!blocked.blocked.length) throw new Error("opt-out must surface a blocked capability");
});

// ══ SC-07 · encrypted containers ═════════════════════════════════════════

await test("SC-07 · lifecycle: sealed → unlocked → locked → sealed", { "SC-07": "full" }, () => {
  let c = createContainer("Vault", 1024, 1000);
  if (c.phase !== "sealed") throw new Error("new container must be sealed");
  const good = (pw: string) => pw === "correct horse";
  c = unlockContainer(c, "correct horse", 2000, good).container;
  if (c.phase !== "unlocked") throw new Error("unlock failed");
  if (c.lastUnlock !== 2000) throw new Error("lastUnlock not stamped");
  c = lockContainer(c);
  if (c.phase !== "locked") throw new Error("lock failed");
  c = sealContainer(c, "a".repeat(64), "beef");
  if (c.phase !== "sealed") throw new Error("seal failed");
  if (c.sealedHash !== "a".repeat(64)) throw new Error("hash not stored");
  if (!containerStatus(c).toLowerCase().includes("sealed")) throw new Error("status text");
  let threw = false;
  try { sealContainer({ ...c, phase: "unlocked", sealedHash: "a".repeat(64) }, "b".repeat(64)); } catch { threw = true; }
  if (!threw) throw new Error("sealing while unlocked must be refused");
});

await test("SC-07 · rate limiting counts failures, not successes", { "SC-07": "full" }, () => {
  let c = createContainer("V", 10, 0);
  const deny = () => false;
  // Five SUCCESSFUL unlocks must not lock the container out.
  let ok = c;
  for (let i = 0; i < 6; i++) {
    const r = unlockContainer(ok, "pw", i, () => true);
    if (!r.ok) throw new Error(`success #${i} rejected: ${r.reason}`);
    ok = lockContainer(r.container);
  }
  // Five FAILURES must.
  let bad = c;
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    const r = unlockContainer(bad, "pw", i, deny);
    if (r.ok) throw new Error("wrong password accepted");
    bad = r.container;
  }
  const locked = unlockContainer(bad, "pw", 99, () => true);
  if (locked.ok) throw new Error("lockout did not apply");
  if (!locked.lockedOut) throw new Error("lockedOut flag missing");
  if (!/locked out/i.test(locked.reason)) throw new Error(`reason: ${locked.reason}`);
});

await test("SC-07 · a throwing verifier is a failed attempt, not a crash", { "SC-07": "full" }, () => {
  const c = createContainer("V", 10, 0);
  const r = unlockContainer(c, "pw", 0, () => { throw new Error("AEAD failure"); });
  if (r.ok) throw new Error("a throwing verifier was treated as success");
  if (r.container.failedAttempts !== 1) throw new Error("failure not counted");
});

await test("SC-07 · destroyed is terminal; auto-lock respects idle", { "SC-07": "full" }, () => {
  let c = createContainer("V", 10, 0);
  c = destroyContainer(c);
  const r = unlockContainer(c, "pw", 0, () => true);
  if (r.ok) throw new Error("destroyed container opened");
  if (c.sealedHash !== undefined) throw new Error("destroy left the hash behind");
  let live = unlockContainer(createContainer("V", 10, 0), "pw", 0, () => true).container;
  if (autoLock(live, 1000, 5000).phase !== "unlocked") throw new Error("locked too early");
  if (autoLock(live, 6000, 5000).phase !== "locked") throw new Error("auto-lock did not fire");
  if (!containerCaveats().length) throw new Error("caveats must be stated");
  let threw = false;
  try { sealContainer(createContainer("V", 10, 0), "nothex"); } catch { threw = true; }
  if (!threw) throw new Error("a non-hex hash must be refused");
});

// ══ RG-01 · load governor ════════════════════════════════════════════════

const sample = (frameLoad: number, lag: number, heap: number, at: number) => ({ frameLoad, eventLoopLagMs: lag, heapPressure: heap, at });

await test("RG-01 · composite pressure is bounded and monotone", { "RG-01": "full" }, () => {
  if (compositePressure(sample(0, 0, 0, 0)) !== 0) throw new Error("zero load must be zero");
  const max = compositePressure(sample(1, 1000, 1, 0));
  if (Math.abs(max - 1) > 1e-9) throw new Error(`saturated pressure ${max}, want 1`);
  const mid = compositePressure(sample(0.5, 100, 0.5, 0));
  if (!(mid > 0.3 && mid < 0.7)) throw new Error(`mid pressure ${mid}`);
  // Clamping: absurd inputs cannot exceed 1 or go below 0.
  if (compositePressure(sample(5, 5000, 9, 0)) !== 1) throw new Error("over-range must clamp to 1");
  if (compositePressure(sample(-5, -100, -1, 0)) !== 0) throw new Error("under-range must clamp to 0");
});

await test("RG-01 · hysteresis prevents oscillation at a fixed load", { "RG-01": "full" }, () => {
  let g = createLoadGovernor(0);
  // Sits exactly between enterAt.hot (0.60) and leaveAt.hot (0.45): settle once.
  const between = sample(0.5, 100, 0.5, 0);
  const p = compositePressure(between);
  for (let t = 0; t < 60_000; t += 500) {
    g = applyLoadSample(g, { ...between, at: t });
  }
  const transitionsAtSteady = g.transitions.length;
  if (transitionsAtSteady > 4) {
    throw new Error(`oscillated ${transitionsAtSteady} times at a constant load`);
  }
  if (p > DEFAULT_THRESHOLDS.enterAt.hot) throw new Error("test fixture is not actually in the band");
});

await test("RG-01 · sustained pressure rises; unloading falls", { "RG-01": "full" }, () => {
  let g = createLoadGovernor(0);
  for (let t = 0; t <= 20_000; t += 500) {
    g = applyLoadSample(g, sample(0.9, 190, 0.9, t));
  }
  if (g.level !== "critical" && g.level !== "throttled") throw new Error(`heavy load → ${g.level}`);
  if (!isThrottled(g)) throw new Error("isThrottled false under heavy load");
  const heavy = g.level;
  for (let t = 21_000; t <= 40_000; t += 500) {
    g = applyLoadSample(g, sample(0.02, 2, 0.1, t));
  }
  if (g.level === heavy) throw new Error("level did not recover after unload");
  if (throttlePolicy(g.level).maxFps !== 60) throw new Error("recovered level still throttles fps");
});

await test("RG-01 · a single spike does not act (dwell time)", { "RG-01": "full" }, () => {
  let g = createLoadGovernor(0);
  for (let t = 0; t <= 4000; t += 500) g = applyLoadSample(g, sample(0.05, 5, 0.1, t));
  const before = g.level;
  // One critical sample immediately after a transition.
  g = applyLoadSample(g, sample(1, 500, 1, 4500));
  if (g.level === "critical") throw new Error("a single spike jumped straight to critical");
  void before;
});

await test("RG-01 · throttle policy is monotone across levels", { "RG-01": "full" }, () => {
  const levels = ["cool", "warm", "hot", "throttled", "critical"] as const;
  let prevFps = Infinity;
  let prevTasks = Infinity;
  let prevCache = Infinity;
  for (const l of levels) {
    const p = throttlePolicy(l);
    if (p.maxFps > prevFps) throw new Error(`fps rose at ${l}`);
    if (p.maxConcurrentTasks > prevTasks) throw new Error(`tasks rose at ${l}`);
    if (p.cacheEntries > prevCache) throw new Error(`cache rose at ${l}`);
    prevFps = p.maxFps;
    prevTasks = p.maxConcurrentTasks;
    prevCache = p.cacheEntries;
  }
  if (throttlePolicy("critical").allowDecoration) throw new Error("decoration allowed at critical");
});

await test("RG-02 · scheduling hints defer heavy work under pressure", { "RG-02": "full" }, () => {
  let g = createLoadGovernor(0);
  for (let t = 0; t <= 20_000; t += 500) g = applyLoadSample(g, sample(1, 300, 1, t));
  const heavy = schedulingHint(g, "heavy");
  if (heavy.runNow) throw new Error("heavy work ran during critical load");
  if (!heavy.reason) throw new Error("a deferral needs a reason the UI can show");
  const user = schedulingHint(g, "heavy", true);
  if (!user.runNow) throw new Error("user-initiated work must not be deferred");
  const cool = createLoadGovernor(0);
  if (!schedulingHint(cool, "light").runNow) throw new Error("light work should run on a cool system");
});

await test("RG-04 · resource report distinguishes spiky from steady", { "RG-04": "full" }, () => {
  let steady = createLoadGovernor(0);
  for (let t = 0; t < 10_000; t += 500) steady = applyLoadSample(steady, sample(0.3, 20, 0.3, t));
  const flat = resourceReport(steady);
  if (flat.spiky) throw new Error("steady load called spiky");
  let jumpy = createLoadGovernor(0);
  for (let t = 0; t < 10_000; t += 500) jumpy = applyLoadSample(jumpy, sample(t % 2000 === 0 ? 0.95 : 0.05, 10, 0.2, t));
  const spiky = resourceReport(jumpy);
  if (!spiky.spiky) throw new Error(`peaks vs average not detected: peak ${spiky.frameLoadPeak} avg ${spiky.frameLoadAvg}`);
  const empty = resourceReport(createLoadGovernor(0));
  if (empty.sampleCount !== 0 || empty.spiky) throw new Error("empty report wrong");
  if (!describeGovernor(steady).includes("cool")) throw new Error("describeGovernor");
});

await test("RG-06 · low-memory mode degrades explicitly", { "RG-06": "full" }, () => {
  const normal = memoryPolicy(0.2, 4096);
  if (normal.enabled) throw new Error("normal memory flagged");
  const tight = memoryPolicy(0.9, 4096);
  if (!tight.enabled) throw new Error("high heap pressure did not enable the mode");
  if (tight.imageCacheEntries >= normal.imageCacheEntries) throw new Error("cache did not shrink");
  if (!tight.degraded.length) throw new Error("must name what degrades");
  if (!tight.unaffected.length) throw new Error("must name what still works");
  if (!memoryPolicy(0.1, 128).enabled) throw new Error("a small heap must enable the mode regardless of pressure");
  for (const bad of [-0.1, 1.5]) {
    let threw = false;
    try { memoryPolicy(bad, 4096); } catch { threw = true; }
    if (!threw) throw new Error(`heap pressure ${bad} accepted`);
  }
});

// ══ HW-02 · worker pool ══════════════════════════════════════════════════

await test("HW-02 · CPU-bound pool leaves a core for the main thread", { "HW-02": "full" }, () => {
  const plan = planPool(4, { medianMs: 100, peakBytes: 1e6, cpuShare: 0.9, parallelizable: true });
  if (plan.poolSize !== 3) throw new Error(`pool ${plan.poolSize}, want 3`);
  if (plan.strategy !== "work-stealing") throw new Error("strategy");
  const io = planPool(4, { medianMs: 100, peakBytes: 1e5, cpuShare: 0.1, parallelizable: true });
  if (io.poolSize !== 8) throw new Error(`I/O pool ${io.poolSize}, want 8`);
  const single = planPool(4, { medianMs: 100, peakBytes: 1e5, cpuShare: 0.5, parallelizable: false });
  if (single.poolSize !== 1 || single.strategy !== "fifo") throw new Error("non-parallel must be a single FIFO worker");
});

await test("HW-02 · memory budget and load level can veto the plan", { "HW-02": "full" }, () => {
  const vetoed = planPool(8, { medianMs: 100, peakBytes: 1e8, cpuShare: 0.9, parallelizable: true }, { memoryBudgetBytes: 2.5e8 });
  if (vetoed.poolSize !== 2) throw new Error(`memory veto → ${vetoed.poolSize}, want 2`);
  if (!vetoed.notes.some((n) => /memory/i.test(n))) throw new Error("the veto must be explained");
  const starved = planPool(8, { medianMs: 100, peakBytes: 1e9, cpuShare: 0.9, parallelizable: true }, { memoryBudgetBytes: 1e6 });
  if (starved.poolSize !== 1) throw new Error("a budget below one task must force pool size 1");
  const throttled = planPool(8, { medianMs: 100, peakBytes: 1e5, cpuShare: 0.9, parallelizable: true }, { loadLevel: "critical" });
  if (throttled.poolSize >= 7) throw new Error("critical load did not shrink the pool");
});

await test("HW-02 · realistic throughput is below the ideal (Amdahl honesty)", { "HW-02": "full" }, () => {
  const p = planPool(8, { medianMs: 50, peakBytes: 1e5, cpuShare: 0.6, parallelizable: true });
  if (p.realisticThroughputPerSec > p.idealThroughputPerSec) throw new Error("realistic exceeded ideal");
  if (p.speedup <= 1) throw new Error(`speedup ${p.speedup} should beat a single thread`);
  if (p.speedup >= p.poolSize) throw new Error("speedup claimed perfect scaling");
  if (p.maxQueueDepth < p.poolSize) throw new Error("queue smaller than the pool");
  for (const bad of [0, -1, 2.5]) {
    let threw = false;
    try { planPool(bad, { medianMs: 10, peakBytes: 1, cpuShare: 0.5, parallelizable: true }); } catch { threw = true; }
    if (!threw) throw new Error(`hardwareConcurrency ${bad} accepted`);
  }
  let threw = false;
  try { planPool(4, { medianMs: 0, peakBytes: 1, cpuShare: 0.5, parallelizable: true }); } catch { threw = true; }
  if (!threw) throw new Error("medianMs 0 accepted");
  if (planPool(64, { medianMs: 10, peakBytes: 1, cpuShare: 0.1, parallelizable: true }).poolSize > MAX_WORKERS) {
    throw new Error("worker cap exceeded");
  }
});

await test("HW-02 · measured stats compute exact mean, not an average of means", { "HW-02": "full" }, () => {
  let s = createPoolStats();
  s = recordEnqueue(s);
  s = recordEnqueue(s);
  s = recordStart(s);
  s = recordCompletion(s, 100, true);
  s = recordStart(s);
  s = recordCompletion(s, 300, false);
  const sum = statsSummary(s);
  if (sum.meanMs !== 200) throw new Error(`mean ${sum.meanMs}, want 200`);
  if (Math.abs(sum.failureRate - 0.5) > 1e-9) throw new Error("failure rate");
  if (s.maxQueueSeen !== 2) throw new Error("max queue not tracked");
  if (s.queued !== 0) throw new Error("queue did not drain");
});

// ══ HW-05 · audio budget ═════════════════════════════════════════════════

await test("HW-05 · latency budget adds up and classifies honestly", { "HW-05": "full" }, () => {
  const tight = audioBudget({ baseLatencySec: 0.003, outputLatencySec: 0.01, sampleRate: 48000, bufferFrames: 128, costPerVoice: 0.02 });
  if (Math.abs(tight.totalLatencySec - (0.003 + 0.01 + 128 / 48000)) > 1e-12) throw new Error("latency sum wrong");
  // 128 frames ≈ 2.67 ms buffer, plus 13 ms of device lag = ~15.7 ms, which is
  // "acceptable" (<=40 ms) but not "tight" (<=10 ms). Assert the arithmetic.
  const wantBand = tight.totalLatencySec <= 0.010 ? "tight" : tight.totalLatencySec <= 0.040 ? "acceptable" : "laggy";
  if (tight.perceivedAs !== wantBand) throw new Error(`band ${tight.perceivedAs}, arithmetic says ${wantBand}`);
  if (tight.lookaheadFrames !== Math.round((128 / 48000) * 48000)) throw new Error("lookahead wrong");
  const laggy = audioBudget({ baseLatencySec: 0.02, outputLatencySec: 0.03, sampleRate: 44100, bufferFrames: 2048, costPerVoice: 0.02 });
  if (laggy.perceivedAs !== "laggy") throw new Error(`2048 frames should be laggy, got ${laggy.perceivedAs}`);
  if (!laggy.notes.some((n) => /256/.test(n))) throw new Error("buffer advice missing");
});

await test("HW-05 · voice count shrinks with convolvers", { "HW-05": "full" }, () => {
  const plain = audioBudget({ baseLatencySec: 0.005, outputLatencySec: 0.01, sampleRate: 48000, bufferFrames: 256, costPerVoice: 0.05 });
  const reverbed = audioBudget({ baseLatencySec: 0.005, outputLatencySec: 0.01, sampleRate: 48000, bufferFrames: 256, costPerVoice: 0.05, convolverCount: 3 });
  if (reverbed.safeVoices >= plain.safeVoices) throw new Error("convolvers did not reduce the voice budget");
  if (reverbed.safeVoices < 0) throw new Error("voice count went negative");
  for (const bad of [8000, 0]) {
    let threw = false;
    try { audioBudget({ baseLatencySec: 0, outputLatencySec: 0, sampleRate: bad, bufferFrames: 256, costPerVoice: 0.05 }); } catch { threw = true; }
    if (!threw) throw new Error(`sample rate ${bad} accepted`);
  }
});

// ══ AX-07 · captions ═════════════════════════════════════════════════════

await test("AX-07 · cue model enforces the floor and no overlaps", { "AX-07": "full" }, () => {
  let t = createCaptionTrack("en");
  t = addCue(t, { start: 0, end: 2000, text: "Hello there." });
  if (t.cues.length !== 1) throw new Error("cue not added");
  let threw = false;
  try { addCue(t, { start: 1000, end: 3000, text: "Overlap" }); } catch { threw = true; }
  if (!threw) throw new Error("overlapping cue accepted");
  threw = false;
  try { addCue(t, { start: 3000, end: 3200, text: "Flash" }); } catch { threw = true; }
  if (!threw) throw new Error(`a ${200} ms cue was accepted below the ${MIN_CUE_MS} ms floor`);
  threw = false;
  try { addCue(t, { start: 3000.5 as never, end: 5000, text: "Fractional" }); } catch { threw = true; }
  if (!threw) throw new Error("fractional millisecond cue accepted");
  if (activeCue(t, 1500)?.text !== "Hello there.") throw new Error("activeCue lookup");
  if (activeCue(t, 2500) !== null) throw new Error("activeCue must be null in a gap");
});

await test("AX-07 · wrapping respects the two-line rule", { "AX-07": "full" }, () => {
  const style = { maxCharsPerLine: 20, maxLines: 2, position: "bottom" as const, backgroundOpacity: 0.75 };
  const lines = wrapCue("one two three four five six seven eight", style);
  if (lines.length > 2) throw new Error(`wrapped to ${lines.length} lines`);
  for (const l of lines) if (l.length > 20) throw new Error(`line over 20 chars: "${l}"`);
  const single = wrapCue("short", style);
  if (single.join(" ") !== "short") throw new Error("short text was wrapped");
  // A word longer than the line must be split, not overflow. Two lines of 20
  // is all the style allows, so 40 characters fit and the remaining 10 are
  // dropped on purpose: overflowing the line budget is the worse failure.
  const long = wrapCue("a".repeat(50), style);
  if (long.some((l) => l.length > 20)) throw new Error(`over-long word overflowed: ${long.map((l) => l.length)}`);
  if (long.length > 2) throw new Error("line budget exceeded");
  if (long.join("").length !== 40) throw new Error(`expected 40 kept chars, got ${long.join("").length}`);
  // With enough lines, nothing is lost.
  const roomy = wrapCue("a".repeat(50), { ...style, maxLines: 4 });
  if (roomy.join("") !== "a".repeat(50)) throw new Error("hard split lost characters with room to spare");
});

await test("AX-07 · audit flags unreadable reading rate", { "AX-07": "full" }, () => {
  let t = createCaptionTrack("en");
  // 200 chars in 2 s = 100 chars/s, far past the 25 char/s ceiling.
  t = addCue(t, { start: 0, end: 2000, text: "x".repeat(200) });
  const audit = auditTrack(t, 60_000);
  if (audit.ok) throw new Error("an unreadable track passed the audit");
  if (audit.cues[0].charsPerSecond < READING_RATE.maximum) throw new Error("rate not computed");
  if (!audit.cues[0].problems.some((p) => /chars\/s/.test(p))) throw new Error(`problems ${audit.cues[0].problems}`);
  // A well-paced track passes.
  let good = createCaptionTrack("en");
  good = addCue(good, { start: 0, end: 3000, text: "A comfortable sentence here." });
  good = addCue(good, { start: 3400, end: 6400, text: "And another one after it." });
  const ok = auditTrack(good, 7000);
  if (!ok.ok) throw new Error(`good track failed: ${JSON.stringify(ok.trackProblems)} ${JSON.stringify(ok.cues.map((c) => c.problems))}`);
  if (ok.coveragePercent <= 0) throw new Error("coverage not computed");
});

await test("AX-07 · audit catches flicker gaps and past-the-end cues", { "AX-07": "full" }, () => {
  let t = createCaptionTrack("en");
  t = addCue(t, { start: 0, end: 2000, text: "First line of text." });
  t = addCue(t, { start: 2010, end: 4010, text: "Second line." });
  t = addCue(t, { start: 4010, end: 6010, text: "Third line." });
  const a = auditTrack(t, 5000);
  if (!a.cues[1].problems.some((p) => /flicker/.test(p))) throw new Error("a 10 ms gap must be flagged");
  if (!a.cues[2].problems.some((p) => /one cue/.test(p))) throw new Error("adjacent same-speaker cues must be merged");
  if (!a.cues[2].problems.some((p) => /past the media/.test(p))) throw new Error("cue past the end not flagged");
});

await test("AX-07 · WebVTT round-trip, including a voice span", { "AX-07": "full" }, () => {
  let t = createCaptionTrack("en");
  t = addCue(t, { start: 0, end: 2000, text: "Plain cue." });
  t = addCue(t, { start: 2500, end: 5000, text: "Spoken by someone.", speaker: "Ada" });
  const vtt = toWebVtt(t);
  if (!vtt.startsWith("WEBVTT")) throw new Error("missing header");
  if (!vtt.includes("00:00:00.000 --> 00:00:02.000")) throw new Error(`timestamp format: ${vtt}`);
  if (!vtt.includes("<v Ada>")) throw new Error("speaker span missing");
  const back = fromWebVtt(vtt);
  if (back.cues.length !== 2) throw new Error(`round-trip → ${back.cues.length} cues`);
  if (back.cues[1].speaker !== "Ada") throw new Error("speaker lost");
  if (back.cues[0].start !== 0 || back.cues[1].end !== 5000) throw new Error("timing lost");
  let threw = false;
  try { fromWebVtt("not a vtt"); } catch { threw = true; }
  if (!threw) throw new Error("non-VTT input accepted");
});

await test("AX-07 · autoTime weights by length, not by count", { "AX-07": "full" }, () => {
  const t = autoTime(["short", "a much much longer line of dialogue here"], 10_000);
  if (t.cues.length !== 2) throw new Error(`cues ${t.cues.length}`);
  const d0 = t.cues[0].end - t.cues[0].start;
  const d1 = t.cues[1].end - t.cues[1].start;
  if (d1 <= d0) throw new Error("the longer line did not get more time");
  if (t.cues[1].end > 10_000) throw new Error("autoTime ran past the media");
  const empty = autoTime([], 1000);
  if (empty.cues.length !== 0) throw new Error("empty input produced cues");
});

finish();
