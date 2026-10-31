/** Calendar preflight identifies known lossy imports without changing data. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { inspectIcsImport } from "../src/lib/ics.ts";
const { test, finish } = makeHarness("tt129-calendar-core");
const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
const event = (body: string) => `BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT`;
const counts = (s: string) => Object.fromEntries(inspectIcsImport(s).map((w) => [w.code, w.items]));
await test("a UTC single event with UID has no known-loss warnings", { "PR-04": "partial" }, () => {
  assert.deepEqual(counts(wrap(event("UID:a\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z"))), {});
});
await test("timezone, recurrence, exceptions, duration and alarms are counted per item", { "PR-04": "partial" }, () => {
  const ics = wrap(event("UID:a\r\nDTSTART;TZID=America/New_York:20261102T090000\r\nDTEND;TZID=America/New_York:20261102T100000\r\nRRULE:FREQ=WEEKLY\r\nEXDATE:20261109T090000Z\r\nRDATE:20261110T090000Z\r\nDURATION:PT1H\r\nBEGIN:VALARM\r\nDTSTART:20260230T100000Z\r\nEND:VALARM"));
  assert.deepEqual(counts(ics), { timezone: 1, recurrence: 1, exceptions: 1, duration: 1, alarms: 1 });
});
await test("folded and lowercase TZID parameters are recognized", { "PR-04": "partial" }, () => {
  assert.deepEqual(counts(wrap(event("UID:a\r\nDTSTART;tz\r\n id=Europe/London:20261102T090000"))), { timezone: 1 });
});
await test("floating, all-day, invalid date and missing UID are distinct warnings", { "PR-04": "partial" }, () => {
  const ics = wrap([event("UID:a\r\nDTSTART:20261102T090000"), event("UID:b\r\nDTSTART;VALUE=DATE:20261103"), event("DTSTART:20260230T100000Z")].join("\r\n"));
  assert.deepEqual(counts(ics), { floating: 1, allDay: 1, invalidDate: 1, missingUid: 1 });
});
await test("nested alarm dates do not masquerade as event dates", { "PR-04": "partial" }, () => {
  const ics = wrap(event("UID:a\r\nDTSTART:20261102T090000Z\r\nBEGIN:VALARM\r\nDTSTART;TZID=X:20260230T100000\r\nEND:VALARM"));
  assert.deepEqual(counts(ics), { alarms: 1 });
});
await test("exception components and multiple missing UIDs are counted independently", { "PR-04": "partial" }, () => {
  const ics = wrap([event("RECURRENCE-ID:20261102T090000Z\r\nDTSTART:20261102T100000Z"), "BEGIN:VTODO\r\nSUMMARY:x\r\nEND:VTODO"].join("\r\n"));
  assert.deepEqual(counts(ics), { exceptions: 1, missingUid: 2 });
});
finish();
