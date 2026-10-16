/**
 * Real-browser suite "e2e-vector" (TT16): the vector engine against Chromium's own SVG implementation (independent
 * oracle that keeps arcs as true arcs), then the Vector studio driven with real mouse/keyboard over a production server.
 *   1–3  ORACLES (about:blank, no server): getBBox / getTotalLength / isPointInFill / transform.baseVal vs our engine;
 *        render parity: original SVG vs our import→export, rasterised by Chromium, pixel-diffed.
 *   4–   UI flows: tools, selection/transform handles, pen + node editing, keyboard, arrange, import safety, files.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-vector.mts
 */
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { PATHS, TRANSFORMS } from "./svg-corpus.mts";
import { containsPoint, distanceToPath, parsePath, pathBounds, pathLength, parseTransform, type Seg } from "../src/lib/vector/path.ts";
import { exportSvg, importSvg, migrate } from "../src/lib/vector/model.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `vec${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-vector");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const close = (a: number, b: number, tol: number, m: string) => ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b} (tol ${tol})`);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const browser: Browser = await launchChromium();
const errors: string[] = [];

/* ================================================================ oracles */
await test("ORACLE Chromium SVG: getBBox + getTotalLength of the ORIGINAL d vs our normalised cubics (arcs included)", { "FF-32": "full" }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto("about:blank");
  const chrome = await page.evaluate((ds: string[]) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); document.body.appendChild(svg);
    return ds.map((d) => { const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); svg.appendChild(p); const b = p.getBBox(); return { b: [b.x, b.y, b.width, b.height], L: p.getTotalLength() }; });
  }, PATHS.map((p) => p.d));
  let worstB = 0, worstL = 0;
  PATHS.forEach((p, i) => {
    const segs = parsePath(p.d).segs, b = pathBounds(segs)!, L = pathLength(segs);
    const scale = Math.max(1, ...chrome[i].b.map(Math.abs));
    const eb = Math.max(Math.abs(b.x - chrome[i].b[0]), Math.abs(b.y - chrome[i].b[1]), Math.abs(b.w - chrome[i].b[2]), Math.abs(b.h - chrome[i].b[3])) / scale;
    const el = Math.abs(L - chrome[i].L) / Math.max(1, chrome[i].L);
    worstB = Math.max(worstB, eb); worstL = Math.max(worstL, el);
    // Chromium returns float32 geometry and measures length with its own flattening tolerance
    ok(eb <= (p.arc ? 1e-3 : 1e-5), `${p.d}: bbox ours ${[b.x, b.y, b.w, b.h].map((v) => v.toFixed(3))} vs chromium ${chrome[i].b.map((v: number) => v.toFixed(3))}`);
    ok(el <= 2e-3, `${p.d}: length ours ${L} vs chromium ${chrome[i].L}`);
  });
  const rx0 = PATHS.findIndex((p) => p.oracleDeviates);
  close(chrome[rx0].L, Math.SQRT2 * 50, 1e-3, "Chromium arbitration: rx=0 arc is a straight line (svgelements says 0)");
  console.log(`    worst relative error vs Chromium: bbox ${worstB.toExponential(2)}, length ${worstL.toExponential(2)}`);
  await ctx.close();
});

await test("ORACLE Chromium SVG: isPointInFill (nonzero + evenodd) vs our containment on a 31×31 grid per path; transform.baseVal", { "FF-32": "full" }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto("about:blank");
  const shapes = [
    { d: "M0 0h100v100h-100z M25 25h50v50h-50z", rule: "evenodd" as const },
    { d: "M0 0h100v100h-100z M25 25h50v50h-50z", rule: "nonzero" as const },
    { d: "M0 0h100v100h-100z M25 25v50h50v-50z", rule: "nonzero" as const },
    { d: "M50 0 L61 35 L98 35 L68 57 L79 91 L50 70 L21 91 L32 57 L2 35 L39 35 Z", rule: "nonzero" as const },
    { d: "M50 0 L79 91 L2 35 L98 35 L21 91 Z", rule: "evenodd" as const },     // pentagram: centre is a hole under evenodd
    { d: "M50 0 L79 91 L2 35 L98 35 L21 91 Z", rule: "nonzero" as const },
    { d: "M10 50 A40 40 0 1 1 90 50 A40 40 0 1 1 10 50 Z M30 50 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0Z", rule: "nonzero" as const },
    { d: "M0 0 C100 0 0 100 100 100 L0 100 Z", rule: "nonzero" as const },
    { d: "M10 10 Q90 10 90 90 T10 90", rule: "nonzero" as const },          // open subpath: implicitly closed for fill
  ];
  const pts: [number, number][] = []; for (let y = 0; y <= 30; y++) for (let x = 0; x <= 30; x++) pts.push([-2 + x * 3.48, -2 + y * 3.48]);
  const res = await page.evaluate(({ shapes, pts }) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"); document.body.appendChild(svg);
    return shapes.map((s) => { const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", s.d); p.setAttribute("fill-rule", s.rule); svg.appendChild(p);
      return pts.map(([x, y]) => { const q = svg.createSVGPoint(); q.x = x; q.y = y; return p.isPointInFill(q); }); });
  }, { shapes, pts });
  let compared = 0, skipped = 0;
  shapes.forEach((s, i) => {
    const segs = parsePath(s.d).segs;
    pts.forEach(([x, y], k) => {
      if (distanceToPath(segs, x, y) < 0.35) { skipped++; return; }   // on-the-edge points are implementation-defined
      compared++;
      ok(containsPoint(segs, x, y, s.rule) === res[i][k], `${s.d} (${s.rule}) at ${x.toFixed(2)},${y.toFixed(2)}: chromium ${res[i][k]}`);
    });
  });
  const mats = await page.evaluate((ts: string[]) => ts.map((t) => { const g = document.createElementNS("http://www.w3.org/2000/svg", "g"); g.setAttribute("transform", t); const m = g.transform.baseVal.consolidate()!.matrix; return [m.a, m.b, m.c, m.d, m.e, m.f]; }), TRANSFORMS);
  TRANSFORMS.forEach((t, i) => parseTransform(t).forEach((v, k) => close(v, mats[i][k], 1e-4 * Math.max(1, Math.abs(v)), `${t}[${k}]`)));
  console.log(`    ${compared} containment points agree (${skipped} edge points skipped), ${TRANSFORMS.length} transform lists agree`);
  await ctx.close();
});

const FIXTURE = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="240" height="160" viewBox="10 10 240 160">
  <defs>
    <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ff5500"/><stop offset="100%" stop-color="#2255ff"/></linearGradient>
    <radialGradient id="rg"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#00aa44"/></radialGradient>
    <path id="petal" d="M0 0 C10 -20 30 -20 40 0 C30 20 10 20 0 0Z"/>
  </defs>
  <rect x="10" y="10" width="240" height="160" fill="#fdf6e3"/>
  <g transform="translate(30 30) rotate(-12)" style="fill:url(#lg);stroke:#073642;stroke-width:3">
    <rect x="0" y="0" width="90" height="60" rx="12"/>
    <circle cx="130" cy="30" r="26" fill="url(#rg)"/>
  </g>
  <path d="M30 150 a40 25 20 1 1 80 0 l20 -10 q15 -30 30 0 t30 0" fill="none" stroke="#dc322f" stroke-width="4" stroke-linecap="round" stroke-dasharray="10 4"/>
  <use xlink:href="#petal" x="190" y="120" fill="#6c71c4" opacity="0.8"/>
  <use href="#petal" transform="translate(190 120) rotate(90)" fill="#b58900"/>
  <polygon points="200,20 230,60 170,60" fill="#859900" fill-rule="evenodd" stroke="none"/>
  <polyline points="160,80 180,95 200,80 220,95" fill="none" stroke="#268bd2" stroke-width="2"/>
</svg>`;
await test("ORACLE render parity: Chromium rasterises the original SVG and our import→export identically (≤0.5% pixels > 24/255)", { "FF-32": "full" }, async () => {
  const r = importSvg(FIXTURE, "fixture");
  ok(r.dropped.length === 0, `unexpected drops ${r.dropped}`);
  const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto("about:blank");
  const out = await page.evaluate(async ([a, b]) => {
    const raster = async (src: string) => {
      const url = URL.createObjectURL(new Blob([src], { type: "image/svg+xml" })); const img = new Image(); img.src = url; await img.decode();
      const c = document.createElement("canvas"); c.width = 480; c.height = 320; const g = c.getContext("2d")!; g.drawImage(img, 0, 0, 480, 320); return g.getImageData(0, 0, 480, 320).data;
    };
    const A = await raster(a), B = await raster(b);
    let bad = 0, sum = 0, max = 0, opaque = 0;
    for (let i = 0; i < A.length; i += 4) { let d = 0; for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k])); if (d > 24) bad++; sum += d; max = Math.max(max, d); if (A[i + 3] > 0) opaque++; }
    return { bad, mean: sum / (A.length / 4), max, n: A.length / 4, opaque };
  }, [FIXTURE, exportSvg(r.doc)]);
  console.log(`    ${out.n} px: ${out.bad} differ by > 24/255 (${(out.bad / out.n * 100).toFixed(3)}%), mean |Δ| ${out.mean.toFixed(3)}, max ${out.max}; painted px ${out.opaque}`);
  ok(out.opaque > out.n * 0.9, "render came out empty");
  ok(out.bad / out.n <= 0.005, "render parity broken");
  ok(out.mean < 0.5, "mean difference too high");
  await ctx.close();
});

