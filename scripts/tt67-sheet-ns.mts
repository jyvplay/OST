/**
 * TT67 — Spreadsheet reader: XML namespace prefixes resolved, not matched literally (src/lib/office/xml-ns.ts).
 *
 * Independent verifiers (no shared code with ours):
 *  - lxml (scripts/oracle/xml_ns_equiv.py): every rewritten part is namespace-EQUIVALENT to the original (same expanded
 *    names / attributes / text / comments), uses the canonical prefixes, and keeps Markup-Compatibility prefix lists
 *    pointing at the same namespaces — over every XML part of the 353-file Apache POI corpus plus adversarial shapes;
 *  - openpyxl: the cell values of the corpus workbooks written with `x:` / `s:` SpreadsheetML prefixes;
 *  - the MS-XLSX x14 oracle (scripts/oracle/xlsx_x14.py) for the foreign-prefix CF case.
 * "Before" = the TT66 reader (git 2edf699, extracted with git archive), run on the same inputs.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt67-sheet-ns.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import type { CondRule } from "../src/lib/formula/sheetmeta.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { readCentralDirectory, readEntryVerified, writeZip } from "../src/lib/server/zip.ts";
import { canonicalizeNs, isCanonicalNs, NS, RELS_CANON, SML_CANON, type NsCanon } from "../src/lib/office/xml-ns.ts";

const { test, finish } = makeHarness("tt67-sheet-ns");
const COV = { "FF-21": "full", "FF-50": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
const dir = "/tmp/tt67ns"; mkdirSync(dir, { recursive: true });
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 900)} != ${JSON.stringify(b)?.slice(0, 900)}`); };
/** what the reader applies (formula/xlsx.ts get): .rels → package relationships, xl/**.xml → SpreadsheetML; other parts are never parsed */
const canonFor = (name: string): NsCanon | null => (/\.rels$/i.test(name) ? RELS_CANON : /^xl\/.*\.xml$/i.test(name) ? SML_CANON : null);
type Item = { id: string; orig: string; canon: string; map: NsCanon };
const runOracle = (items: Item[], tag: string) => {
  const p = `${dir}/${tag}.json`; writeFileSync(p, JSON.stringify(items));
  let out = "";
  try { out = execFileSync(PY, ["scripts/oracle/xml_ns_equiv.py", p], { encoding: "utf8", maxBuffer: 1 << 28 }); } catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
  const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { id?: string; ok?: boolean; problems?: string[]; summary?: boolean; items?: number; failed?: number });
  return { summary: lines.find((l) => l.summary)!, bad: lines.filter((l) => l.ok === false) };
};

// the TT66 reader, for "before" evidence
const BEFORE = "/tmp/tt67-before";
if (!existsSync(`${BEFORE}/src/lib/formula/xlsx.ts`)) { mkdirSync(BEFORE, { recursive: true }); execFileSync("bash", ["-c", `git archive 2edf699 src/lib | tar -x -C ${BEFORE}`]); }
const before = (await import(`${BEFORE}/src/lib/formula/xlsx.ts`)) as { readXlsxWorkbook: typeof readXlsxWorkbook };

/* ------------------------------------------------------------------ adversarial shapes */
const SML = NS.sml, X14 = NS.x14, XM = NS.xm;
const ADV: [string, string][] = [
  ["prefixed-main", `<x:worksheet xmlns:x="${SML}" xmlns:r="${NS.r}"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c></x:row></x:sheetData><x:hyperlinks><x:hyperlink ref="A1" r:id="rId1"/></x:hyperlinks></x:worksheet>`],
  ["renamed-r", `<worksheet xmlns="${SML}" xmlns:rel="${NS.r}"><drawing rel:id="rId9"/></worksheet>`],
  ["redeclare-deep", `<x:worksheet xmlns:x="${SML}"><x:extLst><x:ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x="${X14}"><x:conditionalFormattings/></x:ext></x:extLst><x:sheetData/></x:worksheet>`],
  ["foreign-on-x14", `<worksheet xmlns="${SML}"><extLst><ext uri="{T}" xmlns:x14="urn:example:other"><x14:cfRule type="iconSet"/></ext></extLst></worksheet>`],
  ["foreign-default", `<worksheet xmlns="${SML}"><extLst><ext uri="{T}"><thing xmlns="urn:example:other"><c r="A1"/></thing></ext></extLst><sheetData/></worksheet>`],
  ["x14-default", `<worksheet xmlns="${SML}"><extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}"><conditionalFormattings xmlns="${X14}"><conditionalFormatting xmlns:m="${XM}"><cfRule type="iconSet" priority="2" id="{A}"><iconSet iconSet="3Stars"><cfvo type="percent"><m:f>0</m:f></cfvo></iconSet></cfRule><m:sqref>A1:A3</m:sqref></conditionalFormatting></conditionalFormattings></ext></extLst></worksheet>`],
  ["mce", `<x:worksheet xmlns:x="${SML}" xmlns:mx="${NS.mc}" xmlns:q="${X14}" xmlns:k="urn:k" mx:Ignorable="q k" mx:ProcessContent="q:foo k:*"><mx:AlternateContent><mx:Choice Requires="q"><q:thing/></mx:Choice><mx:Fallback/></mx:AlternateContent></x:worksheet>`],
  ["comments-cdata-pi", `<?xml version="1.0"?><!-- <x:fake/> --><x:worksheet xmlns:x="${SML}"><?pi <x:no/>?><x:sheetData><![CDATA[<x:c r="Z9"/>]]></x:sheetData><!--x:--></x:worksheet>`],
  ["gt-in-attr", `<x:worksheet xmlns:x="${SML}"><x:sheetData><x:row r="1" spans="a>b"/></x:sheetData></x:worksheet>`],
  ["single-quotes-ws", `<x:worksheet\n  xmlns:x='${SML}'\n  ><x:sheetData\n/></x:worksheet\n>`],
  ["xml-space", `<x:sst xmlns:x="${SML}"><x:si><x:t xml:space="preserve"> a </x:t></x:si></x:sst>`],
  ["undeclare-default", `<root xmlns="urn:example:r"><x:a xmlns:x="${SML}"/><b xmlns=""/></root>`],
  // TT67 second-order (mutants survived without these): no-namespace children under a canonical OUTPUT default, incl.
  // two consecutive self-closing siblings (the output default must be restored after each) and a nested one
  ["no-ns-under-default", `<x:worksheet xmlns:x="${SML}"><x:sheetData><a xmlns=""/><b xmlns=""/><c xmlns=""><d/></c><x:row r="1"/></x:sheetData></x:worksheet>`],
  ["strict-prefixed", `<s:worksheet xmlns:s="${NS.smlStrict}" xmlns:rs="${NS.rStrict}"><s:sheetData><s:row r="1"><s:c r="A1"><s:v>1</s:v></s:c></s:row></s:sheetData><s:drawing rs:id="rId2"/></s:worksheet>`],
  ["alias-collision", `<x:worksheet xmlns:x="${SML}" xmlns:ns1="urn:keep"><ns1:a/><extLst xmlns="urn:example:other"><b/></extLst></x:worksheet>`],
];

