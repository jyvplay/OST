/**
 * Real-browser suite "e2e-media27" (TT27): the Video, Music and Maps modules and the layout ↔ style pairing, in
 * headless Chromium against the production build.
 *
 * Network honesty: YouTube / Spotify / SoundCloud / OSM are NOT reachable from this sandbox. Every request to those
 * hosts is intercepted by Playwright: we record it (URL + Referer header) and answer with a small stub page / PNG.
 * So these tests prove what this app sends (when, to whom, with which Referer, with which iframe attributes) — not
 * that the providers' players then play. /Documents/Streams.json and /Documents/Places.geojson are backed up and
 * restored; settings touched are put back.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-media27.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Locator, Page, Request } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import * as M from "../src/lib/maps-core.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const ORIGIN = new URL(BASE).origin;
const { test, finish } = makeHarness("e2e-media27");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const readFile = async (p: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(p)}`); return r.status === 200 ? String(r.json.node.content) : null; };
const getSetting = async (key: string) => (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === key)?.value as string | undefined;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`timed out: ${what}`); }
const win = (id: string, module: string, props: Record<string, unknown> = {}) => ({ id, module, title: module, x: 10, y: 10, w: 1380, h: 800, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
async function axe(page: Page, sel: string): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
  return page.evaluate(async (s) => {
    const w = window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run(document.querySelector(s), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  }, sel);
}

const EXTERNAL = /(youtube|youtube-nocookie|ytimg|googlevideo|spotify|scdn|soundcloud|sndcdn|vimeo|dailymotion|twitch|openstreetmap)\./i;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
type Seen = { url: string; referer: string; type: string };
const browser: Browser = await launchChromium();
async function boot(windows: unknown[], vw = 1440, vh = 900): Promise<{ page: Page; ctx: BrowserContext; seen: Seen[]; close: () => Promise<void> }> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const seen: Seen[] = [];
  await ctx.route(EXTERNAL, async (route) => {
    const r: Request = route.request();
    seen.push({ url: r.url(), referer: (await r.allHeaders())["referer"] ?? "", type: r.resourceType() });
    if (r.resourceType() === "image") await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
    else await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title><p>stub player (sandbox has no route to the provider)</p>" });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  return { page, ctx, seen, close: () => ctx.close() };
}

const backup: Record<string, string | null> = {};
const SETTINGS = ["media.embeds", "maps.tiles", "maps.tileUrl", "appearance.layout", "appearance.style", "appearance.theme", "appearance.pairStyle"];
const savedSettings: Record<string, string | undefined> = {};
for (const p of ["/Documents/Streams.json", "/Documents/Places.geojson"]) backup[p] = await readFile(p);
for (const k of SETTINGS) savedSettings[k] = await getSetting(k);
const writeFile = (p: string, content: string) => api("POST", "/api/fs", { op: "write", path: p, content, mime: "application/json" });
const removeFile = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };

try {
  await test("Video: privacy gate (no provider request before consent), youtube-nocookie iframe with origin-only Referer + sandbox/allow, bad links explained, Save → Streams.json, reload keeps it, Next walks the library", { "SM-01": "partial", "SM-03": "full" }, async () => {
    await removeFile("/Documents/Streams.json");
    await setSetting("media.embeds", "ask");
    const { page, seen, close } = await boot([win("v1", "video")]);
    const app = page.getByTestId("sv-app");
    await app.waitFor();
    await page.getByTestId("sv-url").fill("https://example.com/not-a-video");
    await page.getByTestId("sv-play").click();
    ok(/not a supported player/.test((await page.getByTestId("sv-error").textContent()) ?? ""), "unsupported site explained");
    await page.getByTestId("sv-url").fill("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT");
    await page.getByTestId("sv-play").click();
    ok(/music link/.test((await page.getByTestId("sv-error").textContent()) ?? ""), "music link redirected to Music");
    await page.getByTestId("sv-url").fill("https://youtu.be/dQw4w9WgXcQ?t=42");
    await page.getByTestId("sv-play").click();
    await page.getByTestId("sv-facade").waitFor();
    await page.waitForTimeout(600);
    ok(seen.length === 0, `nothing sent before consent: ${seen.map((s) => s.url).join(", ")}`);
    await page.getByTestId("sv-load").click();
    const frame = page.getByTestId("sv-frame");
    await frame.waitFor();
    const attrs = await frame.evaluate((f: HTMLIFrameElement) => ({ src: f.src, rp: f.getAttribute("referrerpolicy"), allow: f.allow, sandbox: f.getAttribute("sandbox"), fs: f.allowFullscreen }));
    ok(attrs.src === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42&rel=0", attrs.src);
    ok(attrs.rp === "strict-origin-when-cross-origin" && attrs.allow.includes("encrypted-media") && attrs.fs && !(attrs.sandbox ?? "").includes("allow-top-navigation"), JSON.stringify(attrs));
    await poll(async () => seen.some((s) => s.url.startsWith("https://www.youtube-nocookie.com/embed/")), "iframe request");
    const req = seen.find((s) => s.url.startsWith("https://www.youtube-nocookie.com/embed/"))!;
    ok(req.referer === `${ORIGIN}/`, `Referer is the origin only (YouTube's embed requirement; no path/query leaks): "${req.referer}"`);
    await page.getByTestId("sv-save").click();
    await poll(async () => { const f = await readFile("/Documents/Streams.json"); return !!f && JSON.parse(f).items?.length === 1; }, "library file written");
    await page.getByTestId("sv-url").fill("https://vimeo.com/76979871");
    await page.getByTestId("sv-save").click();
    await poll(async () => (await page.getByTestId("sv-item").count()) === 2, "2 items");
    await poll(async () => { const f = await readFile("/Documents/Streams.json"); return !!f && JSON.parse(f).items?.length === 2; }, "second item saved");
    await close();
    const r2 = await boot([win("v1", "video")]);
    await poll(async () => (await r2.page.getByTestId("sv-item").count()) === 2, "library survives reload");
    await r2.page.getByTestId("sv-item-play").first().click();
    ok((await r2.page.getByTestId("sv-stage").getAttribute("data-provider")) === "vimeo", "first item (newest) plays");
    await r2.page.getByTestId("sv-next").click();
    ok((await r2.page.getByTestId("sv-stage").getAttribute("data-provider")) === "youtube", "Next walks the library");
    ok((await r2.page.getByTestId("sv-stage").getAttribute("data-loaded")) === "0", "a new session asks again before loading the provider (consent is per session unless 'Always load')");
    await r2.close();
  });

  await test("Music: Spotify (152 px track player, encrypted-media) and SoundCloud widget (166 px, documented params) behind the gate; 'Always load' persists and skips the gate; video links redirected", { "SM-02": "partial" }, async () => {
    await setSetting("media.embeds", "ask");
    const { page, seen, close } = await boot([win("m1", "music")]);
    await page.getByTestId("sa-app").waitFor();
    await page.getByTestId("sa-url").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await page.getByTestId("sa-play").click();
    ok(/video link/.test((await page.getByTestId("sa-error").textContent()) ?? ""), "video link redirected to Video");
    await page.getByTestId("sa-url").fill("https://open.spotify.com/intl-de/track/4cOdK2wGLETKBW3PvgPWqT?si=x");
    await page.getByTestId("sa-play").click();
    ok(/30-second previews/.test((await page.getByTestId("sa-facade").textContent()) ?? ""), "Spotify preview limit stated before loading");
    await page.getByTestId("sa-remember").check();
    await page.getByTestId("sa-load").click();
    const f = page.getByTestId("sa-frame");
    await f.waitFor();
    const a = await f.evaluate((el: HTMLIFrameElement) => ({ src: el.src, h: el.getBoundingClientRect().height, allow: el.allow, rp: el.getAttribute("referrerpolicy") }));
    ok(a.src.startsWith("https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT") && Math.abs(a.h - 152) < 1.5 && a.allow.includes("encrypted-media") && a.rp === "strict-origin-when-cross-origin", JSON.stringify(a));
    await poll(async () => (await getSetting("media.embeds")) === "allow", "always-load persisted");
    await page.getByTestId("sa-url").fill("https://soundcloud.com/forss/flickermood");
    await page.getByTestId("sa-play").click();
    const sc = page.getByTestId("sa-frame");
    await poll(async () => ((await sc.getAttribute("src")) ?? "").startsWith("https://w.soundcloud.com/player/"), "no gate the second time");
    const u = new URL((await sc.getAttribute("src"))!);
    ok(u.searchParams.get("url") === "https://soundcloud.com/forss/flickermood" && u.searchParams.get("auto_play") === "false", u.href);
    ok(Math.abs((await sc.boundingBox())!.height - 166) < 1.5, "SoundCloud track widget height");
    await poll(async () => seen.some((s) => s.url.startsWith("https://w.soundcloud.com/")), "widget requested");
    ok(seen.filter((s) => s.type === "document").every((s) => s.referer === "" || s.referer === `${ORIGIN}/`), `only origin referers: ${seen.map((s) => s.referer).join()}`);
    await page.getByTestId("sa-ask-again").click();
    await poll(async () => (await getSetting("media.embeds")) === "ask", "back to asking");
    await close();
  });

  await test("Maps offline: the world draws with zero tile requests (≥ 230 countries, land pixels on the canvas); search 'France' flies there; hover names the country; coordinates search; Explore click selects a country", { "MP-01": "full", "MP-02": "partial" }, async () => {
    await setSetting("maps.tiles", "off");
    const { page, seen, close } = await boot([win("g1", "maps")]);
    const map = page.getByTestId("mp-map");
    await poll(async () => (await map.getAttribute("data-ready")) === "1", "map ready", 20000);
    ok(Number(await map.getAttribute("data-countries")) >= 230, "countries loaded");
    let land = 0;
    await poll(async () => { land = await page.evaluate(() => {
      const c = document.querySelector("[data-testid=mp-map] canvas") as HTMLCanvasElement | null; if (!c) return -1;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 16) if (d[i + 3] > 200) n++;
      return n / (d.length / 16);
    }); return land > 0.1; }, "land drawn", 10000).catch(() => {});
    ok(land > 0.1, `land drawn on the canvas (${(land * 100).toFixed(1)} % opaque samples)`);
    await page.getByTestId("mp-search").fill("France");
    await page.getByTestId("mp-result").filter({ hasText: "France" }).first().click();
    await poll(async () => Number(await map.getAttribute("data-zoom")) >= 4 && Math.abs(Number(await map.getAttribute("data-lat")) - 46) < 6, "flew to France", 10000);
    await page.waitForTimeout(400);
    const b = (await map.boundingBox())!;
    // France fills the view after fitBounds: the centre of the map is inside France (metropolitan bbox ≈ lat 41–51, lng −5–10)
    const lat = Number(await map.getAttribute("data-lat")), lng = Number(await map.getAttribute("data-lng"));
    ok(lat > 41 && lat < 51.5 && lng > -5.5 && lng < 10, `centre ${lat},${lng}`);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await poll(async () => ((await page.getByTestId("mp-hover-country").textContent().catch(() => "")) ?? "") === "France", "hover names France");
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await poll(async () => ((await page.getByTestId("mp-country").textContent()) ?? "").includes("France"), "click selects France");
    await page.getByTestId("mp-search").fill("35.7796, -78.6382");
    await page.getByTestId("mp-search").press("Enter");
    await poll(async () => Math.abs(Number(await map.getAttribute("data-lat")) - 35.78) < 0.05 && Math.abs(Number(await map.getAttribute("data-lng")) + 78.64) < 0.05, "flew to the coordinates", 10000);
    ok(seen.length === 0, `offline mode made no external requests: ${seen.slice(0, 3).map((s) => s.url).join()}`);
    await close();
  });

  await test("Maps places + measure: Add place by map click and 'Add at centre' → Places.geojson (valid RFC 7946, [lng, lat]); rename persists; measured distance equals haversine of the clicked points (Web Mercator inverse, ±1 %)", { "MP-02": "full", "MP-03": "full" }, async () => {
    await removeFile("/Documents/Places.geojson");
    const { page, close } = await boot([win("g1", "maps")]);
    const map = page.getByTestId("mp-map");
    await poll(async () => (await map.getAttribute("data-ready")) === "1", "map ready", 20000);
    await page.getByTestId("mp-search").fill("geo:48.8566,2.3522");
    await page.getByTestId("mp-search").press("Enter");
    await poll(async () => Math.abs(Number(await map.getAttribute("data-lat")) - 48.8566) < 0.02, "Paris", 10000);
    await page.waitForTimeout(300);
    const z = Number(await map.getAttribute("data-zoom")), cLat = Number(await map.getAttribute("data-lat")), cLng = Number(await map.getAttribute("data-lng"));
    const b = (await map.boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    // Web Mercator inverse around the centre
    const S = 256 * 2 ** z, r = Math.PI / 180;
    const wx = ((cLng + 180) / 360) * S, wy = ((1 - Math.log(Math.tan(cLat * r) + 1 / Math.cos(cLat * r)) / Math.PI) / 2) * S;
    const ll = (dx: number, dy: number): M.LatLng => {
      const x = wx + dx, y = wy + dy;
      return [Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / S))) / r, (x / S) * 360 - 180];
    };
    await page.getByTestId("mp-mode-pin").check({ force: true });
    await page.mouse.click(cx - 120, cy + 40);
    await poll(async () => (await page.getByTestId("mp-place").count()) === 1, "place added by click");
    await page.getByTestId("mp-add-centre").click();
    await poll(async () => (await page.getByTestId("mp-place").count()) === 2, "place added at centre");
    await page.getByTestId("mp-place-name").fill(`Centre ${Date.now().toString(36)}`);
    await poll(async () => {
      const f = await readFile("/Documents/Places.geojson"); if (!f) return false;
      const g = JSON.parse(f); return g.type === "FeatureCollection" && g.features.length === 2 && String(g.features[1].properties.name).startsWith("Centre");
    }, "Places.geojson written with the rename");
    const g = JSON.parse((await readFile("/Documents/Places.geojson"))!);
    const want = ll(-120, 40), got = g.features[0].geometry.coordinates;
    ok(Math.abs(got[0] - want[1]) < 0.01 && Math.abs(got[1] - want[0]) < 0.01, `clicked place [lng, lat] ${got} ≈ ${want[1].toFixed(4)},${want[0].toFixed(4)}`);
    ok(M.normalizePlaces(g).places.length === 2, "the file parses back");
    await page.getByTestId("mp-mode-measure").check({ force: true });
    await page.mouse.click(cx - 200, cy - 60);
    await page.mouse.click(cx + 180, cy + 90);
    await poll(async () => Number(await page.getByTestId("mp-measure").getAttribute("data-metres")) > 0, "measured");
    const metres = Number(await page.getByTestId("mp-measure").getAttribute("data-metres"));
    const expect = M.haversine(ll(-200, -60), ll(180, 90));
    ok(Math.abs(metres - expect) / expect < 0.01, `measure ${metres} m vs ${expect.toFixed(0)} m`);
    await page.getByTestId("mp-measure-clear").click();
    await close();
  });

  await test("Maps street tiles are opt-in: OSM tile requests start only after choosing them, carry an origin-only Referer (OSM tile policy), show the © OpenStreetMap attribution; bad custom templates are refused by the API", { "MP-01": "full" }, async () => {
    await setSetting("maps.tiles", "off");
    const { page, seen, close } = await boot([win("g1", "maps")]);
    const map = page.getByTestId("mp-map");
    await poll(async () => (await map.getAttribute("data-ready")) === "1", "map ready", 20000);
    await page.waitForTimeout(500);
    ok(!seen.some((s) => s.url.includes("tile.openstreetmap.org")), "no tiles while off");
    await page.getByTestId("mp-layers").locator("summary").click();
    await page.getByTestId("mp-tiles-osm").check();
    await poll(async () => seen.some((s) => /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/.test(s.url)), "tile requests");
    const t = seen.find((s) => s.url.includes("tile.openstreetmap.org"))!;
    ok(t.referer === `${ORIGIN}/`, `tile Referer "${t.referer}"`);
    ok(/© OpenStreetMap contributors/.test((await page.locator(".leaflet-control-attribution").textContent()) ?? ""), "attribution visible");
    const bad = await api("PUT", "/api/settings", { key: "maps.tileUrl", value: "http://evil.example/{z}/{x}.png" });
    ok(bad.status >= 400 && bad.status < 500, `bad template refused (${bad.status})`);
    await page.getByTestId("mp-tiles-off").check();
    await close();
  });

  await test("layout ↔ style pairing: Art → Silver + light, Business → Daylight + light (from the Quick-panel/Settings switch), Fusion keeps the look; 'Match the look' off leaves the style alone", { "LY-14": "full" }, async () => {
    await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark"); await setSetting("appearance.pairStyle", "on");
    const { page, close } = await boot([win("s1", "settings")]);
    const root = page.locator("html");
    await page.getByTestId("settings-layout-art").check({ force: true }).catch(async () => { await page.getByTestId("settings-layout-art").locator("..").click(); });
    await poll(async () => (await root.getAttribute("data-style")) === "silver" && (await root.getAttribute("data-theme")) === "light", "Art → Silver light");
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fs-bg").trim());
    ok(bg === "#e6e8ec", `silver background token ${bg}`);
    await page.getByTestId("settings-layout-business").check({ force: true }).catch(async () => { await page.getByTestId("settings-layout-business").locator("..").click(); });
    await poll(async () => (await root.getAttribute("data-style")) === "daylight", "Business → Daylight");
    await page.getByTestId("settings-pair-style").uncheck();
    await poll(async () => (await getSetting("appearance.pairStyle")) === "off", "pairing off");
    await page.getByTestId("settings-layout-fusion").check({ force: true }).catch(async () => { await page.getByTestId("settings-layout-fusion").locator("..").click(); });
    await page.getByTestId("settings-layout-art").check({ force: true }).catch(async () => { await page.getByTestId("settings-layout-art").locator("..").click(); });
    await poll(async () => (await getSetting("appearance.layout")) === "art", "art again");
    await page.waitForTimeout(400);
    ok((await root.getAttribute("data-style")) === "daylight", "pairing off: style untouched");
    await close();
  });

  await test("axe-core: Video, Music and Maps (dark + light) — no serious or critical violations", { "SM-03": "partial", "MP-01": "partial", "AX-08": "partial" }, async () => {
    const bad: string[] = [];
    await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside");
    for (const theme of ["dark", "light"]) {
      await setSetting("appearance.theme", theme);
      for (const [id, mod, sel] of [["v1", "video", "[data-testid=sv-app]"], ["m1", "music", "[data-testid=sa-app]"], ["g1", "maps", "[data-testid=mp-app]"]]) {
        const { page, close } = await boot([win(id, mod)]);
        await page.locator(sel).waitFor();
        if (mod === "maps") await poll(async () => (await page.getByTestId("mp-map").getAttribute("data-ready")) === "1", "map", 20000);
        await page.waitForTimeout(600);
        bad.push(...(await axe(page, sel)).map((v) => `${theme}/${mod} ${v}`));
        await close();
      }
    }
    ok(bad.length === 0, bad.slice(0, 8).join("\n"));
  });
} finally {
  for (const [p, c] of Object.entries(backup)) { if (c === null) await removeFile(p); else await writeFile(p, c); }
  for (const [k, v] of Object.entries(savedSettings)) if (v !== undefined) await setSetting(k, v);
  await desktop([]);
  await browser.close();
}
finish();