/* ================================================================ UI */
interface Studio { page: Page; root: Locator; svg: Locator; attr: (k: string) => Promise<string | null>; at: (x: number, y: number) => Promise<{ x: number; y: number }>; drag: (a: [number, number], b: [number, number], mods?: string[]) => Promise<void>; click: (x: number, y: number, mods?: string[]) => Promise<void>; tool: (n: string) => Promise<void>; bbox: () => Promise<number[] | null>; d: (sid: string) => Promise<string | null>; key: (k: string) => Promise<void>; close: () => Promise<void> }
async function openStudio(path?: string): Promise<Studio> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`unexpected dialog: ${d.message()}`); void d.dismiss(); });
  await page.goto(`${BASE}/?open=vector${path ? `&path=${encodeURIComponent(path)}` : ""}`, { waitUntil: "domcontentloaded" });
  const root = page.locator('[data-testid="vector-studio"]').first();
  await root.waitFor({ timeout: 25_000 });
  const svg = root.locator('[data-testid="vector-canvas"]');
  const attr = (k: string) => root.getAttribute(`data-${k}`);
  const at = (x: number, y: number) => svg.evaluate((s: SVGSVGElement, [x, y]) => { const p = new DOMPoint(x, y).matrixTransform(s.getScreenCTM()!); return { x: p.x, y: p.y }; }, [x, y]);
  const withMods = async (mods: string[] | undefined, f: () => Promise<void>) => { for (const m of mods ?? []) await page.keyboard.down(m); await f(); for (const m of mods ?? []) await page.keyboard.up(m); };
  const drag = (a: [number, number], b: [number, number], mods?: string[]) => withMods(mods, async () => { const p = await at(...a), q = await at(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 }); await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up(); });
  const click = (x: number, y: number, mods?: string[]) => withMods(mods, async () => { const p = await at(x, y); await page.mouse.click(p.x, p.y); });
  const tool = (n: string) => root.getByRole("button", { name: new RegExp(`^${n} tool`) }).click();
  const bbox = async () => { const l = root.locator('[data-testid="sel-bbox"]'); if (!(await l.count())) return null; return (await l.getAttribute("data-bbox"))!.split(",").map(Number); };
  const d = (sid: string) => root.locator(`[data-sid="${sid}"]`).getAttribute("d");
  const key = (k: string) => page.keyboard.press(k);
  return { page, root, svg, attr, at, drag, click, tool, bbox, d, key, close: () => ctx.close() };
}
const boxIs = (b: number[] | null, e: number[], tol: number, m: string) => { ok(b, `${m}: nothing selected`); e.forEach((v, i) => close(b![i], v, tol, `${m} [${i}]`)); };
const waitMsg = async (s: Studio, re: RegExp) => { for (let i = 0; i < 100; i++) { const t = await s.root.locator('[data-testid="vector-message"]').innerText(); if (re.test(t)) return t; await s.page.waitForTimeout(100); } throw new Error(`message never matched ${re}`); };
const lastSid = async (s: Studio) => (await s.attr("selected"))!.split(",").pop()!;