await test("lxml equivalence: every rewritten XML part of the 353-file corpus + 15 adversarial shapes keeps its expanded names, attributes, text, comments and MCE prefix meanings, in canonical prefixes; Excel's own parts take the no-copy fast path", COV, () => {
  const items: Item[] = []; let fast = 0, slow = 0, files = 0, unreadable = 0;
  const slowFiles = new Set<string>();
  for (const f of readdirSync(CORPUS).filter((x) => x.endsWith(".xlsx")).sort()) {
    let entries; const buf = readFileSync(`${CORPUS}/${f}`);
    try { entries = readCentralDirectory(buf); } catch { unreadable++; continue; }
    files++;
    for (const e of entries) {
      const map = canonFor(e.name); if (!map) continue;
      let s: string; try { s = readEntryVerified(buf, e).toString("utf8").replace(/\r\n?/g, "\n"); } catch { continue; }
      const c = canonicalizeNs(s, map);
      if (c === s) { fast++; ok(isCanonicalNs(s, map), `${f}/${e.name}: unchanged but not canonical?`); continue; }
      slow++; slowFiles.add(f); items.push({ id: `${f}/${e.name}`, orig: s, canon: c, map });
      ok(canonicalizeNs(c, map) === c, `${f}/${e.name}: not idempotent`);
    }
  }
  for (const [id, x] of ADV) { const c = canonicalizeNs(x, SML_CANON); items.push({ id: `adv/${id}`, orig: x, canon: c, map: SML_CANON }); ok(canonicalizeNs(c, SML_CANON) === c, `adv/${id}: not idempotent`); }
  const { summary, bad } = runOracle(items, "corpus");
  ok(summary && summary.failed === 0, `lxml: ${bad.length} parts not equivalent: ${bad.slice(0, 3).map((b) => `${b.id}: ${b.problems?.join("; ")}`).join(" || ")}`);
  ok(files >= 338 && fast > 3000, `corpus coverage: ${files} files, ${fast} parts on the fast path`);
  ok(slowFiles.has("59021.xlsx") && slowFiles.has("59746_NoRowNums.xlsx") && slowFiles.has("InlineString.xlsx") && slowFiles.has("58760.xlsx"), `the prefixed workbooks were rewritten: ${[...slowFiles].join(",")}`);
  console.log(`    corpus: ${files} files (${unreadable} unreadable zips), ${fast} parts fast path, ${slow} rewritten in ${slowFiles.size} files; ${items.length} items lxml-equivalent`);
});

