/**
 * TT72 — Writer / Spreadsheet readers: XML syntax and namespaces the readers matched literally.
 *
 *  W  Writer (src/lib/office/wordml.ts readWord + writeWord settings, src/lib/office/docx.ts readDocx): every
 *     WordprocessingML part is read through canonicalizeNs(WML_CANON). TT71 matched "w:p" literally, so a document whose
 *     WordprocessingML prefix is not "w" (valid XML Namespaces 1.0: the prefix is a local alias) did not open at all.
 *  S  Spreadsheet (src/lib/formula/xlsx.ts xmlAttrs + font / fill flags): attributes in single quotes and with spaces
 *     around "=" (XML 1.0 §3.1 Attribute ::= Name Eq AttValue, Eq ::= S? '=' S?). TT71 read only name="value": such a
 *     workbook lost every cell reference, type and style index.
 *
 * Method — whole-corpus differentials: each corpus file is rewritten into an EQUIVALENT form (W: prefix w → q, and a
 * default-namespace form; S: every attribute in xl/**.xml single-quoted with spaces around "="). The rewrite's validity is
 * checked by independent readers that share no code with ours — lxml (namespace equivalence, scripts/oracle/xml_ns_equiv.py),
 * python-docx (paragraph / table text of original vs rewrite) and openpyxl (cell values of original vs rewrite) — and our
 * reader must return the same model for the rewrite as for the original. "Before" = the TT71 reader (git ed8c39b).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt72-office.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, type WordDoc } from "../src/lib/office/wordml.ts";
import { readDocx } from "../src/lib/office/docx.ts";
import { readPptx } from "../src/lib/office/pptx.ts";
import { decryptOffice, encryptOffice } from "../src/lib/office/offcrypto.ts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { readCentralDirectory, readEntryVerified, writeZip } from "../src/lib/server/zip.ts";
import { canonicalizeNs, NS, WML_CANON } from "../src/lib/office/xml-ns.ts";

const { test, finish } = makeHarness("tt72-office");
const PY = "/home/user/tools/venv/bin/python";
const DOCX = "/home/user/tools/corpus/docx", XLSX = "/home/user/tools/corpus/xlsx";
const dir = "/tmp/tt72"; mkdirSync(dir, { recursive: true });
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) { let i = 0; while (i < x.length && x[i] === y[i]) i++; throw new Error(`${m}: differ at ${i}: …${x.slice(Math.max(0, i - 80), i + 160)} != …${y.slice(Math.max(0, i - 80), i + 160)}`); } };

const BEFORE = "/tmp/tt72-before";
if (!existsSync(`${BEFORE}/src/lib/office/wordml.ts`)) { mkdirSync(BEFORE, { recursive: true }); execFileSync("bash", ["-c", `git archive ed8c39b src/lib | tar -x -C ${BEFORE}`]); }
const before = {
  word: (await import(`${BEFORE}/src/lib/office/wordml.ts`)) as { readWord: typeof readWord },
  docx: (await import(`${BEFORE}/src/lib/office/docx.ts`)) as { readDocx: typeof readDocx },
  xlsx: (await import(`${BEFORE}/src/lib/formula/xlsx.ts`)) as { readXlsxWorkbook: typeof readXlsxWorkbook },
  pptx: (await import(`${BEFORE}/src/lib/office/pptx.ts`)) as { readPptx: typeof readPptx },
  crypto: (await import(`${BEFORE}/src/lib/office/offcrypto.ts`)) as { decryptOffice: typeof decryptOffice },
};

/* ------------------------------------------------------------------ rewriting helpers (test-only, tag-level) */
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const mapTags = (xml: string, f: (tag: string) => string) => xml.replace(TOKEN, (t) => (t.startsWith("<!") || t.startsWith("<?") ? t : f(t)));
const ATTR = /(\s)([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** WordprocessingML prefix w → q (declaration, element names, attribute names); only in parts that declare it */
const reprefix = (xml: string, to = "q") => mapTags(xml, (t) => t.replace(/^<(\/?)w:/, `<$1${to}:`).replace(ATTR, (m, sp: string, n: string, d?: string, s?: string) => {
  const v = d ?? s ?? ""; const q = d !== undefined ? '"' : "'";
  const nn = n === "xmlns:w" ? `xmlns:${to}` : n.startsWith("w:") ? `${to}:${n.slice(2)}` : n;
  return `${sp}${nn}=${q}${v}${q}`;
}));
/** default-namespace form: elements unprefixed, attributes keep a prefix (an unprefixed attribute has NO namespace) */
const defaultNs = (xml: string) => mapTags(xml, (t) => t.replace(/^<(\/?)w:/, "<$1").replace(/\sxmlns:w=("[^"]*"|'[^']*')/, (m, v: string) => ` xmlns=${v} xmlns:w=${v}`));
/** every attribute single-quoted with spaces around "=" (a ' inside a value becomes &apos;) */
const singleQuote = (xml: string) => mapTags(xml, (t) => t.replace(ATTR, (m, sp: string, n: string, d?: string, s?: string) => `${sp}${n} = '${(d ?? s ?? "").replace(/'/g, "&apos;")}'`));

function rezipAll(buf: Buffer, pick: (name: string) => boolean, edit: (s: string, name: string) => string): Buffer {
  const files = readCentralDirectory(buf).filter((e) => !e.name.endsWith("/")).map((e) => {
    const data = readEntryVerified(buf, e);
    return { name: e.name, data: pick(e.name) ? Buffer.from(edit(data.toString("utf8"), e.name), "utf8") : data };
  });
  return writeZip(files);
}
const declaresW = (s: string) => /\sxmlns:w\s*=\s*["']http:\/\/schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main["']/.test(s);
const isWmlPart = (n: string) => /^word\/.*\.xml$/i.test(n);

/** our Word model without source-tree references (XEl / XNode / bytes) — what the editor shows and edits */
function wordModel(d: WordDoc) {
  const strip = (k: string, v: unknown) => {
    if (v && typeof v === "object" && "k" in (v as object) && typeof (v as { k: unknown }).k === "string" && ["el", "text", "cdata", "comment", "pi"].includes((v as { k: string }).k)) return undefined;
    if (k === "id" && typeof v === "string" && /^[a-z]+\d+$/.test(v)) return "#"; // editor block ids come from a process-wide counter
    if (v instanceof Uint8Array) return `bytes:${v.length}`;
    if (v instanceof Map) return [...v];
    if (v instanceof Set) return [...v];
    return v;
  };
  return JSON.parse(JSON.stringify({ blocks: d.blocks, page: d.page, styles: d.styles, defaults: d.defaults, numbering: d.numbering, parts: d.parts, comments: d.comments, notes: d.notes, theme: d.theme, title: d.title, warnings: d.warnings, track: d.track.on, next: d.track.next, media: d.media }, strip));
}
const readOr = async (f: () => Promise<WordDoc>) => { try { return { doc: await f() }; } catch (e) { return { err: (e as Error).message }; } };

const pyDocx = (paths: string[]): (string | null)[] => JSON.parse(execFileSync(PY, ["-c", `
import json, sys, warnings
warnings.filterwarnings("ignore")
import docx
out = []
for p in sys.argv[1:]:
    try:
        d = docx.Document(p)
        body = [x.text for x in d.paragraphs] + [c.text for t in d.tables for r in t.rows for c in r.cells]
        out.append(json.dumps(body))
    except Exception as e:
        out.append(None)
print(json.dumps(out))
`, ...paths], { encoding: "utf8", maxBuffer: 1 << 28 }));

/* ------------------------------------------------------------------ W: Writer */
const WCOV = { "FF-22": "full" } as const;
const docxFiles = readdirSync(DOCX).filter((f) => f.endsWith(".docx")).sort();

await test("W1 corpus: every readable docx rewritten with WordprocessingML prefix q (and in default-namespace form) reads to the SAME model as the original; the TT71 reader opened none of the prefix rewrites", WCOV, async () => {
  let files = 0, rewritten = 0, same = 0, beforeOpened = 0, defaultForms = 0, unreadable = 0;
  const pyPaths: string[] = [], fails: string[] = [];
  for (const f of docxFiles) {
    const buf = readFileSync(`${DOCX}/${f}`);
    const o = await readOr(() => readWord(new Uint8Array(buf), f));
    if (!o.doc) { unreadable++; continue; }
    files++;
    let entries; try { entries = readCentralDirectory(buf); } catch { continue; }
    const doc = entries.find((e) => e.name === o.doc!.docPath);
    if (!doc || !declaresW(readEntryVerified(buf, doc).toString("utf8"))) continue;
    const q = rezipAll(buf, isWmlPart, (s) => (declaresW(s) ? reprefix(s) : s));
    rewritten++;
    const r = await readOr(() => readWord(new Uint8Array(q), f));
    if (!r.doc) { fails.push(`${f}: rewrite failed: ${r.err}`); continue; }
    const a = JSON.stringify(wordModel(o.doc)), b = JSON.stringify(wordModel(r.doc));
    if (a === b) same++; else { let i = 0; while (a[i] === b[i]) i++; fails.push(`${f}: model differs at ${i}: ${a.slice(i - 60, i + 80)} | ${b.slice(i - 60, i + 80)}`); }
    const old = await (async () => { try { await before.word.readWord(new Uint8Array(q), f); return true; } catch { return false; } })();
    if (old) beforeOpened++;
    if (pyPaths.length < 40) { const po = `${dir}/w-${files}-o.docx`, pq = `${dir}/w-${files}-q.docx`; writeFileSync(po, buf); writeFileSync(pq, q); pyPaths.push(po, pq); }
    // default-namespace form (document part only, when w is declared on the root and no default namespace exists)
    const src = readEntryVerified(buf, doc).toString("utf8");
    if (!/<[A-Za-z_][\w.-]*:document\b[^>]*\sxmlns\s*=/.test(src) && /<w:document\b[^>]*xmlns:w=/.test(src)) {
      const dn = rezipAll(buf, (n) => n === o.doc!.docPath, defaultNs);
      const rd = await readOr(() => readWord(new Uint8Array(dn), f));
      ok(rd.doc, `${f}: default-namespace form failed: ${rd.err}`);
      eq(wordModel(rd.doc).blocks, wordModel(o.doc).blocks, `${f}: default-namespace form`);
      defaultForms++;
    }
  }
  ok(fails.length === 0, `${fails.length} rewrites not equivalent: ${fails.slice(0, 3).join(" || ")}`);
  ok(files >= 100 && rewritten >= 100 && same === rewritten, `coverage: ${files} readable, ${rewritten} rewritten, ${same} same`);
  ok(defaultForms >= 80, `default-namespace forms: ${defaultForms}`);
  ok(beforeOpened === 0, `the TT71 reader opened ${beforeOpened} prefix rewrites (expected none)`);
  // the rewrites are valid and equivalent for an independent reader too
  const py = pyDocx(pyPaths); let pyPairs = 0;
  for (let i = 0; i < py.length; i += 2) { if (py[i] === null) continue; eq(py[i + 1], py[i], `python-docx on ${pyPaths[i + 1]}`); pyPairs++; }
  ok(pyPairs >= 15, `python-docx pairs: ${pyPairs}`);
  console.log(`    docx corpus: ${files} readable (${unreadable} not), ${rewritten} prefix rewrites → ${same} identical models (TT71: ${beforeOpened} opened); ${defaultForms} default-namespace forms identical; python-docx agrees on ${pyPairs} pairs`);
});

await test("W2 lxml: every WordprocessingML part canonicalised by the reader (prefix rewrites, default-namespace forms, corpus parts that are not already canonical) is namespace-equivalent to its input", WCOV, async () => {
  const items: { id: string; orig: string; canon: string; map: Record<string, string> }[] = [];
  let fast = 0;
  for (const f of docxFiles.slice(0, 70)) {
    const buf = readFileSync(`${DOCX}/${f}`); let entries; try { entries = readCentralDirectory(buf); } catch { continue; }
    for (const e of entries) {
      if (!isWmlPart(e.name)) continue;
      let s: string; try { s = readEntryVerified(buf, e).toString("utf8"); } catch { continue; }
      for (const [tag, v] of [["o", s], ["q", declaresW(s) ? reprefix(s) : s], ["d", e.name.endsWith("document.xml") && declaresW(s) && !/<[\w.-]+:document\b[^>]*\sxmlns\s*=/.test(s) ? defaultNs(s) : s]] as const) {
        const c = canonicalizeNs(v, WML_CANON, { knownRoot: true });
        if (c === v) { fast++; continue; }
        ok(canonicalizeNs(c, WML_CANON, { knownRoot: true }) === c, `${f}/${e.name}/${tag}: not idempotent`);
        items.push({ id: `${f}/${e.name}/${tag}`, orig: v, canon: c, map: WML_CANON as Record<string, string> });
      }
    }
  }
  const p = `${dir}/w2.json`; writeFileSync(p, JSON.stringify(items));
  let out = ""; try { out = execFileSync(PY, ["scripts/oracle/xml_ns_equiv.py", p], { encoding: "utf8", maxBuffer: 1 << 28 }); } catch (e) { out = String((e as { stdout?: string }).stdout ?? ""); }
  const lines = out.trim().split("\n").map((l) => JSON.parse(l) as { ok?: boolean; id?: string; problems?: string[]; summary?: boolean; failed?: number; items?: number });
  const sum = lines.find((l) => l.summary), bad = lines.filter((l) => l.ok === false);
  ok(sum && sum.failed === 0, `lxml: ${bad.length} not equivalent: ${bad.slice(0, 3).map((b) => `${b.id}: ${b.problems?.join("; ")}`).join(" || ")}`);
  ok(items.length >= 300 && fast >= 300, `coverage: ${items.length} rewritten parts, ${fast} fast path`);
  console.log(`    lxml: ${items.length} canonicalised WML parts equivalent; ${fast} parts unchanged (fast path)`);
});

await test("W3 round trip from a foreign-prefix document: edit → writeWord → the output re-reads to the edited model, python-docx opens it, and Track Changes on a q:-prefixed settings.xml writes a DECLARED w:trackRevisions", WCOV, async () => {
  const f = docxFiles.find((x) => /^(sample|SampleDoc|Bug|bug)/.test(x)) ?? docxFiles[0];
  let src: Buffer | null = null, name = "";
  for (const g of [f, ...docxFiles]) {
    const b = readFileSync(`${DOCX}/${g}`);
    let entries; try { entries = readCentralDirectory(b); } catch { continue; }
    if (entries.some((e) => /word\/settings\.xml$/.test(e.name)) && (await readOr(() => readWord(new Uint8Array(b), g))).doc) { src = b; name = g; break; }
  }
  ok(src, "a corpus docx with settings.xml");
  const q = rezipAll(src, isWmlPart, (s) => (declaresW(s) ? reprefix(s) : s));
  const d = await readWord(new Uint8Array(q), name);
  const was = d.track.on; d.track.on = !was;
  const out = await writeWord(d);
  const back = await readWord(out, name);
  eq(back.track.on, !was, "Track Changes toggled and persisted");
  eq(wordModel(back).blocks, wordModel(d).blocks, "body survives the round trip");
  const outPath = `${dir}/w3.docx`; writeFileSync(outPath, out);
  const check = execFileSync(PY, ["-c", `
import sys, zipfile, json
from lxml import etree
import docx
z = zipfile.ZipFile(sys.argv[1]); bad = []
for n in z.namelist():
    if n.endswith(".xml") or n.endswith(".rels"):
        try: etree.fromstring(z.read(n))
        except Exception as e: bad.append(n + ": " + str(e))
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
names = [n for n in z.namelist() if n.endswith("settings.xml")]
s = etree.fromstring(z.read(names[0]))
tr = s.find("{%s}trackRevisions" % W)
d = docx.Document(sys.argv[1])
print(json.dumps({"bad": bad, "track": tr is not None, "paras": len(d.paragraphs)}))
`, outPath], { encoding: "utf8" });
  const r = JSON.parse(check) as { bad: string[]; track: boolean; paras: number };
  eq(r.bad, [], "every XML part of the output parses (lxml)");
  eq(r.track, !was, "lxml sees w:trackRevisions in the WordprocessingML namespace");
  ok(r.paras >= 0, "python-docx opens the output");
  // the writer re-parses settings.xml; without canonicalising it, the inserted w:trackRevisions would carry an unbound
  // prefix (unreachable in TT71, whose reader refused such files) — the mutant "writer settings not canonicalised" checks it
});

await test("W4 legacy /api/office readDocx: prefix and default-namespace forms, single-quoted pStyle, numeric character references", WCOV, async () => {
  const W = NS.w;
  const docXml = (body: string, root = `<w:document xmlns:w="${W}">`) => `<?xml version="1.0" encoding="UTF-8"?>${root}<w:body>${body}</w:body></w:document>`;
  const pkg = (xml: string) => writeZip([{ name: "[Content_Types].xml", data: Buffer.from(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`) }, { name: "word/document.xml", data: Buffer.from(xml) }]);
  const body = `<w:p><w:pPr><w:pStyle w:val='Heading1'/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Line&#10;two &#x1F61C; &amp;lt;</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
  const want = readDocx(pkg(docXml(body)));
  eq(want.blocks[0], { kind: "paragraph", style: "Heading1", runs: [{ text: "Line\ntwo 😜 &lt;", bold: true, italic: false, underline: false }] }, "single-quoted style + numeric refs, one decoding pass");
  eq(want.blocks[1], { kind: "table", rows: [["cell"]] }, "table");
  eq(readDocx(pkg(reprefix(docXml(body), "ns0"))).blocks, want.blocks, "ns0: prefix");
  eq(readDocx(pkg(defaultNs(docXml(body)))).blocks, want.blocks, "default namespace");
  let oldErr = ""; try { before.docx.readDocx(pkg(reprefix(docXml(body), "ns0"))); } catch (e) { oldErr = (e as Error).message; }
  ok(/w:body/.test(oldErr), `TT71 refused the ns0: form: ${oldErr}`);
  // a foreign namespace on the w prefix can never pose as WordprocessingML
  const evil = readDocx(pkg(`<x:document xmlns:x="${W}"><x:body><x:p><x:r><x:t>real</x:t></x:r></x:p><w:p xmlns:w="urn:evil"><w:r><w:t>fake</w:t></w:r></w:p></x:body></x:document>`));
  eq(evil.blocks.map((b) => b.kind === "paragraph" ? b.runs.map((r) => r.text).join("") : ""), ["real"], "foreign w: is aliased away");
});

/* ------------------------------------------------------------------ S: Spreadsheet */
const SCOV = { "FF-21": "full", "FF-51": "full" } as const;
const a1 = (k: string) => { const [c, r] = k.split(",").map(Number); let s = "", n = c + 1; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return `${s}${r + 1}`; };
type AnySheet = { grid: Map<string, { input: string; value: unknown; style?: unknown }>; colWidths: unknown; merges: unknown; validations: unknown; links: unknown };
function wbModel(wb: ReturnType<typeof readXlsxWorkbook>) {
  const out: Record<string, unknown> = {};
  for (const [name, sh0] of wb.sheets) {
    const sh = sh0 as unknown as AnySheet;
    // volatile formulas (NOW, TODAY, RAND…) recalculate on every read: their VALUE is not comparable between two reads
    out[name] = { cells: [...sh.grid].map(([k, c]) => [a1(k), c.input, /\b(NOW|TODAY|RAND|RANDBETWEEN|RANDARRAY)\s*\(/i.test(c.input) ? "volatile" : c.value, c.style ?? null]), w: sh.colWidths, m: sh.merges, v: sh.validations, l: sh.links };
  }
  return JSON.parse(JSON.stringify(out, (k, v) => (k === "src" ? undefined : v)));
}
const xlsxFiles = readdirSync(XLSX).filter((f) => f.endsWith(".xlsx")).sort();
const isSml = (n: string) => /^xl\/.*\.xml$/i.test(n);

await test("S1 corpus: every readable xlsx with all xl/**.xml attributes single-quoted and spaced around '=' reads to the SAME model (inputs, values, styles, widths, merges, validations, links); the TT71 reader lost cells / styles on them", SCOV, () => {
  let files = 0, same = 0, beforeLost = 0, cellsTotal = 0;
  const fails: string[] = [], pyPaths: string[] = [];
  for (const f of xlsxFiles) {
    const buf = readFileSync(`${XLSX}/${f}`);
    let o; try { o = readXlsxWorkbook(buf); } catch { continue; }
    let v: Buffer; try { v = rezipAll(buf, isSml, singleQuote); } catch { continue; }
    files++;
    const mo = wbModel(o);
    let r; try { r = readXlsxWorkbook(v); } catch (e) { fails.push(`${f}: ${(e as Error).message}`); continue; }
    const a = JSON.stringify(mo), b = JSON.stringify(wbModel(r));
    if (a === b) same++; else { let i = 0; while (a[i] === b[i]) i++; fails.push(`${f}: differs at ${i}: ${a.slice(i - 60, i + 90)} | ${b.slice(i - 60, i + 90)}`); }
    cellsTotal += Object.values(mo).reduce((n: number, s) => n + (s as { cells: unknown[] }).cells.length, 0);
    try { if (JSON.stringify(wbModel(before.xlsx.readXlsxWorkbook(v))) !== a) beforeLost++; } catch { beforeLost++; }
    if (pyPaths.length < 30 && buf.length < 400_000) { const po = `${dir}/s-${files}-o.xlsx`, pv = `${dir}/s-${files}-v.xlsx`; writeFileSync(po, buf); writeFileSync(pv, v); pyPaths.push(po, pv); }
  }
  ok(fails.length === 0, `${fails.length} not equivalent: ${fails.slice(0, 3).join(" || ")}`);
  ok(files >= 300 && same === files, `coverage ${files} / same ${same}`);
  ok(beforeLost >= files * 0.9, `the TT71 reader differed on only ${beforeLost}/${files}`);
  // openpyxl: the rewrite is the same workbook for an independent reader
  const vals = JSON.parse(execFileSync(PY, ["-c", `
import json, sys, warnings, datetime
warnings.filterwarnings("ignore")
import openpyxl
out = []
for p in sys.argv[1:]:
    try:
        wb = openpyxl.load_workbook(p)
        out.append(json.dumps({ws.title: {c.coordinate: (c.value.isoformat() if isinstance(c.value, (datetime.datetime, datetime.date, datetime.time)) else c.value) for row in ws.iter_rows() for c in row if c.value is not None} for ws in wb.worksheets}, default=str, sort_keys=True))
    except Exception as e:
        out.append(None)
print(json.dumps(out))
`, ...pyPaths], { encoding: "utf8", maxBuffer: 1 << 28 })) as (string | null)[];
  let pairs = 0; for (let i = 0; i < vals.length; i += 2) { if (vals[i] === null) continue; eq(vals[i + 1], vals[i], `openpyxl ${pyPaths[i + 1]}`); pairs++; }
  ok(pairs >= 10, `openpyxl pairs ${pairs}`);
  console.log(`    xlsx corpus: ${files} workbooks (${cellsTotal} cells) single-quoted → identical models; TT71 lost data on ${beforeLost}; openpyxl agrees on ${pairs} pairs`);
});

await test("S2 font / fill flags: <b val='0'/> and <b val = \"false\"/> are not bold, <b/> and <b val='1'/> are; patternType = 'solid' fills; underline 'none' is off", SCOV, () => {
  const sheet = `<worksheet xmlns="${NS.sml}"><sheetData><row r="1">${[0, 1, 2, 3, 4, 5].map((i) => `<c r="${String.fromCharCode(65 + i)}1" s="${i + 1}" t="inlineStr"><is><t>x</t></is></c>`).join("")}</row></sheetData></worksheet>`;
  const fonts = [`<font/>`, `<font><b val='0'/></font>`, `<font><b val = "false"/></font>`, `<font><b/></font>`, `<font><b val='1'/><u val='none'/></font>`, `<font><i/><u val = 'single'/></font>`, `<font/>`];
  const styles = `<styleSheet xmlns="${NS.sml}"><fonts count="7">${fonts.join("")}</fonts><fills count="3"><fill><patternFill patternType='none'/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType = 'solid'><fgColor rgb='FFFF0000'/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="7"><xf fontId="0" fillId="0"/>${[1, 2, 3, 4, 5].map((i) => `<xf fontId='${i}' fillId='0' applyFont='1'/>`).join("")}<xf fontId="6" fillId="2" applyFill="1"/></cellXfs></styleSheet>`;
  const wbx = `<workbook xmlns="${NS.sml}" xmlns:r="${NS.r}"><sheets><sheet name='S' sheetId = '1' r:id='rId1'/></sheets></workbook>`;
  const rels = `<Relationships xmlns="${NS.pkgRels}"><Relationship Id='rId1' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet' Target='worksheets/sheet1.xml'/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const root = `<Relationships xmlns="${NS.pkgRels}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ct = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
  const buf = writeZip([["[Content_Types].xml", ct], ["_rels/.rels", root], ["xl/workbook.xml", wbx], ["xl/_rels/workbook.xml.rels", rels], ["xl/styles.xml", styles], ["xl/worksheets/sheet1.xml", sheet]].map(([name, s]) => ({ name, data: Buffer.from(s) })));
  const wb = readXlsxWorkbook(buf);
  ok(wb.sheets.has("S"), `single-quoted sheet name read: ${[...wb.sheets.keys()]}`);
  const st = (c: string) => ((wb.sheets.get("S") as unknown as AnySheet).grid.get(c)?.style ?? {}) as { bold?: boolean; italic?: boolean; underline?: boolean; fill?: string };
  eq(!!st("0,0").bold, false, "b val='0'"); eq(!!st("1,0").bold, false, "b val = \"false\"");
  eq(!!st("2,0").bold, true, "<b/>"); eq(!!st("3,0").bold, true, "b val='1'"); eq(!!st("3,0").underline, false, "u val='none'");
  eq(!!st("4,0").italic && !!st("4,0").underline, true, "i + u single");
  ok(/F{2}0{4}|#?ff0000/i.test(String(st("5,0").fill ?? "")), `solid fill read from patternType = 'solid': ${JSON.stringify(st("5,0"))}`);
  let oldSheets: string[] = []; try { oldSheets = [...before.xlsx.readXlsxWorkbook(buf).sheets.keys()]; } catch { /* refused */ }
  ok(!oldSheets.includes("S") || JSON.stringify(before.xlsx.readXlsxWorkbook(buf).sheets.get("S")) !== JSON.stringify(wb.sheets.get("S")), "TT71 misread this workbook");
});

/* ------------------------------------------------------------------ P: Slides, C: encrypted Office files */
await test("P1 corpus: every readable pptx with all ppt/**.xml attributes single-quoted and spaced reads to the same deck (titles, bodies, notes); the TT71 reader differed", { "FF-23": "full" }, () => {
  const PPTX = "/home/user/tools/corpus/pptx";
  let files = 0, same = 0, beforeDiff = 0; const fails: string[] = [];
  for (const f of readdirSync(PPTX).filter((x) => x.endsWith(".pptx")).sort()) {
    const buf = readFileSync(`${PPTX}/${f}`);
    let o; try { o = readPptx(buf); } catch { continue; }
    if (!o.slides.some((sl) => sl.title || sl.body.length || sl.notes)) continue; // nothing to compare
    let v: Buffer; try { v = rezipAll(buf, (n) => /^ppt\/.*\.xml$/i.test(n), singleQuote); } catch { continue; }
    files++;
    let r; try { r = readPptx(v); } catch (e) { fails.push(`${f}: ${(e as Error).message}`); continue; }
    if (JSON.stringify(r) === JSON.stringify(o)) same++; else fails.push(`${f}: ${JSON.stringify(r).slice(0, 200)} != ${JSON.stringify(o).slice(0, 200)}`);
    try { if (JSON.stringify(before.pptx.readPptx(v)) !== JSON.stringify(o)) beforeDiff++; } catch { beforeDiff++; }
  }
  ok(fails.length === 0, `${fails.length}: ${fails.slice(0, 3).join(" || ")}`);
  ok(files >= 30 && same === files, `coverage ${files} / ${same}`);
  ok(beforeDiff >= 1, `TT71 differed on ${beforeDiff}`);
  console.log(`    pptx corpus: ${files} decks with text → identical after single-quoting; TT71 differed on ${beforeDiff}`);
});

await test("C1 Agile EncryptionInfo written with single quotes (same bytes length, patched inside the CFB) still decrypts with HMAC verified; TT71 refused it", { "FF-21": "full", "FF-22": "full" }, () => {
  const plain = new Uint8Array(writeZip([{ name: "word/document.xml", data: Buffer.from(`<w:document xmlns:w="${NS.w}"><w:body/></w:document>`) }]));
  const enc = encryptOffice(plain, "pässwörd", { spinCount: 1000 });
  const bytes = Buffer.from(enc);
  const start = bytes.indexOf("<?xml"), end = bytes.indexOf("</encryption>", start) + "</encryption>".length;
  ok(start > 0 && end > start, "EncryptionInfo XML found contiguously in the container");
  const xml = bytes.subarray(start, end).toString("latin1");
  const sq = xml.replace(/="([^"]*)"/g, "='$1'");
  ok(sq.length === xml.length && sq !== xml && !/="/.test(sq), "same length, every attribute single-quoted");
  const patched = Buffer.concat([bytes.subarray(0, start), Buffer.from(sq, "latin1"), bytes.subarray(end)]);
  const d = decryptOffice(new Uint8Array(patched), "pässwörd");
  eq(Buffer.from(d.bytes).equals(Buffer.from(plain)), true, "plaintext recovered");
  eq(d.integrity, "verified", "HMAC verified"); eq(d.method, "agile", "agile");
  let oldErr = ""; try { before.crypto.decryptOffice(new Uint8Array(patched), "pässwörd"); } catch (e) { oldErr = (e as Error).message; }
  ok(oldErr !== "", "the TT71 parser refused the single-quoted EncryptionInfo");
  let wrong = ""; try { decryptOffice(new Uint8Array(patched), "wrong"); } catch (e) { wrong = (e as Error).name; }
  ok(wrong !== "", "a wrong password is still refused");
});

finish();
