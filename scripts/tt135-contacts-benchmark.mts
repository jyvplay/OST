/** Exact differential + alternating timing against the checked-in parent version.
 * Run alone. The temporary baseline is the actual Git blob, not copied production code. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as current from "../src/lib/contacts-core.ts";
mkdirSync(".cache/tt135", {recursive:true});
const source = execFileSync("git", ["show", "b31a078e1b42cd3271955a706bb0ef0a6a3be394:src/lib/contacts-core.ts"]);
writeFileSync(".cache/tt135/contacts-before.ts", source);
const before = await import(pathToFileURL(`${process.cwd()}/.cache/tt135/contacts-before.ts`).href);
let seed = 0x8452d14;
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
for (let trial = 0; trial < 500; trial++) {
  const rows = Array.from({length: random(35)}, (_, i) => {
    const c = current.emptyContact(`uid-${i}`); c.fn = ["", "Unnamed", "Åda", "Ada", "李", `person ${random(12)}`][random(6)];
    c.emails = Array.from({length:random(3)}, () => ({value:["", " X@EXAMPLE.COM ", `p${random(8)}@example.com`][random(3)], types:[]}));
    c.tels = Array.from({length:random(3)}, () => ({value:["", "123", `555-123-${String(random(9)).padStart(4, "0")}`][random(3)], types:[]}));
    return c;
  });
  assert.deepEqual(current.findDuplicates(rows), before.findDuplicates(rows), `differential trial ${trial}`);
}
// Differential folding includes boundary cuts, astral characters, combining
// marks, and unpaired surrogates (TextEncoder emits U+FFFD for each).
for (let trial = 0; trial < 1000; trial++) {
  const fragments = ["a", "é", "漢", "🙂", "\ud800", "\udc00", "\u0301", "\t"];
  const text = Array.from({length:random(250)}, () => fragments[random(fragments.length)]).join("");
  assert.equal(current.foldLine(text), before.foldLine(text), `fold trial ${trial}`);
}
const pairs = Array.from({length: 6000}, (_, i) => { const c = current.emptyContact(`id-${i}`); c.fn = `Person ${i}`; c.emails = [{value:`pair${Math.floor(i/2)}@example.com`, types:[]}]; return c; });
const giant = Array.from({length: 12000}, (_, i) => { const c = current.emptyContact(`id-${i}`); c.fn = "Same"; return c; });
const results: unknown[] = [];
for (const [label, input] of [["pairs", pairs], ["giant", giant]] as const) {
  const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
  assert.equal(hash(current.findDuplicates(input)), hash(before.findDuplicates(input)));
  const samples: { implementation:string; wallMs:number; cpuMs:number; hash:string }[] = [];
  for (const implementation of ["before", "after", "after", "before", "before", "after"]) {
    const fn = implementation === "before" ? before.findDuplicates : current.findDuplicates;
    const cpu = process.cpuUsage(), start = performance.now(); const value = fn(input); const wallMs = performance.now() - start;
    const used = process.cpuUsage(cpu); samples.push({implementation, wallMs, cpuMs:(used.user+used.system)/1000, hash:hash(value)});
  }
  assert.equal(new Set(samples.map(s => s.hash)).size, 1);
  const median = (key: "wallMs"|"cpuMs", name:string) => samples.filter(s => s.implementation === name).map(s => s[key]).sort((a,b)=>a-b)[1];
  results.push({label, count:input.length, samples, medians:{ beforeWallMs:median("wallMs","before"), afterWallMs:median("wallMs","after"), beforeCpuMs:median("cpuMs","before"), afterCpuMs:median("cpuMs","after") }});
}
const foldInput = "ASCII-é-漢-🙂-".repeat(25000);
const foldSamples: {implementation:string; wallMs:number; cpuMs:number; hash:string}[] = [];
for (const implementation of ["before", "after", "after", "before", "before", "after"]) {
  const fn = implementation === "before" ? before.foldLine : current.foldLine;
  const cpu = process.cpuUsage(), start = performance.now(); const value = fn(foldInput), wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu); foldSamples.push({implementation, wallMs, cpuMs:(used.user+used.system)/1000, hash:createHash("sha256").update(value).digest("hex")});
}
assert.equal(new Set(foldSamples.map(s => s.hash)).size, 1);
const foldMedian = (key:"wallMs"|"cpuMs", name:string) => foldSamples.filter(s=>s.implementation===name).map(s=>s[key]).sort((a,b)=>a-b)[1];
results.push({label:"fold", codeUnits:foldInput.length, samples:foldSamples, medians:{beforeWallMs:foldMedian("wallMs","before"), afterWallMs:foldMedian("wallMs","after"), beforeCpuMs:foldMedian("cpuMs","before"), afterCpuMs:foldMedian("cpuMs","after")}});
const output = {baselineCommit:"b31a078e1b42cd3271955a706bb0ef0a6a3be394", baselineSha256:createHash("sha256").update(source).digest("hex"), differentialCases:500, foldingDifferentialCases:1000, node:process.version, results, limits:"Local single-process observations, no peak memory measurement; synthetic input, not universal Pareto or full suite speed."};
writeFileSync("docs/evidence/tt135-contacts-benchmark.json", JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify(output,null,2));