await test("adversarial shapes read correctly: comment / CDATA / PI lookalikes untouched, no-namespace children undeclare the default, strict prefixes canonical, value text is not a declaration, foreign namespace on the x14 prefix aliased away, x14 as the default namespace becomes x14:, MCE lists follow the renaming", COV, () => {
  const c = (id: string) => canonicalizeNs(ADV.find((a) => a[0] === id)![1], SML_CANON);
  ok(c("comments-cdata-pi").includes("<!-- <x:fake/> -->") && c("comments-cdata-pi").includes("<![CDATA[<x:c r=\"Z9\"/>]]>") && c("comments-cdata-pi").includes("<?pi <x:no/>?>"), "lookalikes untouched");
  ok(!/<x14:cfRule/.test(c("foreign-on-x14")) && /<ns\d+:cfRule/.test(c("foreign-on-x14")), `foreign x14 prefix aliased: ${c("foreign-on-x14")}`);
  ok(/<x14:conditionalFormattings>/.test(c("x14-default")) && /<xm:sqref>A1:A3<\/xm:sqref>/.test(c("x14-default")), `x14 default → x14: ${c("x14-default")}`);
  ok(/mc:Ignorable="x14 k"/.test(c("mce")) && /mc:ProcessContent="x14:foo k:\*"/.test(c("mce")) && /Requires="x14"/.test(c("mce")), `MCE: ${c("mce")}`);
  ok(/<c r="A1"\/>/.test(c("prefixed-main")) === false && /<c r="A1" t="s">/.test(c("prefixed-main")) && /r:id="rId1"/.test(c("prefixed-main")), "prefixed main → unprefixed, r: kept");
  ok(/r:id="rId9"/.test(c("renamed-r")), `rel:id → r:id: ${c("renamed-r")}`);
  ok(/<ns\d+:thing/.test(c("foreign-default")) && /<ns\d+:c r="A1"\/>/.test(c("foreign-default")), `foreign default namespace can't pose as SpreadsheetML: ${c("foreign-default")}`);
  const nn = c("no-ns-under-default");
  ok(/<worksheet xmlns="[^"]+">/.test(nn) && /<a xmlns=""\/><b xmlns=""\/><c xmlns=""><d\/><\/c><row r="1"\/>/.test(nn), `no-namespace siblings each undeclare the default, SpreadsheetML resumes after them: ${nn}`);
  ok(/^<worksheet[\s>]/.test(c("strict-prefixed")) && /<c r="A1"><v>1<\/v><\/c>/.test(c("strict-prefixed")) && /r:id="rId2"/.test(c("strict-prefixed")), `strict s: → unprefixed, rs: → r: ${c("strict-prefixed")}`);
  // the fast path's global scan is only an over-approximation: "declarations" inside an attribute value are not real
  const fake = `<worksheet xmlns="${SML}"><definedName v=" xmlns:x14='urn:evil' xmlns=''"/></worksheet>`;
  ok([...fake.matchAll(/\sxmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].length === 3, "fixture: the global over-approximation DOES see the two fakes (so the exact scan is exercised)");
  ok(isCanonicalNs(fake, SML_CANON) && canonicalizeNs(fake, SML_CANON) === fake, "declaration text inside an attribute value is not a declaration");
  ok(!/xmlns:ns1="urn:example:other"/.test(c("alias-collision")) && /xmlns:ns1="urn:keep"/.test(c("alias-collision")), `alias never reuses a source prefix: ${c("alias-collision")}`);
});

/** TT68: corpus workbooks containing "" string cells (now kept as non-blank empty text, scripts/tt68-blank.mts) */
const TT68_EMPTY_TEXT = ["47737.xlsx", "54288-ref.xlsx", "54288.xlsx", "56278.xlsx", "FormulaEvalTestData_Copy.xlsx", "LIBRE_OFFICE-116306-0.xlsx", "bug60858.xlsx", "bug66675.xlsx"];
/* ------------------------------------------------------------------ the corpus workbooks with prefixed SpreadsheetML */
/** the corpus workbooks the TT66 reader could not open or read empty (found by the whole-corpus differential below) */
const PREFIXED = ["59021.xlsx", "59746_NoRowNums.xlsx", "InlineString.xlsx", "58760.xlsx", "65016.xlsx", "craftonhills.edu_programreview_report.aspx_goalpriorityreport_0011d159-1eeb-4b63-8833-867b0926e5f3.xlsx", "style-alternate-content.xlsx"];
type Vals = Record<string, Record<string, unknown>>;
const openpyxlVals = (path: string): Vals => JSON.parse(execFileSync(PY, ["-c", `
import json, sys, datetime, warnings
warnings.filterwarnings("ignore")
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
out = {}
for ws in wb.worksheets:
    d = {}
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if v is None or v == "" or isinstance(v, (datetime.datetime, datetime.date, datetime.time)): continue
            d[c.coordinate] = v
    out[ws.title] = d
print(json.dumps(out))`, path], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }));
const a1 = (k: string) => { const [c, r] = k.split(",").map(Number); let s = "", n = c + 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return `${s}${r + 1}`; };
const ourVals = (wb: ReturnType<typeof readXlsxWorkbook>): Vals => {
  const out: Vals = {};
  for (const [name, sh] of wb.sheets) { const d: Record<string, unknown> = {}; for (const [k, c] of (sh as unknown as { grid: Map<string, { value: unknown }> }).grid) d[a1(k)] = c.value; out[name] = d; }
  return out;
};
const same = (o: unknown, t: unknown) => (typeof t === "boolean" ? o === t || o === (t ? "TRUE" : "FALSE") : typeof t === "number" ? Math.abs(Number(o) - t) <= 1e-9 * Math.max(1, Math.abs(t)) : String(o) === String(t));

