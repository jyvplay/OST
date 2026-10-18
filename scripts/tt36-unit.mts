/**
 * Suite "tt36-unit" (TT36), without a browser:
 *   - reader view (src/lib/reader-core.ts) against an INDEPENDENT oracle — readability-lxml (Apache-2.0, a Python port
 *     of Arc90 / Mozilla Readability, test-only) on live pages: same article boundaries and recall ≥ 0.95 (the reader
 *     never loses what Readability calls the article); precision is printed (the two legitimately differ on
 *     link-dense lists inside READMEs)
 *   - reader safety: adversarial markup, then the output re-parsed by Python's html.parser — only allow-listed tags
 *     and attributes may survive, and every URL must go through the caller's mapper
 *   - chrome pruning / scoring / metadata on a fixture; the reader page and its CSP
 *   - Plus Codes code lengths against Google's reference implementation (openlocationcode, Apache-2.0, test-only):
 *     identical codes or identical refusals for lengths −1…20 at 300 random points
 *   - profile names and session normalisation
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt36-unit.mts
 */
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { readable, readerDocument, parseHtml } from "../src/lib/reader-core.ts";
import { readerCsp, documentCsp } from "../src/lib/wp-core.ts";
import * as PC from "../src/lib/pluscode.ts";
import { normalizeSession, safeProfileName } from "../src/lib/browserSession.ts";

