/**
 * TT73 FF-29 held-out check: the values Fusion plots for every chart series in the xlsx corpus versus the values Excel
 * cached in the chart part (scripts/oracle/chart_cache.py, lxml, independent of the app). Series are matched by chart
 * part and order; values compare numerically (1e-9 relative), a cached point that is absent must be blank (null) for
 * us, categories compare as text (numbers within 1e-9). Prints totals and every disagreeing series.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { seriesOutFor } from "../src/lib/formula/chartxml.ts";

const CORPUS = "/home/user/tools/corpus/xlsx";
type Ser = { val_f: string | null; vals: Record<string, string>; ptCount: number; cat_f: string | null; cats: Record<string, string | null>; tx_f: string | null; tx?: string | null };
export function chartCache(files: string[]) {
  const out = execFileSync("/home/user/tools/venv/bin/python", ["scripts/oracle/chart_cache.py"], { input: files.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 26 });
  const byFile = new Map<string, { part: string; series: Ser[] }[]>();
  for (const l of out.trim().split("\n")) { if (!l) continue; const j = JSON.parse(l); if (j.error || !j.series) continue; if (!byFile.has(j.file)) byFile.set(j.file, []); byFile.get(j.file)!.push(j); }
  const numEq = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  let series = 0, points = 0, agreePts = 0, charts = 0, matched = 0, cats = 0, agreeCats = 0, names = 0, agreeNames = 0; const bad: string[] = [];
  const txtEq = (a0: string | null, b0: string | null) => { const a = String(a0 ?? ""), b = String(b0 ?? ""); return a.trim() === b.trim() || (a.trim() !== "" && b.trim() !== "" && !isNaN(Number(a)) && !isNaN(Number(b)) && numEq(Number(a), Number(b))); };
  for (const [file, parts] of byFile) {
    let wb; try { wb = readXlsxWorkbook(readFileSync(file)); } catch { continue; }
    for (const part of parts) {
      if (!part.series.some((x) => x.val_f)) continue; // a chart part with no referenced data (empty <c:val/>) has nothing to compare
      charts++;
      const spec = wb.charts.find((c) => c.src === part.part); if (!spec) { bad.push(`${file.split("/").pop()} ${part.part}: chart not read`); continue; }
      matched++;
      let outs; try { outs = seriesOutFor(wb, spec); } catch (e) { bad.push(`${file.split("/").pop()} ${part.part}: ${(e as Error).message}`); continue; }
      part.series.forEach((s, i) => {
        if (!s.val_f) return; // literal-only series: nothing to evaluate
        series++;
        const o = outs[i]; const n = s.ptCount;
        let sAgree = 0; const diffs: string[] = [];
        for (let k = 0; k < n; k++) {
          points++;
          const cached = s.vals[String(k)]; const ours = o?.values[k] ?? null;
          const ok = cached === undefined ? ours === null : ours !== null && numEq(ours, Number(cached));
          if (ok) { agreePts++; sAgree++; } else if (diffs.length < 3) diffs.push(`#${k} xl=${cached ?? "blank"} us=${ours}`);
        }
        if (s.cat_f) for (const [k, t] of Object.entries(s.cats)) { cats++; const xv = o?.xs ? o.xs[Number(k)] : undefined; const u = o?.xs ? (xv === null || xv === undefined ? "" : String(xv)) : o?.categories[Number(k)] ?? ""; if (txtEq(u, t)) agreeCats++; else if (bad.length < 60) bad.push(`${file.split("/").pop()} ${part.part} ser${i} category #${k}: xl=${JSON.stringify(t)} us=${JSON.stringify(u)}`); }
        if (s.tx_f && typeof s.tx === "string") { names++; if (o && txtEq(o.name, s.tx)) agreeNames++; else bad.push(`${file.split("/").pop()} ${part.part} ser${i} name: xl=${JSON.stringify(s.tx)} us=${JSON.stringify(o?.name)}`); }
        if (sAgree !== n) bad.push(`${file.split("/").pop()} ${part.part} ser${i} ${s.val_f}: ${sAgree}/${n} ${diffs.join(" ")}`);
      });
    }
  }
  return { charts, matched, series, points, agreePts, cats, agreeCats, names, agreeNames, bad };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(CORPUS).filter((f) => /\.xlsx$/i.test(f)).map((f) => `${CORPUS}/${f}`);
  const r = chartCache(files);
  console.log(JSON.stringify({ charts: r.charts, matched: r.matched, series: r.series, points: r.points, agree: r.agreePts, cats: r.cats, agreeCats: r.agreeCats, names: r.names, agreeNames: r.agreeNames }));
  for (const b of r.bad) console.log("  ✗", b);
}
