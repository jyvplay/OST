/** Empty-folder accessibility in real Chromium; requires an exclusive disposable server/database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Refusing empty-folder a11y checks without an exclusive disposable database and matching server.");
const BASE = process.env.BASE, folder = `/Documents/tt97-empty-${randomBytes(6).toString("hex")}`;
const { test, finish } = makeHarness("e2e-tt97-files-empty-a11y");
const cov = { "AX-08": "partial", "FM-09": "partial" } as const;
const api = async (method: string, path: string, body?: object) => {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`); return response.json();
};
const settings = (await api("GET", "/api/settings")).rows as { key: string; value: string }[];
const previous = Object.fromEntries(["appearance.style", "appearance.theme", "appearance.textScale"].map((key) => [key, settings.find((s) => s.key === key)?.value]));
const state = await api("GET", "/api/state?id=default");
let created = false; const browser = await launchChromium();
try {
  for (const [key, value] of Object.entries({ "appearance.style": "poolside", "appearance.theme": "dark", "appearance.textScale": "125" })) await api("PUT", "/api/settings", { key, value });
  await api("POST", "/api/fs", { op: "mkdir", path: folder, reason: "tt97-empty-a11y" }); created = true;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${BASE}/?open=files&path=${encodeURIComponent(folder)}`, { waitUntil: "domcontentloaded" });
    // Wait for the pane that actually shows the requested folder: a first-pane locator can be a
    // still-loading /Documents listing whose rows arrive after an empty-options snapshot.
    const listing = page.locator(`.fs-files-pane[data-cwd="${folder}"] [data-testid="files-listing"]`);
    await listing.waitFor({ timeout: 30_000 });
    assert.equal(await listing.count(), 1);
    await page.waitForFunction((path) => {
      const pane = document.querySelector(`.fs-files-pane[data-cwd="${path}"] [data-testid="files-listing"]`);
      return Boolean(pane) && pane!.querySelectorAll('[role="option"]').length === 0;
    }, folder);
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const scan = () => page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const result = await axe.run({ include: ['.fs-window[aria-label="Files"]'] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
      return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }));
    });
    await test("an empty scrollable folder listing is keyboard reachable and has no serious axe violation", cov, async () => {
      assert.equal(await listing.getAttribute("tabindex"), "0"); assert.equal(await listing.getAttribute("role"), "group");
      assert.equal(await listing.getAttribute("aria-label"), "Empty folder");
      assert.deepEqual(await scan(), []);
      await page.keyboard.press("Tab"); await listing.focus(); assert.equal(await listing.evaluate((el) => el === document.activeElement), true);
    });
    await test("reverting to the pre-repair non-tabbable empty listing is detected", cov, async () => {
      // Reproduce the pre-repair element AND guarantee it actually overflows: axe's rule only
      // inspects scrollable regions, and an empty folder may otherwise be too short to scroll.
      await listing.evaluate((el) => {
        el.setAttribute("tabindex", "-1"); el.removeAttribute("role"); el.removeAttribute("aria-label");
        el.setAttribute("style", "height: 120px; overflow-y: auto; padding: 6px; flex: 1;");
        const filler = document.createElement("div"); filler.id = "tt97-filler"; filler.style.height = "2000px"; filler.textContent = "overflow filler";
        el.appendChild(filler);
      });
      try {
        assert.equal(await listing.evaluate((el) => el.scrollHeight > el.clientHeight), true, "injected state must overflow to be a scrollable region");
        const broken = await scan();
        // axe reports the generated selector (".fs-scroll"), not the test id; the scan is
        // already scoped to the Files window, so accept either spelling.
        assert.ok(broken.some((v) => v.id === "scrollable-region-focusable" && v.targets.some((t) => t.includes("fs-scroll") || t.includes("files-listing"))), JSON.stringify(broken));
      } finally { await listing.evaluate((el) => {
        document.getElementById("tt97-filler")?.remove(); el.removeAttribute("style");
        el.setAttribute("tabindex", "0"); el.setAttribute("role", "group"); el.setAttribute("aria-label", "Empty folder");
      }); }
      assert.deepEqual(await scan(), []);
    });
    await test("the empty-state check produces no uncaught page errors", cov, () => { assert.deepEqual(errors, []); });
  } finally { await context.close(); }
} finally {
  await browser.close();
  if (created) await api("POST", "/api/fs", { op: "purge", path: folder });
  for (const [key, value] of Object.entries(previous)) if (value !== undefined) await api("PUT", "/api/settings", { key, value });
  if (state.row?.state) { const latest = await api("GET", "/api/state?id=default"); await api("PUT", "/api/state", { id: "default", revision: Number(latest.row?.revision ?? 1) + 1000, state: state.row.state }); }
}
finish();