await test("UI: rect/ellipse/star by drag (shift = square), exact geometry; undo/redo by keyboard", { "FF-32": "full", "FF-25": "full" }, async () => {
  const s = await openStudio();
  try {
    ok((await s.attr("shapes")) === "4", "blank doc has 4 shapes");
    await s.tool("Rect"); await s.drag([500, 300], [620, 380]);
    ok((await s.attr("shapes")) === "5", "rect not added");
    boxIs(await s.bbox(), [500, 300, 120, 80], 1.5, "rect bbox");
    await s.tool("Ellipse"); await s.drag([100, 450], [180, 470], ["Shift"]);
    boxIs(await s.bbox(), [100, 450, 80, 80], 1.5, "shift-ellipse is a circle");
    await s.tool("Star"); await s.drag([700, 120], [700, 60]);
    const b = (await s.bbox())!; close(b[1], 60, 1.5, "star top vertex points up at radius 60"); ok((await s.attr("shapes")) === "7", "star not added");
    await s.key("Control+z"); ok((await s.attr("shapes")) === "6", "undo"); await s.key("Control+z"); ok((await s.attr("shapes")) === "5", "undo 2");
    await s.key("Control+y"); ok((await s.attr("shapes")) === "6", "redo");
  } finally { await s.close(); }
});

