/**
 * TT74 (FF-02) Markdown → DOCX probe. Corpus: the README.md files shipped in node_modules (real-world Markdown written
 * by hundreds of authors; read-only, nothing is copied into the product). Each file is converted by Fusion
 * (markdownToDocx, rawHtml:"text") and the .docx is read back by mammoth (independent, BSD-2); the source Markdown is
 * rendered by markdown-it-py (independent CommonMark reference implementation, MIT, html:false + GFM tables,
 * strikethrough, footnotes). Both HTMLs go through the same parser and are compared on block texts, headings, list
 * items, table shapes, links and footnotes. python-docx must also open every output.
 * Exported as runMdProbe() for the tt74-office suite; run directly for a per-file diff.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownToDocx, uriTarget } from "../src/lib/office/md2docx.ts";

const PY = "/home/user/tools/venv/bin/python";
type Parsed = { blocks: string[]; heads: [number, string][]; items: [boolean, number, string][]; tables: number[][]; links: [string, string][]; notes: { footnote: string[]; endnote: string[] }; fmt: Record<string, string> };
export interface MdFileResult { name: string; status: "match" | "diff" | "error" | "oracle-error"; axes?: Record<string, boolean>; detail?: string; blocks?: [number, number, number]; pyDocx?: boolean; loss?: string[] }
const J = (x: unknown) => JSON.stringify(x);
function lcsLen(a: string[], b: string[]): number {
  if (a.length * b.length > 4e6) { const s = new Set(b); return a.filter((x) => s.has(x)).length; }
  const dp = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = tmp; } }
  return dp[b.length];
}
function firstDiff(a: string[], b: string[]): string {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `#${i}: ours=${J((a[i] ?? "<none>").slice(0, 120))} theirs=${J((b[i] ?? "<none>").slice(0, 120))}`;
  return "";
}
export function mdCorpus(limit = 1000): string[] {
  const out = execFileSync("bash", ["-c", "find node_modules -maxdepth 3 -iname 'readme.md' -size -200k | sort"]).toString().split("\n").filter(Boolean);
  return out.slice(0, limit);
}
export async function runMdProbe(filter = "", limit = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "tt74m-"));
  const files: MdFileResult[] = [];
  const names = new Map<string, string>();
  for (const path of mdCorpus(limit).filter((p) => p.includes(filter))) {
    if (statSync(path).size === 0) continue;
    const name = path.replace(/^node_modules\//, "").replace(/[/@]/g, "_");
    names.set(`${name}.md`, path);
    const md = readFileSync(path, "utf8");
    writeFileSync(join(dir, `${name}.md`), md);
    try {
      const r = await markdownToDocx(md, { rawHtml: "text" });
      writeFileSync(join(dir, `${name}.md.docx`), r.bytes);
      files.push({ name: `${name}.md`, status: "match", loss: r.loss });
    } catch (e) { files.push({ name: `${name}.md`, status: "error", detail: String((e as Error).stack).slice(0, 300) }); }
  }
  const rep = JSON.parse(execFileSync(PY, ["scripts/oracle/docx_mammoth.py", "mdcompare", dir], { maxBuffer: 1 << 28 }).toString()) as Record<string, { theirs?: Parsed; ours?: Parsed; oracle_error?: string; python_docx?: boolean }>;
  const agree: Record<string, number> = { blocks: 0, heads: 0, items: 0, tables: 0, links: 0, notes: 0, fmt: 0, all: 0 };
  const tot = { ours: 0, theirs: 0, lcs: 0 };
  let pyOk = 0;
  for (const f of files) {
    if (f.status === "error") continue;
    const r = rep[f.name];
    if (!r || r.oracle_error || !r.theirs || !r.ours) { f.status = "oracle-error"; f.detail = r?.oracle_error ?? "missing"; continue; }
    const o = r.ours, t = r.theirs;
    // declared normalisation: a relationship Target must be an xs:anyURI, so ours is uriTarget(href); markdown-it's own
    // normalizeLink already percent-encodes, making uriTarget idempotent on its hrefs except the "./" that keeps a
    // relative reference with ":" in its first segment from reading as a scheme
    // (both sides were unquoted by the oracle; both are re-encoded the same way here)
    for (const side of [o, t]) side.links = side.links.map(([x, h]) => [x, h.startsWith("#") ? h : uriTarget(h)]);
    f.pyDocx = !!r.python_docx; if (f.pyDocx) pyOk++;
    const axes = { blocks: J(o.blocks) === J(t.blocks), heads: J(o.heads) === J(t.heads), items: J(o.items) === J(t.items), tables: J(o.tables) === J(t.tables),
      links: J([...o.links].map((x) => J(x)).sort()) === J([...t.links].map((x) => J(x)).sort()), notes: J(o.notes) === J(t.notes), fmt: J(o.fmt) === J(t.fmt) };
    f.axes = axes;
    const l = lcsLen(o.blocks, t.blocks); f.blocks = [l, o.blocks.length, t.blocks.length]; tot.ours += o.blocks.length; tot.theirs += t.blocks.length; tot.lcs += l;
    for (const [k, v] of Object.entries(axes)) if (v) agree[k]++;
    if (Object.values(axes).every(Boolean) && f.pyDocx) agree.all++;
    else {
      f.status = "diff";
      const d: string[] = [];
      if (!axes.blocks) d.push(`blocks ${firstDiff(o.blocks, t.blocks)}`);
      if (!axes.heads) d.push(`heads ${firstDiff(o.heads.map((x) => J(x)), t.heads.map((x) => J(x)))}`);
      if (!axes.items) d.push(`items ${firstDiff(o.items.map((x) => J(x)), t.items.map((x) => J(x)))}`);
      if (!axes.tables) d.push(`tables ours=${J(o.tables).slice(0, 160)} theirs=${J(t.tables).slice(0, 160)}`);
      if (!axes.links) { const so = o.links.map((x) => J(x)), st = t.links.map((x) => J(x)); d.push(`links onlyOurs=${so.filter((x) => !st.includes(x)).slice(0, 2).join(",")} onlyTheirs=${st.filter((x) => !so.includes(x)).slice(0, 2).join(",")}`); }
      if (!axes.notes) d.push(`notes ${firstDiff([...o.notes.footnote], [...t.notes.footnote])}`);
      if (!axes.fmt) for (const k of Object.keys(t.fmt)) if (o.fmt[k] !== t.fmt[k]) { let q = 0; while (o.fmt[k][q] === t.fmt[k][q]) q++; d.push(`fmt.${k} @${q}: ours=${J(o.fmt[k].slice(Math.max(0, q - 30), q + 40))} theirs=${J(t.fmt[k].slice(Math.max(0, q - 30), q + 40))}`); }
      if (!f.pyDocx) d.push("python-docx could not open the output");
      f.detail = d.join(" ; ");
    }
  }
  return { dir, files, names, agree, blockTotals: tot, pythonDocxOpened: pyOk, compared: files.filter((f) => f.status === "match" || f.status === "diff").length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runMdProbe(process.argv[2] ?? "", Number(process.argv[3] ?? 1000));
  for (const f of r.files) if (f.status !== "match") console.log(f.status.padEnd(12), f.name, f.blocks ? `lcs ${f.blocks.join("/")}` : "", "\n    ", (f.detail ?? "").slice(0, 600));
  console.log(JSON.stringify({ dir: r.dir, compared: r.compared, errors: r.files.filter((f) => f.status === "error").length, oracleErrors: r.files.filter((f) => f.status === "oracle-error").length, agree: r.agree, blockTotals: r.blockTotals, pythonDocxOpened: r.pythonDocxOpened }));
}
