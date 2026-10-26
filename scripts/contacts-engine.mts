/**
 * Unit suite "contacts-engine" (TT24): the vCard engine in src/lib/contacts-core.ts.
 * The vCards marked RFC are copied verbatim from RFC 6350 §8 / §4.1 and RFC 2426 §7 (fetched from rfc-editor.org);
 * expected values are read off the RFC text by hand, not from the engine.
 */
import { makeHarness } from "./harness.mts";
import * as C from "../src/lib/contacts-core.ts";

const { test, finish } = makeHarness("contacts-engine");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: got ${x}, want ${y}`); };
let seq = 0; const uid = () => `urn:uuid:test-${++seq}`;
const parse = (s: string) => C.parseVcf(s, { newUid: uid });

// RFC 6350 §8 "Author's vCard" — verbatim, CRLF line ends, folded lines start with one space
const RFC6350_8 = [
  "BEGIN:VCARD", "VERSION:4.0", "FN:Simon Perreault", "N:Perreault;Simon;;;ing. jr,M.Sc.", "BDAY:--0203", "ANNIVERSARY:20090808T1430-0500", "GENDER:M",
  "LANG;PREF=1:fr", "LANG;PREF=2:en", "ORG;TYPE=work:Viagenie", "ADR;TYPE=work:;Suite D2-630;2875 Laurier;", " Quebec;QC;G1V 2M2;Canada",
  'TEL;VALUE=uri;TYPE="work,voice";PREF=1:tel:+1-418-656-9254;ext=102', 'TEL;VALUE=uri;TYPE="work,cell,voice,video,text":tel:+1-418-262-6501',
  "EMAIL;TYPE=work:simon.perreault@viagenie.ca", "GEO;TYPE=work:geo:46.772673,-71.282945", "KEY;TYPE=work;VALUE=uri:", " http://www.viagenie.ca/simon.perreault/simon.asc",
  "TZ:-0500", "URL;TYPE=home:http://nomis80.org", "END:VCARD",
].join("\r\n");
// RFC 2426 §7 first example (vCard 3.0) — verbatim, note the mixed-case BEGIN:vCard and the folded ADR
const RFC2426_7 = [
  "BEGIN:vCard", "VERSION:3.0", "FN:Frank Dawson", "ORG:Lotus Development Corporation", "ADR;TYPE=WORK,POSTAL,PARCEL:;;6544 Battleford Drive", " ;Raleigh;NC;27613-3502;U.S.A.",
  "TEL;TYPE=VOICE,MSG,WORK:+1-919-676-9515", "TEL;TYPE=FAX,WORK:+1-919-676-9564", "EMAIL;TYPE=INTERNET,PREF:Frank_Dawson@Lotus.com", "EMAIL;TYPE=INTERNET:fdawson@earthlink.net",
  "URL:http://home.earthlink.net/~fdawson", "END:vCard",
].join("\r\n");

await test("RFC 6350 §8 author's vCard: unfolding, structured N/ADR, quoted TYPE lists, tel: URIs, unknown properties kept", { "CN-01": "full" }, () => {
  const r = parse(RFC6350_8);
  eq(r.contacts.length, 1, "one contact"); eq(r.versions, { "4.0": 1 }, "version"); eq(r.warnings, [], "no warnings");
  const c = r.contacts[0];
  eq(c.fn, "Simon Perreault", "FN");
  eq(c.n, { family: "Perreault", given: "Simon", additional: "", prefix: "", suffix: "ing. jr, M.Sc." }, "N (suffix list)");
  eq(c.bday, "--0203", "BDAY"); eq(C.parseBday(c.bday), { month: 2, day: 3 }, "year-less birthday");
  eq(c.org, ["Viagenie"], "ORG");
  eq(c.adrs.length, 1, "1 ADR");
  eq([c.adrs[0].ext, c.adrs[0].street, c.adrs[0].locality, c.adrs[0].region, c.adrs[0].code, c.adrs[0].country], ["Suite D2-630", "2875 Laurier", "Quebec", "QC", "G1V 2M2", "Canada"], "ADR across the fold");
  eq(c.tels.map((t) => [t.value, t.types, t.pref ?? null, !!t.uri]), [["+1-418-656-9254;ext=102", ["work"], 1, true], ["+1-418-262-6501", ["work", "cell", "video", "text"], null, true]], "TEL");
  eq(c.emails.map((e) => [e.value, e.types]), [["simon.perreault@viagenie.ca", ["work"]]], "EMAIL");
  eq(c.urls.map((u) => u.value), ["http://nomis80.org"], "URL");
  // ANNIVERSARY, GENDER, LANG×2, GEO, KEY (unfolded), TZ are not modelled → kept verbatim
  eq(c.extra, ["ANNIVERSARY:20090808T1430-0500", "GENDER:M", "LANG;PREF=1:fr", "LANG;PREF=2:en", "GEO;TYPE=work:geo:46.772673,-71.282945", "KEY;TYPE=work;VALUE=uri:http://www.viagenie.ca/simon.perreault/simon.asc", "TZ:-0500"], "extra lines");
  eq(c.uid, "urn:uuid:test-1", "missing UID generated");
});

await test("RFC 2426 §7 (vCard 3.0): TYPE=PREF, INTERNET dropped, VOICE dropped beside other types, mixed-case BEGIN", { "CN-01": "full" }, () => {
  const c = parse(RFC2426_7).contacts[0];
  eq(c.fn, "Frank Dawson", "FN"); eq(c.org, ["Lotus Development Corporation"], "ORG");
  eq([c.adrs[0].street, c.adrs[0].locality, c.adrs[0].region, c.adrs[0].code, c.adrs[0].country, c.adrs[0].types], ["6544 Battleford Drive", "Raleigh", "NC", "27613-3502", "U.S.A.", ["work", "postal", "parcel"]], "ADR");
  eq(c.tels.map((t) => [t.value, t.types]), [["+1-919-676-9515", ["msg", "work"]], ["+1-919-676-9564", ["fax", "work"]]], "TEL types");
  eq(c.emails.map((e) => [e.value, e.types, e.pref ?? null]), [["Frank_Dawson@Lotus.com", [], 1], ["fdawson@earthlink.net", [], null]], "EMAIL pref");
});

await test("vCard 2.1: QUOTED-PRINTABLE with soft breaks, CHARSET=ISO-8859-1, bare TYPE params, base64 PHOTO, missing FN", { "CN-01": "full" }, () => {
  const v21 = [
    "BEGIN:VCARD", "VERSION:2.1",
    "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;",
    "TEL;CELL;PREF:+49 170 1234567",
    "NOTE;ENCODING=QUOTED-PRINTABLE:Line one=0D=0ALine two continues on the =",
    "next physical line",
    "PHOTO;ENCODING=BASE64;TYPE=PNG:iVBORw0KGgo=",
    "END:VCARD",
    "BEGIN:VCARD", "VERSION:2.1", "FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Ren=E9 Fran=E7ois", "END:VCARD",
  ].join("\r\n");
  const r = parse(v21);
  const [a, b] = r.contacts;
  eq([a.n.family, a.n.given], ["Müller", "Jürgen"], "UTF-8 QP name");
  eq(a.fn, "Jürgen Müller", "FN derived from N"); ok(r.warnings.some((w) => w.includes("no FN")), "warns about derived FN");
  eq(a.tels[0], { value: "+49 170 1234567", types: ["cell"], pref: 1 }, "bare TYPE + PREF");
  eq(a.note, "Line one\r\nLine two continues on the next physical line", "QP soft line break");
  eq(a.photo, "data:image/png;base64,iVBORw0KGgo=", "PHOTO → data URI");
  eq(b.fn, "René François", "ISO-8859-1 QP");
  eq(r.versions, { "2.1": 2 }, "versions");
});

await test("round trip: parse → write 4.0 → parse is identical; lines ≤ 75 octets; UTF-8 never split; PID/ALTID kept", { "CN-01": "full" }, () => {
  const src = parse(RFC6350_8 + "\r\n" + RFC2426_7).contacts;
  const out = C.serializeVcf(src);
  for (const l of out.split("\r\n")) ok(new TextEncoder().encode(l).length <= 75, `line over 75 octets: ${l}`);
  const back = C.parseVcf(out).contacts;
  eq(back, src, "round trip");
  // RFC 6350 §7 sync parameters survive (they key property matching between devices)
  const sync = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1\r\nFN:J. Doe\r\nEMAIL;PID=1.1:jdoe@example.com\r\nTEL;PID=2.1,2.2;VALUE=uri:tel:+1-666-666-6666\r\nCLIENTPIDMAP:1;urn:uuid:53e374d9-337e-4727-8803-a1e9c14e0556\r\nEND:VCARD\r\n";
  const s2 = C.serializeVcf(C.parseVcf(sync).contacts);
  ok(s2.includes("EMAIL;PID=1.1:jdoe@example.com"), `EMAIL PID lost:\n${s2}`);
  ok(s2.includes("TEL;PID=2.1,2.2;VALUE=uri:tel:+1-666-666-6666"), `TEL PID/uri lost:\n${s2}`);
  ok(s2.includes("CLIENTPIDMAP:1;urn:uuid:53e374d9-337e-4727-8803-a1e9c14e0556"), "CLIENTPIDMAP lost");
  // long multi-byte note: folding must cut between code points
  const c = C.emptyContact("u1"); c.fn = "Ünïcödé"; c.note = "日本語のメモ🙂".repeat(20) + ", with; commas\nand lines";
  const w = C.serializeContact(c);
  for (const l of w.split("\r\n")) ok(new TextEncoder().encode(l).length <= 75, "fold limit with multibyte");
  ok(!w.includes("\ufffd"), "no replacement chars");
  eq(C.parseVcf(w).contacts[0].note, c.note, "multibyte note round trip");
  // RFC 6350 §4.1 NOTE example
  const note = C.parseVcf("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:x\r\nNOTE:Mythical Manager\\nHyjinx Software Division\\n\r\n BabsCo\\, Inc.\\n\r\nEND:VCARD").contacts[0].note;
  eq(note, "Mythical Manager\nHyjinx Software Division\nBabsCo, Inc.\n", "RFC 6350 §4.1 NOTE");
});

await test("RFC 6350 §4.3.1 dates: write basic format (YYYY-MM-DD is disallowed in 4.0), accept every listed form, Feb 29", { "CN-01": "full", "CN-03": "partial" }, () => {
  const c = C.emptyContact("d"); c.fn = "D"; c.bday = "1985-04-12";
  ok(C.serializeContact(c).includes("BDAY:19850412\r\n"), "extended date written as basic");
  c.bday = "--04-12"; ok(C.serializeContact(c).includes("BDAY:--0412\r\n"), "--MM-DD → --MMDD");
  for (const d of ["19850412", "1985-04", "1985", "--0412", "---12", "19961022T140000", "1985-04-12"]) eq(C.validate({ ...c, bday: d }), [], `RFC date ${d}`);
  ok(C.validate({ ...c, bday: "April 12" }).length === 1, "non-date rejected");
  eq(C.parseBday("--0230"), null, "Feb 30 invalid"); eq(C.parseBday("--0229"), { month: 2, day: 29 }, "Feb 29 without year valid");
  eq(C.parseBday("19000229"), null, "1900 is not a leap year");
  const leap = { ...C.emptyContact("l"), fn: "Leap", bday: "20000229" };
  // 2027 is not a leap year → observed Feb 28 2027; today 2027-02-20 → 8 days, turns 27
  eq(C.upcomingBirthdays([leap], "2027-02-20", 30), [{ uid: "l", fn: "Leap", date: "2027-02-28", inDays: 8, turns: 27 }], "Feb 29 in a non-leap year");
  // year wrap: today Dec 30, birthday Jan 2 → 3 days
  eq(C.upcomingBirthdays([{ ...leap, bday: "--0102" }], "2026-12-30", 7).map((b) => [b.date, b.inDays, b.turns ?? null]), [["2027-01-02", 3, null]], "year wrap");
  // a text birthday is kept verbatim, never re-emitted as an invalid date
  const t = C.parseVcf("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Old\r\nBDAY;VALUE=text:circa 1800\r\nEND:VCARD").contacts[0];
  eq([t.bday, t.extra], ["", ["BDAY;VALUE=text:circa 1800"]], "text BDAY");
});

await test("duplicates (e-mail case, phone formatting, folded name) and merge keep everything from both", { "CN-03": "full" }, () => {
  const mk = (u: string, fn: string, email?: string, tel?: string) => ({ ...C.emptyContact(u), fn, emails: email ? [{ value: email, types: [] }] : [], tels: tel ? [{ value: tel, types: [] }] : [] });
  const list = [mk("a", "Ana Lima", "ana@x.org"), mk("b", "A. Lima", "ANA@X.ORG ", "+1 (919) 555-0100"), mk("c", "Bo", undefined, "919.555.0100"), mk("d", "José Núñez"), mk("e", "jose  nunez"), mk("f", "Solo", "solo@x.org", "123")];
  const g = C.findDuplicates(list);
  eq(g.map((x) => x.uids.sort()), [["a", "b", "c"], ["d", "e"]], "groups (a~b by e-mail, b~c by last-10 phone digits, d~e by folded name; 3-digit phone ignored)");
  ok(g[0].reasons.some((r) => r.startsWith("same e-mail")) && g[0].reasons.some((r) => r.startsWith("same phone")), `reasons ${g[0].reasons}`);
  const a = { ...list[0], note: "met at PyCon", categories: ["work"], extra: ["X-A:1"] };
  const b = { ...list[1], note: "likes tea", categories: ["Work", "friends"], extra: ["X-B:2"], title: "CTO" };
  const m = C.mergeContacts(a, b, "20261016T000000Z");
  eq(m.uid, "a", "keeps a's UID"); eq(m.fn, "Ana Lima", "keeps a's name"); eq(m.title, "CTO", "fills empty title from b");
  eq(m.emails.map((e) => e.value), ["ana@x.org"], "e-mail deduplicated case-insensitively");
  eq(m.tels.map((t) => t.value), ["+1 (919) 555-0100"], "phone taken from b");
  eq(m.note, "met at PyCon\nlikes tea", "both notes kept"); eq(m.categories, ["work", "friends"], "categories unioned (case-folded)");
  eq(m.extra, ["X-A:1", "X-B:2"], "unknown properties from both kept"); eq(m.rev, "20261016T000000Z", "REV updated");
});

await test("search (accents, tokens, phone digits), sort/letters, CSV export with injection guard, Contact Picker mapping, validation", { "CN-02": "partial", "CN-04": "full" }, () => {
  const c = { ...C.emptyContact("s"), fn: "Zoë Ångström", n: { ...C.emptyContact("s").n, family: "Ångström", given: "Zoë" }, org: ["ACME"], tels: [{ value: "+1 (919) 555-0142", types: [] }], emails: [{ value: "zoe@acme.io", types: [] }] };
  ok(C.matches(c, "zoe angstrom"), "accent-insensitive"); ok(C.matches(c, "acme zo"), "multi-token"); ok(C.matches(c, "555-0142"), "phone digits");
  ok(C.matches(c, "9195550142"), "phone without formatting"); ok(!C.matches(c, "zoe smith"), "all tokens must match"); ok(!C.matches(c, "12"), "two digits are not a phone query");
  const sorted = C.sortContacts([{ ...C.emptyContact("1"), fn: "bob" }, c, { ...C.emptyContact("2"), fn: "Émile" }, { ...C.emptyContact("3"), fn: "42 Club" }]);
  eq(sorted.map((x) => x.fn), ["42 Club", "Zoë Ångström", "bob", "Émile"], "sort by folded family-or-name (Ångström → angstrom)");
  eq(sorted.map(C.letterOf), ["#", "A", "B", "E"], "letters");
  const evil = { ...C.emptyContact("e"), fn: "=HYPERLINK(\"http://x\")", note: "@SUM(1)", tels: [{ value: "+1 919 555 0100", types: [] }, { value: "-12", types: [] }], title: "a,b \"q\"" };
  const csv = C.toCsv([evil]).split("\r\n")[1];
  ok(csv.startsWith(`"'=HYPERLINK(""http://x"")"`), `formula guarded: ${csv}`);
  ok(csv.includes(",'@SUM(1)") && csv.includes(",+1 919 555 0100,-12,"), `phone-like values exempt, @ guarded: ${csv}`);
  ok(csv.includes(`"a,b ""q"""`), "RFC 4180 quoting");
  const p = C.fromPicker({ name: ["Kai"], email: ["kai@x.org"], tel: ["+44 20 7946 0958"], address: [{ addressLine: ["1 Way", "Flat 2"], city: "London", postalCode: "E1", country: "GB" }] }, "p1");
  eq([p.fn, p.emails[0].value, p.tels[0].value, p.adrs[0].street, p.adrs[0].locality], ["Kai", "kai@x.org", "+44 20 7946 0958", "1 Way, Flat 2", "London"], "picker mapping");
  eq(C.fromPicker({ email: ["only@x.org"] }, "p2").fn, "only@x.org", "picker without a name");
  eq(C.validate({ ...C.emptyContact("v"), fn: "" , emails: [{ value: "nope", types: [] }], tels: [{ value: "x1", types: [] }] }).length, 3, "three problems");
});

await test("hostile input: nested AGENT vCard, missing END, junk lines, 25 MB input, 20 001 contacts, RFC 6868 param escapes", { "CN-01": "full" }, () => {
  const nested = "BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Outer\r\nAGENT:\r\nBEGIN:VCARD\r\nFN:Inner\r\nEND:VCARD\r\nEMAIL:o@x.org\r\nEND:VCARD\r\n";
  const r = parse(nested);
  eq(r.contacts.map((c) => [c.fn, c.emails.map((e) => e.value)]), [["Outer", ["o@x.org"]]], "inner card skipped, outer intact");
  ok(r.warnings.some((w) => w.includes("nested")), "warned");
  const noEnd = parse("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Cut\r\n");
  eq(noEnd.contacts.map((c) => c.fn), ["Cut"], "kept without END"); ok(noEnd.warnings.some((w) => w.includes("without END")), "warned");
  eq(parse("hello\r\nworld\r\nBEGIN:VCARD\r\nFN:A\r\nthis line has no colon\r\nEND:VCARD").contacts.length, 1, "junk outside and inside ignored");
  const big = C.parseVcf("x".repeat(C.MAX_INPUT + 1));
  eq(big.contacts.length, 0, "over-size input refused"); ok(big.warnings[0].includes("limit"), "says why");
  const many = Array.from({ length: C.MAX_CONTACTS + 1 }, (_, i) => `BEGIN:VCARD\r\nFN:c${i}\r\nEND:VCARD`).join("\r\n");
  const t0 = performance.now(); const m = parse(many);
  eq(m.contacts.length, C.MAX_CONTACTS, "contact cap"); ok(m.warnings.some((w) => w.includes("stopped after")), "cap warned"); ok(performance.now() - t0 < 4000, "20k contacts parse in < 4 s");
  // RFC 6868: ^n newline, ^' double quote, ^^ caret inside a parameter value; written back the same way
  const p = parse('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:P\r\nADR;LABEL="Line 1^nLine ^\'2^\' ^^up":;;Street;Town;;;\r\nEND:VCARD').contacts[0];
  ok(p.adrs[0].params === ';LABEL="Line 1^nLine ^\'2^\' ^^up"', `LABEL param re-encoded: ${p.adrs[0].params}`);
  ok(C.serializeContact(p).includes('ADR;LABEL="Line 1^nLine ^\'2^\' ^^up":;;Street;Town;;;'), "written back");
});

finish();