await test("UI: select, move by drag, resize from the se handle, rotate 90° with shift-snap, nudge 1/10", { "FF-32": "full" }, async () => {
  const s = await openStudio();
  try {
    await s.click(150, 150);  // gradient rect s1 at 80,80 220×150
    ok((await s.attr("selected")) === "s1", `selected ${await s.attr("selected")}`);
    boxIs(await s.bbox(), [80, 80, 220, 150], 0.01, "initial");
    await s.drag([150, 150], [190, 120]); boxIs(await s.bbox(), [120, 50, 220, 150], 1.5, "moved by (40,-30)");
    const se = await s.root.locator('[data-testid="handle-se"]').boundingBox(); ok(se, "no se handle");
    const target = await s.at(400, 250);
    await s.page.mouse.move(se!.x + se!.width / 2, se!.y + se!.height / 2); await s.page.mouse.down(); await s.page.mouse.move(target.x, target.y, { steps: 8 }); await s.page.mouse.up();
    boxIs(await s.bbox(), [120, 50, 280, 200], 1.5, "resized to 400,250");
    const rot = await s.root.locator('[data-testid="handle-rot"]').boundingBox(); ok(rot, "no rotate handle");
    const c = await s.at(260, 150), right = await s.at(500, 150);
    await s.page.keyboard.down("Shift");
    await s.page.mouse.move(rot!.x + rot!.width / 2, rot!.y + rot!.height / 2); await s.page.mouse.down(); await s.page.mouse.move(c.x + 40, c.y - 40, { steps: 4 }); await s.page.mouse.move(right.x, right.y, { steps: 6 }); await s.page.mouse.up();
    await s.page.keyboard.up("Shift");
    await waitMsg(s, /rotated 90°/);
    const b = (await s.bbox())!; close(b[2], 200, 1.5, "rotated width = old height"); close(b[3], 280, 1.5, "rotated height = old width"); close(b[0] + b[2] / 2, 260, 1.5, "centre kept");
    await s.key("ArrowRight"); await s.key("Shift+ArrowDown");
    const n = (await s.bbox())!; close(n[0], b[0] + 1, 0.01, "nudge 1"); close(n[1], b[1] + 10, 0.01, "nudge 10");
  } finally { await s.close(); }
});

await test("UI: pen — corner clicks + close on first node; drag makes a smooth (cubic) node; node tool drags an anchor", { "FF-32": "full" }, async () => {
  const s = await openStudio();
  try {
    await s.tool("Pen");
    await s.click(450, 300); await s.click(600, 320); await s.click(560, 450); await s.click(450, 300);
    await waitMsg(s, /path with 3 nodes \(closed\)/);
    const sid = await lastSid(s);
    const segs = parsePath((await s.d(sid))!).segs;
    ok(segs.at(-1)!.t === "Z" && segs.filter((q) => q.t === "L").length === 3, `closed polygon path expected, got ${await s.d(sid)}`);
    boxIs(await s.bbox(), [450, 300, 150, 150], 1.5, "pen bbox");
    // smooth node: press at (650,500), drag the handle to (700,500); finish with Enter
    await s.tool("Pen");
    await s.click(600, 520);
    const p = await s.at(650, 560), q = await s.at(700, 560);
    await s.page.mouse.move(p.x, p.y); await s.page.mouse.down(); await s.page.mouse.move(q.x, q.y, { steps: 6 }); await s.page.mouse.up();
    await s.click(760, 520); await s.key("Enter");
    await waitMsg(s, /path with 3 nodes(?! \(closed)/);
    const sid2 = await lastSid(s);
    const segs2 = parsePath((await s.d(sid2))!).segs as Seg[];
    const c1 = segs2[1] as Extract<Seg, { t: "C" }>;
    ok(c1.t === "C", `expected a cubic into the smooth node: ${await s.d(sid2)}`);
    close(c1.x2, 600, 1.5, "mirrored in-handle x = 2·650 − 700"); close(c1.x, 650, 1.5, "anchor x");
    // node tool: drag the middle anchor of the first path down by 40
    await s.tool("Node"); await s.click(520, 340);
    ok((await s.attr("selected")) === sid, `node tool selected ${await s.attr("selected")}`);
    const anchor = s.root.locator('[data-node="1:anchor"]');
    const ab = (await anchor.boundingBox())!; const dst = await s.at(600, 360);
    await s.page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2); await s.page.mouse.down(); await s.page.mouse.move(dst.x, dst.y, { steps: 6 }); await s.page.mouse.up();
    const moved = parsePath((await s.d(sid))!).segs[1] as { x: number; y: number };
    close(moved.x, 600, 1.5, "anchor x"); close(moved.y, 360, 1.5, "anchor y");
  } finally { await s.close(); }
});

