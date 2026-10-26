/**
 * TT73 triage: every corpus formula cell whose recalculated value disagrees with the value Excel (or the authoring
 * application) cached in the file. Oracle: scripts/oracle/xlsx_cached.py (openpyxl, data_only). Writes
 * docs/heldout/tt73-disagree.json and prints a bucket summary by leading function.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt73-triage.mts [out.json]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
export type Row = { file: string; sheet: string; ref: string; formula: string; cached: unknown; ours: unknown };
const norm = (v: unknown) => (v && typeof v === "object" && "error" in (v as object) ? (v as { error: string }).error : v === undefined || v === null ? "" : v);
export const same = (a: unknown, b: unknown) => {
  a = norm(a); b = norm(b);
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  if (typeof b === "boolean" && typeof a === "number") return (a !== 0) === b;
  return a === b;
};
export function triage(files: string[]) {
  const out = execFileSync(PY, ["scripts/oracle/xlsx_cached.py"], { input: files.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28, timeout: 1_200_000 });
  let cells = 0, agree = 0; const bad: Row[] = []; const errors: string[] = [];
  for (const line of out.trim().split("\n")) {
    const j = JSON.parse(line) as { file: string; sheets?: Record<string, [string, string, unknown, string][]> };
    if (!j.sheets) continue;
    let wb;
    try { wb = readXlsxWorkbook(readFileSync(j.file)); wb.recalculate(); } catch (e) { errors.push(`${j.file}: ${(e as Error).message}`); continue; }
    for (const [sh, rows] of Object.entries(j.sheets)) {
      if (!wb.sheets.get(sh)) continue;
      for (const [ref, formula, cached] of rows) {
        const m = /^([A-Z]+)(\d+)$/.exec(ref); if (!m) continue;
        const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row = Number(m[2]) - 1;
        const v = wb.valueAt(sh, col, row); cells++;
        if (same(v, cached)) agree++; else bad.push({ file: j.file.split("/").pop()!, sheet: sh, ref, formula, cached, ours: norm(v) });
      }
    }
  }
  return { cells, agree, bad, errors };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(CORPUS).filter((f) => /\.xlsx$/i.test(f)).map((f) => `${CORPUS}/${f}`);
  const r = triage(files);
  writeFileSync(process.argv[2] ?? "docs/heldout/tt73-disagree.json", JSON.stringify(r, null, 1));
  const fn = (f: string) => (/^=?\s*([A-Z][A-Z0-9.]*)\s*\(/.exec(f.replace(/^=/, ""))?.[1] ?? "(expr)");
  const b = new Map<string, number>(); for (const x of r.bad) b.set(fn(x.formula), (b.get(fn(x.formula)) ?? 0) + 1);
  const fb = new Map<string, number>(); for (const x of r.bad) fb.set(x.file, (fb.get(x.file) ?? 0) + 1);
  console.log(JSON.stringify({ cells: r.cells, agree: r.agree, disagree: r.bad.length, errors: r.errors.length }));
  console.log("by function:", [...b].sort((a, c) => c[1] - a[1]).slice(0, 40).map(([k, v]) => `${k}:${v}`).join(" "));
  console.log("by file:", [...fb].sort((a, c) => c[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(" "));
}
