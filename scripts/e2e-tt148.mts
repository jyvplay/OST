/**
 * TT148 — the two engines from this turn, exercised by the real browser.
 *
 * Pure suite: `tt148-core.mts` proves the rules. This one proves the rules are
 * wired to a running Chromium and a running server:
 *
 *  FF-06  a real AVIF written under a `.heic` name must produce a thumbnail,
 *         and the pixels must come from the decoder — not from the name.
 *         A real HEIC (libheif/HEVC bytes) must be refused, and the in-page
 *         decoder must reject the very same bytes, so the panel's sentence is
 *         the engine's truth rather than a guess about extensions.
 *  IN-04  the capture box must read physical keys, separate "the browser takes
 *         this" from "this app already uses this", and consume the chord so a
 *         captured shortcut cannot also open six windows behind the panel.
 *
 * Both fixtures are produced outside the app (`scripts/oracle/avif_fixture.py`,
 * `scripts/oracle/heic_fixture.py`) — one implementation writes the bytes, a
 * different one is asked what they are.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { BINDINGS, comboFor } from "../src/lib/shortcuts.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt148");

type Fixture = { bytes: string; width?: number; height?: number; brand?: string };
function fixture(path: string, name: string): Fixture {
  try { return JSON.parse(readFileSync(path, "utf8")) as Fixture; } catch {
    throw new Error(`${name} is missing — run scripts/oracle/${name === "AVIF" ? "avif" : "heic"}_fixture.py first (the suite refuses to assert against nothing)`);
  }
}

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}

const browser = await launchChromium();

/**
 * Open exactly one module, in a fresh context, from a clean desktop.
 *
 * The shell restores whatever desktop the server holds, so a suite that only
 * navigates inherits the previous suite's windows — and then scopes its
 * locators to a window that is not the module it asked for. Resetting the
 * desktop first makes the assertions about this module only.
 */
async function openAt(module: string, path?: string) {
  // The desktop is written directly rather than requested through `?open=`:
  // the deep link depends on boot order, while a written window is exactly the
  // thing the suite wants to look at.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", {
      id: "default", revision: Number(cur.row?.revision ?? 1) + 1000,
      state: {
        windows: [{ id: "w1", module, title: module, x: 10, y: 10, w: 1240, h: 860, z: 10, workspace: 1, props: path ? { path } : {} }],
        focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
      },
    });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const win = page.locator('[data-win-id="w1"]');
    await win.waitFor();
    try {
      await page.waitForFunction((id) => {
        const el = document.querySelector('[data-win-id="w1"]');
        return Boolean(el?.querySelector(".fs-winbody > *")) && (el?.getAttribute("aria-label") ?? "").toLowerCase().includes(id);
      }, module, { timeout: 25_000 });
      return { page, context, errors, win };
    } catch (e) {
      await context.close();
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`the shell never showed the ${module} window`);
}

const avif = fixture("/tmp/tt148-avif.json", "AVIF");
const heic = fixture("/tmp/tt148-heic.json", "HEIC");

