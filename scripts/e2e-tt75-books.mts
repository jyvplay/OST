/**
 * TT75 real-browser suite for Books (FF-10): Playwright + headless Chromium 143 against the production server. Books
 * are zipped on the fly from the IDPF epub3-samples and W3C epub-tests corpora (cloned under /home/user/tools, not
 * in git), uploaded to the VFS and opened with ?open=books&path=…; every check reads the live frame DOM.
 *  B1 reflowable pages: CSS columns give > 1 page, Next / ArrowRight move by one page width, the end of a part goes
 *     to the next part, the position is restored when the book is reopened
 *  B2 contents: clicking an entry shows that spine item; B3 search: a hit opens its part with a visible <mark>
 *  B4 safety: no script runs (a book script that would set a flag does not), the frame has no allow-scripts, CSP meta
 *     is present; an external link asks first and Cancel opens nothing
 *  B5 right-to-left progression: ArrowLeft advances
 *  B6 fixed layout: viewport 900×600 scaled to fit; synthetic spread puts page-spread-left on the left; spread none
 *     shows one page
 *  B7 -epub-writing-mode reaches the computed style; B8 an obfuscated font loads, the wrong-key one does not
 *  B9 theme + font size reach the frame; B10 manifest images load under the CSP, an unlisted image does not
 *  B11 a malformed chapter shows an error, not a guess; B12 roll layout stacks the parts in one scroller
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt75-books.mts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type Browser, type Frame, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { writeZip } from "../src/lib/office/zipkit.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t75b${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt75-books");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const W3C = "/home/user/tools/corpus/epub/epub-tests/tests", IDPF = "/home/user/tools/corpus/epub/epub3-samples/30";
const COV = { "FF-10": "full" } as const;
const SAFE = { ...COV, "FF-61": "full" } as const;
const LAYOUT = { ...COV, "FF-60": "full" } as const;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timed out: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
type F = { name: string; data: Uint8Array | string; store?: boolean };
async function zipDir(dir: string): Promise<Uint8Array> {
  const files: F[] = walk(dir).map((p) => relative(dir, p)).filter((n) => n !== "mimetype").sort().map((n) => ({ name: n, data: new Uint8Array(readFileSync(join(dir, n))) }));
  return writeZip([{ name: "mimetype", data: "application/epub+zip", store: true }, ...files]);
}
async function uploadBook(name: string, bytes: Uint8Array): Promise<string> {
  const path = `/Documents/${RUN}/${name}.epub`;
  const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/epub+zip" }); ok(r.status < 300, `upload ${r.status}`);
  return path;
}
const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openBook(path: string, viewport = { width: 1600, height: 1000 }, page0?: Page): Promise<Page> {
  // every other open tab (earlier tests) is closed and the reused one leaves first: an open tab's autosave could
  // otherwise write its windows back after the reset below
  for (const c of browser.contexts()) if (c !== page0?.context()) await c.close();
  if (page0) { await page0.goto("about:blank"); await new Promise((r) => setTimeout(r, 300)); }
  await putDesktop();
  const page = page0 ?? await (async () => { const ctx = await browser.newContext({ viewport }); ctx.setDefaultTimeout(20_000); const p = await ctx.newPage(); p.on("pageerror", (e) => errors.push(e.message)); return p; })();
  await page.goto(`${BASE}/?open=books&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("books-app").first().waitFor({ timeout: 25_000 });
  return page;
}
async function frameOf(page: Page, n = 0): Promise<Frame> {
  let fr: Frame | null = null;
  await poll(async () => { const el = page.getByTestId("books-frame").nth(n); fr = await (await el.elementHandle())?.contentFrame() ?? null; return !!fr && (await fr.evaluate(() => document.readyState === "complete" && !!document.documentElement)); }, "frame loaded", 25_000);
  await page.waitForTimeout(400);
  return fr!;
}
const progress = (page: Page) => page.getByTestId("books-progress").innerText();

await test("B1 reflowable pages: columns paginate, Next / ArrowRight move one page width, the end of a part goes on, the position is restored on reopen", COV, async () => {
  const path = await uploadBook("moby", await zipDir(join(IDPF, "moby-dick")));
  const page = await openBook(path);
  await poll(async () => /part \d+ of \d+ · page/.test(await progress(page)), "paginated progress");
  // find a long part: step forward until a part has > 2 pages
  let fr = await frameOf(page); let pages = 1;
  for (let k = 0; k < 12; k++) { pages = Number(/page \d+ of (\d+)/.exec(await progress(page))?.[1] ?? 1); if (pages > 2) break; await page.getByTestId("books-next").click(); await page.waitForTimeout(500); fr = await frameOf(page); }
  ok(pages > 2, `no long part (${await progress(page)})`);
  const w = await fr.evaluate(() => innerWidth); const x0 = await fr.evaluate(() => document.scrollingElement!.scrollLeft);
  await page.getByTestId("books-next").click(); await page.waitForTimeout(200);
  const x1 = await fr.evaluate(() => document.scrollingElement!.scrollLeft);
  ok(Math.abs(x1 - x0 - w) <= 2, `Next moved ${x1 - x0}, page width ${w}`);
  await page.getByTestId("books-stage").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.getByTestId("books-app").focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(200);
  const x2 = await fr.evaluate(() => document.scrollingElement!.scrollLeft);
  ok(Math.abs(x2 - x1 - w) <= 2, `ArrowRight moved ${x2 - x1}`);
  const before = await progress(page);
  const partBefore = Number(/part (\d+)/.exec(before)![1]);
  for (let k = 0; k < pages + 2; k++) { await page.getByTestId("books-next").click(); await page.waitForTimeout(120); }
  await poll(async () => Number(/part (\d+)/.exec(await progress(page))![1]) > partBefore, "next part after the last page");
  await page.waitForTimeout(600); const where = await progress(page);
  const page2 = await openBook(path, undefined, page);
  await poll(async () => (await progress(page2)).split(" · page")[0] === where.split(" · page")[0], `restored ${where}`);
});

await test("B2 contents: clicking an entry shows that part", COV, async () => {
  const page = await openBook(await uploadBook("moby2", await zipDir(join(IDPF, "moby-dick"))));
  await page.getByTestId("books-toc").click(); const items = page.getByTestId("books-toc-item"); await items.nth(10).waitFor();
  const label = await items.nth(10).innerText(); await items.nth(10).click();
  await poll(async () => (await progress(page)).startsWith(label.trim()), `progress shows ${label}`);
});

await test("B3 search: hits are listed; a hit opens its part with a visible <mark>", COV, async () => {
  const page = await openBook(await uploadBook("moby3", await zipDir(join(IDPF, "moby-dick"))));
  await page.getByTestId("books-search").click(); await page.getByTestId("books-find").fill("Ishmael"); await page.keyboard.press("Enter");
  await poll(async () => /\d+ match/.test(await page.getByTestId("books-hits").innerText()), "hits");
  await page.getByTestId("books-hit").first().click();
  await poll(async () => { const fr = await frameOf(page); return fr.evaluate(() => { const m = document.querySelector("mark.fusion-hit"); if (!m) return false; const r = m.getBoundingClientRect(); return /ishmael/i.test(m.textContent ?? "") && r.left >= 0 && r.right <= innerWidth + 1; }); }, "visible mark");
});

const EVIL = async () => writeZip([
  { name: "mimetype", data: "application/epub+zip", store: true },
  { name: "META-INF/container.xml", data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="p.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
  { name: "p.opf", data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="u">evil-${RUN}</dc:identifier><dc:title>Evil</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml" properties="scripted"/><item id="n" href="n.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c"/></spine></package>` },
  { name: "n.xhtml", data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>n</title></head><body><nav epub:type="toc"><ol><li><a href="c.xhtml">C</a></li></ol></nav></body></html>` },
  { name: "c.xhtml", data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title><script>parent.__pwned = 1; window.__pwned = 1;</script></head><body onload="parent.__pwned2 = 1"><p id="p">Evil book</p><img src="x" onerror="parent.__pwned3 = 1"/><a id="ext" href="https://example.org/">outside</a></body></html>` },
]);
await test("B4 safety: book scripts and handlers never run, no allow-scripts, CSP meta present; an external link asks first and Cancel opens nothing", SAFE, async () => {
  const page = await openBook(await uploadBook("evil", await EVIL()));
  const fr = await frameOf(page);
  const sb = await page.getByTestId("books-frame").first().getAttribute("sandbox"); ok(sb === "allow-same-origin", `sandbox ${sb}`);
  ok(await fr.evaluate(() => !document.querySelector("script") && !!document.querySelector('meta[http-equiv="Content-Security-Policy"]') && document.getElementById("p")?.textContent === "Evil book"), "frame content");
  ok(await page.evaluate(() => !(window as unknown as Record<string, unknown>).__pwned && !(window as unknown as Record<string, unknown>).__pwned2 && !(window as unknown as Record<string, unknown>).__pwned3), "a book script ran");
  ok(await fr.evaluate(() => { const a = document.getElementById("ext")!; return a.getAttribute("href") === "#" && a.getAttribute("data-epub-ext") === "https://example.org/"; }), "the live href must not point outside");
  const windows = () => page.locator("[role=dialog]:not([data-testid=ask-dialog])").count();
  const windowsBefore = await windows();
  const ask = page.getByTestId("ask-dialog");
  // (1) the question opens on the safe answer: Enter right away is Cancel, not consent (modal shortcut safety)
  await fr.locator("#ext").click(); await ask.waitFor(); ok(/example\.org/.test(await ask.innerText()), "consent text");
  ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "ask-cancel"), "focus is not on Cancel");
  await page.keyboard.press("Enter"); await ask.waitFor({ state: "detached" }); await page.waitForTimeout(400);
  ok((await windows()) === windowsBefore, "Enter on the fresh question opened a window");
  // (2) Escape cancels
  await fr.locator("#ext").click(); await ask.waitFor(); await page.keyboard.press("Escape"); await ask.waitFor({ state: "detached" }); await page.waitForTimeout(400);
  ok((await windows()) === windowsBefore, "a window opened after Escape");
  // (3) Cancel button
  await fr.locator("#ext").click(); await ask.waitFor(); await page.getByTestId("ask-cancel").click(); await page.waitForTimeout(400);
  ok((await windows()) === windowsBefore, "a window opened after Cancel");
  ok(fr.url().startsWith("blob:"), `the frame navigated: ${fr.url()}`);
  // (4) only an explicit OK opens it — in the Browser app (through its proxy), never inside the book frame
  await fr.locator("#ext").click(); await ask.waitFor(); await page.getByTestId("ask-ok").click();
  await poll(async () => (await windows()) === windowsBefore + 1, "the Browser window after OK");
  const labels = await page.locator("[role=dialog]:not([data-testid=ask-dialog])").evaluateAll((e) => e.map((x) => x.getAttribute("aria-label")));
  ok(labels.some((l) => /browser/i.test(l ?? "")), `new window is not the Browser: ${JSON.stringify(labels)}`);
});

await test("B5 right-to-left page progression: ArrowLeft advances, ArrowRight goes back", COV, async () => {
  const page = await openBook(await uploadBook("rtl", await zipDir(join(W3C, "pkg-spine-progression_rtl"))));
  await frameOf(page); const p0 = await progress(page);
  await page.getByTestId("books-app").focus();
  for (let k = 0; k < 6; k++) { await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(250); }
  const p1 = await progress(page); ok(p1 !== p0, `ArrowLeft did not advance (${p0})`);
  for (let k = 0; k < 6; k++) { await page.keyboard.press("ArrowRight"); await page.waitForTimeout(250); }
  ok((await progress(page)) === p0, `ArrowRight did not go back (${await progress(page)})`);
});

await test("B6 fixed layout: the 900×600 viewport is scaled to fit; a spread puts page-spread-left on the left; spread none shows one page", LAYOUT, async () => {
  const page = await openBook(await uploadBook("icb", await zipDir(join(W3C, "lay-fxl-xhtml-icb"))));
  await frameOf(page);
  const box = await page.getByTestId("books-frame").first().evaluate((el) => ({ w: (el as HTMLIFrameElement).style.width, t: (el as HTMLIFrameElement).style.transform }));
  ok(box.w === "900px" && /scale\(/.test(box.t), JSON.stringify(box));
  const p2 = await openBook(await uploadBook("spread", await zipDir(join(W3C, "lay-fxl-page-spread-left"))), undefined, page);
  // the first page stands alone (spreadGroups); the next view pairs page 2 (page-spread-left) with page 3
  await frameOf(p2); ok((await p2.getByTestId("books-frame").count()) === 1, "the first page is not alone");
  await p2.getByTestId("books-next").click();
  await poll(async () => (await p2.getByTestId("books-frame").count()) === 2, "two pages in the spread");
  const xs = await p2.getByTestId("books-frame").evaluateAll((els) => els.map((e) => ({ x: e.getBoundingClientRect().left, spine: Number((e as HTMLElement).dataset.spine) })));
  ok(xs[0].x < xs[1].x && xs[0].spine < xs[1].spine, JSON.stringify(xs));
  const p3 = await openBook(await uploadBook("none", await zipDir(join(W3C, "lay-fxl-spread-none"))), undefined, page);
  await frameOf(p3); await p3.waitForTimeout(500); ok((await p3.getByTestId("books-frame").count()) === 1, "spread none shows one page");
});

await test("B7 -epub-writing-mode reaches the computed style", COV, async () => {
  const page = await openBook(await uploadBook("wm", await zipDir(join(W3C, "css-epub-writing-mode"))));
  await frameOf(page); await page.getByTestId("books-next").click(); // part 2: <body style="-epub-writing-mode: vertical-rl">
  await poll(async () => /part 2 of/.test(await progress(page)), "part 2");
  const fr = await frameOf(page);
  const wm = await fr.evaluate(() => ({ body: getComputedStyle(document.body).writingMode, style: document.body.getAttribute("style") }));
  ok(wm.body === "vertical-rl" && /(^|;)\s*writing-mode:\s*vertical-rl/.test(wm.style ?? ""), JSON.stringify(wm));
});

await test("B8 an obfuscated font loads after de-obfuscation; the wrong-key variant does not", COV, async () => {
  const st = async (name: string) => { const page = await openBook(await uploadBook(name, await zipDir(join(W3C, name)))); const fr = await frameOf(page); await fr.evaluate(() => document.fonts.ready); await page.waitForTimeout(800); return fr.evaluate(() => [...document.fonts].map((f) => f.status)); };
  const good = await st("ocf-font_obfuscation"); ok(good.includes("loaded"), JSON.stringify(good));
  const bad = await st("ocf-font_obfuscation_bis"); ok(!bad.includes("loaded"), JSON.stringify(bad));
});

await test("B9 Dark theme and a larger font reach the frame", COV, async () => {
  const page = await openBook(await uploadBook("theme", await zipDir(join(IDPF, "moby-dick"))));
  let fr = await frameOf(page); const fs0 = await fr.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  await page.getByTestId("books-theme").selectOption("dark"); await page.getByTestId("books-font-up").click(); await page.getByTestId("books-font-up").click();
  await page.waitForTimeout(800); fr = await frameOf(page);
  const s = await fr.evaluate(() => ({ bg: getComputedStyle(document.documentElement).backgroundColor, fs: parseFloat(getComputedStyle(document.documentElement).fontSize) }));
  ok(s.bg === "rgb(23, 25, 30)" && s.fs > fs0 * 1.15, JSON.stringify({ ...s, fs0 }));
  await page.getByTestId("books-theme").selectOption("light"); await page.getByTestId("books-font-down").click(); await page.getByTestId("books-font-down").click();
});

await test("B10 manifest images decode under the frame CSP; an image missing from the manifest is not shown", COV, async () => {
  const page = await openBook(await uploadBook("png", await zipDir(join(W3C, "pub-cmt-png"))));
  const fr = await frameOf(page); await poll(() => fr.evaluate(() => [...document.images].some((i) => i.complete && i.naturalWidth > 0)), "png decoded");
  const p2 = await openBook(await uploadBook("unlisted", await zipDir(join(W3C, "pkg-manifest-unlisted-resource"))), undefined, page);
  const f2 = await frameOf(p2); await p2.waitForTimeout(600);
  ok(await f2.evaluate(() => [...document.images].every((i) => !i.getAttribute("src") || i.naturalWidth === 0)), "unlisted image shown");
});

await test("B11 a malformed chapter shows an error message instead of guessed content", COV, async () => {
  const page = await openBook(await uploadBook("unclosed", await zipDir(join(W3C, "pub-xml-non-validating_unclosed"))));
  await poll(async () => (await page.getByTestId("books-error-part").count()) > 0, "error shown");
  ok(/not well-formed/.test(await page.getByTestId("books-error-part").first().innerText()), "message");
});

await test("B12 roll layout: all parts are stacked in one vertical scroller", LAYOUT, async () => {
  // the W3C lay-roll-* books are 27–30 MB (over the VFS store limit), so a small roll book is built here
  const part = (i: number, h: number) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>p${i}</title></head><body><div id="d" style="height:${h}px;background:hsl(${i * 90},60%,70%)">Part ${i}</div></body></html>`;
  const roll = writeZip([
    { name: "mimetype", data: "application/epub+zip", store: true },
    { name: "META-INF/container.xml", data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="p.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { name: "p.opf", data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="u">roll-${RUN}</dc:identifier><dc:title>Roll</dc:title><dc:language>en</dc:language><meta property="rendition:layout">roll</meta></metadata><manifest><item id="n" href="n.xhtml" media-type="application/xhtml+xml" properties="nav"/>${[1, 2, 3].map((i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${[1, 2, 3].map((i) => `<itemref idref="c${i}"/>`).join("")}</spine></package>` },
    { name: "n.xhtml", data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>n</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">1</a></li></ol></nav></body></html>` },
    ...[1, 2, 3].map((i) => ({ name: `c${i}.xhtml`, data: part(i, 300 + i * 100) })),
  ]);
  const page = await openBook(await uploadBook("roll", await roll));
  await page.getByTestId("books-roll").waitFor();
  await poll(async () => (await page.getByTestId("books-frame").count()) >= 2, "stacked parts");
  await page.waitForTimeout(800);
  // stacked with no gaps, each frame as tall as its document (400 / 500 / 600 px parts)
  const boxes = await page.getByTestId("books-frame").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: r.top, h: r.height }; }));
  ok(boxes.length === 3 && boxes.every((b, i) => i === 0 || Math.abs(b.top - (boxes[i - 1].top + boxes[i - 1].h)) <= 1), JSON.stringify(boxes));
  const zoom = boxes[0].h / 400; ok(zoom > 0.5 && boxes.every((b, i) => Math.abs(b.h - (400 + i * 100) * zoom) <= 3), `heights ${JSON.stringify(boxes)}`);
});

await test("B14 Shell: a file opened after a reload loads even when a restored window holds the same id (w1_books) — it was focused instead and the file never loaded", COV, async () => {
  const p1 = await uploadBook("first", await zipDir(join(W3C, "pkg-title-order"))), p2 = await uploadBook("second", await zipDir(join(IDPF, "moby-dick")));
  const page = await openBook(p1);
  await poll(async () => (await page.getByTestId("books-title").first().innerText()).length > 0, "first title");
  const t1 = await page.getByTestId("books-title").first().innerText();
  await page.waitForTimeout(2500); // let the desktop autosave the open Books window (restored on the next load)
  await page.goto(`${BASE}/?open=books&path=${encodeURIComponent(p2)}`, { waitUntil: "domcontentloaded" });
  await poll(async () => (await page.getByTestId("books-app").count()) === 2, "restored + new Books window");
  await poll(async () => (await page.getByTestId("books-title").allInnerTexts()).some((x) => /moby/i.test(x)), "the new file loaded");
  ok((await page.getByTestId("books-title").allInnerTexts()).includes(t1), "the restored window kept its book");
});

await test("B15 an in-book link (data-epub-href) opens its target part through the frame listener; the frame itself never navigates", COV, async () => {
  const page = await openBook(await uploadBook("links", await zipDir(join(W3C, "pkg-spine-nonlinear-activation"))));
  let fr = await frameOf(page); const before = await progress(page); const url0 = fr.url();
  const a = fr.locator("a[data-epub-href]").first(); await a.waitFor();
  const target = await a.getAttribute("data-epub-href");
  await a.click();
  await poll(async () => (await progress(page)) !== before, `link to ${target}`);
  fr = await frameOf(page); ok(fr.url() !== url0 && fr.url().startsWith("blob:"), fr.url());
});

await test("B16 visual: reflowable page and a fixed-layout spread render (screenshots for inspection)", COV, async () => {
  const page = await openBook(await uploadBook("vis", await zipDir(join(IDPF, "moby-dick"))));
  await frameOf(page); for (let k = 0; k < 4; k++) { await page.getByTestId("books-next").click(); await page.waitForTimeout(300); }
  await page.waitForTimeout(800); await page.screenshot({ path: "docs/screens/tt75-books-reflow.png" });
  const p2 = await openBook(await uploadBook("vis2", await zipDir(join(W3C, "lay-fxl-page-spread-left"))), undefined, page);
  await frameOf(p2); await p2.getByTestId("books-next").click(); await p2.waitForTimeout(1500); await p2.screenshot({ path: "docs/screens/tt75-books-spread.png" });
  ok((await p2.getByTestId("books-frame").count()) === 2, "spread");
});

await test("B13 no page errors were thrown by the app during the suite", COV, async () => { ok(!errors.length, errors.slice(0, 5).join("\n")); });
await browser.close();
await api("POST", "/api/fs", { op: "delete", path: `/Documents/${RUN}` }).catch(() => {});
finish();
