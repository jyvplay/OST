/** Capture the initial, populated-or-empty window of every registered app.
 * These screenshots are review aids, not assertions of visual quality or full
 * functional coverage. Run only against an exclusive disposable server. */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchChromium } from "./browser-launch.mts";
import { MODULES } from "../src/lib/registry.ts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, dir = resolve(process.env.VISUAL_OUT ?? "/home/user/.cache/ost-tt128-visual"); mkdirSync(dir, { recursive: true });
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`); return await r.json() as T;
}
const original = await api<{ row?: { state?: unknown } }>("GET", "/api/state?id=default");
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
const { test, finish } = makeHarness("tt128-visual");
try {
  for (const m of MODULES) {
    await test(`initial view: ${m.title}`, {}, async () => {
      const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
      await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: m.id, title: m.title, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      try {
        await page.goto(BASE, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => {
          const body = document.querySelector('[data-win-id="w1"] .fs-winbody');
          return !!body && body.children.length > 0 && (body.textContent?.trim().length ?? 0) > 3;
        }, null, { timeout: 12_000 });
        await page.locator('[data-win-id="w1"]').screenshot({ path: `${dir}/${m.id}.png`, animations: "disabled", timeout: 15_000 });
      } finally { await page.close(); }
    });
  }
} finally {
  await context.close();
  if (original.row?.state) {
    const last = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", { id: "default", revision: Number(last.row?.revision ?? 1) + 1000, state: original.row.state });
  }
  await browser.close(); finish();
}
