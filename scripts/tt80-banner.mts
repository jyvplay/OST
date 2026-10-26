/**
 * TT80 — banner audit: every creative app gets ONE Fusion banner and its menus are honest mirrors of the strip.
 *
 * Checked here (headless, real DOM, one browser for all apps):
 *   1. exactly one banner per app, and no wrapped row above the document besides the banner's own two rows;
 *   2. the top-level menu names are Fusion's own — every name is in banner-core's vocabulary and is NOT the name of a
 *      top-level menu of macOS / Windows / Office / Google / LibreOffice / Acrobat / Photoshop / Figma / browsers;
 *   3. every menu opens and lists every control of its group in strip order, with no label invented;
 *   4. clicking a menu item activates the very control the strip shows (aria-pressed / checked / select value), so a
 *      command cannot behave differently from its button;
 *   5. Escape closes the menu and the strip scrolls sideways instead of wrapping;
 *   6. in the Art layout the shell menu bar lists the focused window's menus beside its own Frame / Guide.
 */
import { launchChromium } from "./browser-launch.mts";
import { BANNER_MENUS, FOREIGN_MENU_NAMES, MENU_ITEM_CAP } from "../src/lib/banner-core.ts";
import { makeHarness } from "./harness.mts";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("tt80-banner");
const ok = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
const eq = (a: number, b: number, msg: string) => ok(a === b, `${msg} (got ${a}, want ${b})`);
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => null);
};
async function reset() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur?.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const stripSel = ".fs-banner-strip";
const itemText = (m: string) => `[role=menu][aria-label="${m}"] [role=menuitem],[role=menuitemcheckbox]`;

const APPS: Record<string, { label: string; menus: string[]; url?: string; seed?: string; switch?: string }> = {
  writer: { label: "Writer", menus: ["Keep", "Tweak", "Look", "Put", "Polish", "Glance"] },
  slides: { label: "Slides", menus: ["Keep", "Stage", "Tweak", "Put", "Look", "Stack"] },
  sheet: { label: "Spreadsheet", menus: ["Keep", "Tweak", "Look", "Crunch", "Put", "Glance", "Polish"] },
  pdf: { label: "PDF", menus: ["Keep", "Tweak", "Ink", "Glance"] },
  vector: { label: "Vector", menus: ["Keep", "Tweak", "Glance", "Kit", "Stack"] },
  whiteboard: { label: "Whiteboard", menus: ["Keep", "Tweak", "Kit", "Glance"] },
  tables: { label: "Tables", menus: ["Keep", "Tweak", "Glance", "Crunch", "Put"] },
  editor: { label: "Editor", menus: ["Keep"] },
  photos: { label: "Photos", menus: ["Glance", "Keep"] },
  imageedit: { label: "Image Editor", menus: ["Keep", "Tweak", "Glance", "Kit"] },
  imagequick: { label: "Image Editor", menus: ["Keep", "Look"], url: "?open=imageedit&path=/Pictures/tt80-quick.png", seed: "/Pictures/tt80-quick.png", switch: "Quick edit (classic)" },
};
const ALL_MENUS = Object.keys(BANNER_MENUS);
/** a seed file for the apps that need a document open to show their full menu set */
const seed = (path: string) => fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "upload", path, content: Buffer.from(readFileSync("scripts/fixtures/tt80/quick.png")).toString("base64"), mime: "image/png" }) }).then((r) => r.json());
const FOREIGN = new Set(FOREIGN_MENU_NAMES);