await test("the 7 corpus workbooks TT66 could not read (x: / s: SpreadsheetML prefixes, prefixed mc:AlternateContent) open, and every non-empty cell equals an lxml namespace-aware reader and (where it can open the file) openpyxl; TT66 rejected 6 and read 0 cells from the 7th", COV, () => {
  const report: string[] = [];
  for (const f of PREFIXED) {
    const buf = readFileSync(`${CORPUS}/${f}`);
    const o = ourVals(readXlsxWorkbook(buf));
    // verifier 1: lxml with real namespace resolution (every file); verifier 2: openpyxl (where it can open the file)
    const lx = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", `${CORPUS}/${f}`], { encoding: "utf8", maxBuffer: 1 << 28 })) as Vals;
    eq(Object.keys(o), Object.keys(lx), `${f}: sheet names (lxml)`);
    let n = 0;
    for (const [s, cells] of Object.entries(lx)) for (const [ref, v] of Object.entries(cells)) { ok(ref in o[s] && same(o[s][ref], v), `${f} ${s}!${ref}: ours ${JSON.stringify(o[s][ref])}, lxml ${JSON.stringify(v)}`); n++; }
    for (const [s, cells] of Object.entries(o)) for (const ref of Object.keys(cells)) ok(ref in lx[s] || cells[ref] === "", `${f} ${s}!${ref}: extra cell ${JSON.stringify(cells[ref])}`);
    let t: Vals | null = null; let op = "openpyxl can't open it";
    try { t = openpyxlVals(`${CORPUS}/${f}`); } catch { t = null; }
    if (t) {
      let m = 0;
      for (const [s, cells] of Object.entries(t)) for (const [ref, v] of Object.entries(cells)) { ok(ref in o[s] && same(o[s][ref], v), `${f} ${s}!${ref}: ours ${JSON.stringify(o[s][ref])}, openpyxl ${JSON.stringify(v)}`); m++; }
      op = `${m} = openpyxl`;
    }
    let b = "";
    try { const bw = before.readXlsxWorkbook(buf); b = `${[...bw.sheets.values()].reduce((a, sh) => a + (sh as unknown as { grid: Map<string, unknown> }).grid.size, 0)} cells`; } catch (e) { b = `error: ${(e as Error).message}`; }
    report.push(`${f.slice(0, 40)}: ${n} cells = lxml, ${op}; before: ${b}`);
  }
  console.log(`    ${report.join("\n    ")}`);
  const bad = report.filter((r) => /before: (error|0 cells)/.test(r));
  ok(bad.length === PREFIXED.length, `before evidence (every one failed or read empty): ${report.join(" | ")}`);
  ok(report.some((r) => r.startsWith("59746_NoRowNums.xlsx: 571 cells = lxml, 571 = openpyxl")), "59746: all 571 non-empty cells compared with both verifiers (its 84 empty-text cells and 14 styled blanks hold no value)");
  ok(report.some((r) => r.startsWith("65016.xlsx: 68048 cells = lxml, 68048 = openpyxl")), "65016: 68 048 cells");
});

/* ------------------------------------------------------------------ x14 conditional formats under foreign prefixes */
function fixture(): Buffer {
  execFileSync(PY, ["-c", `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Data"
for i, v in enumerate([-5, -2, 0, 3, 7, 12, 20, 8], 1):
    for c in range(1, 7): ws.cell(i, c, v * c)
lim = wb.create_sheet("Limits"); lim["A1"] = 10; lim["B1"] = 2
wb.save("${dir}/base.xlsx")`]);
  return readFileSync(`${dir}/base.xlsx`);
}
const pct = (ps: number[]) => ps.map((p) => ({ t: "percent" as const, v: String(p) }));
const RULES: Omit<CondRule, "id" | "sheet">[] = [
  { range: "A1:A8", kind: "bar", barColor: "#638ec6", barNeg: "#ff0000", barAxis: "middle", barAxisColor: "#000000", barBorder: "#1f4e79", barSolid: true, cfvo: [{ t: "autoMin" }, { t: "autoMax" }], barMinLen: 0, barMaxLen: 100 },
  { range: "B1:B8", kind: "icons", iconSet: "3Stars", cfvo: pct([0, 33, 67]) },
  { range: "D1:D8", kind: "icons", iconSet: "3Arrows", cfvo: pct([0, 33, 67]), icons: ["3Flags:0", "NoIcons:0", "3Symbols:2"] },
  { range: "E1:E8", kind: "expr", formula: "E1>Limits!$A$1", fill: "#ffc7ce", bold: true },
  { range: "B1:B8", kind: "bar", barColor: "#5a8a3a", barBorder: "#333333", cfvo: [{ t: "num", v: "0" }, { t: "formula", v: "Limits!$A$1*4" }] },
];
const norm = (rs: CondRule[]) => rs.map(({ id: _i, src: _s, x14: _x, sheet: _sh, ...r }) => JSON.stringify(r, Object.keys(r).sort())).sort();
const rezip = (b: Uint8Array, part: string, edit: (s: string) => string) => {
  const buf = Buffer.from(b);
  return writeZip(readCentralDirectory(buf).filter((e) => !e.name.endsWith("/")).map((e) => {
    const d = readEntryVerified(buf, e);
    return { name: e.name, data: e.name === part ? Buffer.from(edit(d.toString("utf8")), "utf8") : d };
  }));
};
const SHEET = "xl/worksheets/sheet1.xml";
const renamePrefixes = (s: string) => s.replace(/xmlns:x14=/g, "xmlns:q=").replace(/<(\/?)x14:/g, "<$1q:").replace(/xmlns:xm=/g, "xmlns:m=").replace(/<(\/?)xm:/g, "<$1m:");

