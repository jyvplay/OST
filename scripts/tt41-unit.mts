/**
 * TT41 unit checks.
 *   WP-17  the original module lexer (src/lib/js-imports.ts) against an EXTERNAL ORACLE — acorn 8 (a full ECMAScript
 *          parser, MIT, already in node_modules) — on the edge cases module lexers are known to get wrong; specifier
 *          rewriting; import maps; import.meta.url / import.meta.resolve; HTML wiring (inline modules, import maps,
 *          crossorigin, modulepreload, iframes).
 *   WP-18  segment flags, redirect-chain flags (Fetch §4.4 HTTP-redirect fetch: tainted origin; §4.1 main fetch:
 *          sticky response tainting), the policy they produce (Origin, cookies, Referer, Sec-Fetch-Site).
 *   WP-19  documents with cross-site ancestors; documentCsp for nested frames.
 * The large-scale differential (12,457 files of node_modules, 0 disagreements) is scripts/oracle/js-imports-diff.mts.
 * Run: node --use-system-ca --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt41-unit.mts
 */
import { spawnSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { acornSpecifiers } from "./oracle/js-imports-diff.mts";
import { findImportSpecifiers, findModuleRefs, rewriteModule } from "../src/lib/js-imports.ts";
import { rewriteSpecifier, rewriteImportMap, rewriteHtml, rewriteModuleSource, RESOLVE_WRAP, documentCsp, siteOf, decodeTarget } from "../src/lib/wp-core.ts";
import { parseSidSegment, flagString, nextChainFlags, policyFor, resourcePolicy, type ChainFlags } from "../src/lib/wp-cors.ts";
import { newDoc, docInfo } from "../src/lib/server/wp-sessions.ts";

const { test, finish } = makeHarness("tt41-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
/** the specifiers V8 hands to import() when `src` runs as a classic script (child process: the hook needs a flag) */
function v8DynamicSpecs(src: string): string[] | null {
  const code = `process.on("unhandledRejection", () => {}); process.on("uncaughtException", () => {}); const vm = require("vm"); let src = ""; process.stdin.on("data", (d) => src += d).on("end", () => { const seen = [];
    new vm.Script(src, { importModuleDynamically: (s) => { seen.push(s); return Promise.reject(new Error("captured")); } }).runInNewContext({ x: 0, y: 0, a: 0, f: () => 0, Base: Object, mix: (o) => class {} });
    setTimeout(() => console.log(JSON.stringify(seen)), 20); });`;
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", "-e", code], { input: src, encoding: "utf8" });
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}
const ours = (src: string) => findImportSpecifiers(src).map((s) => `${s.start}-${s.end}`).sort();

// every case: [label, source, how many specifiers acorn must find (so a case cannot pass vacuously)]
const CASES: [string, string, number][] = [
  ["string containing import", `const s = "import('/x.js')"; import a from "/a.js";`, 1],
  ["line + block comments", `// import "/no1.js"\n/* import("/no2.js") */ import "/yes.js";`, 1],
  ["template text and ${} expression", "const t = `import('/no.js') ${ await import('/yes.js') } import \"/no2.js\"`;", 1],
  ["regex containing import", `const r = /import\\("\\/no\\.js"\\)/g; export * from "/e.js";`, 1],
  ["member a.import()", `a.import("/no.js"); obj?.import("/no2.js"); import("/yes.js");`, 1],
  ["class method named import", `class K { import(x) { return x; } static import() {} } import("/yes.js");`, 1],
  ["object key import", `const o = { import: 1, "import": 2, import() {} }; import "/yes.js";`, 1],
  ["while(...) /re/", `while (false) /import("\\/no")/g.test(""); import "/yes.js";`, 1],
  ["export default /re/", `export default /import("\\/no")/; import "/yes.js";`, 1],
  ["for (a of /re/)", `for (const a of /import("\\/no")/.exec("") ?? []) {} import("/yes.js");`, 1],
  ["return /re/", `function f() { return /import("\\/no")/; } import "/yes.js";`, 1],
  ["division, not regex", `const b = 4, c = 2; const v = b / import("/yes.js").then.length / c;`, 1],
  // no ASI before "/": this is 1 / import("\/q") / g.lastIndex — a REAL dynamic import (the trap is calling it a regex)
  ["newline then / is division, not a regex", `let y = 1\n/import("\\/q")/g.lastIndex; import("/yes.js");`, 2],
  ["hashbang", `#!/usr/bin/env node\nimport "/yes.js";`, 1],
  ["import attributes", `import data from "/d.json" with { type: "json" }; export { x } from "/x.js" with { type: "json" };`, 2],
  ["escaped slash \\u002f in string", `import "\\u002fyes.js";`, 1],
  ["export * as ns", `export * as ns from "/ns.js";`, 1],
  ["export { a } from", `export { a, b as c } from "/ab.js"; const z = 1; export { z };`, 1],
  ["string-named import", `import { "a-b" as c } from "/s.js";`, 1],
  ["dynamic import with options", `import("/o.js", { with: { type: "json" } });`, 1],
  ["plain template dynamic import", "import(`/tpl.js`);", 1],
  ["template with expression is not static", "const n = 1; import(`/t${n}.js`);", 0],
  ["import.meta is not a specifier", `const u = import.meta.url; import "/m.js";`, 1],
  ["nested braces / regex in arrow body", `const f = () => { if (a) { return /}/.test("x"); } }; import "/yes.js";`, 1],
  ["keyword-led regex: typeof /re/", `const k = typeof /import("\\/no")/; import "/yes.js";`, 1],
  ["many imports", `import a from "/1.js"; import * as b from "/2.js"; import { c } from "/3.js"; import d, { e } from "/4.js"; import "/5.js";`, 5],
  ["parenthesised expression then division", `const q = (1) / 2 / import("/yes.js").length;`, 1],
  ["object literal then regex-looking", `({}) / 1; import("/yes.js");`, 1],
];

await test("WP-17 lexer oracle: 28 edge cases module lexers are known to get wrong (strings / comments / templates / regexes containing import, member and method named import, regex after while / export default / of / return / typeof / a newline, division vs regex, hashbang, import attributes, \\u escapes, export * as, string-named imports, dynamic import with options and plain templates) — the specifier ranges are IDENTICAL to acorn's", { "WP-17": "full" }, async () => {
  const bad: string[] = [];
  for (const [label, src, n] of CASES) {
    const a = acornSpecifiers(src);
    if (!a) { bad.push(`${label}: acorn could not parse the case itself`); continue; }
    if (a.ranges.length !== n) { bad.push(`${label}: acorn found ${a.ranges.length}, the case expects ${n}`); continue; }
    let o: string[];
    try { o = ours(src); } catch (e) { bad.push(`${label}: lexer error ${(e as Error).message}`); continue; }
    if (JSON.stringify(o) !== JSON.stringify(a.ranges)) bad.push(`${label}: ours ${JSON.stringify(o)} acorn ${JSON.stringify(a.ranges)}`);
  }
  ok(bad.length === 0, bad.join("\n    "));
});

await test("WP-17 lexer, function / class EXPRESSION vs DECLARATION (TT42; TT41 refused these files — and one shape was silently MISSED, not refused): after an expression body's \"}\" a slash divides, after a declaration's it starts a regex — 15 shapes identical to acorn (V8 when acorn itself mis-lexes), including named / async / generator function expressions, class expressions with heritage, a declaration followed by a regex statement, and export default function", { "WP-17": "full" }, async () => {
  const hard: [string, number][] = [
    [`x = function () {} / 2; import("/yes.js");`, 1],
    [`x = function () {} / 1; import("/a.js"); y = 1 / 2;`, 1], // TT41: lex error -> file left unrewritten (fail-safe)
    [`x = function () {} / 1; import('dep.js'); y = 1 / 2; z = 'q';`, 1], // TT41: NO error, import silently missed (verified vs git HEAD)
    [`x = class {} / 2; import("/yes.js");`, 1],
    [`f(function () {} / 1, import("/yes.js"));`, 1],
    [`x = async function () {} / 1; import("/yes.js");`, 1],
    [`x = function* g(a, b) { yield a; } / 1; import("/yes.js");`, 1],
    [`x = function named({ a }, [b]) { return a; } / 2 / import("/yes.js").length;`, 1],
    [`x = class extends (Base ?? Object) { m() { return 1; } } / 2; import("/yes.js");`, 1],
    [`x = class Y extends mix({ a: 1 }) { static { this.q = 1; } } / 2; import("/yes.js");`, 1],
    [`function f() {}\n/import("\\/no")/g.test(""); import("/yes.js");`, 1],
    [`class K {}\n/import("\\/no")/g.test(""); import("/yes.js");`, 1],
    [`export default function () {}\n/import("\\/no")/g.test(""); import("/yes.js");`, 1],
    [`if (a) function g() {}\n/import("\\/no")/.test(""); import("/yes.js");`, 1],
    [`const o = { m: function () {} / 1, n: class {} / 2 }; import("/yes.js");`, 1],
  ];
  const bad: string[] = [];
  for (const [src, n] of hard) {
    const a = acornSpecifiers(src);
    if (!a) {
      // acorn's own tokenizer mis-reads one shape (async function expression then "/") — the arbiter is then V8:
      // run the snippet and record which import() calls really execute
      const v8 = v8DynamicSpecs(src);
      let o: string[] = [];
      try { o = findImportSpecifiers(src).map((x) => x.value); } catch (e) { bad.push(`lexer error ${(e as Error).message}: ${src}`); continue; }
      if (v8 === null || JSON.stringify(v8) !== JSON.stringify(o) || v8.length !== n) bad.push(`acorn failed; V8 ${JSON.stringify(v8)} ours ${JSON.stringify(o)}: ${src}`);
      continue;
    }
    if (a.ranges.length !== n) { bad.push(`case expects ${n}, acorn ${a.ranges.length}: ${src}`); continue; }
    let o: string[];
    try { o = ours(src); } catch (e) { bad.push(`lexer error ${(e as Error).message}: ${src}`); continue; }
    if (JSON.stringify(o) !== JSON.stringify(a.ranges)) bad.push(`ours ${JSON.stringify(o)} acorn ${JSON.stringify(a.ranges)}: ${src}`);
  }
  ok(bad.length === 0, bad.join("\n    "));
});

await test("WP-17 import.meta: every READ of import.meta.url becomes the module's real URL and import.meta.resolve is wrapped; an assignment target, import.meta.urlx and a string are left alone; the wrapper decodes a proxied URL back and passes any other through", { "WP-17": "full" }, async () => {
  const src = `const a = import.meta.url; const b = import.meta.urlx; const s = "import.meta.url"; const r = import.meta.resolve("./x.js"); import.meta.url = 1;`;
  const refs = findModuleRefs(src);
  eq(refs.metaUrls.length, 1, "metaUrl reads"); eq(refs.metaResolves.length, 1, "resolve");
  const r = rewriteModuleSource(src, { base: "https://a.test/m/main.js", seg: "SID", metaUrl: "https://a.test/m/main.js" });
  ok(r.code.includes(`const a = "https://a.test/m/main.js";`) && r.code.includes("import.meta.urlx") && r.code.includes(`"import.meta.url"`) && r.code.includes("import.meta.url = 1"), r.code);
  ok(r.code.includes(RESOLVE_WRAP + `("./x.js")`), "resolve wrapped");
  // the wrapper itself, with import.meta.resolve stood in for
  const wrap = new Function("fake", `return ${RESOLVE_WRAP.replace("import.meta.resolve(s)", "fake(s)")};`);
  eq(wrap(() => "https://fusion.test/api/wp/s/SID:doc12345:s/https/a.test:8443/m/q.js?v=1#h")("x"), "https://a.test:8443/m/q.js?v=1#h", "decoded");
  eq(wrap(() => "https://elsewhere.test/q.js")("x"), "https://elsewhere.test/q.js", "passed through");
});

await test("WP-17 specifiers and import maps: root-relative, relative, absolute and protocol-relative http(s) specifiers are proxied with the module-graph segment; bare, data:, blob: and already-proxied ones are not; an import map's URL-like KEYS and every address are proxied the same way (so a rewritten specifier still prefix-matches a rewritten key), bare keys stay, scopes are mapped, \"integrity\" is dropped, malformed JSON is untouched", { "WP-17": "full" }, async () => {
  const base = "https://a.test/m/main.js", seg = "SID:doc12345:s";
  eq(rewriteSpecifier("/r.js", base, seg), "/api/wp/s/SID:doc12345:s/https/a.test/r.js", "root-relative");
  eq(rewriteSpecifier("../u.js", base, seg), "/api/wp/s/SID:doc12345:s/https/a.test/u.js", "parent-relative");
  eq(rewriteSpecifier("https://b.test:444/x.js?q", base, seg), "/api/wp/s/SID:doc12345:s/https/b.test:444/x.js?q", "absolute");
  for (const s of ["lodash", "lib/c.js", "data:text/javascript,1", "blob:https://a.test/u", "/api/wp/s/SID/https/a.test/x.js"]) eq(rewriteSpecifier(s, base, seg), null, s);
  const m = JSON.parse(rewriteImportMap(JSON.stringify({ imports: { "lib/": "/lib/", "/mapped/": "/real/", react: "https://cdn.test/react.js" }, scopes: { "/s/": { x: "./x.js" } }, integrity: { "/r.js": "sha384-x" } }), "https://a.test/page", seg));
  eq(m.imports["lib/"], "/api/wp/s/SID:doc12345:s/https/a.test/lib/", "bare key kept, value proxied");
  eq(m.imports["/api/wp/s/SID:doc12345:s/https/a.test/mapped/"], "/api/wp/s/SID:doc12345:s/https/a.test/real/", "URL-like key proxied");
  eq(m.imports.react, "/api/wp/s/SID:doc12345:s/https/cdn.test/react.js", "absolute value");
  eq(Object.keys(m.scopes), ["/api/wp/s/SID:doc12345:s/https/a.test/s/"], "scope key");
  eq(m.scopes["/api/wp/s/SID:doc12345:s/https/a.test/s/"].x, "/api/wp/s/SID:doc12345:s/https/a.test/x.js", "scope value");
  ok(!("integrity" in m), "integrity dropped");
  eq(rewriteImportMap("{not json", base, seg), "{not json", "malformed untouched");
});

await test("WP-17 / WP-19 HTML wiring: an inline module's specifiers and import.meta.url are rewritten (a classic inline script's dynamic import too, without import.meta), an inline import map is rewritten, a body the HTML parser split at a \"</script>\" inside a string is left unchanged, crossorigin elements / module scripts / modulepreload carry the CORS segment (\":i\" for use-credentials), and an iframe names its parent document (\":f\") while links and forms stay plain navigations", { "WP-17": "full", "WP-19": "full" }, async () => {
  const html = `<html><head><script type="importmap">{"imports":{"/m/":"/real/"}}</script>
<script type="module">import a from "/a.js"; const u = import.meta.url;</script>
<script type="module">import b from "/b.js"; const s = "</script>"; import c from "/c.js";</script>
<script>import("/dyn.js")</script>
<script type="module" src="/main.js"></script><link rel="modulepreload" href="/pre.js"><img crossorigin src="/c.png"><img src="/v.png" crossorigin><img crossorigin="use-credentials" src="/u.png"><img src="/plain.png">
</head><body><iframe src="/frame.html"></iframe><a href="/next">n</a><form action="/post"></form></body></html>`;
  const out = rewriteHtml(html, { sid: "SID", resSid: "SID:doc12345:r", url: "https://a.test/page" }).html;
  const has = (s: string, m: string) => ok(out.includes(s), `${m}: ${s}\n${out}`);
  has(`"/api/wp/s/SID:doc12345:s/https/a.test/m/":"/api/wp/s/SID:doc12345:s/https/a.test/real/"`, "import map");
  has(`import a from "/api/wp/s/SID:doc12345:s/https/a.test/a.js"`, "inline module specifier");
  has(`const u = "https://a.test/page"`, "inline module import.meta.url = the document URL");
  // the HTML parser (natively too) ends that second script at the "</script>" inside the string: its body is an
  // unterminated string — the lexer refuses and the body is left exactly as the browser will see it
  has(`import b from "/b.js"; const s = "</script>`, "parser-split body left unchanged");
  has(`import("/api/wp/s/SID:doc12345:s/https/a.test/dyn.js")`, "classic inline dynamic import");
  has(`src="/api/wp/s/SID:doc12345:s/https/a.test/main.js"`, "module script");
  has(`href="/api/wp/s/SID:doc12345:s/https/a.test/pre.js"`, "modulepreload");
  has(`src="/api/wp/s/SID:doc12345:s/https/a.test/c.png"`, "crossorigin anonymous");
  has(`src="/api/wp/s/SID:doc12345:s/https/a.test/v.png"`, "valueless crossorigin after src");
  has(`src="/api/wp/s/SID:doc12345:i/https/a.test/u.png"`, "crossorigin use-credentials");
  has(`src="/api/wp/s/SID:doc12345:r/https/a.test/plain.png"`, "plain image stays no-cors");
  has(`src="/api/wp/s/SID:doc12345:f/https/a.test/frame.html"`, "iframe");
  has(`href="/api/wp/s/SID/https/a.test/next"`, "link"); has(`action="/api/wp/s/SID/https/a.test/post"`, "form");
});

await test("WP-17 root import map: a document with an id gets an import map routing run-time ROOT-RELATIVE module URLs (\"/\" → the site's root through the proxy, \"/api/wp/s/\" → itself so proxied URLs are untouched), injected right after the runtime when the page has none, MERGED into the page's own first map when it has one (one map per document, the page's own \"/\" key wins), using the final <base> origin; documents without an id get none", { "WP-17": "full" }, async () => {
  const opts = { sid: "SID", resSid: "SID:doc12345:r", url: "https://a.test/dir/page", inject: "<script src=\"/wp-shim.js\"></script>" };
  const maps = (h: string) => [...h.matchAll(/<script type="importmap">([^]*?)<\/script>/g)].map((x) => JSON.parse(x[1].replace(/\\u003c/g, "<")));
  const a = rewriteHtml("<html><head><title>t</title></head><body></body></html>", opts).html;
  ok(a.indexOf("/wp-shim.js") < a.indexOf("importmap") && !a.includes("\u0000"), a);
  const ID = { "/api/wp/s/": "/api/wp/s/", "/api/wp/s/SID:doc12345:s/": "/api/wp/s/SID:doc12345:s/", "/api/wp/s/SID:doc12345:i/": "/api/wp/s/SID:doc12345:i/", "/api/wp/s/SID/": "/api/wp/s/SID/" };
  eq(maps(a), [{ imports: { "/": "/api/wp/s/SID:doc12345:s/https/a.test/", ...ID } }], "injected");
  // the trap the identity keys avoid: after the bare prefix, a scheme-shaped session id parses as an ABSOLUTE URL
  eq(new URL("Abc9:doc12345:s/http/a.test/x.js", "http://f.test/api/wp/s/").protocol, "abc9:", "scheme-shaped remainder");
  eq(new URL("http/a.test/x.js", "http://f.test/api/wp/s/Abc9:doc12345:s/").href, "http://f.test/api/wp/s/Abc9:doc12345:s/http/a.test/x.js", "after the full segment: relative");
  const b = rewriteHtml(`<html><head><script type="importmap">{"imports":{"lib/":"/lib/","/":"/mine/"}}</script></head></html>`, opts).html;
  // the page's URL-like keys are proxied AND get root-relative twins; its own "/" key beats ours
  eq(maps(b), [{ imports: { "lib/": "/api/wp/s/SID:doc12345:s/https/a.test/lib/", "/api/wp/s/SID:doc12345:s/https/a.test/": "/api/wp/s/SID:doc12345:s/https/a.test/mine/", "/": "/api/wp/s/SID:doc12345:s/https/a.test/mine/", ...ID } }], "merged, page key wins");
  const c = rewriteHtml(`<html><head><base href="https://cdn.test/x/"></head></html>`, opts).html;
  eq(maps(c)[0].imports["/"], "/api/wp/s/SID:doc12345:s/https/cdn.test/", "final base origin");
  const d = rewriteHtml("<html><head></head></html>", { sid: "SID", url: "https://a.test/", inject: "<i></i>" }).html;
  eq(maps(d).length, 0, "no document id → no map");
});

await test("WP-18 segments: every legal flag combination round-trips through parseSidSegment / flagString / decodeTarget in canonical order; out-of-order, repeated or unknown flags, a flag on \"r\" / \"f\", and a short document id are all rejected", { "WP-18": "full" }, async () => {
  const names: (keyof ChainFlags)[] = ["m", "t", "x", "y", "n"];
  let n = 0;
  const SID = "8hRJWumuyrkyvksevWarYw";
  for (const c of ["i", "s", "o"]) for (let mask = 0; mask < 32; mask++) {
    const f: ChainFlags = {}; let str = c;
    names.forEach((k, j) => { if (mask & (1 << j)) { f[k] = true; str += k; } });
    const p = parseSidSegment(`SID:doc12345:${str}`);
    ok(p && p.doc === "doc12345" && c + flagString(p.flags) === str, `${str}: ${JSON.stringify(p)}`);
    const d = decodeTarget(`/api/wp/s/${SID}:doc12345:${str}/https/a.test/x`);
    ok(c + flagString(d.flags) === str && d.target.href === "https://a.test/x", `decode ${str}`);
    n++;
  }
  for (const bad of ["sxt", "stt", "sz", "rt", "fx", "s m", "S"]) eq(parseSidSegment(`SID:doc12345:${bad}`), null, bad);
  eq(parseSidSegment("SID:short:s"), null, "short doc id");
  eq(parseSidSegment("SID:doc12345:f")?.frame, true, "frame tag");
  console.log(`     ${n} combinations round-trip`);
});

const site = siteOf;
const P0 = (init: string | null, target: string, chain: ChainFlags = {}, cred: "include" | "same-origin" | "omit" = "same-origin", referrerUrl: string | null = null) =>
  policyFor({ initiator: init, target: new URL(target), cred, method: "GET", headers: [], siteOf: site, referrerUrl, chain });

await test("WP-18 redirect chains (Fetch §4.4 / §4.1): A→B→C taints the origin (Origin \"null\") and marks the chain cross-origin and cross-site; A→B→A taints too and keeps the request non-same-origin (no same-origin cookies, origin-only Referer, Sec-Fetch-Site cross-site); A→A stays clean; flags are sticky (never cleared by a later hop); mode same-origin refuses the cross-origin hop", { "WP-18": "full" }, async () => {
  const A = "https://a.test", B = "https://b.other", C = "https://c.third";
  const p1 = P0(A, `${B}/r`);
  const h1 = nextChainFlags(p1, new URL(`${B}/r`), new URL(`${C}/e`));
  ok(h1.x && h1.t && h1.y, `A→B→C hop 2: ${JSON.stringify(h1)}`);
  const p2 = P0(A, `${C}/e`, h1, "include");
  ok(p2.corsOrigin === "null" && !p2.sameOrigin && p2.sendCookies && p2.crossSite && p2.secFetchSite === "cross-site", `at C: ${JSON.stringify(p2)}`);
  const h0 = nextChainFlags(P0(A, `${A}/r`), new URL(`${A}/r`), new URL(`${B}/e`));
  // flags describe hops ALREADY taken: A→A leaves nothing; the next hop's own cross-site-ness is its own policy's
  ok(!h0.t && !h0.x && !h0.y, `A→A→B: ${JSON.stringify(h0)}`);
  const back = nextChainFlags(p1, new URL(`${B}/r`), new URL(`${A}/e`));
  const p3 = P0(A, `${A}/e`, back, "same-origin", `${A}/page?q=1`);
  ok(back.t && back.x && p3.corsOrigin === "null" && !p3.sameOrigin && !p3.sendCookies && p3.secFetchSite === "cross-site" && p3.referer === `${A}/`, `A→B→A: ${JSON.stringify({ back, p3 })}`);
  const clean = P0(A, `${A}/e`, {}, "same-origin", `${A}/page?q=1`);
  ok(clean.sameOrigin && clean.sendCookies && clean.referer === `${A}/page?q=1` && clean.secFetchSite === "same-origin" && clean.corsOrigin === A, `clean: ${JSON.stringify(clean)}`);
  const sticky = nextChainFlags(P0(A, `${A}/e`, { t: true, x: true }), new URL(`${A}/e`), new URL(`${A}/f`));
  ok(sticky.t && sticky.x, "sticky");
  const so = P0(A, `${B}/x`, { m: true });
  ok(!!so.refused, `mode same-origin: ${JSON.stringify(so.refused)}`);
  ok(P0(A, `${A}/x`, { n: true }, "same-origin", `${A}/p`).referer === null, "n → no Referer");
});

await test("WP-19 frame tree: a document registered with cross-site ancestors (xs) keeps that through the LRU; its subresources and script requests are cross-site for SameSite even to its OWN origin, while Sec-Fetch-Site and Origin still follow the document's origin; documentCsp drops frame-ancestors only for a validated nested frame", { "WP-19": "full" }, async () => {
  const s = { sid: "S", docs: undefined } as unknown as Parameters<typeof newDoc>[0];
  const top = newDoc(s, "https://a.test", "https://a.test/page"), fr = newDoc(s, "https://b.other", "https://b.other/frame", true);
  eq(docInfo(s, top)?.xs, false, "top"); eq(docInfo(s, fr)?.xs, true, "frame");
  const rp = resourcePolicy({ initiator: "https://b.other", target: new URL("https://b.other/img"), siteOf: site, referrerUrl: "https://b.other/frame", ancestorsCrossSite: true });
  ok(rp.crossSite && rp.secFetchSite === "same-origin", `subresource: ${JSON.stringify(rp)}`);
  const pol = policyFor({ initiator: "https://b.other", target: new URL("https://b.other/api"), cred: "same-origin", method: "GET", headers: [], siteOf: site, ancestorsCrossSite: true });
  ok(pol.crossSite && pol.sameOrigin && pol.sendCookies && pol.secFetchSite === "same-origin", `fetch: ${JSON.stringify(pol)}`);
  ok(!policyFor({ initiator: "https://b.other", target: new URL("https://b.other/api"), cred: "same-origin", method: "GET", headers: [], siteOf: site }).crossSite, "without xs: same-site");
  ok(/frame-ancestors/.test(documentCsp(["https://f.test"])) && !/frame-ancestors/.test(documentCsp(["https://f.test"], { nestedFrame: true })), "csp");
  ok(/sandbox allow-scripts/.test(documentCsp(["https://f.test"], { nestedFrame: true })), "nested frame stays sandboxed");
});

await finish();
process.exit(0);
