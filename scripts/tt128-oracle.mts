/** Optional independent test-only parsers. Install the pinned versions documented
 * in DESIGN-TT128; missing tools fail, never silently skip this suite. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { makeHarness } from "./harness.mts";
import { parseIcs, toIcs } from "../src/lib/ics.ts";
import { convertZoneTime } from "../src/lib/zone-convert.ts";
const req = createRequire(`${process.env.TOOLS_DIR ?? "/home/user/tools"}/package.json`);
const icalModule = req("ical.js");
const ICAL = icalModule.default ?? icalModule;
const { Temporal } = req("@js-temporal/polyfill");
const { test, finish } = makeHarness("tt128-oracle");
await test("ical.js independently parses UTF-8 folded export and escaped TEXT", { "PR-04": "partial" }, () => {
  const title = "é漢😀 ".repeat(50) + "literal \\n, and\nnewline; ";
  const ics = toIcs([{ uid: "utf8@example.test", title, notes: "one\\n\ntwo, three;", start: new Date("2026-11-02T08:00:00Z"), end: null, kind: "event", done: false }]);
  const root = new ICAL.Component(ICAL.parse(ics)); const item = root.getFirstSubcomponent("vevent");
  assert.equal(item.getFirstPropertyValue("summary"), title);
  assert.equal(item.getFirstPropertyValue("description"), "one\\n\ntwo, three;");
  assert.equal(item.getFirstPropertyValue("uid"), "utf8@example.test");
});
await test("our reader accepts TEXT produced by ical.js", { "PR-04": "partial" }, () => {
  const root = new ICAL.Component(["vcalendar", [], []]); root.addPropertyWithValue("version", "2.0");
  const component = new ICAL.Component("vevent"); component.addPropertyWithValue("uid", "external@example.test");
  const title = "literal \\n; dotted, 漢😀\nnext line"; component.addPropertyWithValue("summary", title); root.addSubcomponent(component);
  assert.equal(parseIcs(root.toString())[0].title, title);
});
await test("ical.js expands a recurring VTODO from the exported due/anchor instant", { "PL-02": "partial" }, () => {
  const ics = toIcs([{ uid: "task@example.test", title: "Follow up", notes: "RRULE:FREQ=DAILY;COUNT=3", start: new Date("2026-01-02T10:00:00Z"), end: null, kind: "task", done: false }]);
  const task = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vtodo");
  const start = task.getFirstPropertyValue("dtstart"), due = task.getFirstPropertyValue("due");
  assert.equal(start.toString(), "2026-01-02T10:00:00Z"); assert.equal(due.toString(), start.toString());
  const iterator = task.getFirstPropertyValue("rrule").iterator(start);
  assert.deepEqual([iterator.next()?.toString(), iterator.next()?.toString(), iterator.next()?.toString(), iterator.next()], ["2026-01-02T10:00:00Z", "2026-01-03T10:00:00Z", "2026-01-04T10:00:00Z", null]);
});
await test("zone candidates agree with Temporal on transition and held-out ordinary times", { "WD-03": "partial" }, () => {
  const points: [string, string, string][] = [
    ["2026-03-08", "02:30", "America/New_York"], ["2026-11-01", "01:30", "America/New_York"],
    ["2026-04-05", "01:45", "Australia/Lord_Howe"], ["2026-10-04", "02:15", "Australia/Lord_Howe"],
    ["2011-12-30", "12:00", "Pacific/Apia"], ["2026-10-25", "02:30", "Europe/Berlin"],
    ["2026-03-29", "02:30", "Europe/Berlin"], ["2026-06-03", "12:15", "Asia/Kathmandu"],
  ];
  // Deterministic sample spanning zones, dates and clock times not used by the
  // unit suite. Temporal uses the platform's Intl tzdata, so this cross-check
  // is independent algorithmically, not an independent time-zone database.
  const zones = ["UTC", "America/New_York", "America/St_Johns", "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Asia/Kathmandu", "Asia/Tokyo", "Pacific/Apia", "Pacific/Chatham", "Australia/Lord_Howe", "Africa/Casablanca"];
  for (const zone of zones) for (const year of [1976, 2001, 2011, 2024, 2027, 2041]) for (const month of [1, 3, 4, 10, 11, 12]) {
    points.push([`${year}-${String(month).padStart(2, "0")}-15`, ["00:00", "01:30", "02:15", "12:45"][(year + month) % 4], zone]);
  }
  for (const [date, time, zone] of points) {
    const plain = Temporal.PlainDateTime.from(`${date}T${time}:00`);
    const earlier = plain.toZonedDateTime(zone, { disambiguation: "earlier" });
    const later = plain.toZonedDateTime(zone, { disambiguation: "later" });
    const isEarlier = earlier.toPlainDateTime().equals(plain), isLater = later.toPlainDateTime().equals(plain);
    const label = `${date} ${time} ${zone}`;
    if (!isEarlier && !isLater) { assert.throws(() => convertZoneTime(date, time, zone, "UTC"), /does not exist/, label); continue; }
    if (earlier.epochMilliseconds !== later.epochMilliseconds) {
      assert.throws(() => convertZoneTime(date, time, zone, "UTC"), /more than once/, label);
      assert.equal(Date.parse(convertZoneTime(date, time, zone, "UTC", "earlier").utc), earlier.epochMilliseconds, label);
      assert.equal(Date.parse(convertZoneTime(date, time, zone, "UTC", "later").utc), later.epochMilliseconds, label);
    } else assert.equal(Date.parse(convertZoneTime(date, time, zone, "UTC").utc), earlier.epochMilliseconds, label);
  }
  console.log(`    ${points.length} Temporal comparisons`);
});
finish();
