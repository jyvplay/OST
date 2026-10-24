/**
 * TT42 differential for COMPUTED dynamic imports: src/lib/js-imports.ts vs acorn (MIT, test-only) over real files.
 * For each file acorn parses (module, else script):
 *   1. the exact source range of every NON-literal ImportExpression source must equal findModuleRefs().computed;
 *   2. the rewritten file (rewriteModuleSource: literals proxied, computed arguments wrapped, import.meta.* replaced)
 *      must still parse in the same mode, with the same number of ImportExpressions, every computed source now a
 *      call of the inline wrapper.
 *   node … scripts/oracle/dynwrap-diff.mts [maxFiles] [root]      — JSON summary; exit 1 on any disagreement
 */
import fs from "node:fs";
import * as acorn from "acorn";
import { filesUnder } from "./js-imports-diff.mts";
import { findModuleRefs } from "../../src/lib/js-imports.ts";
import { rewriteModuleSource } from "../../src/lib/wp-core.ts";

type N = { type: string; start: number; end: number; [k: string]: unknown };
const OPTS = { ecmaVersion: "latest" as const, allowHashBang: true, allowAwaitOutsideFunction: true };
function parse(src: string, mode?: "module" | "script"): { ast: N; mode: "module" | "script" } | null {
  for (const m of mode ? [mode] : (["module", "script"] as const)) { try { return { ast: acorn.parse(src, { ...OPTS, sourceType: m }) as unknown as N, mode: m }; } catch { /* next */ } }
  return null;
}
function importExprs(ast: N): N[] {
  const out: N[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const c of node) walk(c); return; }
    const x = node as N;
    if (x.type === "ImportExpression") out.push(x);
    for (const k of Object.keys(x)) if (k !== "type" && k !== "start" && k !== "end" && k !== "loc") walk(x[k]);
  };
  walk(ast);
  return out;
}
const isLit = (s: N) => (s.type === "Literal" && typeof (s as { value?: unknown }).value === "string") || (s.type === "TemplateLiteral" && (s.expressions as unknown[]).length === 0);

export function dynDiff(files: string[]) {
  const sum = { files: files.length, parsed: 0, computedAcorn: 0, agree: 0, lexErrors: [] as string[], missing: [] as string[], extra: [] as string[], reparseFail: [] as string[], countMismatch: [] as string[], skipped: 0, wrappedFiles: 0 };
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const p = parse(src);
    if (!p) { sum.skipped++; continue; }
    sum.parsed++;
    const ie = importExprs(p.ast);
    const want = ie.map((x) => x.source as N).filter((s) => !isLit(s)).map((s) => `${s.start}-${s.end}`).sort();
    sum.computedAcorn += want.length;
    let mine: string[];
    try { mine = findModuleRefs(src).computed.map((c) => `${c.start}-${c.end}`).sort(); }
    catch (e) { sum.lexErrors.push(`${f}: ${(e as Error).message}`); continue; }
    const W = new Set(want), M = new Set(mine);
    for (const r of want) if (!M.has(r)) sum.missing.push(`${f} @${r} ${JSON.stringify(src.slice(Number(r.split("-")[0]) - 30, Number(r.split("-")[1]) + 5).slice(0, 120))}`);
    for (const r of mine) if (!W.has(r)) sum.extra.push(`${f} @${r} ${JSON.stringify(src.slice(Number(r.split("-")[0]) - 30, Number(r.split("-")[1]) + 5).slice(0, 120))}`);
    const r = rewriteModuleSource(src, { base: "https://site.test/pkg/file.js", seg: "AAAAAAAAAAAAAAAAAAAAAA:d1:s", metaUrl: p.mode === "module" ? "https://site.test/pkg/file.js" : null });
    if (r.code !== src) {
      if (r.wrapped) sum.wrappedFiles++;
      const q = parse(r.code, p.mode);
      if (!q) { sum.reparseFail.push(f); continue; }
      const ie2 = importExprs(q.ast);
      const wrappedNow = ie2.filter((x) => { const s = x.source as N; return s.type === "CallExpression" && (s.callee as N).type === "ArrowFunctionExpression" && ((s.arguments as N[])[2] as { value?: unknown })?.value === "AAAAAAAAAAAAAAAAAAAAAA:d1:s"; }).length;
      // an import() nested INSIDE another's computed argument stays one ImportExpression each
      if (ie2.length !== ie.length || wrappedNow !== (r.wrapped ?? 0)) sum.countMismatch.push(`${f}: imports ${ie.length}→${ie2.length}, wrapped ${r.wrapped} seen ${wrappedNow}`);
    }
    if (!want.filter((x) => !M.has(x)).length && !mine.filter((x) => !W.has(x)).length) sum.agree++;
  }
  return sum;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const max = Number(process.argv[2] ?? 1e9), root = process.argv[3] ?? "node_modules";
  const t0 = Date.now();
  const s = dynDiff(filesUnder(root, max));
  const bad = s.lexErrors.length + s.missing.length + s.extra.length + s.reparseFail.length + s.countMismatch.length;
  console.log(JSON.stringify({ ...s, lexErrors: s.lexErrors.length, missing: s.missing.length, extra: s.extra.length, reparseFail: s.reparseFail.length, countMismatch: s.countMismatch.length, ms: Date.now() - t0 }));
  for (const x of [...s.lexErrors, ...s.missing, ...s.extra, ...s.reparseFail, ...s.countMismatch].slice(0, 30)) console.log("  " + x.slice(0, 300));
  process.exit(bad ? 1 : 0);
}
