/**
 * TT43 unit tests — WP-22 SharedWorker broker (src/lib/wp-shared-broker.ts) with REAL MessageChannels (Node's): the
 * "host" end here is the receiving side of the attach messages (in the browser it is the hidden host document,
 * exercised for real by e2e-tt43); every port a page hands over must arrive at the right host, still entangled.
 */
import { MessageChannel, type MessagePort as NodePort } from "node:worker_threads";
import { SharedBroker, type BrokerSource, type WhoAnswer } from "../src/lib/wp-shared-broker.ts";
import { makeHarness } from "./harness.mts";
import * as acorn from "acorn";
import { findModuleRefs } from "../src/lib/js-imports.ts";
import { rewriteModuleSource } from "../src/lib/wp-core.ts";

const { test, finish } = makeHarness("tt43-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const tick = () => new Promise((r) => setTimeout(r, 5));

const SITES: Record<string, WhoAnswer> = { "S1\nd1": { origin: "https://a.test", xs: false }, "S1\nd2": { origin: "https://a.test", xs: false }, "S2\nd3": { origin: "https://a.test", xs: false },
  "S1\nd4": { origin: "https://b.test", xs: false }, "S1\nx1": { origin: "https://a.test", xs: true }, "S1\nx2": { origin: "https://a.test", xs: true } };
function rig() {
  const hosts: { key: string; msgs: { m: Record<string, unknown>; port?: NodePort }[]; removed: boolean }[] = [];
  const timers: { f: () => void; ms: number; dead: boolean }[] = [];
  let whoCalls = 0;
  const b = new SharedBroker({
    who: async (sid, doc) => { whoCalls++; return SITES[`${sid}\n${doc}`] ?? null; },
    makeHost: (_sid, _doc, key) => {
      const h = { key, msgs: [] as { m: Record<string, unknown>; port?: NodePort }[], removed: false };
      hosts.push(h);
      return { post: (m, tr) => { h.msgs.push({ m: m as Record<string, unknown>, port: (tr?.[0] as unknown as NodePort) ?? undefined }); }, remove: () => { h.removed = true; } };
    },
    setTimer: (f, ms) => { const t = { f, ms, dead: false }; timers.push(t); return t; },
    clearTimer: (t) => { (t as { dead: boolean }).dead = true; },
  });
  const fire = () => { for (const t of timers.splice(0)) if (!t.dead) t.f(); };
  return { b, hosts, fire, whoCalls: () => whoCalls };
}
function page(closed = false) {
  const got: Record<string, unknown>[] = [];
  const src: BrokerSource & { got: typeof got; closed: boolean } = { got, closed, postMessage: (m) => { got.push(m as Record<string, unknown>); } };
  return src;
}
const connect = (b: SharedBroker, src: BrokerSource, o: Record<string, unknown>, origin = "null") => {
  const mc = new MessageChannel();
  b.onMessage({ fusionWpShared: "connect", name: "", type: "classic", ...o }, origin, src, [mc.port2 as unknown as MessagePort]);
  return mc.port1;
};
const recv = (p: NodePort) => new Promise<unknown>((r, j) => { const t = setTimeout(() => j(new Error("no message on the port")), 1000); p.once("message", (m) => { clearTimeout(t); r(m); }); });

await test("WP-22 sharing scope: two documents of one site in ONE session (two tabs of a profile) get ONE host and ONE worker key, and both pages' ports arrive there entangled (a message posted by each page is received at the host end); another session, another site, another name or a module type get their own; a hello is answered; the host gets nothing before it is ready, then everything in order", { "WP-22": "full" }, async () => {
  const { b, hosts } = rig();
  const p1 = page(), p2 = page(), p3 = page(), p4 = page();
  b.onMessage({ fusionWpShared: "hello" }, "null", p1, []);
  ok(p1.got[0]?.fusionWpShared === "here", "hello answered");
  const a1 = connect(b, p1, { id: "c1", sid: "S1", doc: "d1", url: "https://a.test/sw.js" });
  const a2 = connect(b, p2, { id: "c2", sid: "S1", doc: "d2", url: "https://a.test/sw.js" });
  connect(b, p3, { id: "c3", sid: "S2", doc: "d3", url: "https://a.test/sw.js" });
  connect(b, p4, { id: "c4", sid: "S1", doc: "d4", url: "https://b.test/sw.js" });
  connect(b, p1, { id: "c5", sid: "S1", doc: "d1", url: "https://a.test/sw.js", name: "other" });
  connect(b, p1, { id: "c6", sid: "S1", doc: "d1", url: "https://a.test/sw.js", type: "module" });
  await tick();
  ok(hosts.length === 3, `hosts: ${hosts.map((h) => h.key.replace(/\n/g, "|"))}`);
  ok(hosts.every((h) => h.msgs.length === 0), "nothing posted before host-ready");
  for (const h of hosts) b.fromHost(h.key, { fusionWpShared: "host-ready" });
  const hA = hosts.find((h) => h.key === "S1\nhttps://a.test\n")!;
  const att = hA.msgs.map((x) => x.m);
  ok(att.length === 4 && att.every((m) => m.fusionWpShared === "attach"), JSON.stringify(att));
  // attach order across DIFFERENT documents follows each document's server check; within one document it is kept
  const plain = hA.msgs.filter((x) => x.m.name === "" && x.m.type === "classic");
  ok(plain.length === 2 && plain[0].m.key === plain[1].m.key && new Set(att.map((m) => m.key)).size === 3, "c1 and c2 share one worker key; name and type separate");
  ok(att.findIndex((m) => m.name === "other") < att.findIndex((m) => m.type === "module"), "one document's connects keep their order");
  a1.postMessage("from-page"); a2.postMessage("from-page");
  ok((await recv(plain[0].port!)) === "from-page" && (await recv(plain[1].port!)) === "from-page", "ports entangled end to end");
  ok(b.stats().connections === 6 && b.stats().workers === 5, JSON.stringify(b.stats()));
  for (const p of [a1, a2]) p.close();
  for (const h of hosts) for (const x of h.msgs) x.port?.close();
});

await test("WP-22 forged and malformed requests: a sender that is not an opaque-origin document is ignored; an unknown (session, document) — a forged or evicted id — is refused with an error and its port closed; a script on ANOTHER site than the server's record of the document is refused (a page cannot join another site's worker by claiming it); bad id / type / missing port refused; nothing is framed for any of them", { "WP-22": "full" }, async () => {
  const { b, hosts } = rig();
  const p = page();
  connect(b, p, { id: "f0", sid: "S1", doc: "d1", url: "https://a.test/sw.js" }, "http://localhost:3999");
  const pf = connect(b, p, { id: "f1", sid: "S1", doc: "nope", url: "https://a.test/sw.js" });
  let closed = false; pf.on("close", () => { closed = true; });
  connect(b, p, { id: "f2", sid: "S1", doc: "d4", url: "https://a.test/sw.js" }); // d4 is b.test
  connect(b, p, { id: "f3", sid: "S1", doc: "d1", url: "https://a.test/sw.js", type: "shared" });
  connect(b, p, { id: "bad id!", sid: "S1", doc: "d1", url: "https://a.test/sw.js" });
  connect(b, p, { id: "f5", sid: "S1", doc: "d1", url: "javascript:alert(1)" });
  b.onMessage({ fusionWpShared: "connect", id: "f6", sid: "S1", doc: "d1", url: "https://a.test/sw.js", name: "", type: "classic" }, "null", p, []);
  await tick();
  const errs = p.got.filter((m) => m.fusionWpShared === "error").map((m) => m.id).sort();
  ok(JSON.stringify(errs) === JSON.stringify(["f1", "f2", "f3", "f5"]), `errors: ${JSON.stringify(p.got)}`);
  ok(hosts.length === 0, "nothing framed");
  await tick();
  ok(closed, "the refused port is closed");
});

await test("WP-22 partitioning: documents whose frame ancestors are cross-site (third-party contexts) never share with first-party documents of the same site, nor with each other (stricter than Chromium's per-top-site partition — disclosed); the server is asked once per document, not per connection", { "WP-22": "full" }, async () => {
  const { b, hosts, whoCalls } = rig();
  connect(b, page(), { id: "p1", sid: "S1", doc: "d1", url: "https://a.test/sw.js" });
  connect(b, page(), { id: "p2", sid: "S1", doc: "x1", url: "https://a.test/sw.js" });
  connect(b, page(), { id: "p3", sid: "S1", doc: "x2", url: "https://a.test/sw.js" });
  connect(b, page(), { id: "p4", sid: "S1", doc: "x1", url: "https://a.test/sw.js", name: "n" });
  await tick();
  ok(hosts.length === 3, hosts.map((h) => h.key.replace(/\n/g, "|")).join(" / "));
  ok(whoCalls() === 3, `who asked ${whoCalls()} times`);
});

await test("WP-22 lifetime (HTML 'permissible worker'): the worker lives while any document is connected; the last pagehide starts a grace period after which the host is told to terminate it and an empty host is removed; a reconnect within the grace keeps the SAME worker (no release); a window that is gone (closed) is swept; a bye from a different window cannot disconnect someone else; a bye that overtakes its own connect (pagehide during the server check) cancels it", { "WP-22": "full" }, async () => {
  const { b, hosts, fire } = rig();
  const p1 = page(), p2 = page(), evil = page();
  connect(b, p1, { id: "l1", sid: "S1", doc: "d1", url: "https://a.test/sw.js" });
  connect(b, p2, { id: "l2", sid: "S1", doc: "d2", url: "https://a.test/sw.js" });
  await tick(); b.fromHost(hosts[0].key, { fusionWpShared: "host-ready" });
  b.onMessage({ fusionWpShared: "bye", ids: ["l1", "l2"] }, "null", evil, []);
  ok(b.stats().connections === 2, "a foreign bye is ignored");
  b.onMessage({ fusionWpShared: "bye", ids: ["l1"] }, "null", p1, []); fire();
  ok(b.stats().connections === 1 && !hosts[0].removed && !hosts[0].msgs.some((x) => x.m.fusionWpShared === "release"), "one left: alive");
  b.onMessage({ fusionWpShared: "bye", ids: ["l2"] }, "null", p2, []);
  ok(!hosts[0].removed, "grace: not yet");
  const p3 = page();
  connect(b, p3, { id: "l3", sid: "S1", doc: "d1", url: "https://a.test/sw.js" }); await tick(); fire();
  ok(!hosts[0].removed && !hosts[0].msgs.some((x) => x.m.fusionWpShared === "release") && hosts.length === 1, "reconnect within the grace keeps the worker");
  p3.closed = true; b.sweep(); fire();
  ok(hosts[0].msgs.some((x) => x.m.fusionWpShared === "release") && hosts[0].removed && b.stats().hosts === 0, "closed window swept → released → host removed");
  const p4 = page();
  b.onMessage({ fusionWpShared: "bye", ids: ["e1"] }, "null", p4, []);
  const pe = connect(b, p4, { id: "e1", sid: "S1", doc: "d1", url: "https://a.test/sw.js" }); await tick();
  ok(hosts.length === 1 && b.stats().connections === 0, "early bye cancels the connect");
  pe.close();
});

await test("WP-22 errors: a worker error reported by a host reaches exactly the documents connected to THAT worker (by their own connection ids), not other workers' documents; a message from an unknown host key is ignored", { "WP-22": "full" }, async () => {
  const { b, hosts } = rig();
  const p1 = page(), p2 = page();
  connect(b, p1, { id: "e1", sid: "S1", doc: "d1", url: "https://a.test/bad.js" });
  connect(b, p2, { id: "e2", sid: "S1", doc: "d2", url: "https://a.test/good.js" });
  await tick(); b.fromHost(hosts[0].key, { fusionWpShared: "host-ready" });
  const badKey = hosts[0].msgs.find((x) => x.m.url === "https://a.test/bad.js")!.m.key as string;
  b.fromHost(hosts[0].key, { fusionWpShared: "error", key: badKey });
  b.fromHost("nope", { fusionWpShared: "error", key: badKey });
  ok(p1.got.filter((m) => m.fusionWpShared === "error").length === 1 && p1.got.find((m) => m.fusionWpShared === "error")!.id === "e1", JSON.stringify(p1.got));
  ok(p2.got.length === 0, "other worker's document untouched");
  for (const x of hosts[0].msgs) x.port?.close();
});

await test("WP-22 liveness by acknowledgement (the TT43 repair: a pagehide message is not always delivered): the broker pings each connected window; the document now in it answers with the ids it owns — a navigated window's NEW document (answering without the old ids) releases them at once; a busy page that misses one ping keeps its worker; a window that never answers is dropped after exactly 3 missed pings; an answer with a wrong nonce or from another window changes nothing", { "WP-22": "full" }, async () => {
  const { b, hosts, fire } = rig();
  const nav = page(), busy = page(), mute = page(), other = page();
  connect(b, nav, { id: "n1", sid: "S1", doc: "d1", url: "https://a.test/sw.js" });
  connect(b, nav, { id: "n2", sid: "S1", doc: "d1", url: "https://a.test/sw.js", name: "x" });
  connect(b, busy, { id: "b1", sid: "S1", doc: "d2", url: "https://a.test/sw.js" });
  connect(b, mute, { id: "m1", sid: "S2", doc: "d3", url: "https://a.test/sw.js" });
  await tick(); for (const h of hosts) b.fromHost(h.key, { fusionWpShared: "host-ready" });
  const nonce = (p: ReturnType<typeof page>) => [...p.got].reverse().find((m) => m.fusionWpShared === "ping")?.nonce as string;
  b.sweep();
  ok(nonce(nav) && nonce(busy) && nonce(mute), "every connected window pinged");
  b.onMessage({ fusionWpShared: "alive", nonce: "forged", ids: [] }, "null", nav, []);
  b.onMessage({ fusionWpShared: "alive", nonce: nonce(nav), ids: [] }, "null", other, []);
  ok(b.stats().connections === 4, "wrong nonce / other window: nothing released");
  b.onMessage({ fusionWpShared: "alive", nonce: nonce(nav), ids: ["n2"] }, "null", nav, []);
  ok(b.stats().connections === 3, "the window's current document does not own n1 → released");
  b.onMessage({ fusionWpShared: "alive", nonce: nonce(nav), ids: [] }, "null", nav, []);
  ok(b.stats().connections === 2, "a new document owning nothing → the rest released");
  b.sweep(); // busy misses this one
  b.onMessage({ fusionWpShared: "alive", nonce: nonce(busy), ids: ["b1"] }, "null", busy, []);
  b.sweep(); b.onMessage({ fusionWpShared: "alive", nonce: nonce(busy), ids: ["b1"] }, "null", busy, []);
  ok(b.stats().connections === 2, `busy page kept (mute has missed 2): ${JSON.stringify(b.stats())}`);
  b.sweep();
  ok(b.stats().connections === 1, `mute dropped after the 3rd missed ping: ${JSON.stringify(b.stats())}`);
  fire();
  ok(hosts.find((h) => h.key.startsWith("S2"))!.removed && !hosts.find((h) => h.key.startsWith("S1"))!.removed, "mute's host removed after the grace; busy's kept");
});

await test("Modules (TT42 blocker `import(x)` + newline + `{` not wrapped): a computed import followed on the next line by \"{\" is a CALL then a block wherever only statements can stand (top level, blocks, function / method / arrow bodies, class static blocks, switch bodies), and a METHOD named import inside a class body (declaration or expression, with heritage) or an object literal (incl. `export default {`); acorn (MIT, test-only) is the oracle for every case — the exact computed ranges must match, and the rewritten source must still parse with the same number of import expressions", { "WP-20": "full" }, async () => {
  type N = { type: string; start: number; end: number; source?: N; [k: string]: unknown };
  const calls = (src: string): { ranges: string[]; mode: "module" | "script"; count: number } => {
    let ast: N | null = null, mode: "module" | "script" = "module";
    for (const m of ["module", "script"] as const) { try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: m }) as unknown as N; mode = m; break; } catch { /* next */ } }
    if (!ast) throw new Error(`acorn cannot parse: ${src}`);
    const out: string[] = []; let count = 0;
    const walk = (x: unknown): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } const n = x as N; if (n.type === "ImportExpression") { count++; if (n.source && n.source.type !== "Literal") out.push(`${n.source.start}-${n.source.end}`); } for (const k in n) if (k !== "type") walk(n[k]); };
    walk(ast); return { ranges: out, mode, count };
  };
  const cases = [
    "import(x)\n{ y() }",
    "function f(){ if (a) import(x)\n{ b() } }",
    "({ import(x) { return x } })",
    "class A { import(x) {} static import(y) {} async *import(z) {} }",
    "export default { import(x) { return 1 } }",
    "class A extends B { import(x) {} }",
    "class A extends mix({ k: 1 }) { import(x) {} }",
    "x = { class: 1 }; class A { import(y) {} }; import(z)\n{}",
    "({ class() { import(z)\n{} } })",
    "x = class { import(q) {} }; import(w)\n{}",
    "`${ ({ import(a) {} }) }`; import(b)\n{}",
    "label: import(x)\n{}",
    "{ import(x)\n{} }",
    "switch (a) { case 1: import(x)\n{} }",
    "class A { m() { import(x)\n{} } }",
    "async () => { import(x)\n{} }",
    "x = { a: () => { import(x)\n{} } }",
    "class A { static { import(x)\n{} } }",
    "x = { import(a, b) {} }",
    "if (c) { import(u + v)\n{ w() } } else import(t)\n{}",
    "x = { get import() { return 1 }, set import(v) {} }",
  ];
  const bad: string[] = [];
  for (const src of cases) {
    const want = calls(src), got = findModuleRefs(src).computed.map((r) => `${r.start}-${r.end}`);
    if (JSON.stringify(got) !== JSON.stringify(want.ranges)) { bad.push(`${JSON.stringify(src)}: ours ${got} acorn ${want.ranges}`); continue; }
    const re = rewriteModuleSource(src, { base: "https://a.test/m.js", seg: "S:d:s", metaUrl: null });
    if (re.error) { bad.push(`${JSON.stringify(src)}: rewrite error ${re.error}`); continue; }
    if ((re.wrapped ?? 0) !== want.ranges.length) bad.push(`${JSON.stringify(src)}: wrapped ${re.wrapped}`);
    const after = calls(re.code);
    if (after.mode !== want.mode || after.count !== want.count) bad.push(`${JSON.stringify(src)}: rewrite changed parse (${after.mode}/${after.count})`);
  }
  ok(!bad.length, bad.join("\n"));
  // the remaining, documented, CONSERVATIVE miss: a block after a label / case colon is taken for an object literal,
  // so its import(x)+newline+{ stays unwrapped (exactly TT42's behaviour) — never a method wrongly wrapped
  for (const src of ["L: { import(x)\n{} }", "switch (a) { case 1: { import(x)\n{} } }"]) ok(findModuleRefs(src).computed.length === 0 && calls(src).ranges.length === 1, `documented miss changed: ${src}`);
});

await finish();
process.exit(0);