const { test, finish } = makeHarness("tt36-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const map = (abs: string, kind: "link" | "image") => (kind === "image" ? `/IMG/${abs}` : `/LINK/${abs}`);

/* ============================================================ oracle agreement */
await test("reader vs Readability (PR-07k): on live pages from github.com and pypi.org the reader keeps everything readability-lxml calls the article (recall ≥ 0.95) and agrees on where the article starts and ends; pages a site answers with a bot challenge are skipped and named, at least 5 must be measured", { "PR-07k": "full" }, () => {
  const pages = ["https://github.com/nodejs/node", "https://github.com/expressjs/express/blob/master/Readme.md", "https://github.com/nodejs/node/blob/main/CONTRIBUTING.md", "https://pypi.org/help/", "https://pypi.org/security/", "https://pypi.org/stats/", "https://pypi.org/"];
  let measured = 0;
  for (const u of pages) {
    const html = execFileSync("curl", ["-sL", "-m", "20", "-A", "Mozilla/5.0", u], { maxBuffer: 1 << 26 }).toString();
    if (/<title>Client Challenge/i.test(html) || html.length < 500) { console.log(`     ${u}: skipped (site answered with a bot challenge / nothing)`); continue; }
    const ours = readable(html, u, map);
    const or = JSON.parse(execFileSync(PY, ["scripts/oracle/readability_oracle.py", u], { input: html, maxBuffer: 1 << 26 }).toString()) as { text: string };
    const a = words(ours.text), b = words(or.text);
    const pool = new Map<string, number>(); for (const w of a) pool.set(w, (pool.get(w) ?? 0) + 1);
    let hit = 0; for (const w of b) { const c = pool.get(w) ?? 0; if (c) { hit++; pool.set(w, c - 1); } }
    const recall = hit / (b.length || 1), precision = hit / (a.length || 1);
    // start: Readability's first 6 words, in order, in our text. End: its last word among our last 5, and its last 3
    // words all in our final quarter — not "in order", because Readability drops link-dense lists (a README's
    // contributor lists), so its final words can straddle a cut of any length
    const head = b.slice(0, 6).join(" "), joined = a.join(" "), lastQuarter = new Set(a.slice(Math.floor(a.length * 0.75)));
    const sameStart = joined.includes(head), sameEnd = a.slice(-5).includes(b[b.length - 1]) && b.slice(-3).every((w) => lastQuarter.has(w));
    console.log(`     ${u}: ours ${a.length} words, Readability ${b.length}; recall ${recall.toFixed(2)}, precision ${precision.toFixed(2)}; start ${sameStart ? "same" : "DIFFERENT"}, end ${sameEnd ? "same" : "DIFFERENT"}`);
    ok(recall >= 0.95, `${u}: recall ${recall.toFixed(3)}`);
    ok(sameStart && sameEnd, `${u}: article boundaries differ`);
    measured++;
  }
  ok(measured >= 5, `only ${measured} pages could be measured`);
});

/* ============================================================ safety */
await test("reader safety (PR-07k): adversarial markup — script / style / svg / iframe / template / noscript bodies (any case, '</script >', a fake end tag inside a string), event handlers, javascript: / data: / vbscript: links, style attributes, forms, tracking pixels — re-parsed by Python's html.parser: only allow-listed tags and attributes survive and every href / src went through the mapper", { "PR-07k": "full" }, () => {
  const evil = `<html><head><title>T</title><style>body{x:1}</style></head><body><article class="post-content">
    <p onclick="alert(1)" style="color:red" class="x">First paragraph with enough text to count, as articles do, with commas, and more.</p>
    <SCRIPT>document.write("<p>INJECTED-1</p>")</SCRIPT ><script type="text/plain">var s = "</div><p>INJECTED-2</p>";</script >
    <svg><script>INJECTED-3</script><text>INJECTED-4</text></svg><iframe src="https://evil.example/">INJECTED-5</iframe>
    <template><p>INJECTED-6</p></template><noscript><p>INJECTED-7</p></noscript><style>.a{}</style>
    <p>Links: <a href="javascript:alert(1)">js</a> <a href=" JaVaScRiPt:alert(2)">js2</a> <a href="data:text/html,x">data</a> <a href="vbscript:x">vb</a>
      <a href='/single?q=1&amp;r=2' onmouseover=alert(3)>single</a> <a href=unquoted.html>unq</a> <a href="#frag">frag</a> <a>bare</a></p>
    <p>Images: <img src="https://t.example/p.gif" width="1" height="1"> <img data-src="/lazy.jpg" src="data:image/gif;base64,R0l" alt="lazy &amp; fine">
      <img srcset="/s.jpg 320w, /l.jpg 1200w, /m.jpg 640w" alt="set"> <img src="/plain.png" onerror="alert(4)" alt='a"b'></p>
    <form action="/steal"><input name="pw"><button>INJECTED-8</button></form>
    <table><tr><td colspan="2" style="x" onclick="y">cell</td><td rowspan="x9">c2</td></tr></table>
    <ol start="3" type="a"><li>three</li><li>four</ol>
    <p>Second paragraph that is long enough to be counted as content, with a comma, and another, for the scorer.</p>
  </article></body></html>`;
  const r = readable(evil, "https://site.example/a/b.html", map);
  for (let i = 1; i <= 8; i++) ok(!r.html.includes(`INJECTED-${i}`), `INJECTED-${i} leaked`);
  ok(!/javascript:|vbscript:|data:text|onclick|onmouseover|onerror|style=|<script|<form|<input|<iframe|<svg/i.test(r.html), "dangerous markup survived: " + r.html);
  const parsed = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
from html.parser import HTMLParser
out = []
class P(HTMLParser):
    def handle_starttag(self, t, a): out.append([t, a])
P().feed(sys.stdin.read()); print(json.dumps(out))`], { input: r.html }).toString()) as [string, [string, string | null][]][];
  const ALLOWED_ATTR: Record<string, string[]> = { a: ["href"], img: ["src", "alt", "loading"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], ol: ["start"] };
  const ALLOWED_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s", "sub", "sup", "mark", "small", "br", "hr", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "dl", "dt", "dd", "a", "div", "abbr", "cite", "q", "time", "kbd", "var", "samp", "del", "ins"]);
  for (const [tag, attrs] of parsed) {
    ok(ALLOWED_TAGS.has(tag), `tag <${tag}> survived`);
    for (const [k, v] of attrs) {
      ok((ALLOWED_ATTR[tag] ?? []).includes(k), `attribute ${k} on <${tag}> survived`);
      if (k === "href") ok(v!.startsWith("/LINK/") || v!.startsWith("#"), `unmapped href ${v}`);
      if (k === "src") ok(v!.startsWith("/IMG/"), `unmapped src ${v}`);
    }
  }
  const hrefs = parsed.filter(([t]) => t === "a").map(([, a]) => a.find(([k]) => k === "href")?.[1] ?? null);
  eq(hrefs, [null, null, null, null, "/LINK/https://site.example/single?q=1&r=2", "/LINK/https://site.example/a/unquoted.html", "#frag", null], "links (refused URLs keep their text, lose the link)");
  const srcs = parsed.filter(([t]) => t === "img").map(([, a]) => a.find(([k]) => k === "src")![1]);
  eq(srcs, ["/IMG/https://site.example/lazy.jpg", "/IMG/https://site.example/l.jpg", "/IMG/https://site.example/plain.png"], "images (pixel dropped, lazy + widest srcset chosen)");
  ok(r.html.includes('alt="a&quot;b"') && r.html.includes('alt="lazy &amp; fine"'), "alt text escaped");
  ok(/<td colspan="2">cell<\/td><td>c2<\/td>/.test(r.html), "numeric colspan kept, junk rowspan dropped");
  ok(r.html.includes('<ol start="3"><li>three</li><li>four</li></ol>'), "implied </li> and ol start");
  eq([r.images, r.links], [3, 2]);
});

await test("chrome pruning, scoring and metadata (PR-07k): navigation, header, a link-heavy sidebar, a cookie banner, a share bar, comments and hidden blocks are dropped while the article (and its own lists and code) stays; og:title, author, site name, language, direction; a repeated <h1> is not shown twice; reading time; the reader page escapes the title and carries no script but the runtime; reader CSP forbids inline script, forms and same-origin", { "PR-07k": "full" }, () => {
  const para = (n: number) => `<p>Paragraph ${n} of the story explains things at length, with commas, clauses, and detail, so that it reads like real prose rather than a menu item or a caption.</p>`;
  const page = `<!doctype html><html lang="pt-BR" dir="ltr"><head><title>Ignored — Site</title><meta property="og:title" content="The &quot;Real&quot; Title"><meta name="author" content="Ana Lima"><meta property="og:site_name" content="Daily Example"></head>
  <body><header class="masthead">MASTHEAD-TEXT <a href="/">Home</a></header><nav>NAV-TEXT <a href="/a">A</a><a href="/b">B</a></nav>
  <div id="cookie-banner">COOKIE-TEXT we use cookies, accept them all please, thank you very much for understanding.</div>
  <div class="layout"><aside class="sidebar">${Array.from({ length: 30 }, (_, i) => `<a href="/s${i}">SIDEBAR-LINK-${i} with a long enough label</a>`).join(" ")}</aside>
  <main><article class="story-body"><h1>The "Real" Title</h1>${para(1)}${para(2)}<ul><li>OWN-LIST item one</li><li>item two</li></ul><pre><code>OWN-CODE()</code></pre>${para(3)}${para(4)}
  <div class="share-bar">SHARE-TEXT <a href="/tw">Tweet</a></div><div hidden>HIDDEN-TEXT</div><div style="display:none">HIDDEN-2</div><p aria-hidden="true">HIDDEN-3</p></article>
  <section id="comments">${Array.from({ length: 5 }, (_, i) => `<p>COMMENT-${i}: I think so too, really, and here is my long comment about it, with commas.</p>`).join("")}</section></main></div>
  <footer>FOOTER-TEXT</footer></body></html>`;
  const r = readable(page, "https://news.example/2026/10/story", map);
  for (const bad of ["MASTHEAD", "NAV-TEXT", "COOKIE-TEXT", "SIDEBAR-LINK", "SHARE-TEXT", "HIDDEN-TEXT", "HIDDEN-2", "HIDDEN-3", "COMMENT-", "FOOTER-TEXT"]) ok(!r.text.includes(bad), `${bad} kept`);
  for (const good of ["Paragraph 1", "Paragraph 4", "OWN-LIST", "OWN-CODE()"]) ok(r.text.includes(good), `${good} lost`);
  eq([r.title, r.byline, r.site, r.lang, r.dir], ['The "Real" Title', "Ana Lima", "Daily Example", "pt-BR", "ltr"]);
  ok(!/<h1>/.test(r.html), "the repeated h1 is shown once (as the page title)");
  eq(r.minutes, Math.max(1, Math.round(r.words / 230)));
  ok(r.words > 100, `${r.words} words`);
  // reader document
  const doc = readerDocument({ ...r, title: `</title><script>alert(1)</script>` }, { target: "https://news.example/x", inject: `<script src="/wp-shim.js" data-fusion-wp="1"></script>`, original: "/api/wp/s/SID/https/news.example/x" });
  eq((doc.match(/<script/gi) ?? []).length, 1, "scripts in the reader page");
  ok(doc.includes("&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "title escaped");
  ok(/data-reader-meta>.*min read/.test(doc) && doc.includes('lang="pt-BR"'), "meta line + language");
  const csp = readerCsp(["http://localhost:3999"]);
  ok(/^sandbox /.test(csp) && !/allow-same-origin/.test(csp) && /script-src 'self' http:\/\/localhost:3999(;|$)/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) && /form-action 'none'/.test(csp), csp);
  ok(documentCsp(["http://x"]).includes("unsafe-inline"), "(ordinary proxied pages keep their inline scripts — the reader does not)");
  // forgiving parser: stray end tags and unclosed elements do not lose text
  const t = parseHtml("<div><p>one<p>two</span></div></div><b>three");
  const texts: string[] = [];
  const collect = (n: unknown) => { if (typeof n === "string") texts.push(n); else for (const k of (n as { kids: unknown[] }).kids) collect(k); };
  collect(t);
  eq(texts.join("|"), "one|two|three");
});

/* ============================================================ Plus Codes */
await test("Plus Codes code lengths (MP-07): identical codes — or identical refusals — to Google's reference implementation (openlocationcode, Apache-2.0) for lengths −1…20 at 300 random points: odd lengths below 10 and lengths below 2 are refused, 10–15 encode, longer is clamped to 15 digits", { "MP-07": "full" }, () => {
  let seed = 36; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pts = Array.from({ length: 300 }, () => [rnd() * 180 - 90, rnd() * 360 - 180]);
  pts.push([90, 180], [-90, -180], [0, 0], [47.36559, 8.524997]);
  const lens = Array.from({ length: 22 }, (_, i) => i - 1);
  const ref = JSON.parse(execFileSync(PY, ["-c", `
import sys, json
from openlocationcode import openlocationcode as olc
pts, lens = json.load(sys.stdin)
out = []
for la, ln in pts:
    row = []
    for n in lens:
        try: row.append(olc.encode(la, ln, n))
        except ValueError: row.append(None)
    out.append(row)
print(json.dumps(out))`], { input: JSON.stringify([pts, lens]), maxBuffer: 1 << 24 }).toString()) as (string | null)[][];
  let same = 0, refusals = 0;
  pts.forEach(([la, ln], i) => lens.forEach((n, j) => {
    let ours: string | null;
    try { ours = PC.encode(la, ln, n); } catch (e) { ok(e instanceof RangeError, "refusal is a RangeError"); ours = null; }
    eq(ours, ref[i][j], `encode(${la}, ${ln}, ${n})`);
    same++; if (ours === null) refusals++;
  }));
  console.log(`     ${same} (point, length) pairs identical to the reference, ${refusals} of them refusals (lengths −1, 0, 1, 3, 5, 7, 9)`);
  eq(refusals, pts.length * 7);
  let threw = false; try { PC.encode(Number.NaN, 0); } catch { threw = true; }
  ok(threw, "NaN refused");
});

/* ============================================================ profiles */
await test("profile names and saved sessions (PR-07o): a named profile survives normalisation of a saved Browser session; unsafe or oversized names are dropped (the tab falls back to 'this tab only')", { "PR-07o": "full" }, () => {
  eq([safeProfileName("Work"), safeProfileName("  Família  2 "), safeProfileName("a_b-c"), safeProfileName(""), safeProfileName("x".repeat(31)), safeProfileName("<img>"), safeProfileName("p:1"), safeProfileName(7)], ["Work", "Família 2", "a_b-c", undefined, undefined, undefined, undefined, undefined]);
  const s = normalizeSession({ tabs: [{ id: "t1", url: "https://pypi.org/", profile: "Work" }, { id: "t2", url: "https://github.com/", profile: "<script>" }, { id: "t3", url: "https://pypi.org/help/" }], active: "t1" });
  eq(s.tabs.map((t) => t.profile ?? ""), ["Work", "", ""]);
});

await finish();
