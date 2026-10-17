/**
 * Oracle suite "oracle-vcard" (TT24): the vCard engine checked in BOTH directions against an independent
 * implementation, vobject 0.9.9 (Python, Apache-2.0, installed into TOOLS_DIR/venv by scripts/sandbox/bootstrap.sh).
 *   A. what we WRITE (4.0, folded at 75 octets, escaped) is read back by vobject with the same field values;
 *   B. what vobject WRITES (3.0, its own folding/escaping) is read by us with the same field values.
 * Missing Python/vobject makes the suite FAIL loudly.
 */
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import * as C from "../src/lib/contacts-core.ts";

const { test, finish } = makeHarness("oracle-vcard");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: ours ${x} vs vobject ${y}`); };
const PY = process.env.ORACLE_PY ?? `${process.env.TOOLS_DIR ?? "/home/user/tools"}/venv/bin/python`;
const py = (prog: string, input: string) => execFileSync(PY, ["-c", prog], { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

const READ = `import sys, json, vobject
out = []
for card in vobject.readComponents(sys.stdin.read()):
    def all_(name): return [x for x in card.getChildren() if x.name == name.upper()]
    n = card.n.value if hasattr(card, "n") else None
    out.append({
        "fn": card.fn.value,
        "n": [n.family, n.given, n.additional, n.prefix, n.suffix] if n else None,
        "emails": [[e.value, sorted(t.lower() for t in e.params.get("TYPE", []))] for e in all_("EMAIL")],
        "tels": [t.value for t in all_("TEL")],
        "adr": [[a.value.street, a.value.city, a.value.region, a.value.code, a.value.country] for a in all_("ADR")],
        "note": card.note.value if hasattr(card, "note") else "",
        "categories": card.categories.value if hasattr(card, "categories") else [],
        "org": card.org.value if hasattr(card, "org") else [],
        "uid": card.uid.value if hasattr(card, "uid") else "",
    })
print(json.dumps(out))`;

function tricky(): C.Contact {
  const c = C.emptyContact("urn:uuid:oracle-1");
  c.fn = "Zoë \"Z\" Ångström-Ñúñez, PhD";
  c.n = { family: "Ångström-Ñúñez", given: "Zoë", additional: "", prefix: "Dr.", suffix: "PhD" };
  c.org = ["ACME; Labs", "R&D"];
  c.emails = [{ value: "zoe@acme.io", types: ["work"], pref: 1 }, { value: "z@home.example", types: ["home"] }];
  c.tels = [{ value: "+1 (919) 555-0142", types: ["cell"] }];
  c.adrs = [{ types: ["work"], pobox: "", ext: "Suite 5", street: "1 Main St, Bldg; B", locality: "Raleigh", region: "NC", code: "27601", country: "USA" }];
  c.note = "Line one, with comma; and semicolon\nLine two: 日本語 🙂 " + "long ".repeat(30) + "\\ backslash";
  c.categories = ["work", "conference 2026"];
  return c;
}

await test("A. vobject reads what we write: names, typed e-mails, phones, structured ADR, escaped multi-line UTF-8 note, ORG, categories", { "CN-01": "full" }, () => {
  const c = tricky();
  const ours = C.serializeVcf([c]);
  const [v] = JSON.parse(py(READ, ours));
  eq(c.fn, v.fn, "FN"); eq([c.n.family, c.n.given, c.n.additional, c.n.prefix, c.n.suffix], v.n, "N");
  eq(c.emails.map((e) => [e.value, [...e.types].sort()]), v.emails, "EMAIL + TYPE");
  eq(c.tels.map((t) => t.value), v.tels, "TEL");
  eq(c.adrs.map((a) => [a.street, a.locality, a.region, a.code, a.country]), v.adr, "ADR");
  eq(c.note, v.note, "NOTE (escapes + folding across multibyte)"); eq(c.org, v.org, "ORG components"); eq(c.categories, v.categories, "CATEGORIES"); eq(c.uid, v.uid, "UID");
  // and the RFC 6350 §8 vCard after our round trip
  const rfc = C.parseVcf("BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Simon Perreault\r\nN:Perreault;Simon;;;ing. jr,M.Sc.\r\nADR;TYPE=work:;Suite D2-630;2875 Laurier;\r\n Quebec;QC;G1V 2M2;Canada\r\nEMAIL;TYPE=work:simon.perreault@viagenie.ca\r\nEND:VCARD").contacts;
  const [r] = JSON.parse(py(READ, C.serializeVcf(rfc)));
  eq(["2875 Laurier", "Quebec", "QC", "G1V 2M2", "Canada"], r.adr[0], "RFC ADR after our write");
});

await test("B. we read what vobject writes (3.0, its own folding and escaping)", { "CN-01": "full" }, () => {
  const WRITE = `import vobject, sys
