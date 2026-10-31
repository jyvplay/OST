/** Independent, test-only Temporal + ICAL.js oracles. No production dependency,
 * network access, browser or database. Install the named libraries in TOOLS_DIR. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { taskInputInstant, taskInstant, taskLocalInput } from "../src/lib/task-model.ts";
import { parseIcs, toIcs } from "../src/lib/ics.ts";

if (!process.env.TOOLS_DIR) throw new Error("TOOLS_DIR must contain the explicitly installed independent oracle libraries");
const require = createRequire(join(process.env.TOOLS_DIR, "package.json"));
const { Temporal } = require("@js-temporal/polyfill"), ICAL = require("ical.js");
console.log(`Independent oracles: Temporal ${require("./node_modules/@js-temporal/polyfill/package.json").version}, ICAL.js ${require("./node_modules/ical.js/package.json").version}`);
const { test, finish } = makeHarness("tt132-oracles"), covers = { "PR-03": "partial", "PR-04": "partial" } as const;
const previousZone = process.env.TZ;
try {
  process.env.TZ = "America/New_York";
  await test("explicit-offset and low-year instants match Temporal rather than our own parser", covers, () => {
    for (const value of ["0099-01-01T00:00:00Z", "1900-03-01T00:00:00+05:45", "2000-02-29T23:59:59.123-03:30", "2026-11-01T01:30:00.456-05:00", "9999-12-30T23:00:00-01:00"]) {
      assert.equal(taskInstant(value, "dueAt"), Temporal.Instant.from(value).toString({ smallestUnit: "millisecond" }));
    }
  });
  await test("both DST fold occurrences and the millisecond remainder agree with Temporal", covers, () => {
    const wall = { timeZone: "America/New_York", year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 15, millisecond: 123 };
    const earlier = Temporal.ZonedDateTime.from(wall, { disambiguation: "earlier" }).toInstant().toString({ smallestUnit: "millisecond" });
    const later = Temporal.ZonedDateTime.from(wall, { disambiguation: "later" }).toInstant().toString({ smallestUnit: "millisecond" });
    assert.notEqual(earlier, later);
    for (const instant of [earlier, later]) { const input = taskLocalInput(instant); assert.equal(input, "2026-11-01T01:30:15.123"); assert.equal(taskInputInstant(input, instant), instant); }
    assert.equal(taskInputInstant("2026-11-01T01:30:15.123"), earlier, "new ambiguous time uses the browser's earlier choice, not an invented unique instant");
  });
  await test("spring DST gaps are rejected independently by Temporal and the editor converter", covers, () => {
    assert.throws(() => Temporal.ZonedDateTime.from({ timeZone: "America/New_York", year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, { disambiguation: "reject" }));
    assert.throws(() => taskInputInstant("2026-03-08T02:30:00.123"), /does not exist/);
    assert.throws(() => taskInstant("1900-02-29T10:00:00Z", "dueAt"));
    assert.throws(() => Temporal.Instant.from("1900-02-29T10:00:00Z"));
  });
  await test("real ICAL.js reads exported event endpoints, Unicode folding, UID and literal notes", covers, () => {
    const title = "Independent, ; \\ title — 🌍 ".repeat(8), notes = "line one\nline two, ; \\ final";
    const text = toIcs([{ uid: "independent-132@example.test", kind: "event", title, notes, done: false, start: new Date("2026-11-01T06:30:15.123Z"), end: new Date("2026-11-01T07:45:15.456Z") }]);
    const calendar = new ICAL.Component(ICAL.parse(text)), event = new ICAL.Event(calendar.getFirstSubcomponent("vevent"));
    assert.equal(event.uid, "independent-132@example.test"); assert.equal(event.summary, title); assert.equal(event.description, notes);
    assert.equal(event.startDate.toJSDate().toISOString(), "2026-11-01T06:30:15.000Z"); assert.equal(event.endDate.toJSDate().toISOString(), "2026-11-01T07:45:15.000Z");
    for (const line of text.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `folded line is ${Buffer.byteLength(line)} octets`);
    // RFC 5545 DATE-TIME exports intentionally have whole-second precision;
    // PostgreSQL/UI retain milliseconds. Do not pretend an ICS round trip does.
  });
  await test("our importer agrees with independent UTC VEVENT output, not just self-generated ICS", covers, () => {
    const event = new ICAL.Event(); event.uid = "external-132@example.test"; event.summary = "External event"; event.description = "External\nnotes";
    event.startDate = ICAL.Time.fromString("2026-11-01T06:30:00Z"); event.endDate = ICAL.Time.fromString("2026-11-01T07:30:00Z");
    const cal = new ICAL.Component(["vcalendar", [["version", {}, "text", "2.0"], ["prodid", {}, "text", "-//independent oracle//EN"]], []]); cal.addSubcomponent(event.component);
    const [actual] = parseIcs(cal.toString()); assert.equal(actual.uid, event.uid); assert.equal(actual.title, event.summary); assert.equal(actual.notes, event.description);
    assert.equal(actual.start?.toISOString(), event.startDate.toJSDate().toISOString()); assert.equal(actual.end?.toISOString(), event.endDate.toJSDate().toISOString());
  });
} finally { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; }
finish();