await test("FF-06 an AVIF named .heic becomes a real thumbnail in Files — and the decoder agrees it is decodable", { "FF-06": "full" }, async () => {
  // The mix-up this row exists for: the same container, a name from the other format.
  const target = `/Documents/tt148-avif-as-heic-${Date.now()}.heic`;
  const w = await api("POST", "/api/fs", { op: "write", path: target, content: avif.bytes, encoding: "base64", mime: "image/heic" });
  assert.equal((w as { ok?: boolean }).ok, true, `the fixture could not be written: ${JSON.stringify(w).slice(0, 200)}`);

  const { page, context, errors, win } = await openAt("files", "/Documents");
  try {
    // What the engine itself says about these bytes, asked in this page: the
    // thumbnail is only trustworthy if the decoder really produced it.
    const engine = await page.evaluate(async (b64: string) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      try {
        const bmp = await createImageBitmap(new Blob([raw], { type: "image/avif" }));
        const out = { ok: true, w: bmp.width, h: bmp.height };
        bmp.close();
        return out;
      } catch (e) { return { ok: false, w: 0, h: 0, why: String(e) }; }
    }, avif.bytes);

    const row = win.locator(`[data-path="${target}"]`);
    await row.waitFor();
    if (!engine.ok) {
      // An engine without an AVIF decoder is a legitimate platform, and then the
      // honest expectation is the refusal — never a green tick for nothing.
      await win.getByTitle("grid view").click();
      const thumb = row.locator("[data-thumb]");
      await thumb.waitFor();
      assert.equal(await thumb.getAttribute("data-thumb"), "none", "no decoder means no thumbnail, not a placeholder image");
      const title = (await thumb.getAttribute("title")) ?? "";
      assert.match(title, /AVIF|cannot be decoded/i, `the refusal must name what happened: ${title}`);
      console.log(`    (this engine cannot decode AVIF: ${engine.why} — the refusal path was asserted instead)`);
      return;
    }
    assert.deepEqual([engine.w, engine.h], [avif.width, avif.height], "the engine disagrees with the fixture's own dimensions");

    await win.getByTitle("grid view").click();
    const thumb = row.locator("[data-thumb]");
    await thumb.waitFor();
    await page.waitForFunction((p) => {
      const el = document.querySelector(`[data-path="${p}"] [data-thumb]`);
      return el?.getAttribute("data-thumb") === "ready";
    }, target, { timeout: 30_000 });
    const img = thumb.locator("img");
    await img.waitFor();
    const drawn = await img.evaluate((el) => {
      const i = el as HTMLImageElement;
      return { w: i.naturalWidth, h: i.naturalHeight, blob: i.src.startsWith("blob:"), alt: i.getAttribute("alt") ?? "" };
    });
    assert.deepEqual([drawn.w, drawn.h], [avif.width, avif.height], "the thumbnail is the decoded picture, not an icon or a stretched placeholder");
    assert.equal(drawn.blob, true, "the preview is a locally rendered blob URL, not a fetch to a third party");
    assert.match(drawn.alt, /avif-as-heic/, "the preview names the file it belongs to");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

await test("FF-06 a real HEIC is refused by the app and by the engine in the same page — the sentence is measured", { "FF-06": "full" }, async () => {
  const target = `/Documents/tt148-genuine-heic-${Date.now()}.heic`;
  const w = await api("POST", "/api/fs", { op: "write", path: target, content: heic.bytes, encoding: "base64", mime: "image/heic" });
  assert.equal((w as { ok?: boolean }).ok, true, `the fixture could not be written: ${JSON.stringify(w).slice(0, 200)}`);

  const { page, context, errors, win } = await openAt("files", "/Documents");
  try {
    const engine = await page.evaluate(async (b64: string) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      try {
        const bmp = await createImageBitmap(new Blob([raw], { type: "image/heic" }));
        const out = { ok: true, w: bmp.width, h: bmp.height };
        bmp.close();
        return out;
      } catch (e) { return { ok: false, w: 0, h: 0, why: String(e) }; }
    }, heic.bytes);

    await win.getByTitle("grid view").click();
    const row = win.locator(`[data-path="${target}"]`);
    await row.waitFor();
    const thumb = row.locator("[data-thumb]");
    await thumb.waitFor();
    await page.waitForFunction((p) => {
      const el = document.querySelector(`[data-path="${p}"] [data-thumb]`);
      return el?.getAttribute("data-thumb") !== "pending";
    }, target, { timeout: 30_000 });
    const state = await thumb.getAttribute("data-thumb");
    const title = (await thumb.getAttribute("title")) ?? "";

    if (engine.ok) {
      // A browser with an HEVC image decoder (Safari ships one) must show the
      // picture; asserting a refusal there would be an assertion about the box.
      assert.equal(state, "ready", "this engine decodes HEIC, so the file must be shown");
      console.log("    (this engine decodes HEVC images — the decode path was asserted instead of the refusal)");
      return;
    }
    assert.equal(state, "none", "an undecodable HEIC must not fabricate a preview");
    assert.match(title, /no HEIC \(HEVC image\) decoder/, `the reason must name the missing decoder, not the file: ${title}`);
    assert.match(title, /convert the file to AVIF, PNG or JPEG/, "the refusal has to leave the user with an action");
    assert.doesNotMatch(title, /corrupt|damaged|invalid/i, "a format the engine lacks is not a damaged file");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

await test("IN-04 the capture box reads the physical chord and separates browser-reserved from app-owned", { "IN-04": "full" }, async () => {
  const { page, context, errors, win } = await openAt("settings");
  try {
    await win.getByRole("tab", { name: /^Shortcuts$/i }).click();
    const box = win.getByTestId("capture-box");
    await box.waitFor();
    const chord = win.getByTestId("capture-chord");
    assert.match(await chord.innerText(), /click here, then press a combination/i);

    // A chord nobody else wants: it reaches the page.
    await box.click();
    await page.keyboard.press("Control+Shift+KeyK");
    await page.waitForFunction(() => document.querySelector('[data-testid="capture-chord"]')?.textContent?.includes("K"));
    assert.equal(await chord.innerText(), "Ctrl+Shift+K");
    assert.equal(await win.getByTestId("capture-verdict").innerText(), "reaches the page");

    // A browser-reserved chord: the panel must say the browser wins, and say why.
    await page.keyboard.press("Control+KeyT");
    await page.waitForFunction(() => document.querySelector('[data-testid="capture-chord"]')?.textContent === "Ctrl+T");
    assert.equal(await win.getByTestId("capture-verdict").innerText(), "not usable");
    const why = await win.getByTestId("capture-why").innerText();
    assert.match(why, /new tab|browser/i, `the reserved reason must name the browser's own use: ${why}`);

    // A chord this app already binds: a different kind of clash, said differently.
    const own = comboFor(BINDINGS.find((b) => b.id === "palette")!, "hybrid");
    assert.equal(own, "Ctrl+Space");
    await page.keyboard.press("Control+Space");
    await page.waitForFunction(() => document.querySelector('[data-testid="capture-chord"]')?.textContent === "Ctrl+Space");
    const ownWhy = await win.getByTestId("capture-why").innerText();
    assert.match(ownWhy, /this app's own binding|Command palette/i, `an app binding must be named as ours, not as the browser's: ${ownWhy}`);
    assert.doesNotMatch(ownWhy, /browser|tab|address bar/i, `an app-owned clash must not be blamed on the browser: ${ownWhy}`);

    // The disclosure states the real limit and never claims an OS-wide hotkey.
    const limit = await win.getByTestId("capture-limit").innerText();
    assert.match(limit, /only while this window has focus/i);
    assert.doesNotMatch(limit, /global|system-wide|anywhere|always/i);

    await win.getByTestId("capture-clear").click();
    assert.match(await chord.innerText(), /cleared/i);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

await test("IN-04 capturing a chord consumes it: the shell must not act on a key the panel is capturing", { "IN-04": "full" }, async () => {
  const { page, context, errors, win } = await openAt("settings");
  try {
    await win.getByRole("tab", { name: /^Shortcuts$/i }).click();
    const box = win.getByTestId("capture-box");
    await box.waitFor();
    const windowsBefore = await page.locator('[data-win-id]').count();
    await box.click();
    // "files" is a real binding: if the event escaped the box, a Files window
    // would open behind the panel — the classic way a capture UI breaks a shell.
    for (const key of ["Meta+KeyE", "Control+Space", "Meta+KeyA"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
    }
    assert.equal(await page.locator('[data-win-id]').count(), windowsBefore, "the shell acted on a captured chord");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

finish();
await browser.close();
