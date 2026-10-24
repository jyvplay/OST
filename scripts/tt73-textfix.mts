/**
 * TT73: builds docs/heldout/tt73-text-oracle.json — every corpus cell of the form TEXT(value, format) with the value
 * and format resolved and the result Excel cached in the file (openpyxl oracle). The fixture lets the number-format
 * engine be checked against ~all Excel-observed TEXT outputs in milliseconds (scripts/tt73-office.mts N1).
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
const CORPUS = "/home/user/tools/corpus/xlsx";
const files = readdirSync(CORPUS).filter((f) => /\.xlsx$/i.test(f)).map((f) => `${CORPUS}/${f}`);
const out = execFileSync("/home/user/tools/venv/bin/python", ["scripts/oracle/xlsx_cached.py"], { input: files.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 });
const cellAt = (wb: any, sh: string, ref: string) => { const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(ref)!; return wb.valueAt(sh, [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, Number(m[2]) - 1); };
const arg = (wb: any, sh: string, a: string): unknown => { a = a.trim(); if (/^\$?[A-Z]+\$?\d+$/.test(a)) return cellAt(wb, sh, a); if (/^".*"$/.test(a)) return a.slice(1, -1).replace(/""/g, '"'); if (/^-?[\d.]+(E[+-]?\d+)?$/i.test(a)) return Number(a); return undefined; };
const rows: { file: string; ref: string; v: unknown; fmt: unknown; xl: unknown; d1904?: true }[] = [];
for (const line of out.trim().split("\n")) {
  const j = JSON.parse(line); if (!j.sheets) continue;
  const cand = Object.entries(j.sheets as Record<string, [string, string, unknown][]>).flatMap(([sh, rs]) => rs.filter((r) => /^=?TEXT\(/i.test(r[1])).map((r) => [sh, ...r] as const));
  if (!cand.length) continue;
  let wb; try { wb = readXlsxWorkbook(readFileSync(j.file)); wb.recalculate(); } catch { continue; }
  for (const [sh, ref, f, xl] of cand) {
    const m = /^=?TEXT\(\s*((?:"(?:[^"]|"")*"|[^,"])+?)\s*,\s*("(?:[^"]|"")*"|\$?[A-Z]+\$?\d+)\s*\)$/i.exec(f); if (!m) continue;
    const v = arg(wb, sh, m[1]), fmt = arg(wb, sh, m[2]);
    if (v === undefined || typeof fmt !== "string" || typeof xl !== "string") continue;
    rows.push({ file: j.file.split("/").pop()!, ref: `${sh}!${ref}`, v, fmt, xl, ...(wb.date1904 ? { d1904: true as const } : {}) });
  }
}
writeFileSync("docs/heldout/tt73-text-oracle.json", JSON.stringify(rows));
console.log(rows.length, "TEXT cells");
