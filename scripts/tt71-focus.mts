/**
 * TT71 NC-02 focus rules (src/lib/focus-rules.ts) — pure.
 *  1. parseRules rejects 18 malformed shapes, each with a message naming the rule; accepts and normalises a good list.
 *  2. inSchedule equals an independent oracle (minute-of-week intervals) on EVERY minute of the week for 60 schedules,
 *     incl. overnight, single-day, Sat→Sun wrap and 1-minute windows.
 *  3. localTime: DST jumps (New York spring/fall), half- and 45-minute offsets, unknown zone → UTC (flagged).
 *  4. decide: every active rule must let the alert through; the FIRST blocking rule is recorded; disabled, off-schedule,
 *     other-workspace and focus-mode-mismatch rules never hold; apps match case-insensitively; an unknown priority is
 *     treated as normal; no rules → always delivered.
 *  5. the reason sentence names the rule, its condition, the app and the priority.
 *  6. validateSetting uses the same parser for alerts.focusRules and checks alerts.timeZone with Intl.
 *  7. (repair) normalizeAlert: non-string app / title / body / groupKey and non-enum priorities are refused; blanks default.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt71-focus.mts
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { activeRules, decide, inSchedule, localTime, normalizeAlert, parseRules, type FocusContext, type FocusRule, type Schedule } from "../src/lib/focus-rules.ts";
import { validateSetting } from "../src/lib/settings-validate.ts";

const { test, finish } = makeHarness("tt71-focus");
const COV = { "NC-02": "full" } as const;

const ok = (json: unknown): FocusRule[] => { const r = parseRules(JSON.stringify(json)); if ("error" in r) throw new Error(r.error); return r.rules; };
const bad = (json: unknown) => { const r = parseRules(typeof json === "string" ? json : JSON.stringify(json)); assert.ok("error" in r, `accepted ${JSON.stringify(json)}`); return r.error; };
const base = { id: "a", name: "A" };

await test("parseRules rejects 18 malformed shapes with a message naming the rule; accepts and normalises a good list", COV, () => {
  const shapes: [unknown, RegExp][] = [
    ["{not json", /JSON/], [{ id: "a" }, /list/], [[1], /rule 1: not an object/], [[null], /not an object/], [[[]], /not an object/],
    [[{ name: "x" }], /id/], [[{ id: "Bad Id", name: "x" }], /id/], [[{ id: "a".repeat(33), name: "x" }], /id/],
    [[base, base], /rule 2: duplicate id a/], [[{ id: "a", name: "  " }], /name/], [[{ id: "a", name: "x".repeat(61) }], /name/],
    [[{ ...base, enabled: "yes" }], /enabled/], [[{ ...base, schedule: { days: [], from: "09:00", to: "10:00" } }], /days/],
    [[{ ...base, schedule: { days: [7], from: "09:00", to: "10:00" } }], /days/], [[{ ...base, schedule: { days: [1], from: "9:00", to: "10:00" } }], /HH:MM/],
    [[{ ...base, schedule: { days: [1], from: "24:00", to: "10:00" } }], /HH:MM/], [[{ ...base, schedule: { days: [1], from: "10:00", to: "10:00" } }], /equal/],
    [[{ ...base, workspaces: [0] }], /workspaces/], [[{ ...base, focusMode: 1 }], /focusMode/], [[{ ...base, allowApps: [""] }], /allowApps/],
    [[{ ...base, allowPriorities: ["urgent"] }], /allowPriorities/], [Array.from({ length: 33 }, (_, i) => ({ id: `r${i}`, name: "x" })), /at most 32/],
  ];
  assert.ok(shapes.length >= 18);
  for (const [j, re] of shapes) assert.match(bad(j), re, JSON.stringify(j).slice(0, 80));
  const [r] = ok([{ id: "night", name: " Night ", schedule: { days: [5, 1, 1], from: "22:00", to: "07:00" }, workspaces: [2, 2], allowApps: [" Planner "] }]);
  assert.deepEqual(r, { id: "night", name: "Night", enabled: true, schedule: { days: [1, 5], from: "22:00", to: "07:00" }, workspaces: [2], allowApps: ["Planner"], allowPriorities: ["high"] });
  assert.deepEqual(ok([{ ...base, workspaces: [] }])[0].workspaces, undefined, "an empty workspace list means any workspace");
  assert.deepEqual(ok([{ ...base, allowPriorities: [] }])[0].allowPriorities, [], "an explicit empty list = nothing breaks through");
  assert.deepEqual(parseRules(""), { rules: [] });
});

/** Oracle: a schedule is a set of half-open intervals on the 10080-minute week, one per listed start day. */
function oracle(s: Schedule, day: number, minute: number): boolean {
  const [fh, fm] = s.from.split(":").map(Number), [th, tm] = s.to.split(":").map(Number);
  const f = fh * 60 + fm, t = th * 60 + tm, len = t > f ? t - f : t + 1440 - f;
  const w = day * 1440 + minute;
  return s.days.some((d) => { const start = d * 1440 + f; return ((w - start) % 10080 + 10080) % 10080 < len; });
}

