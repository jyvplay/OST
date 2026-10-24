/**
 * Real-browser suite "e2e-tt33" (TT33) in headless Chromium against the production build: TIDAL, Qobuz and Amazon
 * Music in the Video / Music players, one-player-at-a-time, embed codes, library and a modal shortcut.
 *
 * Honesty: the providers are NOT reachable from this sandbox; requests to their hosts are intercepted.
 *   - TIDAL: the intercepted https://embed.tidal.com/… page runs TIDAL's OWN bridge code — message-bridge.js and
 *     url-options.js copied unmodified from github.com/tidal-music/embed-player (Apache-2.0, scripts/fixtures/
 *     tidal-embed/) — wired to a stand-in play button exactly the way TIDAL's app.js wires it (onRequestPlay /
 *     onRequestPause click the play button; a start calls requestPauseOfSiblingEmbeds). So Fusion's independently
 *     written controller is checked against the provider's real message handling. What is NOT exercised: TIDAL's
 *     servers, sign-in, DRM audio.
 *   - Qobuz / Amazon Music: no control protocol exists; their frames are blank stand-ins. The suite checks the exact
 *     player address, size and permissions Fusion gives the provider's iframe, and that no request is made before
 *     consent — not that the provider's player renders.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt33.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt33");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const readFile = async (p: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(p)}`); return r.status === 200 ? String(r.json.node.content) : null; };
const getSetting = async (key: string) => (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === key)?.value as string | undefined;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const writeFile = (p: string, content: string) => api("POST", "/api/fs", { op: "write", path: p, content, mime: "application/json" });
const removeFile = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`timed out: ${what}`); }
const win = (id: string, module: string, props: Record<string, unknown> = {}, r = { x: 10, y: 10, w: 1380, h: 800 }) => ({ id, module, title: module, ...r, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });

/* ---------------------------------------------- TIDAL: the provider's own bridge, wired as in its app.js */
const BRIDGE = readFileSync("scripts/fixtures/tidal-embed/message-bridge.js", "utf8");
const URLOPT = readFileSync("scripts/fixtures/tidal-embed/url-options.js", "utf8");
const TIDAL_PAGE = `<!doctype html><title>TIDAL bridge fixture</title><body style="background:#000;color:#fff;font:14px sans-serif">
<button id="pp" class="play-pause-button">play</button> <span id="st">IDLE</span>
<script type="module">
import MessageBridge from "/__fixture/message-bridge.js";
window.fx = { cmds: [], state: "IDLE" };
const bridge = new MessageBridge();
const pp = document.getElementById("pp"), st = document.getElementById("st");
// stand-in for the SDK player: the button toggles; a START tells the parent (TIDAL app.js: requestPauseOfSiblingEmbeds)
pp.addEventListener("click", () => {
  if (fx.state === "PLAYING") fx.state = "PAUSED"; else { fx.state = "PLAYING"; bridge.requestPauseOfSiblingEmbeds(); }
  st.textContent = fx.state;
});
// TIDAL app.js lines 850–866: commands click the play button when the state differs
bridge.onRequestPause(() => { fx.cmds.push("pause"); if (fx.state === "PLAYING") pp.click(); });
bridge.onRequestPlay(() => { fx.cmds.push("play"); if (fx.state !== "PLAYING") pp.click(); });
fx.ready = true;
</script>`;
const BLANK = (name: string) => `<!doctype html><title>${name} stand-in</title><body style="background:#eee">${name} stand-in (provider not reachable from the sandbox)`;
const EXTERNAL = /(tidal|qobuz|amazon|spotify|youtube|soundcloud)\./i;
const browser: Browser = await launchChromium();
type Seen = { url: string; type: string };
async function boot(windows: unknown[]): Promise<{ page: Page; ctx: BrowserContext; seen: Seen[]; close: () => Promise<void> }> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const seen: Seen[] = [];
  await ctx.route(EXTERNAL, async (route) => {
    const r = route.request(); const u = new URL(r.url());
    seen.push({ url: r.url(), type: r.resourceType() });
    if (u.hostname === "embed.tidal.com" && u.pathname === "/__fixture/message-bridge.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: BRIDGE });
    if (u.hostname === "embed.tidal.com" && u.pathname === "/__fixture/url-options.js") return route.fulfill({ status: 200, contentType: "text/javascript", body: URLOPT });
    if (r.resourceType() === "document") {
      const body = u.hostname === "embed.tidal.com" ? TIDAL_PAGE : BLANK(u.hostname);
      return route.fulfill({ status: 200, contentType: "text/html", body });
    }
    return route.fulfill({ status: 204, body: "" });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  return { page, ctx, seen, close: () => ctx.close() };
}
/** the TIDAL fixture frame inside one app's stage (sa = Music, sv = Video) */
async function tidalFrame(page: Page, pfx: string): Promise<Frame> {
  let f: Frame | null = null;
  await poll(async () => { f = await (await page.getByTestId(`${pfx}-frame`).elementHandle())?.contentFrame() ?? null; return !!f && (await f.evaluate("!!(window.fx && window.fx.ready)").catch(() => false)) as boolean; }, `${pfx} TIDAL fixture ready`);
  return f!;
}
const status = (page: Page, pfx: string) => page.getByTestId(`${pfx}-clock`).getAttribute("data-status");
const clockText = async (page: Page, pfx: string) => ((await page.getByTestId(`${pfx}-clock`).textContent()) ?? "").trim();

const SETTINGS = ["media.embeds"];
const saved: Record<string, string | undefined> = {};
for (const k of SETTINGS) saved[k] = await getSetting(k);
const LIB = "/Documents/Streams.json";
const libBackup = await readFile(LIB);
const TR = "https://tidal.com/browse/track/1766030", VID = "https://tidal.com/video/71196108";

try {
  await test("TIDAL (SM-05): click-to-load gate names embed.tidal.com + the 30-second/sign-in note and sends nothing before consent; against TIDAL's real bridge: Play → 'Started', Pause → 'Pause sent' (flagged assumed), a start inside the player → 'Started'; spoofed starts (our own window, a foreign pid) ignored",
    { "SM-05": "full" }, async () => {
      await setSetting("media.embeds", "ask");
      const { page, seen, close } = await boot([win("m1", "music")]);
      try {
        await page.getByTestId("sa-url").fill(TR);
        await page.getByTestId("sa-play").click();
        const facade = page.getByTestId("sa-facade");
        await facade.waitFor();
        const note = (await page.getByTestId("sa-access-note").textContent()) ?? "";
        ok(/embed\.tidal\.com/.test((await facade.textContent()) ?? "") && /30-second/.test(note) && /sign/.test(note), `facade: ${note}`);
        ok(!seen.some((s) => /tidal\./.test(s.url)), "nothing sent to TIDAL before consent");
        await page.getByTestId("sa-load").click();
        const src = await page.getByTestId("sa-frame").getAttribute("src");
        const u = new URL(src!);
        ok(u.origin + u.pathname === "https://embed.tidal.com/tracks/1766030" && /^fusion-m1-\d+$/.test(u.searchParams.get("pid") ?? ""), `src ${src}`);
        const pid = u.searchParams.get("pid")!;
        ok(((await page.getByTestId("sa-frame").getAttribute("allow")) ?? "").includes("encrypted-media"), "allow encrypted-media");
        ok((await page.getByTestId("sa-frame").evaluate((el) => (el as HTMLElement).offsetHeight)) === 120, "TIDAL's track size");
        const f = await tidalFrame(page, "sa");
        await poll(async () => (await page.getByTestId("sa-clock").getAttribute("data-connected")) === "1", "usable after load");
        ok(await page.getByTestId("sa-toggle").count() === 0 && await page.getByTestId("sa-ctl-play").isEnabled() && await page.getByTestId("sa-ctl-pause").isEnabled(), "one-way player offers Play and Pause");
        // our Play → the real bridge → the stand-in starts → the real bridge reports the start with OUR pid
        await page.getByTestId("sa-ctl-play").click();
        await poll(async () => (await status(page, "sa")) === "playing", "started");
        ok(await clockText(page, "sa") === "Started" && (await f.evaluate("fx.state")) === "PLAYING" && JSON.stringify(await f.evaluate("fx.cmds")) === '["play"]', "Play reached the player");
        await page.getByTestId("sa-ctl-pause").click();
        await poll(async () => (await f.evaluate("fx.state")) === "PAUSED", "player paused");
        ok(await clockText(page, "sa") === "Pause sent" && (await page.getByTestId("sa-clock").getAttribute("data-assumed")) === "1", "pause is shown as sent, not confirmed");
        // spoofs: our own window (wrong source) and a start from the frame that names another player
        await page.evaluate((p) => window.postMessage(JSON.stringify({ activatePlayerId: p }), "*"), pid);
        await f.evaluate(() => parent.postMessage(JSON.stringify({ activatePlayerId: "fusion-someone-else" }), "*"));
        await page.waitForTimeout(400);
        ok(await clockText(page, "sa") === "Pause sent", "spoofed starts ignored");
        // the listener starts playback INSIDE TIDAL's player → the bridge's own start signal reaches us
        await f.locator("#pp").click();
        await poll(async () => (await status(page, "sa")) === "playing" && (await page.getByTestId("sa-clock").getAttribute("data-assumed")) === "0", "in-player start");
        ok(JSON.stringify(await f.evaluate("fx.cmds")) === '["play","pause"]', "no extra commands were sent");
      } finally { await close(); }
    });

  await test("one player at a time (SM-08): a TIDAL video started in Video pauses the TIDAL track playing in Music through TIDAL's real bridge; Music shows 'Pause sent'; Music refuses a video link with a pointer to Video",
    { "SM-08": "full", "SM-05": "full" }, async () => {
      await setSetting("media.embeds", "allow");
      const { page, close } = await boot([win("v1", "video", { url: VID }, { x: 10, y: 10, w: 700, h: 760 }), win("m1", "music", { url: TR }, { x: 720, y: 10, w: 700, h: 760 })]);
      try {
        ok(new URL((await page.getByTestId("sv-frame").getAttribute("src"))!).pathname === "/videos/71196108", "TIDAL video plays in Video");
        const fm = await tidalFrame(page, "sa"), fv = await tidalFrame(page, "sv");
        await poll(async () => (await page.getByTestId("sa-clock").getAttribute("data-connected")) === "1" && (await page.getByTestId("sv-clock").getAttribute("data-connected")) === "1", "both usable");
        await page.getByTestId("sa-ctl-play").click();
        await poll(async () => (await status(page, "sa")) === "playing", "music started");
        await page.getByTestId("sv-ctl-play").click();
        await poll(async () => (await status(page, "sv")) === "playing", "video started");
        await poll(async () => (await fm.evaluate("fx.state")) === "PAUSED", "music's player was paused");
        ok(await clockText(page, "sa") === "Pause sent" && JSON.stringify(await fm.evaluate("fx.cmds")) === '["play","pause"]' && (await fv.evaluate("fx.state")) === "PLAYING", "exactly one pause went to Music; Video keeps playing");
        await page.getByTestId("sa-url").fill(VID);
        await page.getByTestId("sa-play").click();
        ok(/video link — open it in Video/.test((await page.getByTestId("sa-error").textContent()) ?? ""), "kind check");
      } finally { await close(); }
    });

  await test("Qobuz + Amazon Music (SM-06, SM-07): store link → widget.qobuz.com with the page's zone at 390 px with encrypted-media; Amazon Share → Embed code pasted → the issued address minus tracking; a page link → built address + the 'use Share → Embed' note; neither offers controls it cannot honour",
    { "SM-06": "full", "SM-07": "full", "SM-08": "full" }, async () => {
      await setSetting("media.embeds", "ask");
      const { page, seen, close } = await boot([win("m1", "music")]);
      try {
        await page.getByTestId("sa-url").fill("https://www.qobuz.com/fr-fr/album/embed-lux/v6lslmwybzkbb");
        await page.getByTestId("sa-play").click();
        ok(/excerpts/.test((await page.getByTestId("sa-access-note").textContent()) ?? "") && (await page.getByTestId("sa-open-site").getAttribute("href")) === "https://open.qobuz.com/album/v6lslmwybzkbb", "Qobuz facade");
        ok(!seen.some((s) => /qobuz\./.test(s.url)), "nothing sent to Qobuz before consent");
        await page.getByTestId("sa-load").click();
        const q = page.getByTestId("sa-frame");
        ok((await q.getAttribute("src")) === "https://widget.qobuz.com/album/v6lslmwybzkbb?zone=FR-fr", `qobuz src ${await q.getAttribute("src")}`);
        ok((await q.evaluate((el) => (el as HTMLElement).offsetHeight)) === 390 && ((await q.getAttribute("allow")) ?? "").includes("encrypted-media"), "size + DRM permission");
        ok((await page.getByTestId("sa-toggle").count()) + (await page.getByTestId("sa-ctl-play").count()) + (await page.getByTestId("sa-clock").count()) === 0, "no transport for a player without a control protocol");
        await poll(async () => seen.some((s) => s.url.startsWith("https://widget.qobuz.com/album/v6lslmwybzkbb") && s.type === "document"), "the widget was requested after consent");
        // Amazon: a real Share → Embed snippet (HTML-escaped &, with an affiliate tag that must be dropped)
        const snippet = `<iframe id='AmazonMusicEmbedB001MTVGS8' src='https://music.amazon.co.uk/embed/B001MTVGS8/?id=FpAGPnGH0e&amp;tag=someone-21&amp;marketplaceId=A1F83G8C2ARO7P&amp;musicTerritory=GB' width='100%' height='550px'></iframe>`;
        await page.getByTestId("sa-url").fill(snippet);
        await page.getByTestId("sa-play").click();
        let note = (await page.getByTestId("sa-access-note").textContent()) ?? "";
        ok(/30-second/.test(note) && !/Share → Embed/.test(note), `issued embed note: ${note}`);
        await page.getByTestId("sa-load").click();
        const a = page.getByTestId("sa-frame");
        ok((await a.getAttribute("src")) === "https://music.amazon.co.uk/embed/B001MTVGS8/?id=FpAGPnGH0e&marketplaceId=A1F83G8C2ARO7P&musicTerritory=GB", `amazon src ${await a.getAttribute("src")}`);
        ok((await a.evaluate((el) => (el as HTMLElement).offsetHeight)) === 550, "Amazon's issued height");
        await page.getByTestId("sa-url").fill("https://music.amazon.com/albums/B076YSK8CS");
        await page.getByTestId("sa-play").click();
        note = (await page.getByTestId("sa-access-note").textContent()) ?? "";
        ok(/Share → Embed/.test(note) && /music\.amazon\.com/.test(note), `built-address note: ${note}`);
        await page.getByTestId("sa-url").fill("https://music.amazon.com/artists/B000QJPQTA/pharrell");
        await page.getByTestId("sa-play").click();
        ok(/no embedded player for artists/.test((await page.getByTestId("sa-error").textContent()) ?? ""), "artist refused with a reason");
      } finally { await close(); }
    });

  await test("library + modal shortcut (SM-08): TIDAL / Qobuz / Amazon links saved show their provider; Next walks them; the Rename dialog traps Escape (closes the dialog only — title unchanged, window open) and Enter renames",
    { "SM-08": "full" }, async () => {
      await setSetting("media.embeds", "ask");
      await removeFile(LIB);
      const { page, close } = await boot([win("m1", "music")]);
      try {
        for (const u of ["https://music.amazon.com/albums/B076YSK8CS", "https://open.qobuz.com/album/v6lslmwybzkbb", TR]) {
          await page.getByTestId("sa-url").fill(u);
          await page.getByTestId("sa-save").click();
        }
        await poll(async () => (await page.getByTestId("sa-item").count()) === 3, "3 items");
        const subs = await page.locator("[data-testid=sa-item] .fs-stream-item-sub").allTextContents();
        ok(JSON.stringify(subs) === JSON.stringify(["TIDAL", "Qobuz", "Amazon Music"]), `labels ${subs}`);
        await page.getByTestId("sa-item-play").first().click();
        ok((await page.getByTestId("sa-stage").getAttribute("data-provider")) === "tidal", "first = TIDAL");
        await page.getByTestId("sa-next").click();
        ok((await page.getByTestId("sa-stage").getAttribute("data-provider")) === "qobuz", "Next → Qobuz");
        await page.getByTestId("sa-next").click();
        ok((await page.getByTestId("sa-stage").getAttribute("data-provider")) === "amazonmusic", "Next → Amazon Music");
        const before = await page.locator("[data-testid=sa-item] .fs-stream-item-title").first().textContent();
        await page.getByTestId("sa-item-rename").first().click();
        const dlg = page.getByTestId("ask-dialog");
        await dlg.waitFor();
        await page.keyboard.press("Escape");
        await dlg.waitFor({ state: "detached" });
        ok((await page.getByTestId("sa-app").count()) === 1 && (await page.locator("[data-testid=sa-item] .fs-stream-item-title").first().textContent()) === before, "Escape closed only the dialog");
        await page.getByTestId("sa-item-rename").first().click();
        await page.getByTestId("ask-input-value").fill("Crazy in Love (TIDAL)").catch(async () => { await page.locator("[data-testid=ask-dialog] input").first().fill("Crazy in Love (TIDAL)"); });
        await page.keyboard.press("Enter");
        await poll(async () => (await page.locator("[data-testid=sa-item] .fs-stream-item-title").first().textContent()) === "Crazy in Love (TIDAL)", "renamed");
        await poll(async () => /Crazy in Love \(TIDAL\)/.test((await readFile(LIB)) ?? ""), "saved to Streams.json");
      } finally { await close(); }
    });
} finally {
  for (const k of SETTINGS) if (saved[k] !== undefined) await setSetting(k, saved[k]!);
  if (libBackup !== null) await writeFile(LIB, libBackup); else await removeFile(LIB);
  await desktop([]);
  await browser.close();
}
finish();
