/**
 * TT41 differential: src/lib/js-imports.ts vs acorn (MIT, a full ECMAScript parser — test-only, already in
 * node_modules as a transitive dependency) over real JavaScript files. For each file acorn can parse (as a module,
 * else as a script), the exact source ranges of every module specifier literal are compared.
 *   node … scripts/oracle/js-imports-diff.mts [maxFiles] [root]
 * Prints a JSON summary; exit 1 on any disagreement.
 */
import fs from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import { findImportSpecifiers } from "../../src/lib/js-imports.ts";

type N = { type: string; start: number; end: number; [k: string]: unknown };
export function acornSpecifiers(src: string): { ranges: string[]; mode: "module" | "script" } | null {
  let ast: N | null = null, mode: "module" | "script" = "module";
  const opts = { ecmaVersion: "latest" as const, allowHashBang: true, allowReturnOutsideFunction: false, allowAwaitOutsideFunction: true, allowImportExportEverywhere: false };
  try { ast = acorn.parse(src, { ...opts, sourceType: "module" }) as unknown as N; }
  catch { try { mode = "script"; ast = acorn.parse(src, { ...opts, sourceType: "script" }) as unknown as N; } catch { return null; } }
  const ranges: string[] = [];
  const lit = (s: unknown) => { const x = s as N | null; if (!x) return; if (x.type === "Literal" && typeof (x as { value?: unknown }).value === "string") ranges.push(`${x.start}-${x.end}`); else if (x.type === "TemplateLiteral" && (x.expressions as unknown[]).length === 0) ranges.push(`${x.start}-${x.end}`); };
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    const x = node as N;
    if (typeof x.type === "string") {
      if (x.type === "ImportDeclaration" || x.type === "ExportAllDeclaration" || (x.type === "ExportNamedDeclaration" && x.source)) lit(x.source);
      else if (x.type === "ImportExpression") lit(x.source);
    }
    for (const k of Object.keys(x)) if (k !== "type" && k !== "start" && k !== "end" && k !== "loc") walk(x[k]);
  };
  walk(ast);
  return { ranges: ranges.sort(), mode };
}

export function filesUnder(root: string, max: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(m|c)?js$/.test(e.name)) { try { if (fs.statSync(p).size < 2_000_000) out.push(p); } catch { /* skip */ } }
      if (out.length >= max) break;
    }
  }
  return out;
}

export function diff(files: string[]) {
  const sum = { files: files.length, parsed: 0, module: 0, script: 0, specifiers: 0, agree: 0, lexErrors: [] as string[], missing: [] as string[], extra: [] as string[], skipped: 0 };
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const a = acornSpecifiers(src);
    if (!a) { sum.skipped++; continue; }
    sum.parsed++; sum[a.mode]++;
    let mine: string[];
    try { mine = findImportSpecifiers(src).map((s) => `${s.start}-${s.end}`).sort(); }
    catch (e) { sum.lexErrors.push(`${f}: ${(e as Error).message}`); continue; }
    sum.specifiers += a.ranges.length;
    const A = new Set(a.ranges), M = new Set(mine);
    const miss = a.ranges.filter((r) => !M.has(r)), ext = mine.filter((r) => !A.has(r));
    for (const r of miss) sum.missing.push(`${f} @${r} ${JSON.stringify(src.slice(Number(r.split("-")[0]) - 40, Number(r.split("-")[1])).slice(-90))}`);
    for (const r of ext) sum.extra.push(`${f} @${r} ${JSON.stringify(src.slice(Number(r.split("-")[0]) - 40, Number(r.split("-")[1])).slice(-90))}`);
    if (!miss.length && !ext.length) sum.agree++;
  }
  return sum;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const max = Number(process.argv[2] ?? 1e9), root = process.argv[3] ?? "node_modules";
  const t0 = Date.now();
  const s = diff(filesUnder(root, max));
  console.log(JSON.stringify({ ...s, lexErrors: s.lexErrors.length, missing: s.missing.length, extra: s.extra.length, ms: Date.now() - t0 }));
  for (const x of [...s.lexErrors.slice(0, 15), ...s.missing.slice(0, 15), ...s.extra.slice(0, 15)]) console.log("  " + x.slice(0, 300));
  process.exit(s.lexErrors.length || s.missing.length || s.extra.length ? 1 : 0);
}
