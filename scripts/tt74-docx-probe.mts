/**
 * TT74 (FF-02) docx conversion probe: every corpus .docx (prepared by scripts/oracle/docx_mammoth.py prep) is converted
 * by Fusion (readWord → wordToHtml) and by mammoth (independent, BSD-2); both HTML outputs are parsed by the same
 * Python parser and compared: block texts in reading order, headings, list items, table shapes, links, notes.
 * Exported as runDocxProbe() for the tt74-office suite; run directly for a per-file diff:
 *   node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt74-docx-probe.mts [filter]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWord } from "../src/lib/office/wordml.ts";
import { wordToHtml } from "../src/lib/office/convert-word.ts";

const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/docx";
type Parsed = { blocks: string[]; heads: [number, string][]; items: [boolean, number, string][]; tables: number[][]; links: [string, string][]; notes: { footnote: string[]; endnote: string[] }; fmt: Record<string, string> };
export interface DocxFileResult { name: string; status: "match" | "diff" | "refused" | "oracle-error"; blocks?: boolean; fmt?: boolean; heads?: boolean; items?: boolean; tables?: boolean; links?: boolean; notes?: boolean; detail?: string; ourBlocks?: number; theirBlocks?: number; lcs?: number }
export interface DocxProbe { files: DocxFileResult[]; converted: number; refused: number; oracleErrors: number; agree: Record<string, number>; blockTotals: { ours: number; theirs: number; lcs: number } }

function lcsLen(a: string[], b: string[]): number {
  if (a.length * b.length > 4e6) { let n = 0; const s = new Set(b); for (const x of a) if (s.has(x)) n++; return n; }
  const dp = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = tmp; } }
  return dp[b.length];
}
const J = (x: unknown) => JSON.stringify(x);
function firstDiff(a: string[], b: string[]): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `#${i}: ours=${J((a[i] ?? "<none>").slice(0, 120))} theirs=${J((b[i] ?? "<none>").slice(0, 120))}`;
  return "";
}

export async function runDocxProbe(filter = ""): Promise<DocxProbe> {
  const tmp = mkdtempSync(join(tmpdir(), "tt74d-"));
  const prepDir = join(tmp, "prep"), oursDir = join(tmp, "ours"); mkdirSync(oursDir, { recursive: true });
  const prep = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_mammoth.py", "prep", CORPUS, prepDir], { maxBuffer: 1 << 26 }).toString()) as Record<string, string>;
  const files: DocxFileResult[] = [];
  let converted = 0;
  for (const name of readdirSync(prepDir).filter((n) => n.endsWith(".docx") && n.includes(filter)).sort()) {
    try {
      const doc = await readWord(new Uint8Array(readFileSync(join(prepDir, name))), name);
      writeFileSync(join(oursDir, `${name}.html`), wordToHtml(doc, { images: "embed" }));
      converted++;
    } catch (e) { files.push({ name, status: "refused", detail: String((e as Error).message).slice(0, 160) }); }
  }
  for (const [n, s] of Object.entries(prep)) if (s !== "ok" && n.includes(filter)) files.push({ name: n, status: "refused", detail: `unreadable zip: ${s}` });
  const rep = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_mammoth.py", "compare", prepDir, oursDir], { maxBuffer: 1 << 28 }).toString()) as Record<string, { theirs?: Parsed; ours?: Parsed; oracle_error?: string }>;
  const agree: Record<string, number> = { blocks: 0, heads: 0, items: 0, tables: 0, links: 0, notes: 0, fmt: 0, all: 0 };
  const tot = { ours: 0, theirs: 0, lcs: 0 };
  for (const [name, r] of Object.entries(rep)) {
    if (r.oracle_error || !r.theirs || !r.ours) { files.push({ name, status: "oracle-error", detail: r.oracle_error }); continue; }
    const o = r.ours, t = r.theirs;
    const res: DocxFileResult = { name, status: "match",
      blocks: J(o.blocks) === J(t.blocks), heads: J(o.heads) === J(t.heads), items: J(o.items.map((x) => [x[0], x[2]])) === J(t.items.map((x) => [x[0], x[2]])),
      tables: J(o.tables) === J(t.tables), links: J([...o.links].map((x) => J(x)).sort()) === J([...t.links].map((x) => J(x)).sort()), notes: J(o.notes) === J(t.notes), fmt: J(o.fmt) === J(t.fmt),
      ourBlocks: o.blocks.length, theirBlocks: t.blocks.length };
    res.lcs = lcsLen(o.blocks, t.blocks); tot.ours += o.blocks.length; tot.theirs += t.blocks.length; tot.lcs += res.lcs;
    const keys = ["blocks", "heads", "items", "tables", "links", "notes", "fmt"] as const;
    for (const k of keys) if (res[k]) agree[k]++;
    if (keys.every((k) => res[k])) agree.all++;
    else {
      res.status = "diff";
      const d: string[] = [];
      if (!res.blocks) d.push(`blocks ${firstDiff(o.blocks, t.blocks)}`);
      if (!res.heads) d.push(`heads ours=${J(o.heads).slice(0, 200)} theirs=${J(t.heads).slice(0, 200)}`);
      if (!res.items) d.push(`items ${firstDiff(o.items.map((x) => J([x[0], x[2]])), t.items.map((x) => J([x[0], x[2]])))}`);
      if (!res.tables) d.push(`tables ours=${J(o.tables).slice(0, 160)} theirs=${J(t.tables).slice(0, 160)}`);
      if (!res.links) d.push(`links ours=${J(o.links).slice(0, 200)} theirs=${J(t.links).slice(0, 200)}`);
      if (!res.notes) d.push(`notes ${firstDiff([...o.notes.footnote, "|", ...o.notes.endnote], [...t.notes.footnote, "|", ...t.notes.endnote])}`);
      if (!res.fmt) for (const k of Object.keys(t.fmt)) if (o.fmt[k] !== t.fmt[k]) { let q = 0; while (o.fmt[k][q] === t.fmt[k][q]) q++; d.push(`fmt.${k} @${q}: ours=${J(o.fmt[k].slice(Math.max(0, q - 30), q + 40))} theirs=${J(t.fmt[k].slice(Math.max(0, q - 30), q + 40))}`); }
      res.detail = d.join(" ; ");
    }
    files.push(res);
  }
  return { files, converted, refused: files.filter((f) => f.status === "refused").length, oracleErrors: files.filter((f) => f.status === "oracle-error").length, agree, blockTotals: tot };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runDocxProbe(process.argv[2] ?? "");
  for (const f of r.files) if (f.status !== "match") console.log(f.status.padEnd(12), f.name, f.status === "diff" ? `lcs ${f.lcs}/${f.ourBlocks}/${f.theirBlocks}` : "", "\n    ", (f.detail ?? "").slice(0, 700));
  console.log(JSON.stringify({ converted: r.converted, refused: r.refused, oracleErrors: r.oracleErrors, compared: r.files.filter((f) => f.status === "match" || f.status === "diff").length, agree: r.agree, blockTotals: r.blockTotals }));
}
