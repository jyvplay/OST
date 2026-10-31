/** Bounded alarm scheduler checks against an independently enumerated UTC
 * weekly calendar. These are pure tests, not browser or OS alarm delivery. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import type { Alarm } from "../src/lib/clock-core.ts";
import { planAlarmChecks } from "../src/lib/clock-alarm-plan.ts";
process.env.TZ = "UTC";
const { test, finish } = makeHarness("tt130-alarms-core");
const alarm = (over: Partial<Alarm> = {}): Alarm => ({ id: "a", label: "", time: "09:30", days: [], enabled: true, snoozeMin: 9, ...over });
await test("no enabled alarms means no repeating scheduler timer", { "CK-01": "partial" }, () => {
  const now = Date.UTC(2030, 0, 7, 9, 29, 50);
  assert.deepEqual(planAlarmChecks([], now), { due: [], delay: null });
  assert.deepEqual(planAlarmChecks([alarm({ enabled: false })], now), { due: [], delay: null });
  assert.throws(() => planAlarmChecks([], NaN));
});
await test("delivery window is inclusive at due and excludes a full minute late", { "CK-01": "partial" }, () => {
  const at = Date.UTC(2030, 0, 7, 9, 30);
  assert.equal(planAlarmChecks([alarm()], at - 1).due.length, 0);
  assert.deepEqual(planAlarmChecks([alarm()], at).due.map((d) => d.at), [at]);
  assert.deepEqual(planAlarmChecks([alarm()], at + 59_999).due.map((d) => d.at), [at]);
  assert.equal(planAlarmChecks([alarm()], at + 60_000).due.length, 0);
  assert.equal(planAlarmChecks([alarm()], at - 10_000).delay, 10_000);
  assert.equal(planAlarmChecks([alarm()], at - 3_600_000).delay, 60_000);
});
await test("weekday schedules do not become daily; empty days mean daily", { "CK-01": "partial" }, () => {
  const monday = Date.UTC(2030, 0, 7, 9, 30), tuesday = monday + 86_400_000;
  assert.equal(new Date(monday).getUTCDay(), 1);
  assert.equal(planAlarmChecks([alarm({ days: [2] })], monday).due.length, 0);
  assert.equal(planAlarmChecks([alarm({ days: [2] })], tuesday).due.length, 1);
  assert.equal(planAlarmChecks([alarm()], monday).due.length, 1);
});
await test("2,000 seeded plans match direct UTC day enumeration", { "CK-01": "partial" }, () => {
  let state = 130_2026;
  const next = (n: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % n; };
  for (let i = 0; i < 2000; i++) {
    const h = next(24), m = next(60), mask = next(128);
    const days = Array.from({ length: 7 }, (_, d) => d).filter((d) => mask & (1 << d));
    const a = alarm({ time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`, days });
    const now = Date.UTC(2030, 0, 1) + next(40) * 86_400_000 + next(86_400_000);
    const midnight = Math.floor(now / 86_400_000) * 86_400_000;
    const events: number[] = [];
    for (let day = -1; day <= 8; day++) {
      const start = midnight + day * 86_400_000;
      if (!days.length || days.includes(new Date(start).getUTCDay())) events.push(start + (h * 60 + m) * 60_000);
    }
    const expectedDue = events.filter((x) => x > now - 60_000 && x <= now);
    const expectedNext = events.find((x) => x > now);
    assert.ok(expectedNext !== undefined);
    const actual = planAlarmChecks([a], now);
    assert.deepEqual(actual.due.map((x) => x.at), expectedDue, `due case ${i}`);
    assert.equal(actual.delay, Math.min(60_000, expectedNext - now), `next case ${i}`);
  }
});
finish();