await test("UI: marquee + shift-click multi-select, align left, distribute, group/ungroup, duplicate, z-order, delete (keyboard)", { "FF-32": "full" }, async () => {
  const s = await openStudio();
  try {
    await s.drag([60, 60], [530, 280]);                 // fully encloses s1 (80..300) and s2 (340..520 × 90..270)
    ok((await s.attr("selected")) === "s1,s2", `marquee selected ${await s.attr("selected")}`);
    await s.root.getByRole("button", { name: "Align left" }).click();
    const b = (await s.bbox())!; close(b[0], 80, 0.01, "left edge");
    await s.key("Control+g");
    const g = await s.attr("selected"); ok(g && /^g\d+$/.test(g), `group id ${g}`);
    ok((await s.attr("shapes")) === "3", "two shapes became one group");
    await s.key("Control+Shift+g"); ok((await s.attr("shapes")) === "4", "ungroup"); ok((await s.attr("selected"))!.split(",").length === 2, "children selected");
    await s.key("Control+d"); ok((await s.attr("shapes")) === "6", "duplicate 2");
    const dupIds = (await s.attr("selected"))!.split(",");
    await s.key("Control+Shift+["); // to back
    const order = await s.root.locator("[data-sid]").evaluateAll((els) => els.map((e) => e.getAttribute("data-sid")));
    ok(order[0] === dupIds[0] && order[1] === dupIds[1], `to back: ${order}`);
    await s.key("Delete"); ok((await s.attr("shapes")) === "4", "delete");
    await s.key("Control+a"); ok((await s.attr("selected"))!.split(",").length === 4, "select all");
  } finally { await s.close(); }
});