c = vobject.vCard()
c.add("fn").value = "Bjørk Guðmundsdóttir; \\"the\\" singer"
c.add("n").value = vobject.vcard.Name(family="Guðmundsdóttir", given="Bjørk", additional="", prefix="", suffix="")
e = c.add("email"); e.value = "bjork@example.is"; e.type_param = "INTERNET"
e2 = c.add("email"); e2.value = "b@work.example"; e2.type_paramlist = ["WORK", "PREF"]
t = c.add("tel"); t.value = "+354 555 1234"; t.type_param = "CELL"
a = c.add("adr"); a.value = vobject.vcard.Address(street="Laugavegur 1, 2. hæð", city="Reykjavík", region="", code="101", country="Iceland"); a.type_param = "HOME"
c.add("note").value = "Comma, semicolon; newline\\nand a very long line " + "x" * 120
c.add("categories").value = ["music", "iceland"]
c.add("org").value = ["One Little Indian", "A&R"]
sys.stdout.write(c.serialize())`;
  const text = py(WRITE, "");
  ok(/\r\n /.test(text), "vobject folded at least one line (so unfolding is exercised)");
  const r = C.parseVcf(text);
  eq(r.warnings, [], "no warnings"); eq(r.versions, { "3.0": 1 }, "version");
  const c = r.contacts[0];
  eq(c.fn, 'Bjørk Guðmundsdóttir; "the" singer', "FN");
  eq([c.n.family, c.n.given], ["Guðmundsdóttir", "Bjørk"], "N");
  eq(c.emails.map((e) => [e.value, e.types, e.pref ?? null]), [["bjork@example.is", [], null], ["b@work.example", ["work"], 1]], "EMAIL types/pref");
  eq(c.tels.map((t) => [t.value, t.types]), [["+354 555 1234", ["cell"]]], "TEL");
  eq([c.adrs[0].street, c.adrs[0].locality, c.adrs[0].code, c.adrs[0].country, c.adrs[0].types], ["Laugavegur 1, 2. hæð", "Reykjavík", "101", "Iceland", ["home"]], "ADR");
  eq(c.note, "Comma, semicolon; newline\nand a very long line " + "x".repeat(120), "NOTE");
  eq(c.categories, ["music", "iceland"], "CATEGORIES"); eq(c.org, ["One Little Indian", "A&R"], "ORG");
});

await test("A+B: 200 generated contacts survive ours → vobject → ours with identical modelled fields", { "CN-01": "full" }, () => {
  const names = ["Ana", "Bo", "Chloé", "Dmitri", "Eun-ji", "Fatima", "Gábor", "Hiro", "Inés", "Jürgen"];
  const list = Array.from({ length: 200 }, (_, i) => {
    const c = C.emptyContact(`urn:uuid:gen-${i}`);
    const g = names[i % names.length], f = `Fam${i}${i % 7 === 0 ? ", Jr" : ""}`;
    c.fn = `${g} ${f}`; c.n = { family: f, given: g, additional: "", prefix: "", suffix: "" };
    c.emails = [{ value: `${g.toLowerCase().replace(/[^a-z]/g, "")}${i}@ex.org`, types: [i % 2 ? "home" : "work"] }];
    c.tels = [{ value: `+1 919 555 ${String(1000 + i)}`, types: ["cell"] }];
    c.note = i % 3 ? `note ${i}; with, punctuation` : "";
    c.categories = i % 4 ? ["a", `g${i % 5}`] : [];
    return c;
  });
  // vobject parses ours and re-serialises as 3.0; we parse that and compare the modelled fields
  const ROUND = `import sys, vobject
sys.stdout.write("".join(c.serialize() for c in vobject.readComponents(sys.stdin.read())))`;
  const back = C.parseVcf(py(ROUND, C.serializeVcf(list))).contacts;
  eq(back.length, 200, "count");
  const pick = (c: C.Contact) => [c.uid, c.fn, c.n.family, c.n.given, c.emails.map((e) => [e.value, e.types]), c.tels.map((t) => t.value), c.note, c.categories];
  for (let i = 0; i < 200; i++) eq(pick(back[i]), pick(list[i]), `contact ${i}`);
});

finish();