await test("x14 conditional formats written under other prefixes (q: for x14, m: for xm) are modelled exactly like Excel's spelling; the MS-XLSX oracle confirms the renamed file is the same x14 content; TT66 lost the x14-only rules", COV, async () => {
  const orig = fixture();
  const wb = readXlsxWorkbook(orig); RULES.forEach((r, i) => wb.condFormats.push({ id: `n${i}`, sheet: "Data", ...r } as CondRule));
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb);
  writeFileSync(`${dir}/x14.xlsx`, bytes);
  const renamed = rezip(bytes, SHEET, renamePrefixes); writeFileSync(`${dir}/x14-renamed.xlsx`, renamed);
  const txt = readEntryVerified(renamed, readCentralDirectory(renamed).find((e) => e.name === SHEET)!).toString("utf8");
  ok(!txt.includes("x14:") && /<q:cfRule/.test(txt) && /<m:sqref>/.test(txt), "the renamed sheet uses q: / m: only");
  const want = norm(readXlsxWorkbook(Buffer.from(bytes)).condFormats.filter((r) => r.sheet === "Data"));
  const got = norm(readXlsxWorkbook(renamed).condFormats.filter((r) => r.sheet === "Data"));
  eq(got, want, "rules read from q: / m: = rules read from x14: / xm:");
  ok(want.length === RULES.length, `all ${RULES.length} rules modelled (${want.length})`);
  // independent: the x14 oracle resolves namespaces with lxml, so both files must report the same x14 rules
  const ox = (p: string) => (JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_x14.py", p], { encoding: "utf8", maxBuffer: 1 << 26 }))[p] as Record<string, { x14: { type: string; sqref: string }[] }>)[SHEET].x14.map((x) => [x.type, x.sqref]);
  eq(ox(`${dir}/x14-renamed.xlsx`), ox(`${dir}/x14.xlsx`), "MS-XLSX oracle: same x14 rules in both spellings");
  const b4 = before.readXlsxWorkbook(renamed).condFormats.filter((r) => r.sheet === "Data").length;
  ok(b4 < RULES.length, `before: TT66 modelled ${b4} of ${RULES.length} rules from the renamed file`);
  console.log(`    before: TT66 modelled ${b4}/${RULES.length}; now ${got.length}/${RULES.length}`);
});

await test("a FOREIGN namespace that borrows the x14 prefix is never read as conditional formatting (TT66 read it as a rule: a false positive)", COV, async () => {
  const orig = fixture();
  const fake = `<ext uri="{11111111-2222-3333-4444-555555555555}" xmlns:x14="urn:example:not-excel"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="urn:example:also-not"><x14:cfRule type="iconSet" priority="99" id="{AAAAAAAA-0000-0000-0000-000000000001}"><x14:iconSet iconSet="3Stars"><x14:cfvo type="percent"><xm:f>0</xm:f></x14:cfvo><x14:cfvo type="percent"><xm:f>33</xm:f></x14:cfvo><x14:cfvo type="percent"><xm:f>67</xm:f></x14:cfvo></x14:iconSet></x14:cfRule><xm:sqref>Z1:Z9</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext>`;
  const b = rezip(orig, SHEET, (s) => (s.includes("<extLst>") ? s.replace("<extLst>", `<extLst>${fake}`) : s.replace("</worksheet>", `<extLst>${fake}</extLst></worksheet>`)));
  const now = readXlsxWorkbook(b).condFormats.filter((r) => r.range === "Z1:Z9");
  eq(now.length, 0, "no rule read from the foreign namespace");
  const then = before.readXlsxWorkbook(b).condFormats.filter((r) => r.range === "Z1:Z9");
  ok(then.length === 1, `before: TT66 read ${then.length} rule(s) from it`);
});

await test("lossless save of a prefixed workbook: edit one cell of 59021.xlsx (x: prefixes), patch, re-read → the edit and every other value survive; openpyxl opens the result", COV, async () => {
  const buf = readFileSync(`${CORPUS}/59021.xlsx`);
  const wb = readXlsxWorkbook(buf);
  const [name, sh] = [...wb.sheets.entries()][0];
  const prev = ourVals(wb);
  sh.setCell(7, 40, "TT67 edit"); // H41
  const { bytes } = await patchXlsx(new Uint8Array(buf), wb);
  writeFileSync(`${dir}/59021-edit.xlsx`, bytes);
  const back = ourVals(readXlsxWorkbook(Buffer.from(bytes)));
  eq(back[name].H41, "TT67 edit", "the edit");
  for (const [ref, v] of Object.entries(prev[name])) ok(same(back[name][ref], v as never), `${ref}: ${JSON.stringify(back[name][ref])} vs ${JSON.stringify(v)}`);
  const t = openpyxlVals(`${dir}/59021-edit.xlsx`);
  eq(t[name].H41, "TT67 edit", "openpyxl sees the edit");
  eq(Object.keys(t[name]).length, Object.keys(openpyxlVals(`${CORPUS}/59021.xlsx`))[0] ? Object.keys(openpyxlVals(`${CORPUS}/59021.xlsx`)[name]).length + 1 : -1, "openpyxl: one more cell, none lost");
});