await test("UI: hostile SVG via Files deep link — report lists drops, no script/handler executes, canvas holds only allowlisted markup", { "FF-04": "full", "FF-32": "full" }, async () => {
  const evil = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" onload="window.__pwned=1">
    <script>window.__pwned=2</script><foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="x" onerror="window.__pwned=3"/></foreignObject>
    <rect x="10" y="10" width="100" height="80" fill="#2aa198" onmouseover="window.__pwned=4"/>
    <path d="M150 20 h120 v120 h-120 z M180 50 h60 v60 h-60 z" fill="#d33682" fill-rule="evenodd"/>
    <image href="https://example.invalid/track.png" width="5" height="5"/><a href="javascript:window.__pwned=5"><circle cx="60" cy="160" r="20" fill="#cb4b16"/></a>
  </svg>`;
  const dst = `/Pictures/${RUN}-evil.svg`;
  ok((await api("POST", "/api/fs", { op: "write", path: dst, content: evil, mime: "image/svg+xml" })).status < 300, "fixture write failed");
  const s = await openStudio(dst);
  try {
    await waitMsg(s, /opened/);
    const rep = await s.root.locator('[data-testid="vector-report"]').innerText();
    for (const w of ["script", "foreignObject", "event-handler", "raster <image>", "hyperlinks"]) ok(rep.includes(w), `report lacks ${w}: ${rep}`);
    const html = await s.root.locator('[data-testid="vector-content"]').innerHTML();
    for (const bad of ["<script", "foreignobject", "onload", "onmouseover", "onerror", "javascript", "<image", "example.invalid"]) ok(!html.toLowerCase().includes(bad), `canvas contains ${bad}`);
    const p = await s.at(60, 50); await s.page.mouse.move(p.x, p.y); await s.page.mouse.click(p.x, p.y);
    ok((await s.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)) === undefined, "hostile code executed");
    // engine hit-testing honours fill-rule: the evenodd hole selects nothing, the ring selects the path
    await s.click(210, 80); ok((await s.attr("selected")) === "", `hole selected ${await s.attr("selected")}`);
    await s.click(160, 80); ok((await s.attr("selected")) !== "", "ring not selected");
  } finally { await s.close(); }
});

await test("UI: Save .fsvg → reopen (v2 round trip), Export SVG (re-importable, safe), Export PNG (valid PNG at doc size)", { "FF-32": "full", "FF-25": "full" }, async () => {
  const s = await openStudio();
  try {
    const title = `${RUN}-art`;
    await s.root.getByLabel("Vector document title").fill(title);
    await s.tool("Rect"); await s.drag([600, 400], [700, 500]);
    await s.root.getByLabel("Fill type").selectOption("+");
    await s.root.getByRole("button", { name: "Save .fsvg" }).click(); await waitMsg(s, /saved \/Documents\//);
    await s.root.getByRole("button", { name: "Export SVG" }).click(); await waitMsg(s, /exported \/Pictures\/.*\.svg/);
    await s.root.getByRole("button", { name: "Export PNG" }).click(); await waitMsg(s, /exported \/Pictures\/.*\.png \(800×600\)/);
    const f = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Documents/${title}.fsvg`)}`);
    const saved = migrate(JSON.parse(f.json.node.content));
    ok(saved.shapes.length === 5 && saved.gradients.length === 2, `fsvg content: ${saved.shapes.length} shapes, ${saved.gradients.length} gradients`);
    const svg = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Pictures/${title}.svg`)}`);
    const re = importSvg(svg.json.node.content); ok(re.dropped.length === 0, `export not clean: ${re.dropped}`); ok(re.doc.shapes.length === 6, "background + 5 shapes");
    const png = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Pictures/${title}.png`)}`);
    const bytes = Buffer.from(png.json.node.content, png.json.node.encoding === "base64" ? "base64" : "utf8");
    ok(bytes.subarray(1, 4).toString() === "PNG" && bytes.readUInt32BE(16) === 800 && bytes.readUInt32BE(20) === 600, "PNG header/size");
  } finally { await s.close(); }
  const r = await openStudio(`/Documents/${RUN}-art.fsvg`);
  try { await waitMsg(r, /opened/); ok((await r.attr("shapes")) === "5", `reopened ${await r.attr("shapes")} shapes`); } finally { await r.close(); }
});

await test("UI: arrow (line tool + Arrowhead) exports as plain path; star stays parametric — point count / inner ratio editable after a move", { "FF-32": "full" }, async () => {
  const s = await openStudio();
  try {
    await s.tool("Line"); await s.root.getByLabel("Arrowhead").check(); await s.drag([100, 600], [300, 600]);
    const ar = await lastSid(s); const d = (await s.d(ar)) ?? "";
    ok(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ M/.test(d) && (d.match(/M/g) ?? []).length === 2, `arrow d: ${d}`);
    await s.tool("Star"); await s.drag([700, 300], [700, 240]);
    const st = await lastSid(s);
    await s.key("ArrowRight"); await s.key("Shift+ArrowDown");          // nudge 1 right, 10 down (baked into points)
    const pts = s.root.getByLabel("Selected star points", { exact: true });
    await pts.fill("8");
    const vertices = async () => { const el = s.root.locator(`[data-sid="${st}"]`); const pa = (await el.getAttribute("points")) ?? (await el.getAttribute("d")) ?? ""; return pa.trim().split(/[\s,]+/).filter((x) => /\d/.test(x)).length / 2; };
    for (let i = 0; i < 30 && (await vertices()) !== 16; i++) await s.page.waitForTimeout(100);
    ok((await vertices()) === 16, `8-point star has 16 vertices, got ${await vertices()}`);
    const b = (await s.bbox())!; close(b[1], 250, 1.5, "top vertex kept after nudge (centre 701,310 R 60)");
    await s.root.getByLabel("Selected inner ratio", { exact: true }).fill("0");
    for (let i = 0; i < 30 && (await vertices()) !== 8; i++) await s.page.waitForTimeout(100);
    ok((await vertices()) === 8, "inner ratio 0 → regular octagon");
  } finally { await s.close(); }
});

await test("no page errors during the vector session", { "FF-32": "partial" }, () => { ok(errors.length === 0, errors.join(" | ")); });
await browser.close();
finish();