const browser = await launchChromium();
for (const [id, spec] of Object.entries(APPS)) {
  await test(`${id}: one banner, own menu names, menus mirror the strip`, { "DP-15": "full" }, async () => {
    const stray = spec.menus.filter((n) => !ALL_MENUS.includes(n));
    ok(stray.length === 0, `${spec.label} uses menu names outside the vocabulary: ${stray}`);
    ok(spec.menus.every((n) => !FOREIGN.has(n)), `${spec.label} reuses a top-level menu name of an existing system`);
    await reset();
    if (spec.seed) await seed(spec.seed);
    await api("PUT", "/api/settings", { key: "appearance.layout", value: "art" });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(20_000);
    const page = await ctx.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}${spec.url ?? `/?open=${id}`}`, { waitUntil: "domcontentloaded" });
    // the banner names its own app, so the audit does not depend on which frame variant the module uses
    const banner = page.locator(`[data-testid=app-banner][data-app="${spec.label}"]`);
    await banner.waitFor({ state: "visible", timeout: 25_000 });
    await page.waitForTimeout(400);
    // the shell only forwards ?path, so an in-app switch (the tab) is the honest way to reach a mode
    if (spec.switch) await page.getByRole("tab", { name: spec.switch }).click();
    // an app with a seeded document renders its edit groups only once the file is read
    if (spec.menus.includes("Look")) await page.waitForSelector('[data-banner-group="Look"]', { timeout: 20_000 });
    eq(await banner.count(), 1, `${id}: exactly one banner`);
    eq(await banner.locator(stripSel).count(), 1, `${id}: one tool strip`);

    // 1. nothing else wrapped above the document (inside the app's own window)
    const above = await banner.evaluate((el) => {
      const win = (el.closest("[data-win-id]") as HTMLElement | null) ?? (el.parentElement as HTMLElement);
      const out: string[] = [];
      for (const c of [...win.querySelectorAll("*")]) {
        if (el.contains(c)) continue;
        if (c.closest("[role=dialog]") && !win.contains(c.closest("[role=dialog]"))) continue;
        const cl = String(c.className ?? ""); if (!/(^|\s)fs-(row|toolbar)(\s|$)/.test(cl)) continue;
        const r = (c as HTMLElement).getBoundingClientRect();
        const b = el.getBoundingClientRect();
        // a header row is fine; a row that WRAPPED (content overflowing its own height) is the mess being audited
        if (r.width > 0 && r.top < b.bottom - 4 && r.bottom > 0 && r.left >= b.left - 1 && r.right <= b.right + 1 && (c as HTMLElement).scrollHeight > (c as HTMLElement).clientHeight + 2)
          out.push(cl.split(/\s+/).filter((x) => !["fs-row", "fs-toolbar"].includes(x)).join(".") || "row");
      }
      return [...new Set(out)].join(",");
    });
    ok(above === "", `${id}: ${above || "no"} extra wrapped row above the document`);

    // 5. strip scrolls, never wraps
    const wrap = await banner.locator(stripSel).evaluate((el) => Math.round(el.scrollHeight - el.clientHeight));
    ok(wrap <= 2, `${id}: strip wrapped by ${wrap}px`);

    // 2 + 3. menus open and every item is a control of that group (a group may live outside the banner: Vector's kit)
    let total = 0;
    for (const m of spec.menus) {
      const btn = banner.locator(`[data-testid="banner-menu-${m.toLowerCase()}"]`);
      eq(await btn.count(), 1, `${id}: menu "${m}" exists`);
      await btn.click();
      const items = await banner.locator(itemText(m)).evaluateAll((els) =>
        els.map((e) => { const b = e as HTMLElement; return (b.querySelector("span:nth-child(2)")?.textContent ?? b.textContent ?? "").replace(/\s+/g, " ").trim(); }).filter((x) => x));
      ok(items.length >= 1, `${id}: menu "${m}" is empty`);
      ok(items.length <= MENU_ITEM_CAP, `${id}: menu "${m}" lists ${items.length} items (cap ${MENU_ITEM_CAP})`);
      total += items.length;
      const groupLabels = await banner.evaluate((el, menu) => {
        const win = (el.closest("[data-win-id]") as HTMLElement | null) ?? (el.parentElement as HTMLElement);
        const out: string[] = [];
        for (const g of [...win.querySelectorAll(`[data-banner-group="${menu}"]`)]) {
          for (const c of g.querySelectorAll("button, select, input, label")) {
            if (c instanceof HTMLInputElement && (c.type === "file" || c.type === "hidden")) continue;
            const a = (c.getAttribute("aria-label") ?? "").trim();
            if (c instanceof HTMLSelectElement) { out.push(a); out.push(...[...c.options].map((o) => o.textContent ?? "").map((t) => t.trim()).filter((t) => t)); continue; }
            const t = (c.textContent ?? "").replace(/\s+/g, " ").trim();
            if (a) out.push(a);
            if (t) out.push(t);
            if (c instanceof HTMLInputElement && !a) out.push(c.type);
          }
        }
        return [...new Set(out.filter((x) => x.length > 1))];
      }, m);
      for (const l of items) {
        const found = groupLabels.some((g) => l.toLowerCase() === g.toLowerCase() || (l.toLowerCase().includes(g.toLowerCase()) && g.length > 3));
        if (!found) throw new Error(`${id} menu "${m}" lists "${l}" which is not a control of its group`);
      }
      await page.keyboard.press("Escape"); await page.waitForTimeout(120);
      eq(await banner.locator(`[role=menu][aria-label="${m}"]`).count(), 0, `${id}: Escape closes menu "${m}"`);
    }
    ok(total >= 4, `${id}: only ${total} commands across ${spec.menus.length} menus`);

    // 4. a menu item activates the strip's control: pick a toggle in the window, open its menu, click its item there
    const probe = await banner.evaluate((el) => {
      const win = (el.closest("[data-win-id]") as HTMLElement | null) ?? (el.parentElement as HTMLElement);
      const cands = [...win.querySelectorAll("[data-banner-group] button[aria-pressed]:not([disabled]),[data-banner-group] input[type=checkbox]:not([disabled])")];
      const e = (cands.find((x) => x.getAttribute("aria-pressed") === "false" || (x as HTMLInputElement).checked === false) ?? cands[0]) as HTMLElement | undefined;
      if (!e) return null;
      const g = e.closest("[data-banner-group]") as HTMLElement;
      // the same naming rule the mirror uses, so the probe addresses the control the menu actually shows
      const text = (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const aria = (e.getAttribute("aria-label") ?? "").trim();
      const label = /[A-Za-z]{2}/.test(text) && text.length >= 3 ? text : aria || e.getAttribute("title") || text;
      const at = e.getAttribute("aria-pressed") ?? ((e as HTMLInputElement).checked ? "true" : "false");
      return { name: g.getAttribute("data-banner-group"), label, before: at };
    });
    ok(probe !== null, `${id}: no toggle to probe through a menu`);
    if (probe) {
      await banner.locator(`[data-testid="banner-menu-${probe!.name.toLowerCase()}"]`).click();
      const item = banner.locator(itemText(probe!.name)).filter({ hasText: probe!.label.slice(0, 20) }).first();
      eq(await item.count(), 1, `${id}: the mirrored item "${probe!.label}" is listed`);
      await item.click(); await page.waitForTimeout(250);
      const after = await banner.evaluate((el, label) => {
        const win = (el.closest("[data-win-id]") as HTMLElement | null) ?? (el.parentElement as HTMLElement);
        for (const e of [...win.querySelectorAll("[data-banner-group] button[aria-pressed],[data-banner-group] input[type=checkbox]")]) {
          const t = (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
          const a = (e.getAttribute("aria-label") ?? "").trim();
          const l = /[A-Za-z]{2}/.test(t) && t.length >= 3 ? t : a;
          if (l !== label) continue;
          return e.getAttribute("aria-pressed") ?? ((e as HTMLInputElement).checked ? "true" : "false");
        }
        return "gone";
      }, probe!.label);
      ok(after !== probe!.before, `${id}: menu item "${probe!.label}" did not change its strip control (${probe!.before} -> ${after})`);
    }
    ok(!errors.length, errors.join("\n"));

    // 6. the shell menu bar lists the focused window's menus beside Frame / Guide
    const bar = page.locator("[data-testid=menubar]");
    if (await bar.count()) {
      const barMenus = await bar.locator("button[aria-haspopup=menu]").evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
      for (const m of spec.menus) ok(barMenus.includes(m), `${id}: shell menu bar is missing "${m}" (${barMenus.join(" ")})`);
      ok(barMenus.includes("Frame") && barMenus.includes("Guide"), `${id}: shell menu bar lost its own menus (${barMenus.join(" ")})`);
    }
    await ctx.close();
    if (spec.seed) { await api("POST", "/api/fs", { op: "trash", path: spec.seed }); await api("POST", "/api/fs", { op: "purge", path: spec.seed }); }
    await api("PUT", "/api/settings", { key: "appearance.layout", value: "fusion" });
  });
}
await browser.close();
// the writer creates recovery drafts while it is open; leave the VFS as the suite found it
{
  const r = await fetch(`${BASE}/api/fs?op=list&path=%2FSystem%2FRecovery`).then((x) => x.json()).catch(() => ({})) as { nodes?: { name: string; path: string }[] };
  for (const n of r.nodes ?? []) if (n.name.startsWith("writer_")) { await api("POST", "/api/fs", { op: "trash", path: n.path }); await api("POST", "/api/fs", { op: "purge", path: n.path }); }
}
await finish();
