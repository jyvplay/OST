/**
 * TT42 unit suite (no server): computed dynamic-import wrapping (WP-20 part 1). Further TT42 units are appended below.
 *   node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt42-unit.mts
 * Oracles: acorn (MIT, test-only) for argument ranges and re-parse; V8 itself (vm importModuleDynamically in a child
 * process) for what import() really receives; rewriteSpecifier (the static path, already browser-tested) for values.
 */
import { spawnSync } from "node:child_process";
import * as acorn from "acorn";
import { makeHarness } from "./harness.mts";
import { findModuleRefs } from "../src/lib/js-imports.ts";
import { rewriteSpecifier, rewriteModuleSource, dynImportWrap, decodeTarget } from "../src/lib/wp-core.ts";
import { parseDhclientLeases, parseNetworkdLease, buildInform, parseDhcpReply } from "../src/lib/server/dhcp-wpad.ts";
import { inferDest, parseSidSegment, flagString, nextChainFlags, policyFor } from "../src/lib/wp-cors.ts";

const { test, finish } = makeHarness("tt42-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

const BASE = "https://site.test/app/sub/main.js", SEG = "AAAAAAAAAAAAAAAAAAAAAA:d1:s";

await test("WP-20 wrapper value semantics: for 20 run-time specifier values (root-relative, ./, ../, a colon in the first path segment, absolute http(s), protocol-relative, URL objects, an object with toString, credentials in the URL, bare names, data:, blob:, already-proxied, a non-http scheme, an unparseable string) the inline wrapper yields EXACTLY what the static rewriter yields for the same literal (or the string itself where the static rewriter leaves it); a throwing toString / a Symbol is passed through untouched so import() rejects natively", { "WP-20": "full" }, async () => {
  const w = dynImportWrap(BASE, SEG);
  const fn = (0, eval)(`(x) => ${w.open}x${w.close}`) as (x: unknown) => unknown;
  const strs = ["/root/x.js", "./rel.js?q=1#h", "../up/y.mjs", "/foo:bar/x.js", "foo:bar/x.js", "https://cdn.test/m.js", "http://cdn.test:8080/a/b.js?x", "//proto.test/p.js", "https://u:p@cred.test/x.js",
    "bare", "@scope/pkg/sub", "data:text/javascript,export default 1", "blob:https://site.test/1234", "/api/wp/s/BBBBBBBBBBBBBBBBBBBBBB:d2:s/https/x.test/y.js", "ftp://old.test/x.js", "http://[::1/x.js"];
  const bad: string[] = [];
  for (const s of strs) {
    const want = rewriteSpecifier(s, BASE, SEG) ?? s;
    const got = fn(s);
    if (got !== want) bad.push(`${JSON.stringify(s)}: wrapper ${JSON.stringify(got)} static ${JSON.stringify(want)}`);
  }
  const u = new URL("./from-url.js", "https://site.test/app/");
  if (fn(u) !== rewriteSpecifier(u.href, BASE, SEG)) bad.push(`URL object: ${fn(u)}`);
  const ts = { toString: () => "../ts.js" };
  if (fn(ts) !== rewriteSpecifier("../ts.js", BASE, SEG)) bad.push(`toString object: ${fn(ts)}`);
  const thrower = { toString() { throw new Error("nope"); } };
  if (fn(thrower) !== thrower) bad.push("throwing toString not passed through");
  const sym = Symbol("s");
  if (fn(sym) !== sym) bad.push("Symbol not passed through");
  ok(bad.length === 0, bad.join("\n    "));
  ok(fn("/foo:bar/x.js") === `/api/wp/s/${SEG}/https/site.test/foo:bar/x.js`, "the TT41 colon blocker shape becomes an exact proxied address");
});

const CASES: [string, number, string][] = [
  [`import(a)`, 1, "identifier"],
  [`import("/x/" + n + ".js")`, 1, "concatenation"],
  [`import(\`/x/\${n}.js\`)`, 1, "template with substitution"],
  [`import(\`/x/\${\`\${a}\${b}\`}/\${c ? \`d\` : "e"}.js\`, { with: { type: "json" } })`, 1, "nested templates + options"],
  [`import(f(a, b), opts)`, 1, "call with commas inside"],
  [`import([a, b].join("/"))`, 1, "array"],
  [`import({ a: 1 }.a ? x : y)`, 1, "object literal"],
  [`import(/* c */ a /* d */)`, 1, "comments around the argument"],
  [`import(\n  base +\n  "/x.js",\n)`, 1, "multi-line + trailing comma"],
  [`import(import.meta.url + "/../x.js")`, 1, "import.meta inside"],
  [`import(cond ? import("/lit.js") : other)`, 1, "a literal import nested in a computed one"],
  [`import(import(a).then(m => m.p))`, 2, "a computed import nested in a computed one"],
  [`import.source(w)`, 1, "import.source"],
  [`import.defer(x)`, 1, "import.defer"],
  [`import("/lit.js")`, 0, "literal: not computed"],
  [`import(\`/plain.js\`)`, 0, "plain template: not computed"],
  [`o = { import(a) { return a; } }`, 0, "object METHOD named import"],
  [`class K { import(a, b) { } static import(c) { } async import(d) { } *import(e) { } }`, 0, "class METHODS named import"],
  [`x.import(a); x?.import(b)`, 0, "member call named import"],
];
await test("WP-20 lexer: the first argument of every computed dynamic import is found with exactly acorn's source range — 19 shapes incl. nested templates, commas inside calls / arrays / objects, comments, a trailing comma, nested imports (literal inside computed, computed inside computed), import.source / import.defer — and literal imports, object / class METHODS named import and member calls are never wrapped", { "WP-20": "full" }, async () => {
  const bad: string[] = [];
  for (const [src, n, name] of CASES) {
    let ast: acorn.Node;
    try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module" }); }
    catch { ast = acorn.parse(src.replace(/import\.(source|defer)/g, "import"), { ecmaVersion: "latest", sourceType: "module" }); } // acorn has no phase imports: same shape
    const want: string[] = [];
    const walk = (x: unknown): void => { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { x.forEach(walk); return; } const o = x as { type?: string; source?: { type: string; start: number; end: number; expressions?: unknown[]; value?: unknown } }; if (o.type === "ImportExpression" && o.source && !(o.source.type === "Literal" && typeof o.source.value === "string") && !(o.source.type === "TemplateLiteral" && !o.source.expressions?.length)) want.push(`${o.source.start}-${o.source.end}`); for (const k of Object.keys(o)) if (k !== "type") walk((o as Record<string, unknown>)[k]); };
    walk(ast);
    const ph = src.match(/import\.(source|defer)/), shift = ph ? ph[0].length - 6 : 0; // acorn ranges were measured on the shortened source
    const wantR = want.map((r) => r.split("-").map((v) => Number(v) + shift).join("-")).sort();
    const got = findModuleRefs(src).computed.map((c) => `${c.start}-${c.end}`).sort();
    if (got.length !== n || JSON.stringify(got) !== JSON.stringify(wantR)) bad.push(`${name}: ours ${JSON.stringify(got)} acorn ${JSON.stringify(wantR)} expected ${n}`);
  }
  ok(bad.length === 0, bad.join("\n    "));
});

/** what V8 hands to import() when `src` runs as a classic script — child process, the hook needs a flag */
function v8Specs(src: string, globals: string): string[] | null {
  const code = `process.on("unhandledRejection", () => {}); const vm = require("vm"); let src = ""; process.stdin.on("data", (d) => src += d).on("end", () => { const seen = [];
    const ctx = vm.createContext(${globals}); ctx.URL = URL;
    try { new vm.Script(src, { importModuleDynamically: (s) => { seen.push(s); return Promise.reject(new Error("captured")); } }).runInContext(ctx); } catch (e) { console.log(JSON.stringify({ err: String(e) })); return; }
    setTimeout(() => console.log(JSON.stringify(seen)), 20); });`;
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "-e", code], { input: src, encoding: "utf8" });
  try { const j = JSON.parse(r.stdout.trim()); return Array.isArray(j) ? j : null; } catch { return null; }
}
await test("WP-20 executed by V8: a rewritten script's import() calls receive the proxied address of every computed root-relative / relative / absolute / colon-segment / URL-object specifier, bare names unchanged, a literal import proxied statically, options still passed — and the original script, run the same way, receives the raw values (the difference is ONLY the proxying)", { "WP-20": "full" }, async () => {
  const src = [
    `var n = "dep";`,
    `import("/" + n + ".js");`,
    `import(\`./\${n}.mjs\`, { with: { type: "json" } });`,
    `import(["..", "up", n].join("/") + ".js");`,
    `import("/" + "foo:bar" + "/x.js");`,
    `import(new URL("./u.js", "https://other.test/lib/"));`,
    `import("lo" + "dash");`,
    `import("/lit.js");`,
    `var o = { import(a) { return a; } }; o.import("/not-an-import.js");`,
  ].join("\n");
  const raw = v8Specs(src, "{}");
  ok(JSON.stringify(raw) === JSON.stringify(["/dep.js", "./dep.mjs", "../up/dep.js", "/foo:bar/x.js", "https://other.test/lib/u.js", "lodash", "/lit.js"]), `original ${JSON.stringify(raw)}`);
  const r = rewriteModuleSource(src, { base: BASE, seg: SEG, metaUrl: null });
  ok(r.wrapped === 6 && r.rewritten === 1, `wrapped ${r.wrapped} rewritten ${r.rewritten}`);
  const got = v8Specs(r.code, "{}");
  const P = `/api/wp/s/${SEG}/`;
  const want = [`${P}https/site.test/dep.js`, `${P}https/site.test/app/sub/dep.mjs`, `${P}https/site.test/app/up/dep.js`, `${P}https/site.test/foo:bar/x.js`, `${P}https/other.test/lib/u.js`, "lodash", `${P}https/site.test/lit.js`];
  ok(JSON.stringify(got) === JSON.stringify(want), `rewritten ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);
});

await test("WP-20 fail-safe and scope: a file the lexer cannot read is returned byte-identical (nothing wrapped); an `import(x)` followed by \"{\" on the next line is a call + block (ASI) at statement level and is wrapped (TT43; was TT42's documented miss), while the same shape inside an object literal / class body is a METHOD and stays untouched", { "WP-20": "full" }, async () => {
  const broken = `import(a); var s = "unterminated`;
  const r = rewriteModuleSource(broken, { base: BASE, seg: SEG, metaUrl: null });
  ok(r.code === broken && r.error, "unlexable source untouched");
  const asi = `import(a)\n{ b(); }`;
  const r2 = rewriteModuleSource(asi, { base: BASE, seg: SEG, metaUrl: null });
  ok(r2.code !== asi && r2.wrapped === 1 && /\n\{ b\(\); \}$/.test(r2.code), `TT43: statement-level ASI block shape wrapped, block kept: ${r2.code.slice(-40)}`);
  const meth = `({ import(a) { b(); } })`;
  const r3 = rewriteModuleSource(meth, { base: BASE, seg: SEG, metaUrl: null });
  ok(r3.code === meth && (r3.wrapped ?? 0) === 0, "a method named import is never wrapped");
});

await test("WP-21 destination inference without Fetch Metadata: Safari's real Accept values (document / image / stylesheet / */*) and the URL tag decide — untagged document → navigate, untagged image / css → no-cors image / style, a markup-subresource tag → its Accept or script, a script tag → script (CORS) or, with the shim's \"e\" flag, empty (fetch / XHR), a frame tag → iframe; ANY Fetch Metadata header present → null (the browser's own values win); \"e\" round-trips in canonical order after \"n\", is rejected out of order, and survives a redirect hop", { "WP-21": "full" }, async () => {
  const SAF = { doc: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", img: "image/webp,image/avif,image/jxl,image/heic,image/heic-sequence,video/*;q=0.8,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5", css: "text/css,*/*;q=0.1", any: "*/*" };
  const H = (acc: string, extra: Record<string, string> = {}) => (n: string) => ({ accept: acc, ...extra } as Record<string, string>)[n] ?? null;
  const sid = "AAAAAAAAAAAAAAAAAAAAAA", doc = "d0c0d0c0d0c0";
  const seg = (x: string) => parseSidSegment(x)!;
  const cases: [string, string, string, { dest: string; mode: string } | null][] = [
    ["untagged document", sid, SAF.doc, { dest: "document", mode: "navigate" }],
    ["untagged, no Accept (old clients)", sid, "", { dest: "document", mode: "navigate" }],
    ["untagged image", sid, SAF.img, { dest: "image", mode: "no-cors" }],
    ["untagged stylesheet", sid, SAF.css, { dest: "style", mode: "no-cors" }],
    ["markup image", `${sid}:${doc}:r`, SAF.img, { dest: "image", mode: "no-cors" }],
    ["markup classic script", `${sid}:${doc}:r`, SAF.any, { dest: "script", mode: "no-cors" }],
    ["module graph", `${sid}:${doc}:s`, SAF.any, { dest: "script", mode: "cors" }],
    ["page fetch()", `${sid}:${doc}:se`, SAF.any, { dest: "empty", mode: "cors" }],
    ["page fetch() asking for HTML", `${sid}:${doc}:ie`, SAF.doc, { dest: "empty", mode: "cors" }],
    ["data-worker fetch()", `${sid}:${doc}:stxyne`, SAF.any, { dest: "empty", mode: "cors" }],
    ["frame", `${sid}:${doc}:f`, SAF.doc, { dest: "iframe", mode: "navigate" }],
  ];
  const bad: string[] = [];
  for (const [name, sg, acc, want] of cases) { const got = inferDest(H(acc), seg(sg)); if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${name}: ${JSON.stringify(got)}`); }
  if (inferDest(H(SAF.any, { "sec-fetch-dest": "script" }), seg(`${sid}:${doc}:se`)) !== null) bad.push("Sec-Fetch-Dest present must win");
  if (inferDest(H(SAF.any, { "sec-fetch-mode": "cors" }), seg(sid)) !== null) bad.push("Sec-Fetch-Mode present must win");
  ok(bad.length === 0, bad.join("\n    "));
  ok(flagString(seg(`${sid}:${doc}:smtxyne`).flags) === "mtxyne" && seg(`${sid}:${doc}:se`).flags?.e === true, "e parsed + canonical");
  ok(parseSidSegment(`${sid}:${doc}:sen`) === null && parseSidSegment(`${sid}:${doc}:see`) === null && parseSidSegment(`${sid}:${doc}:re`) === null, "out of order / repeated / on r → rejected");
  ok(decodeTarget(`/api/wp/s/${sid}:${doc}:se/https/a.test/x`).flags?.e === true, "decodeTarget keeps e");
  const pol = policyFor({ initiator: "https://a.test", target: new URL("https://a.test/x"), cred: "same-origin", method: "GET", headers: [], chain: { e: true }, siteOf: (h: string) => h });
  ok(nextChainFlags(pol, new URL("https://a.test/x"), new URL("https://b.test/y")).e === true, "e survives a redirect hop");
});

await test("WP-15 DHCP option 252 parsing: dhclient leases (named \"wpad\", \"unknown-252\" string with \\000 / \\\" escapes, colon-hex bytes; the LAST lease block wins; non-http values and a block without 252 skipped), systemd-networkd OPTION_252 hex; a DHCPINFORM is a well-formed RFC 2131 BOOTREQUEST (op 1, ciaddr, magic cookie, option 53 = 8, parameter list {252}) and a DHCPACK carrying 252 parses back — a reply for another xid, a BOOTREQUEST, or a bad cookie is ignored", { "WP-15": "full" }, async () => {
  ok(parseDhclientLeases(`lease {\n option wpad "http://a.test/old.dat";\n}\nlease {\n option unknown-252 "http://b.test/w\\"x\\000";\n}`) === "http://b.test/w%22x", "last block, escapes, NUL dropped");
  const hex = [...Buffer.from("http://c.test/p.pac")].map((b) => b.toString(16)).join(":");
  ok(parseDhclientLeases(`lease {\n option unknown-252 ${hex};\n}`) === "http://c.test/p.pac", "colon hex");
  ok(parseDhclientLeases(`lease {\n option unknown-252 "file:///etc/x";\n}\nlease {\n option subnet-mask 255.0.0.0;\n}`) === null, "non-http / absent → null");
  ok(parseNetworkdLease(`ADDRESS=10.0.0.2\nOPTION_252=${Buffer.from("http://d.test/x.pac\0").toString("hex").toUpperCase()}\n`) === "http://d.test/x.pac", "networkd hex + NUL");
  const mac = Buffer.from([2, 0, 0, 0, 0, 7]);
  const q = buildInform({ xid: 0xdeadbeef, ciaddr: "10.1.2.3", mac });
  ok(q[0] === 1 && q.readUInt32BE(4) === 0xdeadbeef && q.subarray(12, 16).join(".") === "10.1.2.3" && q.subarray(236, 240).toString("hex") === "63825363" && q.subarray(240, 246).toString("hex") === "35010837" + "01fc", `inform bytes ${q.subarray(236, 250).toString("hex")}`);
  const ack = Buffer.from(q); ack[0] = 2;
  const url = Buffer.from("http://e.test/wpad.dat");
  const reply = Buffer.concat([ack.subarray(0, 240), Buffer.from([53, 1, 5, 252, url.length]), url, Buffer.from([255])]);
  const r = parseDhcpReply(reply, 0xdeadbeef);
  ok(r?.type === 5 && r.wpad === "http://e.test/wpad.dat", JSON.stringify(r));
  ok(parseDhcpReply(reply, 1) === null && parseDhcpReply(q, 0xdeadbeef) === null, "wrong xid / request ignored");
  const bad = Buffer.from(reply); bad[236] = 0; ok(parseDhcpReply(bad, 0xdeadbeef) === null, "bad cookie ignored");
});

await finish();
process.exit(0);
