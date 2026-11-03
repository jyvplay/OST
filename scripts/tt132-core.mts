/** Pure production contracts; no browser, database, network or timer doubles. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { validateAlarm, type Alarm } from "../src/lib/clock-core.ts";
import { ALARM_WINDOW_MS } from "../src/lib/clock-alarm-plan.ts";
import { ACTIVITY_RETAIN_MS, activityToken, alarmSchedule, planAlarmActivity, reconcileAlarmActivity, startAlarmActivity, transitionAlarmActivity, validateAlarmActivity } from "../src/lib/alarm-activity-core.ts";
import { assertTaskExpected, taskId, taskInputInstant, taskInstant, taskLocalInput, taskSnapshot, taskWrite, type TaskFields } from "../src/lib/task-model.ts";

const { test, finish } = makeHarness("tt132-core"), CK = { "CK-01": "partial" } as const, PL = { "PR-03": "partial", "PR-04": "partial" } as const;
const alarm: Alarm = validateAlarm({ id: "morning", label: "Wake", time: "09:30", days: [1, 2], snoozeMin: 9, enabled: true });
const at = Date.parse("2030-01-07T09:30:00.000Z");
const active = () => startAlarmActivity([], alarm, at);
const base: TaskFields = { title: "Original", notes: "A note", kind: "task", dueAt: "2030-01-07T12:30:00.123Z", endAt: null, done: false };

await test("alarm acknowledgements are bounded, canonical, label-free and reject corrupt storage whole", CK, () => {
  const entries = active();
  assert.deepEqual(validateAlarmActivity(entries), entries);
  assert.doesNotMatch(JSON.stringify(entries), /Wake/);
  for (const raw of [null, {}, [null], [...entries, ...entries], [{ ...entries[0], dueAt: NaN }], [{ ...entries[0], stage: "other" }], [{ ...entries[0], sequence: 1.5 }], [{ ...entries[0], schedule: '["99:00",[]]' }], Array(25).fill(entries[0])]) assert.throws(() => validateAlarmActivity(raw));
});
await test("snooze uses configured elapsed minutes and repeated snoozes have new tokens", CK, () => {
  const first = active()[0];
  const snoozed = transitionAlarmActivity([first], activityToken(first), "snooze", alarm, at + 17_000)[0];
  assert.equal(snoozed.dueAt, at + 17_000 + 9 * 60_000); assert.equal(snoozed.sequence, 1); assert.equal(snoozed.stage, "snoozed");
  assert.deepEqual(transitionAlarmActivity([snoozed], activityToken(snoozed), "snooze", alarm, at + 20_000), [snoozed], "double snooze cannot postpone twice");
  const ringing = transitionAlarmActivity([snoozed], activityToken(snoozed), "ring", alarm, snoozed.dueAt)[0];
  const again = transitionAlarmActivity([ringing], activityToken(ringing), "snooze", { ...alarm, snoozeMin: 1 }, ringing.dueAt + 1)[0];
  assert.equal(again.sequence, 2); assert.equal(again.dueAt, ringing.dueAt + 60_001); assert.notEqual(activityToken(again), activityToken(snoozed));
});
await test("dismiss and cancel snooze remove an occurrence, never the recurring schedule", CK, () => {
  const entry = active()[0]; const before = structuredClone(alarm);
  assert.deepEqual(transitionAlarmActivity([entry], activityToken(entry), "dismiss", alarm, at), []);
  const sleeping = transitionAlarmActivity([entry], activityToken(entry), "snooze", alarm, at)[0];
  assert.deepEqual(transitionAlarmActivity([sleeping], activityToken(sleeping), "dismiss", alarm, at), []);
  assert.deepEqual(alarm, before);
});
await test("stale callbacks cannot undo a snooze or replace a newer occurrence", CK, () => {
  const first = active()[0], sleeping = transitionAlarmActivity([first], activityToken(first), "snooze", alarm, at)[0];
  assert.deepEqual(startAlarmActivity([sleeping], alarm, at), [sleeping]);
  const tomorrow = startAlarmActivity([sleeping], alarm, at + 86_400_000);
  assert.deepEqual(transitionAlarmActivity(tomorrow, activityToken(first), "dismiss", alarm, at + 86_400_000), tomorrow);
  assert.deepEqual(startAlarmActivity(tomorrow, alarm, at), tomorrow);
});
await test("snooze delivery has exact early/on-time/late boundaries and reports a missed wake", CK, () => {
  const first = active()[0], sleeping = transitionAlarmActivity([first], activityToken(first), "snooze", alarm, at)[0];
  assert.equal(planAlarmActivity([sleeping], sleeping.dueAt - 1).delay, 1);
  assert.equal(planAlarmActivity([sleeping], sleeping.dueAt).due.length, 1);
  assert.equal(planAlarmActivity([sleeping], sleeping.dueAt + ALARM_WINDOW_MS - 1).due.length, 1);
  const late = sleeping.dueAt + ALARM_WINDOW_MS;
  assert.equal(planAlarmActivity([sleeping], late).missed.length, 1);
  assert.deepEqual(transitionAlarmActivity([sleeping], activityToken(sleeping), "ring", alarm, late), [sleeping]);
  const missed = transitionAlarmActivity([sleeping], activityToken(sleeping), "miss", alarm, late)[0];
  assert.equal(missed.stage, "missed"); assert.equal(planAlarmActivity([missed], late).delay, null);
});
await test("delete, disable, schedule edits and expiry cancel pending activity; label edits do not", CK, () => {
  const entries = active();
  for (const alarms of [[], [{ ...alarm, enabled: false }], [{ ...alarm, time: "10:30" }], [{ ...alarm, days: [3] }]]) assert.deepEqual(reconcileAlarmActivity(entries, alarms, at), []);
  assert.deepEqual(reconcileAlarmActivity(entries, [{ ...alarm, label: "Renamed", snoozeMin: 60 }], at), entries);
  assert.equal(reconcileAlarmActivity(entries, [alarm], at + ACTIVITY_RETAIN_MS - 1).length, 1);
  assert.equal(reconcileAlarmActivity(entries, [alarm], at + ACTIVITY_RETAIN_MS).length, 0);
});
await test("clock rollback preserves occurrence identity while snoozing from the new wall time", CK, () => {
  const entry = active()[0], back = at - 3_600_000;
  const sleeping = transitionAlarmActivity([entry], activityToken(entry), "snooze", alarm, back)[0];
  assert.equal(sleeping.occurrenceAt, at); assert.equal(sleeping.dueAt, back + 540_000);
  assert.deepEqual(validateAlarmActivity([sleeping]), [sleeping]);
  assert.equal(alarmSchedule({ ...alarm, days: [2, 1] }), alarmSchedule(alarm));
});
await test("one thousand adversarial activity schedules preserve isolation and finite bounds", CK, () => {
  let seed = 132; const random = () => { seed = Math.imul(seed, 1664525) + 1013904223 | 0; return seed >>> 0; };
  let list = active(); let now = at;
  const other = { ...alarm, id: "second" }; list = startAlarmActivity(list, other, at);
  for (let n = 0; n < 1000; n++) {
    now += random() % 80_000;
    const target = list.find((x) => x.alarmId === alarm.id);
    const untouched = list.find((x) => x.alarmId === other.id);
    if (target) list = transitionAlarmActivity(list, activityToken(target), (["snooze", "ring", "miss", "dismiss"] as const)[random() % 4], alarm, now);
    else list = startAlarmActivity(list, alarm, now);
    assert.deepEqual(list.find((x) => x.alarmId === other.id), untouched);
    assert.deepEqual(validateAlarmActivity(list), list); assert.ok(list.length <= 24);
  }
});
await test("task and event validation rejects malformed types, limits, dates and impossible intervals", PL, () => {
  for (const body of [{}, { title: " " }, { title: 42 }, { title: "x".repeat(501) }, { title: "x", notes: [] }, { title: "x", done: "yes" }, { title: "x", reminded: 1 }, { title: "x", kind: "meeting" }, { title: "x", dueAt: "2030-02-30T10:00:00Z" }, { title: "x", dueAt: "2030-01-01T10:00" }, { title: "x", kind: "event" }, { title: "x", endAt: "2030-01-01T10:00:00Z" }, { title: "x", kind: "event", dueAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T10:00:00Z" }]) assert.throws(() => taskWrite(body));
  assert.equal(taskWrite({ title: "  New task  ", notes: "preserved\ntext" }).title, "New task");
  assert.equal(taskWrite({ dueAt: null }, base).reminded, false);
  assert.equal(taskWrite({ dueAt: base.dueAt }, base).reminded, undefined, "unchanged time must not rearm a delivered reminder");
});
await test("explicit-offset date parsing preserves millisecond precision and rejects rollover", PL, () => {
  assert.equal(taskInstant("2030-01-07T07:30:00.123-05:00", "dueAt"), base.dueAt);
  assert.equal(taskInstant("0099-01-01T00:00:00Z", "dueAt"), "0099-01-01T00:00:00.000Z");
  for (const raw of ["0000-01-01T00:00:00Z", "2030-01-01", "2030-01-01T24:00:00Z", "2030-01-01T10:00:60Z", "2030-01-01T10:00:00+24:00", "2030-02-29T10:00:00Z", 0, ""]) assert.throws(() => taskInstant(raw, "dueAt"));
  assert.equal(taskInstant("2032-02-29T10:00:00Z", "dueAt"), "2032-02-29T10:00:00.000Z");
});
await test("snapshot checks reject lost updates in every edited field, without mutating the original", PL, () => {
  const expected = taskSnapshot(base); assertTaskExpected(expected, base);
  for (const changed of [{ title: "New" }, { notes: "New" }, { done: true }, { kind: "event" as const }, { dueAt: null }, { endAt: "2030-01-07T13:30:00.123Z" }]) assert.throws(() => assertTaskExpected(expected, { ...base, ...changed }), /changed in another window/);
  assert.throws(() => assertTaskExpected({ title: base.title }, base), /required/);
  assert.deepEqual(taskSnapshot(base), expected);
  for (const id of [0, -1, 1.1, "1", 2_147_483_648, null]) assert.throws(() => taskId(id));
});
await test("task/event conversion retains notes and dates and clears event-only end data", PL, () => {
  const event = taskWrite({ kind: "event", endAt: "2030-01-07T13:30:00.123Z" }, base);
  assert.equal(event.kind, "event"); assert.equal(event.notes, base.notes);
  const task = taskWrite({ kind: "task" }, event); assert.equal(task.endAt, null); assert.equal(task.dueAt, base.dueAt);
  assert.equal(taskInputInstant(taskLocalInput(base.dueAt), base.dueAt), base.dueAt);
  assert.equal(taskInputInstant(""), null); assert.throws(() => taskInputInstant("2030-02-30T10:00"));
});
finish();