await test("pre-standard / unknown dialects: the Excel 2007 beta namespace (sample-beta.xlsx) is SpreadsheetML; a workbook in a namespace nobody knows is read exactly as TT66 read it (knownRoot guard) instead of being aliased away", COV, () => {
  const beta = readFileSync(`${CORPUS}/sample-beta.xlsx`);
  const wbXml = readEntryVerified(beta, readCentralDirectory(beta).find((e) => e.name === "xl/workbook.xml")!).toString("utf8");
  ok(wbXml.includes(`xmlns="${NS.smlBeta}"`), "fixture: sample-beta uses the 2006/2 beta namespace");
  ok(/^<workbook[\s>]/m.test(canonicalizeNs(wbXml, SML_CANON, { knownRoot: true }).replace(/^<\?xml[^>]*\?>\s*/, "")), "beta root stays an unprefixed workbook");
  const lx = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", `${CORPUS}/sample-beta.xlsx`], { encoding: "utf8" })) as Vals;
  eq([...readXlsxWorkbook(beta).sheets.keys()], Object.keys(lx), "sample-beta sheet names = lxml");
  eq(ourVals(readXlsxWorkbook(beta)), Object.fromEntries(Object.entries(ourVals(before.readXlsxWorkbook(beta)))), "sample-beta reads as TT66 read it");
  // a beta part written with an explicit prefix (x:) — only the beta entry in SML_CANON makes this readable
  const betaSheet = readCentralDirectory(beta).find((e) => /^xl\/worksheets\/sheet1\.xml$/.test(e.name))!.name;
  const xBeta = rezip(beta, betaSheet, (x) => x.replace(`xmlns="${NS.smlBeta}"`, `xmlns:x="${NS.smlBeta}"`).replace(/<(\/?)([A-Za-z][\w]*)(?=[\s>/])/g, (m, sl: string, n: string) => (n === "xml" ? m : `<${sl}x:${n}`)));
  ok(!readEntryVerified(Buffer.from(xBeta), readCentralDirectory(Buffer.from(xBeta)).find((e) => e.name === betaSheet)!).toString("utf8").includes("<sheetData"), "fixture: every element of the beta sheet is now x:-prefixed");
  eq(ourVals(readXlsxWorkbook(Buffer.from(xBeta))), ourVals(readXlsxWorkbook(beta)), "x:-prefixed beta sheet = the original");
  // a hypothetical future dialect: every SpreadsheetML part moved to urn:x-future-sml
  let fut: Uint8Array = fixture();
  for (const part of ["xl/workbook.xml", SHEET, "xl/worksheets/sheet2.xml", "xl/styles.xml"]) fut = rezip(fut, part, (x) => x.split(SML).join("urn:x-future-sml"));
  const futWb = readFileSync(`${dir}/base.xlsx`);
  const unk = `<a xmlns="urn:x-future-sml" xmlns:r="${NS.r}"><b r:id="x"/></a>`;
  eq(canonicalizeNs(unk, SML_CANON, { knownRoot: true }), unk, "unknown root namespace → unchanged");
  ok(canonicalizeNs(unk, SML_CANON) !== unk, "(without the guard it would be aliased — the guard is what keeps it)");
  eq(ourVals(readXlsxWorkbook(Buffer.from(fut))), ourVals(before.readXlsxWorkbook(Buffer.from(fut))), "future-dialect workbook reads as TT66 read it");
  eq(ourVals(readXlsxWorkbook(Buffer.from(fut))), ourVals(readXlsxWorkbook(futWb)), "…which is every value of the original");
});

