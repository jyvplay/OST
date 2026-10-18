// TT39 test helper (spawned by scripts/tt39-pac.mts, one hostile PAC per process, so a hang can only kill this
// child): builds the script, asks for one decision, prints {"ms", "result" | "error", "after"} — "after" proves the
// process (its event loop) is still alive and responsive once the decision returned.
const { PacScript } = await import("../../../src/lib/server/pac.ts");
// the script arrives on stdin (an environment string is limited to 128 KiB on Linux; the >1 MiB case needs more)
const { readFileSync } = await import("node:fs");
const src = readFileSync(0, "utf8");
const t0 = Date.now();
const out: Record<string, unknown> = {};
try {
  const p = new PacScript(src);
  out.result = await p.find(new URL("http://victim.example/"), { dns: process.env.PAC_DNS !== "0", resolve: async (h) => (h.length < 40 ? "10.9.9.9" : null) });
} catch (e) { out.error = (e as Error).message; }
out.ms = Date.now() - t0;
await new Promise((r) => setTimeout(r, 50));
out.after = { alive: true, process: typeof (globalThis as { process?: unknown }).process };
console.log(JSON.stringify(out));
process.exit(0);
