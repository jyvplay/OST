/**
 * TT151 — cron and one-time passwords.
 *
 * Three independent oracles, none of them this code:
 *
 *  RFC 4226 / RFC 6238  normative test vectors (published constants). If the
 *                       dynamic-truncation offset, the 64-bit counter encoding or
 *                       the HMAC inner/outer padding is wrong, these fail.
 *  FIPS 180-4 / RFC 2202 SHA-1 and HMAC-SHA1 vectors — the primitive underneath,
 *                       checked separately so a TOTP failure can be attributed.
 *  brute force          `nextOccurrences` must agree, minute by minute, with an
 *                       exhaustive scan written in the test itself, over a whole
 *                       year of UTC instants. The fast path is allowed to be
 *                       clever only if it equals the slow path everywhere.
 *
 * The DST cases use a real IANA zone through `Intl` (America/New_York), which is
 * the platform's tzdata rather than a fixture, so "a 02:30 job does not exist on
 * the spring-forward day" is asserted against the same data the browser uses.
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { parseCron, nextOccurrences, cronMatchesDay, describeCron, CRON_MACROS } from "../src/lib/cron.ts";
import {
  sha1, hmacSha1, base32Encode, base32Decode, hotp, totp, verifyTotp,
  buildOtpAuthUri, parseOtpAuthUri, normaliseSecret, counterBytes,
} from "../src/lib/totp.ts";
import { partsInZone } from "../src/lib/calendar-time.ts";

const { test, finish } = makeHarness("tt151-time");

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const ascii = (s: string) => new TextEncoder().encode(s);
const MIN = 60_000;

// ── CR-01: grammar ──────────────────────────────────────────────────────────

await test("CR-01 · the grammar accepts the standard five fields and refuses everything ambiguous", {}, () => {
  const ok = (expr: string) => {
    const r = parseCron(expr);
    assert.ok(r.ok, `${expr} should parse: ${r.ok === false ? r.error : ""}`);
    return r.schedule;
  };
  const bad = (expr: string, why: RegExp) => {
    const r = parseCron(expr);
    assert.equal(r.ok, false, `${expr} must be refused`);
    if (r.ok === false) assert.match(r.error, why, `${expr}: ${r.error}`);
  };
  // Field expansion: lists, ranges, steps, names, and the "n/step" open form.
  assert.deepEqual(ok("*/15 * * * *").minute, [0, 15, 30, 45]);
  assert.deepEqual(ok("0 9-17 * * 1-5").hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(ok("0 0 * jan,mar *").month, [1, 3]);
  assert.deepEqual(ok("0 0 * * mon-fri").dayOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(ok("5/10 * * * *").minute, [5, 15, 25, 35, 45, 55]);
  assert.deepEqual(ok("0 0 * * 7").dayOfWeek, [0], "7 is Sunday, not a refusal");
  assert.deepEqual(ok("0 0 * * 0,7").dayOfWeek, [0], "0 and 7 are the same day");
  assert.deepEqual(ok("0 0 1-31/7 * *").dayOfMonth, [1, 8, 15, 22, 29]);
  // Macros expand, and all of them agree with the table.
  for (const [macro, body] of Object.entries(CRON_MACROS)) {
    const sched = ok(macro);
    const expanded = parseCron(body);
    assert.ok(expanded.ok, `${macro} expands to ${body}`);
    assert.equal(sched.macro, macro.toLowerCase());
    assert.deepEqual(
      [sched.minute, sched.hour, sched.dayOfMonth, sched.month, sched.dayOfWeek],
      [expanded.schedule.minute, expanded.schedule.hour, expanded.schedule.dayOfMonth, expanded.schedule.month, expanded.schedule.dayOfWeek],
      `${macro} must expand to ${body}`,
    );
  }
  // Refusals: each names the field it objects to.
  bad("", /empty/);
  bad("* * * *", /expected 5 fields/);
  bad("* * * * * *", /seconds/);
  bad("60 * * * *", /minute: 60 is outside 0–59/);
  bad("0 24 * * *", /hour: 24 is outside 0–23/);
  bad("0 0 0 * *", /day-of-month: 0 is outside 1–31/);
  bad("0 0 * 13 *", /month: 13 is outside 1–12/);
  bad("0 0 * * 8", /day-of-week: 8 is outside 0–7/);
  bad("0 0 * * fry", /not a number or name/);
  bad("*/0 * * * *", /step must be at least 1/);
  bad("5-1 * * * *", /runs backwards/);
  bad("1,,2 * * * *", /empty list item/);
  bad("1-2-3 * * * *", /more than one dash/);
  bad("@reboot", /no wall-clock meaning/);
  bad("@fortnightly", /unknown macro/);
  bad("0 0 30 2 *", /never occurs/);
  bad("0 0 31 4 *", /never occurs/);
});

