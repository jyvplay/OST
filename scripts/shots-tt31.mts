/**
 * Screenshots for TT31 visual inspection (live walls): resting overview, each wall lifted by hover, a fanned wall
 * pile, a spring-loaded drag, the top camera and a phone. Writes scripts/tt31-shots/*.png (git-ignored).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt31.mts
 */
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const OUT = new URL("./tt31-shots/", import.meta.url).pathname;
const RUN = Date.now().toString(36);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
async function desktop(table?: unknown) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 10, ...(table ? { table } : {}) } });
}
const files = Array.from({ length: 14 }, (_, i) => `/Documents/tt31s-${RUN}-${String(i).padStart(2, "0")}.${["md", "csv", "txt"][i % 3]}`);
for (const [i, f] of files.entries()) await api("POST", "/api/fs", { op: "write", path: f, content: f.endsWith(".csv") ? "name,qty\nfig,3\npear,5\n" : `# Note ${i}\n\n- point one\n- point two\n` });
const slot = (i: number) => ({ x: 24 + (i % 6) * 136, y: 24 + Math.floor(i / 6) * 205 });
const table = { v: 2, cards: {}, piles: [], camera: "slant", views: [], walls: {
  north: { cards: Object.fromEntries(files.slice(0, 8).map((f, i) => [f, slot(i)])), piles: [] },
  west: { cards: Object.fromEntries(files.slice(8, 10).map((f, i) => [f, slot(i)])), piles: [{ id: "pw", name: "Ideas", x: 296, y: 24, paths: files.slice(10, 13) }] },
  east: { cards: {}, piles: [] }, south: { cards: { [files[13]]: slot(1) }, piles: [] } } };
await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark");
await setSetting("appearance.textScale", "125"); await setSetting("appearance.desktopView", "tabletop");
await desktop(table);
const browser = await launchChromium();
try {
const shoot = async (vw: number, vh: number, name: string, act?: (p: import("playwright").Page) => Promise<void>) => {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const p = await ctx.newPage();
  await p.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await p.getByTestId("tabletop").waitFor({ timeout: 30_000 });
  await p.waitForTimeout(2200);
  if (act) await act(p);
  await p.screenshot({ path: `${OUT}${name}.png` });
  console.log("shot", name);
  await ctx.close();
};
/** hover the wall's own face at a point a third of the way along it (away from its tag), found by hit-testing */
const hover = (w: string) => async (p: import("playwright").Page) => {
  const q = await p.evaluate((w) => {
    const r = document.querySelector(`[data-testid=tt-wall-${w}]`)!.getBoundingClientRect();
    for (let fx = 0.2; fx < 0.9; fx += 0.05) for (let fy = 0.2; fy < 0.9; fy += 0.05) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy, el = document.elementFromPoint(x, y);
      if (el?.closest(`[data-face=${w}]`)) return [x, y];
    }
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, w);
  await p.mouse.move(q[0], q[1]); await p.waitForTimeout(1300);
};
await shoot(1440, 900, "rest-1440");
for (const w of ["north", "west", "east", "south"]) await shoot(1440, 900, `lift-${w}`, hover(w));
await shoot(1440, 900, "fan-west", async (p) => { await hover("west")(p); await p.locator('[data-testid=tt-wallpile][data-surface=west]').click(); await p.waitForTimeout(900); });
await shoot(390, 760, "phone-lift-north", async (p) => { await p.getByTestId("tt-open-north").focus(); await p.waitForTimeout(1200); });
await desktop({ ...table, camera: "top" });
await shoot(1440, 900, "top-rest");
await shoot(1440, 900, "top-lift-west", async (p) => { await p.getByTestId("tt-open-west").focus(); await p.waitForTimeout(1300); });
} finally {
  // leave the shared desktop as other suites expect it: classic view, an empty table, no stray files (trash + purge)
  await browser.close();
  await desktop({ v: 2, cards: {}, piles: [], camera: "slant", views: [], walls: {} });
  await setSetting("appearance.desktopView", "classic");
  for (const f of files) { await api("POST", "/api/fs", { op: "trash", path: f }); await api("POST", "/api/fs", { op: "purge", path: f }); }
}
