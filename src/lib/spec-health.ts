/** TT117 SP-01 — register health: the checks that keep the Spec app honest.
 * A row may claim "built" only if (a) some module's `implements` list names it,
 * (b) every suite file its test string cites exists, and (c) its code is unique.
 * A module may not claim a code the register does not contain. Blocked rows are
 * exempt from (a): they are claims about the platform, not about a module.
 * Pure: the caller supplies rows, module claims and the set of suite filenames. */
export interface RegisterRow { code: string; status: string; test: string }
export interface ModuleClaim { id: string; implements: string[] }
export interface HealthIssue { kind: "duplicate-code" | "built-without-module" | "missing-suite" | "module-claims-unknown-code" | "partial-without-module"; code: string; detail: string }

export function citedSuites(test: string): string[] {
  return [...new Set([...String(test ?? "").matchAll(/([a-z0-9][a-z0-9-]*\.mts)\b/gi)].map((m) => m[1]))];
}
export function checkRegister(rows: RegisterRow[], modules: ModuleClaim[], suites: ReadonlySet<string>): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
  for (const [code, n] of counts) if (n > 1) issues.push({ kind: "duplicate-code", code, detail: `${n} rows share this code` });
  const claimed = new Map<string, string[]>();
  for (const m of modules) for (const code of m.implements) claimed.set(code, [...(claimed.get(code) ?? []), m.id]);
  const known = new Set(rows.map((r) => r.code));
  for (const [code, ids] of claimed) if (!known.has(code)) issues.push({ kind: "module-claims-unknown-code", code, detail: `claimed by ${ids.join(", ")} but not in the register` });
  for (const r of rows) {
    for (const s of citedSuites(r.test)) if (!suites.has(s)) issues.push({ kind: "missing-suite", code: r.code, detail: `test cites ${s}, which is not on disk` });
    if (r.status === "built" && !claimed.has(r.code)) issues.push({ kind: "built-without-module", code: r.code, detail: "status is built but no module claims it" });
    if (r.status === "partial" && !claimed.has(r.code)) issues.push({ kind: "partial-without-module", code: r.code, detail: "status is partial but no module claims it" });
  }
  return issues.sort((a, b) => a.code.localeCompare(b.code) || a.kind.localeCompare(b.kind));
}