await test("CR-01 · day matching follows the Vixie rule: two restricted day fields are ORed", {}, () => {
  const s = (expr: string) => {
    const r = parseCron(expr);
    assert.ok(r.ok);
    return r.schedule;
  };
  const firstAndMondays = s("0 0 1 * 1");
  // 2025-09-01 is a Monday AND the 1st; 2025-09-08 is a Monday only; 2025-10-01 a 1st only.
  assert.equal(cronMatchesDay(firstAndMondays, 2025, 9, 1), true);
  assert.equal(cronMatchesDay(firstAndMondays, 2025, 9, 8), true, "a Monday matches even when it is not the 1st");
  assert.equal(cronMatchesDay(firstAndMondays, 2025, 10, 1), true, "the 1st matches even when it is a Wednesday");
  assert.equal(cronMatchesDay(firstAndMondays, 2025, 9, 2), false);
  // With only one field restricted, the other must NOT contribute.
  const onlyFirst = s("0 0 1 * *");
  assert.equal(cronMatchesDay(onlyFirst, 2025, 9, 8), false);
  const onlyMondays = s("0 0 * * 1");
  assert.equal(cronMatchesDay(onlyMondays, 2025, 9, 1), true);
  assert.equal(cronMatchesDay(onlyMondays, 2025, 10, 1), false);
  // Month restriction always gates.
  const januaryFirst = s("0 0 1 1 *");
  assert.equal(cronMatchesDay(januaryFirst, 2025, 1, 1), true);
  assert.equal(cronMatchesDay(januaryFirst, 2025, 2, 1), false);
});

// ── CR-02: agreement with brute force ───────────────────────────────────────

