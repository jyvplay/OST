/** Focused regressions. Cases sample contracts; they are not feature certificates. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { parseIcs, parseIcsDate, toIcs } from "../src/lib/ics.ts";
import { parseRRule, expandRecurrence } from "../src/lib/recurrence.ts";
import { convertZoneTime } from "../src/lib/zone-convert.ts";
import { undatedPhotos } from "../src/lib/photo-dates.ts";
import { photoTimeline } from "../src/lib/photo-timeline.ts";
import { sortPhotos, compareNewestPhotoDate } from "../src/lib/photo-sort.ts";
import { businessDaysBetween } from "../src/lib/clock-core.ts";

const { test, finish } = makeHarness("tt128-core");
const event = (title: string, notes = "", uid = "id@example.test") => ({ uid, title, notes, start: new Date("2026-01-02T10:00:00Z"), end: null, kind: "event", done: false });
await test("calendar folds complete content lines at 75 UTF-8 bytes without splitting characters", { "PR-04": "partial" }, () => {
  const title = "é漢😀".repeat(80), uid = "€".repeat(40), notes = "\u{1f4c6}".repeat(70);
  const out = toIcs([event(title, notes, uid)]);
  for (const line of out.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, `${Buffer.byteLength(line)} bytes: ${line}`);
  const [back] = parseIcs(out);
  assert.equal(back.title, title); assert.equal(back.notes, notes); assert.equal(back.uid, uid);
});
await test("calendar TEXT escapes round-trip literal backslashes, newline, commas and semicolons", { "PR-04": "partial" }, () => {
  const title = "literal \\n and newline\ncomma, semicolon; \\\\ tail ";
  const back = parseIcs(toIcs([event(title)]))[0]; assert.equal(back.title, title);
});
await test("calendar UID and title cannot inject additional properties", { "PR-04": "partial" }, () => {
  const out = toIcs([event("ok\r\nSTATUS:COMPLETED", "", "a\r\nEND:VEVENT")]);
  const parts = parseIcs(out); assert.equal(parts.length, 1); assert.equal(parts[0].uid, "a\nEND:VEVENT");
  assert.equal(parts[0].title, "ok\nSTATUS:COMPLETED"); assert.equal(parts[0].done, false);
});
await test("nested alarm properties do not override the enclosing event", { "PR-04": "partial" }, () => {
  const [e] = parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:one\r\nSUMMARY:Meeting \r\nBEGIN:VALARM\r\nUID:evil\r\nSUMMARY:Alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  assert.equal(e.uid, "one"); assert.equal(e.title, "Meeting ");
});
await test("DUE wins over DTSTART for tasks regardless of property order", { "PR-04": "partial" }, () => {
  const common = "BEGIN:VTODO\nUID:u\n";
  for (const fields of ["DUE:20260304T120000Z\nDTSTART:20260301T120000Z", "DTSTART:20260301T120000Z\nDUE:20260304T120000Z"]) {
    assert.equal(parseIcs(common + fields + "\nEND:VTODO\n")[0].start?.toISOString(), "2026-03-04T12:00:00.000Z");
  }
});
await test("calendar dates reject rollover, invalid times and mismatched value type", { "PR-04": "partial" }, () => {
  for (const date of ["20260229", "20260431T120000Z", "20261301", "20260101T240000Z", "20260101T126000Z"]) assert.equal(parseIcsDate(date, ""), null, date);
  assert.ok(parseIcsDate("20240229", "VALUE=DATE")); assert.equal(parseIcsDate("20260101T120000Z", "VALUE=DATE"), null);
  assert.equal(parseIcsDate("00990101T000000Z", "")?.toISOString(), "0099-01-01T00:00:00.000Z");
});
await test("calendar STATUS matches COMPLETED exactly", { "PR-04": "partial" }, () => {
  assert.equal(parseIcs("BEGIN:VTODO\nSTATUS:NOT-COMPLETED\nEND:VTODO")[0].done, false);
  assert.equal(parseIcs("BEGIN:VTODO\nSTATUS:COMPLETED\nEND:VTODO")[0].done, true);
});
await test("calendar rejects injected raw RRULE but permits CRLF note lines", { "PL-02": "partial" }, () => {
  assert.throws(() => toIcs([{ ...event("x"), rrule: "FREQ=DAILY\nEND:VEVENT" }]), /single content line/);
  assert.match(toIcs([event("x", "hello\r\nRRULE:FREQ=DAILY\r\nworld")]), /RRULE:FREQ=DAILY/);
});
await test("weekly Sunday comes after weekdays, including COUNT and window boundaries", { "PL-01": "partial" }, () => {
  const start = new Date("2026-01-05T09:00:00.123Z");
  const got = expandRecurrence(start, parseRRule("FREQ=WEEKLY;BYDAY=SU,MO,WE;COUNT=3"), start, new Date("2026-02-01T00:00:00Z"));
  assert.deepEqual(got.map((x) => x.toISOString()), ["2026-01-05T09:00:00.123Z", "2026-01-07T09:00:00.123Z", "2026-01-11T09:00:00.123Z"]);
});
await test("repeat rules reject unsupported, duplicate or inapplicable parts", { "PL-01": "partial" }, () => {
  for (const s of ["FREQ=DAILY;BYMONTH=3", "FREQ=DAILY;FREQ=WEEKLY", "FREQ=MONTHLY;BYDAY=MO", "FREQ=WEEKLY;BYDAY=MO,", "FREQ=DAILY;INTERVAL=1e2", "FREQ=DAILY;COUNT=2;UNTIL=20260101", "FREQ=DAILY;UNTIL=20260230", "FREQ=DAILY;"]) assert.throws(() => parseRRule(s), undefined, s);
});
await test("repeat expansion refuses invalid dates and direct invalid rules instead of looping", { "PL-01": "partial" }, () => {
  const d = new Date("2026-01-01T00:00:00Z");
  assert.throws(() => expandRecurrence(d, { freq: "DAILY", interval: 0 }, d, d), /invalid recurrence/);
  assert.throws(() => expandRecurrence(d, parseRRule("FREQ=DAILY"), new Date(NaN), d), /valid dates/);
});
await test("zone converter rejects spring gaps and requires explicit fall overlap choice", { "WD-03": "partial" }, () => {
  assert.throws(() => convertZoneTime("2026-03-08", "02:30", "America/New_York", "UTC"), /does not exist/);
  assert.throws(() => convertZoneTime("2026-11-01", "01:30", "America/New_York", "UTC"), /more than once/);
  assert.equal(convertZoneTime("2026-11-01", "01:30", "America/New_York", "UTC", "earlier").utc, "2026-11-01T05:30:00.000Z");
  assert.equal(convertZoneTime("2026-11-01", "01:30", "America/New_York", "UTC", "later").utc, "2026-11-01T06:30:00.000Z");
});
await test("zone converter handles 30-minute overlaps and skipped calendar days", { "WD-03": "partial" }, () => {
  const first = convertZoneTime("2026-04-05", "01:45", "Australia/Lord_Howe", "UTC", "earlier");
  const last = convertZoneTime("2026-04-05", "01:45", "Australia/Lord_Howe", "UTC", "later");
  assert.equal(Date.parse(last.utc) - Date.parse(first.utc), 30 * 60_000); assert.ok(first.ambiguous);
  assert.throws(() => convertZoneTime("2011-12-30", "12:00", "Pacific/Apia", "UTC"), /does not exist/);
});
await test("zone converter validates dates, zones and explicit overlap policy", { "WD-03": "partial" }, () => {
  for (const date of ["2026-02-30", "2026-13-01", "0001-01-01"]) assert.throws(() => convertZoneTime(date, "12:00", "UTC", "UTC"));
  assert.throws(() => convertZoneTime("2026-01-01", "25:00", "UTC", "UTC"));
  assert.throws(() => convertZoneTime("2026-01-01", "12:00", "Wrong/Zone", "UTC"));
  assert.throws(() => convertZoneTime("2026-01-01", "12:00", "UTC", "UTC", "guess" as never));
});
await test("photo No date distinguishes file dates from capture dates, including old cache entries", { "PH-07": "partial" }, () => {
  const items = ["one", "two", "three", "four"].map((sha256) => ({ path: "/" + sha256, sha256 }));
  const ix = { one: { dateSource: "file" as const, date: "2026-01-01" }, two: { dateSource: "exif" as const, date: "2025-01-01" }, three: { capturedAt: "2025-01-01" } };
  assert.deepEqual(undatedPhotos(items, ix).map((i) => i.sha256), ["one", "four"]);
});
await test("timeline aggregation preserves all groups, bytes and lexical first/last dates", { "PH-02": "partial" }, () => {
  const rows = ["2026-02-03T12:00:00Z", "2026-02-01T12:00:00Z", null, "bad", "2025-01-02T12:00:00Z"].map((date, i) => ({ path: `/${i}`, mime: "image/png", size: i + 1, date }));
  const result = photoTimeline(rows); assert.equal(result.totalBytes, 15); assert.deepEqual(result.undated, { count: 2, bytes: 7 });
  assert.deepEqual(result.groups[0], { month: "2026-02", count: 2, bytes: 3, first: rows[1].date, last: rows[0].date });
});
await test("local UNTIL DATE includes the entire day across a non-UTC host", { "PL-01": "partial" }, () => {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "--input-type=module", "-e", `import {parseRRule,expandRecurrence} from './src/lib/recurrence.ts'; const a=new Date(2026,0,1,23,0); console.log(expandRecurrence(a,parseRRule('FREQ=DAILY;UNTIL=20260103'),a,new Date(2026,0,5)).length)`], { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), "3");
});
await test("Planner week and completion windows use calendar days across Santiago's midnight DST shift", { "PL-01": "partial", "PL-07": "partial" }, () => {
  const code = `
    import {localWeekDays} from './src/lib/local-week.ts';
    import {completionStats} from './src/lib/completion-stats.ts';
    const now=new Date('2024-04-07T16:00:00Z');
    const tasks=[{done:true,dueAt:'2024-04-01T15:00:00Z'},{done:true,dueAt:'2024-04-07T15:00:00Z'}];
    const days=localWeekDays(now);
    const start=new Date(now); start.setHours(0,0,0,0); start.setDate(start.getDate()-((start.getDay()+6)%7));
    console.log(JSON.stringify({days:days.map(d=>d.getDate()),stats:completionStats(tasks,now),oldSunday:new Date(start.getTime()+6*86400000).getDate()}));`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "--input-type=module", "-e", code], { env: { ...process.env, TZ: "America/Santiago" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.days, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(result.oldSunday, 6, "the fixed-24-hour implementation must fail this counterexample");
  assert.deepEqual(result.stats, { today: 1, week: 2, undated: 0 });
});
await test("Clock date inputs use the local date and calendar arithmetic across a skipped day", { "CK-03": "partial" }, () => {
  const run = (tz: string, code: string) => {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "--input-type=module", "-e", code], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  const tokyo = run("Asia/Tokyo", `import {localDateInput,addDays} from './src/lib/clock-core.ts'; const start=new Date('2026-01-01T00:30:00+09:00'); console.log(JSON.stringify([localDateInput(start),localDateInput(addDays(start,30))]));`);
  assert.deepEqual(tokyo, ["2026-01-01", "2026-01-31"]);
  const samoa = run("Pacific/Apia", `import {daysBetween,businessDaysBetween} from './src/lib/clock-core.ts'; const a=new Date('2011-12-29T12:00:00-10:00'), b=new Date('2011-12-31T12:00:00+14:00'); console.log(JSON.stringify([daysBetween(a,b),businessDaysBetween(a,b)]));`);
  assert.deepEqual(samoa, [2, 1]);
});
await test("constant-work business-date count agrees with a separate day-by-day calculation", { "CK-03": "partial" }, () => {
  let seed = 19937;
  for (let i = 0; i < 1000; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const first = Math.floor(seed % 9000) - 4500;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = (seed % 1201) - 600;
    const a = new Date(2020, 0, 1 + first, 12), b = new Date(2020, 0, 1 + first + length, 12);
    let expected = 0;
    for (let j = 1; j <= Math.abs(length); j++) {
      const d = new Date(2020, 0, 1 + first + Math.sign(length) * j, 12);
      if (d.getDay() >= 1 && d.getDay() <= 5) expected += Math.sign(length);
    }
    assert.equal(businessDaysBetween(a, b), expected, `start ${first}, delta ${length}`);
  }
});
await test("photo sort puts missing values last in both directions and handles pre-epoch dates", { "PH-05": "partial" }, () => {
  const photos = [{ path: "/a", size: 3, capturedAt: "1965-01-01T00:00:00Z" }, { path: "/b", size: NaN, capturedAt: "invalid" }, { path: "/c", size: 0, capturedAt: "1975-01-01T00:00:00Z" }, { path: "/d" }];
  assert.deepEqual(sortPhotos(photos, "size").map((x) => x.path), ["/c", "/a", "/b", "/d"]);
  assert.deepEqual(sortPhotos(photos, "size", true).map((x) => x.path), ["/a", "/c", "/b", "/d"]);
  assert.deepEqual(sortPhotos(photos, "captured", true).map((x) => x.path), ["/c", "/a", "/b", "/d"]);
  assert.ok(compareNewestPhotoDate("1965-01-01", "invalid") < 0);
  assert.equal(compareNewestPhotoDate("bad", "also bad"), 0);
  assert.deepEqual(photos.map((x) => x.path), ["/a", "/b", "/c", "/d"]);
});
await test("calendar rejects DATE values explicitly declared DATE-TIME", { "PR-04": "partial" }, () => {
  assert.equal(parseIcsDate("20260203", "VALUE=DATE-TIME"), null);
  assert.ok(parseIcsDate("20260203T123000Z", "VALUE=DATE-TIME"));
});
await test("a dated recurring task exports both recurrence anchor and due instant", { "PL-02": "partial" }, () => {
  const source = { ...event("Follow up"), kind: "task", notes: "RRULE:FREQ=DAILY;COUNT=3" };
  const ics = toIcs([source]);
  assert.match(ics, /DTSTART:20260102T100000Z\r\nDUE:20260102T100000Z/);
  const back = parseIcs(ics)[0]; assert.equal(back.start?.toISOString(), source.start.toISOString()); assert.equal(back.rrule, "FREQ=DAILY;COUNT=3");
});
finish();
