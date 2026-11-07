/** Real final-patch UI/HTTP review: actual GitHub XFO denial versus actual
 * reserved-.invalid DNS failure; native disclosures retain the real register
 * and all stored spike criteria. No response interception or fake devices.
 * These repairs/visual checks are NOT new Class A feature registrations. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect } from "playwright/test";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";

const fx = await disposableShell(), { test, finish } = makeHarness("tt134-review-repairs");
const records: { app: string; mode: string; path: string; words: number; proof?: unknown }[] = [];
mkdirSync("docs/screens/tt134-review-repairs", { recursive: true });
const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
try {
  for (const [mode, width] of [["wide", 1500], ["compact", 900]] as const) {
    const context = await fx.context({ viewport: { width, height: 960 } });
    try {
      for (const verdict of ["deny", "unknown"] as const) {
        await test(`${mode} Browser: actual ${verdict === "deny" ? "GitHub framing denial" : "DNS failure"} is not confused with ${verdict === "deny" ? "network uncertainty" : "a measured framing policy"}`, {}, async () => {
          await fx.windows("browser", 1, width); const page = await context.newPage(), errors: string[] = [];
          page.on("pageerror", error => errors.push(error.message));
          try {
            await fx.ready(page, "browser"); const win = page.locator('[data-win-id="w1"]');
            const target = verdict === "deny" ? "https://github.com/" : `https://tt134-${Date.now().toString(36)}-${mode}.invalid/`;
            const response = () => page.waitForResponse(r => {
              const url = new URL(r.url()); return url.pathname === "/api/embed-probe" && url.searchParams.get("url") === target;
            });
            const measured = response(); await win.getByLabel("Address", { exact: true }).fill(target); await win.getByLabel("Address", { exact: true }).press("Enter");
            const reply = await measured; assert.equal(reply.status(), 200); const proof = await reply.json();
            assert.equal(proof.verdict, verdict, "this check depends on the real observed peer/DNS outcome; no fake fallback result");
            if (verdict === "deny") {
              assert.equal(proof.headers["x-frame-options"], "deny");
              await expect(win.getByText(`${target} refuses to be embedded`, { exact: true })).toBeVisible();
              await expect(win.getByText("X-Frame-Options: DENY", { exact: true }).first()).toBeVisible();
            } else {
              assert.equal(proof.status, 0); assert.match(proof.reason, /DNS lookup failed/);
              await expect(win.getByText("Embedding could not be checked", { exact: true })).toBeVisible();
              await expect(win.getByText("unverified", { exact: true })).toBeVisible();
              await expect(win.getByText(/refuses to be embedded/)).toHaveCount(0);
              await expect(win.getByText(/No framing policy was measured/)).toBeVisible();
              const retry = response(); await win.getByRole("button", { name: "Re-probe", exact: true }).click();
              assert.equal((await (await retry).json()).verdict, "unknown", "a real second request, not a cached pretend refusal");
              await expect(win.getByText(/refuses to be embedded/)).toHaveCount(0);
            }
            for (const name of ["Open in a tab (handoff)", "Same-origin proxy", "Reader mode", "Re-probe"]) await expect(win.getByRole("button", { name, exact: true })).toBeVisible();
            await page.evaluate(() => document.fonts.ready);
            const path = `docs/screens/tt134-review-repairs/browser-${verdict}-${mode}.png`;
            await win.screenshot({ path, animations: "disabled" });
            records.push({ app: `browser-${verdict}`, mode, path, words: (await win.locator(".fs-winbody").innerText()).trim().split(/\s+/).length, proof });
            assert.deepEqual(errors, []);
          } finally { await page.close(); }
        });
      }
      await test(`${mode} Spec: all register rows remain; native mouse/keyboard disclosure retains every real question, status, pass criterion, fallback and result`, {}, async () => {
        const features = await fx.api<{ rows: { code: string }[] }>("GET", "/api/features");
        const spikes = await fx.api<{ rows: { code: string; question: string; status: string; pass: string; fallback: string; result: string }[] }>("GET", "/api/spikes");
        // TT148: the register only ever grows, so a fixed 647 both rotted and hid the
        // question. The floor is the count this check was written against; the real
        // invariant (nothing paginated away) is the rendered-vs-API comparison below.
        assert.ok(features.rows.length >= 647, `the register lost rows: ${features.rows.length} < 647`);
        assert.ok(spikes.rows.length > 0);
        await fx.windows("spec", 1, width); const page = await context.newPage();
        try {
          await fx.ready(page, "spec"); const win = page.locator('[data-win-id="w1"]'), group = win.getByTestId("spec-spikes");
          await expect(win.getByTestId("spec-row")).toHaveCount(features.rows.length);
          const rendered = await win.getByTestId("spec-row").evaluateAll(els => els.map(el => el.getAttribute("data-code")));
          assert.deepEqual([...rendered].sort(), features.rows.map(row => row.code).sort(), "not paginated/removed to win a density count");
          const ledger = await fx.api<{ rows: Record<string, { tested: string }> }>("GET", "/api/ledger");
          const marks = await win.getByTestId("spec-row").evaluateAll(rows => rows.map(row => ({ code: row.getAttribute("data-code")!, label: row.querySelector('[role="img"]')?.getAttribute("aria-label"), title: row.querySelector('[role="img"]')?.getAttribute("title"), externalArtwork: row.querySelectorAll("svg image,svg use").length })));
          for (const mark of marks) { assert.equal(mark.label, `Saved coverage: ${ledger.rows[mark.code]?.tested ?? "none"}`); assert.match(mark.title ?? "", /not one fresh run/); assert.equal(mark.externalArtwork, 0); }
          const portable = win.locator('[data-testid="spec-row"][data-code="NT-19"]'); await portable.getByRole("button").click(); await expect(portable).toContainText("No offline replay"); await portable.getByRole("button").press("Enter"); await expect(portable).not.toContainText("No offline replay");
          await expect(group.getByTestId("spec-spike")).toHaveCount(spikes.rows.length);
          await expect(group.locator("summary")).toHaveText(`Questions & checks (${spikes.rows.length})`);
          assert.equal(await group.getAttribute("open"), null);
          await page.evaluate(() => document.fonts.ready);
          let path = `docs/screens/tt134-review-repairs/spec-collapsed-${mode}.png`;
          await win.screenshot({ path, animations: "disabled" });
          records.push({ app: "spec-collapsed", mode, path, words: (await win.locator(".fs-winbody").innerText()).trim().split(/\s+/).length });
          await group.locator("summary").click(); await expect(group).toHaveAttribute("open", "");
          for (const spike of spikes.rows) {
            const row = group.locator(`[data-testid="spec-spike"][data-code="${spike.code}"]`), text = normalize(await row.innerText());
            for (const field of ["code", "question", "status", "pass", "fallback", "result"] as const) if (spike[field]) assert.ok(text.includes(normalize(spike[field])), `${spike.code} lost ${field}`);
          }
          path = `docs/screens/tt134-review-repairs/spec-expanded-${mode}.png`;
          await win.screenshot({ path, animations: "disabled" });
          records.push({ app: "spec-expanded", mode, path, words: (await win.locator(".fs-winbody").innerText()).trim().split(/\s+/).length });
          await group.locator("summary").press("Enter"); assert.equal(await group.getAttribute("open"), null);
          await group.locator("summary").press("Space"); await expect(group).toHaveAttribute("open", "");
        } finally { await page.close(); }
      });
      await test(`${mode} Beam: concise labels retain the file control, real capability distinctions and every blocked transport explanation`, {}, async () => {
        await fx.windows("beam", 1, width); const page = await context.newPage();
        try {
          await fx.ready(page, "beam"); const win = page.locator('[data-win-id="w1"]');
          await expect(win.getByRole("heading", { name: "Browser transports", exact: true })).toBeVisible();
          const file = win.getByLabel("Media to cast", { exact: true }); await expect(file).toBeVisible();
          const gap = await file.evaluate(element => {
            const label = element.closest("label"); if (!label?.firstChild) return -1;
            const text = document.createRange(); text.selectNodeContents(label.firstChild);
            const measured = element.getBoundingClientRect().left - text.getBoundingClientRect().right; text.detach(); return measured;
          });
          assert.ok(gap >= 4, `Local media label touches the native file picker (${gap}px)`);
          for (const label of ["AirPlay audio (RAOP/ALAC) direct", "Google Cast (castv2) direct", "AirPlay screen mirroring (FairPlay)", "DLNA / UPnP", "Miracast", "Act as an AirPlay / Cast receiver"]) await expect(win.getByText(label, { exact: true })).toBeVisible();
          assert.ok(await win.getByText("Missing primitive:", { exact: false }).count() >= 6);
          await expect(win.getByText(/receivers:/)).toBeVisible(); await expect(win.getByText(/unknown targets require/)).toBeVisible();
          await page.evaluate(() => document.fonts.ready);
          const path = `docs/screens/tt134-review-repairs/beam-${mode}.png`; await win.screenshot({ path, animations: "disabled" });
          records.push({ app: "beam", mode, path, words: (await win.locator(".fs-winbody").innerText()).trim().split(/\s+/).length, proof: { localFileGapPx: gap } });
        } finally { await page.close(); }
      });
    } finally { await context.close(); }
  }
} finally {
  writeFileSync("docs/evidence/tt134-review-repairs.json", JSON.stringify({ scope: "Actual presentation-repair attacks and supplemental captures, not new Class A features or universal device acceptance", records }, null, 2) + "\n");
  await fx.close(); finish();
}