const inlineSheet = (cells: string[]) => (x: string) => x.replace(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/, `<sheetData><row r="1">${cells.map((t, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t xml:space="preserve">${t}</t></is></c>`).join("")}</row></sheetData>`);
await test("numeric character references are decoded in ONE pass, exactly as an XML parser does (lxml oracle): decimal, hex, astral, newline; &amp;lt; stays the text &lt;; TT66 showed the raw &#…; text", COV, () => {
  const T = ["a&#10;b", "x&#xA;y", "Don&#039;t", "&#128540;&#x1F600;", "&amp;lt;b&amp;gt;", "&amp;#65;", "R&amp;D &lt;1&gt;", "&#x48;&#105;"];
  const f = rezip(fixture(), SHEET, inlineSheet(T));
  writeFileSync(`${dir}/ents.xlsx`, f);
  const lx = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", `${dir}/ents.xlsx`], { encoding: "utf8" })) as Vals;
  const ours = ourVals(readXlsxWorkbook(Buffer.from(f)));
  const want = Object.fromEntries(T.map((_t, i) => [`${String.fromCharCode(65 + i)}1`, lx.Data[`${String.fromCharCode(65 + i)}1`]]));
  eq(Object.fromEntries(Object.keys(want).map((k) => [k, ours.Data[k]])), want, "ours = lxml");
  eq(want.E1, "&lt;b&gt;", "single pass (no double decode)");
  eq(want.F1, "&#65;", "&amp;#65; is the literal text &#65;");
  eq(want.D1, "\u{1F61C}\u{1F600}", "astral code points");
  const b = ourVals(before.readXlsxWorkbook(Buffer.from(f)));
  ok(b.Data.A1 === "a&#10;b" && b.Data.D1 === "&#128540;&#x1F600;", `before: TT66 left the references raw (${JSON.stringify(b.Data.A1)})`);
});

await test("references that are not characters (lone surrogate in hex and decimal, beyond U+10FFFF in hex and decimal) stay literal instead of crashing or inventing a character — lenient, as Excel-tolerant readers are; lxml rejects such files outright", COV, () => {
  const T = ["&#xD800;", "&#55296;", "&#x110000;", "&#1114112;", "ok&#x10FFFF;"];
  const f = rezip(fixture(), SHEET, inlineSheet(T));
  writeFileSync(`${dir}/bad-ents.xlsx`, f);
  const ours = ourVals(readXlsxWorkbook(Buffer.from(f)));
  eq([ours.Data.A1, ours.Data.B1, ours.Data.C1, ours.Data.D1, ours.Data.E1], ["&#xD800;", "&#55296;", "&#x110000;", "&#1114112;", "ok\u{10FFFF}"], "kept literally / max code point decoded");
  let lxmlRejects = false;
  try { execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", `${dir}/bad-ents.xlsx`], { stdio: "pipe" }); } catch { lxmlRejects = true; }
  ok(lxmlRejects, "lxml treats these as fatal well-formedness errors (so they are not in any Excel-written file)");
});

await test("lossless re-style of a cell in an x:-prefixed styles.xml changes ONLY its font (openpyxl): the patcher reads styles through the same canonical view as the reader (found by the TT67 gate: fill / border / alignment were rebuilt)", COV, async () => {
  const rep: string[] = [];
  for (const [f, ref] of [["59746_NoRowNums.xlsx", "A1"], ["craftonhills.edu_programreview_report.aspx_goalpriorityreport_0011d159-1eeb-4b63-8833-867b0926e5f3.xlsx", "A1"]] as const) {
    const orig = readFileSync(`${CORPUS}/${f}`);
    const wb = readXlsxWorkbook(orig);
    const sh = [...wb.sheets.values()][0];
    sh.setStyle(0, 0, { bold: true });
    const { bytes } = await patchXlsx(orig, wb);
    writeFileSync(`${dir}/restyle.xlsx`, bytes);
    const dump = (path: string) => JSON.parse(execFileSync(PY, ["-c", `