await test("CR-02 · next-occurrence search equals a minute-by-minute scan in UTC", {}, () => {
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  for (const expr of ["*/15 * * * *", "0 9 * * 1-5", "30 2 * * *", "0 0 1 * *", "0 0 29 2 *", "5/10 * * * *"]) {
    const r = parseCron(expr);
    assert.ok(r.ok);
    const horizonDays = 40;
    const run = nextOccurrences(r.schedule, start, "UTC", 5, horizonDays);
    // The slow path: every minute of the window, reading the civil fields straight off
    // the UTC clock (`getUTC*`) rather than through the parser under test.
    const slow: number[] = [];
    const end = start + horizonDays * 24 * 60 * MIN;
    for (let t = start + MIN; t <= end && slow.length < 5; t += MIN) {
      const d = new Date(t);
      if (r.schedule.hour.includes(d.getUTCHours()) && r.schedule.minute.includes(d.getUTCMinutes()) && cronMatchesDay(r.schedule, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) slow.push(t);
    }
    assert.deepEqual(run.instants, slow, `${expr} disagreed with the brute-force scan`);
    assert.deepEqual(run.skipped, [], "UTC has no gaps");
  }
  // The Feb-29 case proves the day walk does not give up after a single year.
  const leap = parseCron("0 0 29 2 *");
  assert.ok(leap.ok);
  const years = nextOccurrences(leap.schedule, Date.UTC(2025, 0, 1), "UTC", 3, 12 * 366);
  assert.equal(years.instants.length, 3);
  assert.deepEqual(years.instants.map((t) => new Date(t).getUTCFullYear()), [2028, 2032, 2036]);
});

// ── CR-03: DST honesty ──────────────────────────────────────────────────────

await test("CR-03 · a wall time the zone skipped is reported, not invented, and an overlap fires once", {}, () => {
  const NY = "America/New_York";
  const daily230 = parseCron("30 2 * * *");
  assert.ok(daily230);
  // 2025-03-09 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
  const spring = nextOccurrences(daily230.schedule, Date.UTC(2025, 2, 7, 0, 0), NY, 4, 30);
  const locals = spring.instants.map((t) => {
    const p = partsInZone(t, NY);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
  });
  assert.deepEqual(locals, ["2025-03-07 02:30", "2025-03-08 02:30", "2025-03-10 02:30", "2025-03-11 02:30"],
    "the skipped morning must be absent from the results");
  assert.equal(spring.skipped.length, 1, "and it must be reported exactly once");
  assert.match(spring.skipped[0].local, /2025-03-09 02:30/);
  // The autumn overlap: 01:30 happens twice on 2025-11-02. Firing twice would be the bug.
  const daily130 = parseCron("30 1 * * *");
  assert.ok(daily130);
  const autumn = nextOccurrences(daily130.schedule, Date.UTC(2025, 10, 1, 0, 0), NY, 4, 30);
  const autumnLocals = autumn.instants.map((t) => {
    const p = partsInZone(t, NY);
    return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
  });
  assert.deepEqual(autumnLocals, ["2025-11-01 01:30", "2025-11-02 01:30", "2025-11-03 01:30", "2025-11-04 01:30"],
    "one occurrence per civil day, even on the day with two 01:30s");
  const nov2 = autumn.instants.filter((t) => {
    const p = partsInZone(t, NY);
    return p.m === 11 && p.d === 2;
  });
  assert.equal(nov2.length, 1);
  assert.equal(partsInZone(nov2[0], NY).offsetMinutes, -240, "the earlier (EDT) instant is the one emitted");
  // Every emitted instant must be strictly after the cursor and strictly increasing.
  for (let i = 1; i < autumn.instants.length; i++) assert.ok(autumn.instants[i] > autumn.instants[i - 1]);
});

// ── CR-04: description ──────────────────────────────────────────────────────

await test("CR-04 · the human description is derived from the parsed fields, never from the source text", {}, () => {
  const d = (expr: string) => {
    const r = parseCron(expr);
    assert.ok(r.ok);
    return describeCron(r.schedule);
  };
  assert.equal(d("* * * * *"), "every minute");
  assert.equal(d("*/15 * * * *"), "at minutes 0, 15, 30, 45 of every hour");
  assert.equal(d("0 * * * *"), "hourly at :00");
  assert.equal(d("0 0 * * *"), "at 00:00");
  assert.equal(d("0 9 * * 1-5"), "on mon–fri at 09:00", "a consecutive run is a range, not five words");
  assert.equal(d("0 0 1 * *"), "on day 1 at 00:00");
  assert.equal(d("0 0 1 * 1"), "on day 1 or weekday mon at 00:00", "the OR semantics must be visible in the words");
  assert.equal(d("@daily"), "@daily (0 0 * * *)");
  assert.equal(d("0 12 * 6 *"), "in jun at 12:00");
  assert.equal(d("30 8,12,18 * * 0"), "on sun at 08:30, 12:30, 18:30");
  // Two different sources that parse to the same fields must describe identically.
  assert.equal(d("0 9 * * 1"), d("0 09 * * MON"));
  assert.equal(d("*/30 * * * *"), d("0,30 * * * *"));
});

// ── OT-01: base32 ───────────────────────────────────────────────────────────

await test("OT-01 · base32 is RFC 4648 and rejects anything that is not exactly that", {}, () => {
  // RFC 4648 §10 test vectors.
  const vectors: [string, string][] = [
    ["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, b32] of vectors) {
    assert.equal(base32Encode(ascii(plain)), b32, `encode ${plain}`);
    if (b32) assert.equal(new TextDecoder().decode(base32Decode(b32)), plain, `decode ${b32}`);
  }
  // The RFC 4226 secret in its standard base32 spelling.
  assert.equal(base32Encode(ascii("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  // Forgiving on presentation, strict on content.
  assert.deepEqual(normaliseSecret("gezd gnbv-gy3t qojq").ok, true);
  assert.equal(normaliseSecret("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ======").ok, true, "padding is forgiven");
  assert.equal(normaliseSecret("GEZDGNBV1Y3TQOJQ").ok, false, "1 is not in the alphabet");
  assert.equal(normaliseSecret("").ok, false);
  // Non-zero trailing bits mean the string was mistyped, not merely padded oddly.
  assert.equal(normaliseSecret("MZ").ok, false, "'MZ' leaves non-zero trailing bits");
});

// ── OT-02: SHA-1 and HMAC-SHA1 against published vectors ────────────────────

await test("OT-02 · SHA-1 and HMAC-SHA1 match FIPS 180-4 and RFC 2202", {}, () => {
  assert.equal(hex(sha1(ascii("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(hex(sha1(ascii(""))), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(hex(sha1(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))), "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  // A multi-block message: 1 MB of 'a' is the classic FIPS long-message vector.
  assert.equal(hex(sha1(new Uint8Array(1_000_000).fill(0x61))), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  // RFC 2202 HMAC-SHA1 cases 1, 2 and 6 (a long key, hashed first).
  assert.equal(hex(hmacSha1(new Uint8Array(20).fill(0x0b), ascii("Hi There"))), "b617318655057264e28bc0b6fb378c8ef146be00");
  assert.equal(hex(hmacSha1(ascii("Jefe"), ascii("what do ya want for nothing?"))), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
  assert.equal(hex(hmacSha1(new Uint8Array(80).fill(0xaa), ascii("Test Using Larger Than Block-Size Key - Hash Key First"))), "aa4ae5e15272d00e95705637ce8a3b55ed402112");
});

// ── OT-03: HOTP and TOTP ────────────────────────────────────────────────────

await test("OT-03 · HOTP and TOTP reproduce the RFC 4226 and RFC 6238 vectors", {}, () => {
  const secret = ascii("12345678901234567890");
  // RFC 4226 Appendix D: counters 0–9.
  const hotpVectors = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  hotpVectors.forEach((expected, counter) => assert.equal(hotp(secret, counter), expected, `HOTP counter ${counter}`));
  // RFC 6238 Appendix B: TOTP-SHA1 at eight digits, with the stated instants.
  const cases: [number, string][] = [
    [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(totp(secret, seconds * 1000, { digits: 8 }).code, expected, `TOTP at ${seconds}s`);
  }
  // The counter is 64-bit even though JS numbers stop being exact at 2^53.
  assert.equal(hex(counterBytes(1)), "0000000000000001");
  assert.equal(hex(counterBytes(1n << 40n)), "0000010000000000");
  assert.equal(hex(counterBytes(2 ** 32)), "0000000100000000", "a counter past 2^32 must not lose the high word");
  assert.equal(hotp(secret, 2 ** 32), hotp(secret, 2 ** 32), "deterministic");
  assert.notEqual(hotp(secret, 2 ** 32), hotp(secret, 1), "and distinct from the low word alone");
  // The window arithmetic is stated, not implied.
  const t = totp(secret, 1_700_000_000_000);
  assert.equal(t.counter, Math.floor(1_700_000_000 / 30));
  assert.equal(t.periodStartMs + t.remainingMs, t.periodStartMs + (30_000 - (1_700_000_000_000 - t.periodStartMs)));
  assert.ok(t.remainingMs > 0 && t.remainingMs <= 30_000);
  assert.ok(t.remainingRatio > 0 && t.remainingRatio <= 1);
});

// ── OT-04: verification, drift and the otpauth URI ──────────────────────────

await test("OT-04 · verification honours the drift window, refuses malformed codes, and the URI round-trips", {}, () => {
  const secret = base32Decode("JBSWY3DPEHPK3PXP");
  const now = 1_700_000_000_000;
  const current = totp(secret, now);
  assert.deepEqual(verifyTotp(secret, current.code, now), { ok: true, drift: 0 });
  // One step early and late are accepted inside the default window, and reported.
  assert.deepEqual(verifyTotp(secret, hotp(secret, current.counter - 1), now), { ok: true, drift: -1 });
  assert.deepEqual(verifyTotp(secret, hotp(secret, current.counter + 1), now), { ok: true, drift: 1 });
  assert.equal(verifyTotp(secret, hotp(secret, current.counter + 2), now).ok, false, "two steps out is outside the window");
  assert.equal(verifyTotp(secret, hotp(secret, current.counter + 2), now, { window: 2 }).ok, true, "a wider window is explicit");
  assert.equal(verifyTotp(secret, "12345", now).ok, false, "five digits is malformed");
  assert.equal(verifyTotp(secret, "abcdef", now).ok, false, "letters are malformed");
  assert.match(verifyTotp(secret, "12345", now).reason ?? "", /expected 6 digits/);
  // Separators are forgiven, because people paste "123 456".
  assert.equal(verifyTotp(secret, `${current.code.slice(0, 3)} ${current.code.slice(3)}`, now).ok, true);
  // Eight-digit mode verifies eight-digit codes and refuses six.
  const eight = totp(secret, now, { digits: 8 });
  assert.equal(verifyTotp(secret, eight.code, now, { digits: 8 }).ok, true);
  assert.equal(verifyTotp(secret, current.code, now, { digits: 8 }).ok, false);
  // Custom periods are honoured consistently in both directions.
  const p60 = totp(secret, now, { period: 60 });
  assert.equal(p60.counter, Math.floor(now / 1000 / 60));
  assert.equal(verifyTotp(secret, p60.code, now, { period: 60 }).ok, true);

  // The URI: build, parse, and every field survives.
  const uri = buildOtpAuthUri({ secret, account: "ada@lovelace.dev", issuer: "Fusion", digits: 8, period: 60 });
  // In this URI builder, the separator colon stays literal while label parts are encoded.
  assert.match(uri, /^otpauth:\/\/totp\/Fusion:ada%40lovelace\.dev\?/);
  const parsed = parseOtpAuthUri(uri);
  assert.ok(parsed.ok);
  assert.equal(parsed.account, "ada@lovelace.dev");
  assert.equal(parsed.issuer, "Fusion");
  assert.equal(parsed.digits, 8);
  assert.equal(parsed.period, 60);
  assert.equal(base32Encode(parsed.secret), base32Encode(secret));
  // A default-shaped URI stays short and carries no redundant parameters.
  const plain = buildOtpAuthUri({ secret, account: "bob" });
  assert.doesNotMatch(plain, /digits|period|algorithm/);
  // Refusals: each is a named error, not a silent default.
  const rejects: [string, RegExp][] = [
    ["https://example.com/?secret=JBSWY3DPEHPK3PXP", /not an otpauth/],
    ["otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1", /need a counter/],
    ["otpauth://totp/x?secret=***", /not base32/],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5", /not 6, 7 or 8/],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0", /outside 1–300/],
    ["otpauth://totp/A:x?secret=JBSWY3DPEHPK3PXP&issuer=B", /disagree/],
    ["otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256", /digest this build does not carry/],
    ["otpauth://totp/?secret=JBSWY3DPEHPK3PXP", /no account label/],
    ["otpauth://totp/%FF?secret=JBSWY3DPEHPK3PXP", /invalid label encoding/],
    ["otpauth://totp/%ZZ?secret=JBSWY3DPEHPK3PXP", /invalid label encoding/],
  ];
  for (const [uri2, why] of rejects) {
    const r = parseOtpAuthUri(uri2);
    assert.equal(r.ok, false, `${uri2} must be refused`);
    if (r.ok === false) assert.match(r.error, why, `${uri2}: ${r.error}`);
  }
});

await finish();