await test("inSchedule equals the minute-of-week oracle on every minute of the week for 60 schedules (incl. overnight, Sat→Sun)", COV, () => {
  let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const fixed: Schedule[] = [
    { days: [5], from: "22:00", to: "07:00" }, { days: [6], from: "23:59", to: "00:00" }, { days: [6], from: "20:00", to: "02:00" },
    { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" }, { days: [0], from: "00:00", to: "23:59" }, { days: [3], from: "12:00", to: "12:01" },
  ];
  const all = [...fixed];
  while (all.length < 60) {
    const f = rnd(1440); let t = rnd(1440); if (t === f) t = (t + 1) % 1440;
    const days = [...new Set(Array.from({ length: 1 + rnd(7) }, () => rnd(7)))];
    all.push({ days, from: hm(f), to: hm(t) });
  }
  let checked = 0, inside = 0;
  for (const s of all) for (let d = 0; d < 7; d++) for (let m = 0; m < 1440; m++) {
    const want = oracle(s, d, m); checked++; if (want) inside++;
    if (inSchedule(s, d, m) !== want) assert.fail(`${JSON.stringify(s)} at day ${d} ${hm(m)}: expected ${want}`);
  }
  assert.equal(checked, 60 * 10080);
  assert.ok(inside > 50000 && inside < checked - 50000, "the sample exercises both sides");
  assert.equal(inSchedule(fixed[0], 6, 6 * 60 + 59), true, "Fri 22:00–07:00 holds Saturday 06:59");
  assert.equal(inSchedule(fixed[0], 5, 6 * 60), false, "…but not Friday morning (that night belongs to Thursday)");
  assert.equal(inSchedule(fixed[2], 0, 60), true, "Sat 20:00–02:00 wraps into Sunday 01:00");
});

await test("localTime: New York DST jumps, +05:30 / +12:45 offsets, unknown zone falls back to UTC (flagged)", COV, () => {
  assert.deepEqual(localTime(new Date("2026-03-08T06:59:00Z"), "America/New_York"), { day: 0, minute: 1 * 60 + 59, zone: "America/New_York" });
  assert.deepEqual(localTime(new Date("2026-03-08T07:00:00Z"), "America/New_York"), { day: 0, minute: 3 * 60, zone: "America/New_York" }, "02:00 does not exist");
  assert.deepEqual(localTime(new Date("2026-11-01T05:30:00Z"), "America/New_York"), { day: 0, minute: 60 + 30, zone: "America/New_York" }, "first 01:30 (EDT)");
  assert.deepEqual(localTime(new Date("2026-11-01T06:30:00Z"), "America/New_York"), { day: 0, minute: 60 + 30, zone: "America/New_York" }, "second 01:30 (EST)");
  assert.deepEqual(localTime(new Date("2026-10-23T20:00:00Z"), "Asia/Kolkata"), { day: 6, minute: 90, zone: "Asia/Kolkata" }, "Fri 20:00Z = Sat 01:30 IST");
  assert.deepEqual(localTime(new Date("2026-07-01T00:00:00Z"), "Pacific/Chatham"), { day: 3, minute: 12 * 60 + 45, zone: "Pacific/Chatham" });
  assert.deepEqual(localTime(new Date("2026-07-01T00:00:00Z"), "Mars/Olympus"), { day: 3, minute: 0, zone: "UTC" });
  assert.deepEqual(localTime(new Date("2026-07-01T23:59:00Z"), ""), { day: 3, minute: 1439, zone: "UTC" });
  for (let h = 0; h < 48; h++) {
    const d = new Date(Date.UTC(2026, 9, 24, 0, 0) + h * 3_600_000 + 17 * 60_000);
    const t = localTime(d, "UTC"); assert.equal(t.day, d.getUTCDay()); assert.equal(t.minute, d.getUTCHours() * 60 + 17);
  }
});

const ctxAt = (iso: string, extra: Partial<FocusContext> = {}): FocusContext => ({ now: new Date(iso), timeZone: "America/New_York", activeWorkspace: 1, focusMode: false, ...extra });
// 2026-10-23 is a Friday; 23:30 New York = 2026-10-24T03:30Z
const FRI_NIGHT = "2026-10-24T03:30:00Z", FRI_NOON = "2026-10-23T16:00:00Z";

await test("decide: every active rule must let the alert through; the first blocking one is recorded; inactive rules never hold", COV, () => {
  const rules = ok([
    { id: "evening", name: "Evening", schedule: { days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" }, allowApps: ["planner"] },
    { id: "deep", name: "Deep work", workspaces: [2], allowPriorities: [] },
    { id: "film", name: "Film", focusMode: true, allowApps: ["Calls"], allowPriorities: ["high"] },
    { id: "off", name: "Off", enabled: false, allowPriorities: [] },
  ]);
  assert.deepEqual(decide([], { app: "X", priority: "low" }, ctxAt(FRI_NIGHT)), { deliver: true, active: [] });
  assert.deepEqual(decide(rules, { app: "Mail", priority: "normal" }, ctxAt(FRI_NOON)), { deliver: true, active: [] }, "nothing active at noon on ws 1");
  const night = ctxAt(FRI_NIGHT);
  assert.deepEqual(activeRules(rules, night).map((r) => r.id), ["evening"]);
  assert.equal(decide(rules, { app: "Mail", priority: "normal" }, night).deliver, false);
  assert.equal(decide(rules, { app: "PLANNER", priority: "low" }, night).deliver, true, "allow list is case-insensitive");
  assert.equal(decide(rules, { app: "Mail", priority: "high" }, night).deliver, true, "high breaks through by default");
  assert.equal(decide(rules, { app: "Mail", priority: "urgent" }, night).deliver, false, "unknown priority = normal");
  const ws2 = ctxAt(FRI_NIGHT, { activeWorkspace: 2 });
  const d = decide(rules, { app: "Mail", priority: "high" }, ws2);
  assert.equal(d.deliver, false, "Deep work lets nothing through, even high");
  if (!d.deliver) { assert.equal(d.rule.id, "deep"); assert.deepEqual(d.active, ["Evening", "Deep work"]); }
  const d2 = decide(rules, { app: "Mail", priority: "normal" }, ws2);
  if (d2.deliver) assert.fail("held"); else assert.equal(d2.rule.id, "evening", "the first blocking rule in list order is recorded");
  const film = ctxAt(FRI_NOON, { focusMode: true });
  assert.equal(decide(rules, { app: "calls", priority: "low" }, film).deliver, true);
  assert.equal(decide(rules, { app: "Mail", priority: "low" }, film).deliver, false);
  assert.equal(decide(rules, { app: "Mail", priority: "low" }, ctxAt(FRI_NOON, { focusMode: false })).deliver, true, "focus mode off → Film inactive");
  assert.equal(decide(rules, { app: "Mail", priority: "low" }, ctxAt(FRI_NIGHT, { timeZone: "UTC" })).deliver, false, "Sat 03:30 UTC is inside the Friday-night window");
  assert.equal(decide(rules, { app: "Mail", priority: "low" }, ctxAt("2026-10-25T03:30:00Z", { timeZone: "UTC" })).deliver, true, "Sun 03:30 UTC: Saturday is not a start day");
  assert.equal(decide(rules, { app: "Mail", priority: "low" }, ctxAt("2026-10-24T13:30:00Z", { timeZone: "Asia/Tokyo" })).deliver, true, "Sat 22:30 Tokyo: not a start day");
});

await test("the reason sentence names the rule, its condition, the app, what breaks through and the alert's priority", COV, () => {
  const rules = ok([{ id: "q", name: "Quiet hours", schedule: { days: [5], from: "22:00", to: "07:00" }, workspaces: [1], allowPriorities: ["high"] }]);
  const d = decide(rules, { app: "Mail", priority: "low" }, ctxAt(FRI_NIGHT));
  if (d.deliver) assert.fail("held");
  assert.equal(d.reason, "Held by focus rule “Quiet hours” (Fri 22:00–07:00 · workspace 1): Mail is not on its allow list and only high priority breaks through (this alert is low).");
  const none = decide(ok([{ id: "n", name: "Silence", allowPriorities: [] }]), { app: "Mail", priority: "high" }, ctxAt(FRI_NOON));
  if (none.deliver) assert.fail("held"); else assert.match(none.reason, /\(always\).*no priority breaks through \(this alert is high\)/);
});

await test("validateSetting: alerts.focusRules uses the same parser; alerts.timeZone is checked with Intl ('' = UTC)", COV, () => {
  assert.equal(validateSetting("alerts.focusRules", "[]"), null);
  assert.equal(validateSetting("alerts.focusRules", JSON.stringify([{ id: "a", name: "A" }])), null);
  assert.match(validateSetting("alerts.focusRules", "[{\"id\":\"a\"}]") ?? "", /name/);
  assert.match(validateSetting("alerts.focusRules", "nope") ?? "", /JSON/);
  for (const z of ["", "UTC", "America/New_York", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) assert.equal(validateSetting("alerts.timeZone", z), null, z);
  for (const z of ["Mars/Olympus", "America/New York", "../etc", "EST5EDT;rm"]) assert.ok(validateSetting("alerts.timeZone", z), z);
});

await test("repair: normalizeAlert refuses non-string fields and non-enum priorities (was: 500 / garbage stored); blanks default", COV, () => {
  assert.deepEqual(normalizeAlert({}), { value: { app: "Fusion", title: "Alert", body: "", priority: "normal", groupKey: "Fusion" } });
  assert.deepEqual(normalizeAlert({ app: "  Mail ", title: " Hi ", priority: "high" }), { value: { app: "Mail", title: "Hi", body: "", priority: "high", groupKey: "Mail" } });
  assert.deepEqual(normalizeAlert({ app: "   ", title: null }), { value: { app: "Fusion", title: "Alert", body: "", priority: "normal", groupKey: "Fusion" } });
  assert.equal((normalizeAlert({ app: "x".repeat(99) }) as { value: { app: string } }).value.app.length, 40);
  for (const b of [{ app: 5 }, { title: {} }, { body: [1] }, { groupKey: true }, { priority: ["high"] }, { priority: "urgent" }, { priority: "HIGH" }, { priority: 2 }]) {
    assert.ok("error" in normalizeAlert(b as Record<string, unknown>), JSON.stringify(b));
  }
});

finish();