import json, sys, openpyxl, warnings
warnings.filterwarnings("ignore")
c = openpyxl.load_workbook(sys.argv[1]).worksheets[0]["${ref}"]
f, b, a = c.fill, c.border, c.alignment
print(json.dumps({"bold": bool(c.font.b), "fill": [f.patternType, str(f.fgColor.rgb), str(f.bgColor.rgb)], "border": [b.left.style, b.right.style, b.top.style, b.bottom.style, str(b.left.color.rgb) if b.left.color else None], "align": [a.horizontal, a.vertical, a.wrap_text], "value": c.value}))`, path], { encoding: "utf8" }));
    const a = dump(`${CORPUS}/${f}`), b = dump(`${dir}/restyle.xlsx`);
    eq({ ...b, bold: a.bold }, a, `${f}: only the font may change`);
    ok(b.bold === true, `${f}: bold applied`);
    rep.push(`${f.slice(0, 20)}: fill ${a.fill[0]}/${a.fill[1]}, align ${a.align[0]} kept`);
  }
  console.log(`    ${rep.join("; ")}`);
});

await test("the x14 oracle REPORTS malformed XML and unreadable packages as findings (TT66 raised a traceback, so a broken writer looked like a broken test)", COV, () => {
  const bad = writeZip([{ name: "xl/worksheets/sheet1.xml", data: Buffer.from(`<worksheet xmlns="${SML}"><sheetData></worksheet>`) }, { name: "xl/worksheets/sheet2.xml", data: Buffer.from(`<worksheet xmlns="${SML}"><sheetData/></worksheet>`) }]);
  writeFileSync(`${dir}/x14-bad.xlsx`, bad); writeFileSync(`${dir}/x14-notzip.xlsx`, "not a zip");
  const r = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_x14.py", `${dir}/x14-bad.xlsx`, `${dir}/x14-notzip.xlsx`], { encoding: "utf8" })) as Record<string, Record<string, { problems: string[]; malformed?: string }>>;
  const s1 = r[`${dir}/x14-bad.xlsx`]["xl/worksheets/sheet1.xml"], s2 = r[`${dir}/x14-bad.xlsx`]["xl/worksheets/sheet2.xml"];
  ok(s1.malformed && s1.problems.some((p) => /malformed XML/.test(p)), `malformed part reported: ${JSON.stringify(s1)}`);
  ok(!s2.malformed && s2.problems.length === 0, "the well-formed sibling part is still analysed");
  ok(r[`${dir}/x14-notzip.xlsx`].__package__.problems.some((p) => /unreadable package/.test(p)), "unreadable package reported");
});

await test("whole-corpus differential vs the TT66 reader (338 workbooks: cells + styles + CF + tables + charts): nothing reads worse; the only changes are 7 workbooks that now open (6 rejected, 1 read empty) and 3 whose &#…; text is now decoded", COV, () => {
  const snap = (wb: ReturnType<typeof readXlsxWorkbook>) => {
    const sheets: Record<string, Record<string, unknown>> = {};
    for (const [n, sh] of wb.sheets) { const d: Record<string, unknown> = {}; for (const [k, c] of (sh as unknown as { grid: Map<string, { input: string; style?: unknown }> }).grid) d[k] = [c.input, c.style ? JSON.stringify(c.style) : ""]; sheets[n] = d; }
    return JSON.stringify({ sheets, cf: wb.condFormats.map(({ id: _i, ...r }) => r), tables: (wb as unknown as { tables?: unknown[] }).tables?.length ?? 0, charts: wb.charts.length });
  };
  const opened: string[] = [], decoded: string[] = [], worse: string[] = [], other: string[] = []; let same = 0; const emptyText = new Map<string, number>();
  for (const f of readdirSync(CORPUS).filter((x) => x.endsWith(".xlsx")).sort()) {
    const buf = readFileSync(`${CORPUS}/${f}`);
    let a: string | null = null, b: string | null = null;
    try { a = snap(before.readXlsxWorkbook(buf)); } catch { a = null; }
    try { b = snap(readXlsxWorkbook(buf)); } catch { b = null; }
    if (a === b) { same++; continue; }
    if (b === null) { worse.push(f); continue; }
    // TT68 FF-52 (intended): a string cell whose text is "" is now kept as the empty-text input "'" (TT66/67 dropped it,
    // leaving nothing or a styled blank). Map exactly that back; any other difference still counts as unexplained.
    if (a !== null) {
      const o = JSON.parse(b) as { sheets: Record<string, Record<string, [string, string]>> }; let n = 0;
      for (const d of Object.values(o.sheets)) for (const [k, [inp, st]] of Object.entries(d)) if (inp === "'") { n++; if (st) d[k] = ["", st]; else delete d[k]; }
      if (n) { b = JSON.stringify(o); emptyText.set(f, n); if (a === b) { same++; continue; } }
    }
    if (a === null || /"sheets":\{"[^"]*":\{\}\}/.test(a)) { opened.push(f); continue; }
    // the same workbook except for numeric character references now decoded
    const dec = a.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (_m, n: string) => JSON.stringify(String.fromCodePoint(n[0] === "x" ? parseInt(n.slice(1), 16) : Number(n))).slice(1, -1));
    (dec === b ? decoded : other).push(f);
  }
  eq(worse, [], "files that read worse (or stopped opening)");
  eq(other, [], "files changed for an unexplained reason");
  eq(opened.length, 7, `newly readable: ${opened.join(", ")}`);
  eq(decoded.sort(), ["CVLKRA-KYC_Download_File_Structure_V3.1.xlsx", "LIBRE_OFFICE-128382-0.xlsx", "no_drawing_patriarch.xlsx"], "entity-decoded files");
  eq([...emptyText.keys()].sort(), TT68_EMPTY_TEXT, "files whose only change is TT68's kept empty-text cells");
  console.log(`    ${same} identical, ${opened.length} newly readable, ${decoded.length} decoded, 0 worse; TT68 empty-text cells kept: ${[...emptyText].map(([f, n]) => `${f}=${n}`).join(" ")}`);
});

await test("cost: Excel-written parts return the SAME string (no copy); a 20 000-row x:-prefixed sheet (≈4 MB) is canonicalised in well under 2 s and reads all 100 000 cells", COV, () => {
  const excel = readFileSync(`${CORPUS}/NewStyleConditionalFormattings.xlsx`);
  for (const e of readCentralDirectory(excel)) { const m = canonFor(e.name); if (!m) continue; const s = readEntryVerified(excel, e).toString("utf8"); ok(canonicalizeNs(s, m) === s, `${e.name}: fast path`); }
  const rows: string[] = [];
  for (let r = 1; r <= 20000; r++) rows.push(`<x:row r="${r}">${[0, 1, 2, 3, 4].map((c) => `<x:c r="${String.fromCharCode(65 + c)}${r}"><x:v>${r * 10 + c}</x:v></x:c>`).join("")}</x:row>`);
  const big = `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${SML}"><x:sheetData>${rows.join("")}</x:sheetData></x:worksheet>`;
  const t0 = performance.now(); const c = canonicalizeNs(big, SML_CANON); const ms = performance.now() - t0;
  ok(ms < 2000, `canonicalise ${(big.length / 1e6).toFixed(1)} MB took ${ms.toFixed(0)} ms`);
  ok(c.startsWith(`<?xml version="1.0" encoding="UTF-8"?><worksheet`) && c.includes(`<c r="E20000"><v>200004</v></c>`), "rewritten");
  const wbx = `<x:workbook xmlns:x="${SML}" xmlns:r="${NS.r}"><x:sheets><x:sheet name="Big" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`;
  const rels = `<Relationships xmlns="${NS.pkgRels}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const z = writeZip([{ name: "xl/workbook.xml", data: Buffer.from(wbx) }, { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(rels) }, { name: SHEET, data: Buffer.from(big) }]);
  const t1 = performance.now(); const wb = readXlsxWorkbook(z); const ms2 = performance.now() - t1;
  eq((wb.sheets.get("Big") as unknown as { grid: Map<string, unknown> }).grid.size, 100000, "cells read");
  console.log(`    canonicalise ${(big.length / 1e6).toFixed(1)} MB: ${ms.toFixed(0)} ms; full read: ${ms2.toFixed(0)} ms`);
});

await finish();
