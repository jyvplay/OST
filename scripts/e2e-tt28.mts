/**
 * Real-browser suite "e2e-tt28" (TT28) in headless Chromium against the production build:
 *   - SM-04 embed control: the parent side of the YouTube / Vimeo / SoundCloud postMessage protocols (handshake,
 *     subscriptions, progress, play/pause, ended → auto-next, same-player YouTube load), and that spoofed messages
 *     (our own window, a foreign-origin frame) are ignored
 *   - MP-04/MP-05 offline gazetteer (API + Maps UI, no third-party requests)
 *   - SH-15 in-app ask dialogs (focus, trap, modal shortcuts, cancel, masked double-entry passphrases)
 *   - LY-16/LY-17 Business Snap (layouts flyout, Snap Assist, corner drag with live preview, keyboard chord)
 *   - AX-13 accessibility-tree snapshots (Playwright ariaSnapshot; NOT a real screen reader)
 *   - LY-18/LY-19 Art dock auto-hide (edge / keyboard reveal, hide delay) and the genie minimise (and reduced motion)
 *
 * Honesty: the providers are NOT reachable from this sandbox. Requests to their player hosts are intercepted and
 * answered with a PROTOCOL FIXTURE — a small page that speaks the documented player-side messages and records what
 * it receives. This proves our side of the protocol against the published message formats; it does not prove the
 * real players' current behaviour (that needs network access to the providers).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt28.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const ORIGIN = new URL(BASE).origin;
const { test, finish } = makeHarness("e2e-tt28");
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
async function desktop(windows: unknown[], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev, ...extra } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`timed out: ${what}`); }
const win = (id: string, module: string, props: Record<string, unknown> = {}, r = { x: 10, y: 10, w: 1380, h: 800 }) => ({ id, module, title: module, ...r, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
export const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");

/* ------------------------------------------------------------------ protocol fixtures (player side) */
const FIX_COMMON = `window.fx={got:[],origin:null};addEventListener("message",function(e){var d=e.data;if(typeof d==="string"){try{d=JSON.parse(d)}catch(x){return}}fx.got.push(d);fx.origin=e.origin;fx.on&&fx.on(d)});`;
const FIXTURES: Record<string, string> = {
  youtube: `${FIX_COMMON}
    fx.post=function(o){o.id=fx.id||1;o.channel="widget";parent.postMessage(JSON.stringify(o),"*")};
    fx.on=function(d){
      if(d.event==="listening"){fx.id=d.id;fx.post({event:"initialDelivery",info:{playerState:5,currentTime:0,duration:30}});fx.post({event:"onReady"})}
      if(d.event==="command"){
        if(d.func==="playVideo")fx.post({event:"onStateChange",info:1});
        if(d.func==="pauseVideo")fx.post({event:"onStateChange",info:2});
        if(d.func==="loadVideoById"){fx.loaded=d.args[0];fx.post({event:"infoDelivery",info:{playerState:1,currentTime:0,duration:40}})}
      }};
    fx.progress=function(t,dur){fx.post({event:"infoDelivery",info:{currentTime:t,duration:dur}})};
    fx.end=function(){fx.post({event:"onStateChange",info:0})};`,
  vimeo: `${FIX_COMMON}
    fx.post=function(o){parent.postMessage(JSON.stringify(o),"*")};
    fx.on=function(d){if(d.method==="play")fx.post({event:"play"});if(d.method==="pause")fx.post({event:"pause"})};
    addEventListener("load",function(){fx.post({event:"ready",player_id:"x"})});
    fx.end=function(){fx.post({event:"ended",data:{seconds:61.8,duration:61.8,percent:1}})};`,
  soundcloud: `${FIX_COMMON}
    fx.post=function(o){parent.postMessage(JSON.stringify(o),"*")};
    fx.on=function(d){if(d.method==="play")fx.post({method:"play"});if(d.method==="pause")fx.post({method:"pause"})};
    addEventListener("load",function(){fx.post({method:"ready",value:null})});
    fx.progress=function(ms,rel){fx.post({method:"playProgress",value:{currentPosition:ms,relativePosition:rel,loadedProgress:1}})};
    fx.end=function(){fx.post({method:"finish"})};`,
  // Spotify embed side (TT29): OBJECT messages, speaks first with {type:"ready"}, answers {command:"toggle"}
  spotify: `${FIX_COMMON}
    fx.st={position:0,duration:30000,isPaused:true,isBuffering:false};
    fx.post=function(o){parent.postMessage(o,"*")};
    fx.upd=function(){fx.post({type:"playback_update",payload:{position:fx.st.position,duration:fx.st.duration,isPaused:fx.st.isPaused,isBuffering:false,playingURI:"spotify:track:fixture"}})};
    fx.on=function(d){if(d&&d.command==="toggle"){fx.st.isPaused=!fx.st.isPaused;fx.upd()}};
    addEventListener("load",function(){fx.post({type:"ready"})});
    fx.progress=function(ms,paused){fx.st.position=ms;fx.st.isPaused=paused;fx.upd()};`,
  // a hostile frame on another origin that tries to fake an "ended" for every provider format
  evil: `setTimeout(function(){parent.postMessage(JSON.stringify({event:"onStateChange",info:0,channel:"widget"}),"*");parent.postMessage(JSON.stringify({event:"ended"}),"*");parent.postMessage(JSON.stringify({method:"finish"}),"*");parent.postMessage({type:"playback_update",payload:{position:29900,duration:30000,isPaused:true}},"*")},50);`,
};
const fixtureFor = (host: string): string | null =>
  /youtube(-nocookie)?\.com$/.test(host) ? "youtube" : host === "player.vimeo.com" ? "vimeo" : host === "w.soundcloud.com" ? "soundcloud" : host === "open.spotify.com" ? "spotify" : host === "evil.example" ? "evil" : null;

const EXTERNAL = /(youtube|youtube-nocookie|ytimg|googlevideo|spotify|scdn|soundcloud|sndcdn|vimeo|dailymotion|twitch|openstreetmap|evil)\./i;
const browser: Browser = await launchChromium();
type Seen = { url: string; type: string };
async function boot(windows: unknown[], vw = 1440, vh = 900, extra: Record<string, unknown> = {}): Promise<{ page: Page; ctx: BrowserContext; seen: Seen[]; close: () => Promise<void> }> {
  await desktop(windows, extra);
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
  const seen: Seen[] = [];
  await ctx.route(EXTERNAL, async (route) => {
    const r = route.request(); const u = new URL(r.url());
    seen.push({ url: r.url(), type: r.resourceType() });
    const fx = fixtureFor(u.hostname);
    if (fx && r.resourceType() === "document") await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>protocol fixture: ${fx}</title><body style="background:#111;color:#eee">fixture ${fx}<script>${FIXTURES[fx]}</script>` });
    else await route.fulfill({ status: 204, body: "" });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  return { page, ctx, seen, close: () => ctx.close() };
}
const playerFrame = (page: Page, host: RegExp): Frame | undefined => page.frames().find((f) => { try { return host.test(new URL(f.url()).hostname); } catch { return false; } });
const fx = <T,>(f: Frame, js: string) => f.evaluate(js) as Promise<T>;

const SETTINGS = ["media.embeds", "appearance.layout", "appearance.dockAutoHide"];
const PLACES = "/Documents/Places.geojson";
const savedSettings: Record<string, string | undefined> = {};
for (const k of SETTINGS) savedSettings[k] = await getSetting(k);
const LIB = "/Documents/Streams.json";
const libBackup = await readFile(LIB);
const lib = (items: { id: string; url: string; title: string }[]) => JSON.stringify({ v: 1, items: items.map((i) => ({ ...i, provider: "x", kind: "x", added: "2026-10-17T00:00:00Z" })) });

try {
  await test("embed control (SM-04): YouTube handshake with origin + id, Play/Pause commands, progress clock, ended → auto-next by loadVideoById in the SAME player; spoofed 'ended' from our own window or a foreign-origin frame is ignored; Auto-next off stops", { "SM-04": "partial" }, async () => {
    await setSetting("media.embeds", "allow");
    await writeFile(LIB, lib([{ id: "a", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "First" }, { id: "b", url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", title: "Second" }, { id: "c", url: "https://www.youtube.com/watch?v=ccccccccccc", title: "Third" }]));
    const { page, seen, close } = await boot([win("v1", "video")]);
    try {
      await page.getByTestId("sv-item-play").first().click();
      await poll(async () => !!playerFrame(page, /youtube-nocookie/), "youtube frame");
      const src = new URL((await page.getByTestId("sv-frame").getAttribute("src"))!);
      ok(src.searchParams.get("enablejsapi") === "1" && src.searchParams.get("origin") === ORIGIN, `embed src carries enablejsapi + origin: ${src}`);
      const f = playerFrame(page, /youtube-nocookie/)!;
      await poll(async () => (await page.getByTestId("sv-clock").getAttribute("data-connected")) === "1", "handshake answered");
      const hs = await fx<{ event: string; id: string; channel: string }[]>(f, "fx.got.filter(function(d){return d.event==='listening'})");
      ok(hs.length >= 1 && hs[0].channel === "widget" && /^fusion-\d+$/.test(hs[0].id), `listening handshake ${JSON.stringify(hs[0])}`);
      ok(await fx<string>(f, "fx.origin") === ORIGIN, "messages come from our origin");
      ok((await page.getByTestId("sv-clock").textContent())?.includes("0:00 / 0:30"), `duration shown: ${await page.getByTestId("sv-clock").textContent()}`);
      await page.getByTestId("sv-toggle").click();
      await poll(async () => (await page.getByTestId("sv-clock").getAttribute("data-status")) === "playing", "Play → playing");
      ok((await fx<{ func?: string }[]>(f, "fx.got")).some((d) => d.func === "playVideo"), "playVideo command sent");
      await fx(f, "fx.progress(12.4, 30)");
      await poll(async () => (await page.getByTestId("sv-clock").textContent())?.includes("0:12 / 0:30") ?? false, "progress clock");
      await page.getByTestId("sv-toggle").click();
      await poll(async () => (await page.getByTestId("sv-clock").getAttribute("data-status")) === "paused", "Pause → paused");
      // spoofs: our own window, then a foreign-origin frame — neither may advance the queue
      const docs = () => seen.filter((s) => s.type === "document" && /youtube-nocookie/.test(s.url)).length;
      const docs0 = docs();
      await page.evaluate(() => { window.postMessage(JSON.stringify({ event: "onStateChange", info: 0, channel: "widget" }), "*"); });
      await page.evaluate(() => { const i = document.createElement("iframe"); i.src = "https://evil.example/x"; i.id = "evil"; i.style.cssText = "position:fixed;width:1px;height:1px;left:-9px"; document.body.appendChild(i); });
      await page.waitForTimeout(900);
      ok(await page.locator("[data-testid=sv-lib] li[data-current]").textContent().then((t) => t?.includes("First")), "spoofed 'ended' ignored (still on First)");
      // the real end → auto-next in the same frame
      await fx(f, "fx.end()");
      await poll(async () => (await page.locator("[data-testid=sv-lib] li[data-current]").textContent())?.includes("Second") ?? false, "auto-next to Second");
      await poll(async () => (await fx<string>(f, "fx.loaded||''")) === "bbbbbbbbbbb", "loadVideoById(Second) in the same player");
      ok(docs() === docs0, `no new player document was loaded (${docs0} → ${docs()})`);
      // Auto-next off
      await page.getByTestId("sv-auto").uncheck();
      await fx(f, "fx.end()");
      await page.waitForTimeout(700);
      ok((await page.locator("[data-testid=sv-lib] li[data-current]").textContent())?.includes("Second"), "Auto-next off: stays");
      ok((await page.getByTestId("sv-clock").getAttribute("data-status")) === "ended", "status shows ended");
    } finally { await close(); }
  });

  await test("embed control (SM-04): Vimeo ready → addEventListener subscriptions → ended advances to the next item (new player, autoplay requested); SoundCloud ready → subscriptions → playProgress clock → finish advances (auto_play=true); Spotify (TT29): ready → ack, Play → confirmed toggle, clock, a near-end pause is NOT an end, paused-at-end → inferred end → next Spotify player asked to play", { "SM-04": "partial" }, async () => {
    await setSetting("media.embeds", "allow");
    await writeFile(LIB, lib([{ id: "v", url: "https://vimeo.com/76979871", title: "Vim" }, { id: "y", url: "https://youtu.be/ddddddddddd", title: "Tube" },
      { id: "s1", url: "https://soundcloud.com/artist-a/track-one", title: "One" }, { id: "s2", url: "https://soundcloud.com/artist-b/track-two", title: "Two" }, { id: "sp", url: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT", title: "Spot" }, { id: "sp2", url: "https://open.spotify.com/track/1301WleyT98MSxVHPZCA6M", title: "Second spot" }]));
    const { page, close } = await boot([win("v1", "video", {}, { x: 10, y: 10, w: 900, h: 780 }), win("m1", "music", {}, { x: 920, y: 10, w: 500, h: 780 })]);
    try {
      // Vimeo
      await page.locator("[data-testid=sv-item-play]", { hasText: "Vim" }).click();
      await poll(async () => !!playerFrame(page, /player\.vimeo\.com/), "vimeo frame");
      const vf = playerFrame(page, /player\.vimeo\.com/)!;
      await poll(async () => (await fx<{ method?: string; value?: string }[]>(vf, "fx.got")).filter((d) => d.method === "addEventListener").length >= 4, "vimeo subscriptions");
      const subs = (await fx<{ method?: string; value?: string }[]>(vf, "fx.got")).filter((d) => d.method === "addEventListener").map((d) => d.value);
      ok(subs.includes("ended") && subs.includes("finish"), `subscribed ${subs}`);
      await page.getByTestId("sv-toggle").click();
      await poll(async () => (await fx<{ method?: string }[]>(vf, "fx.got")).some((d) => d.method === "play"), "vimeo play command");
      await fx(vf, "fx.end()");
      await poll(async () => (await page.locator("[data-testid=sv-lib] li[data-current]").textContent())?.includes("Tube") ?? false, "vimeo ended → next");
      const ysrc = new URL((await page.getByTestId("sv-frame").getAttribute("src"))!);
      ok(ysrc.hostname === "www.youtube-nocookie.com" && ysrc.searchParams.get("autoplay") === "1", `next player asks to autoplay: ${ysrc}`);
      // SoundCloud in Music
      await page.locator("[data-testid=sa-item-play]", { hasText: "One" }).click();
      await poll(async () => !!playerFrame(page, /w\.soundcloud\.com/), "soundcloud frame");
      const sf = playerFrame(page, /w\.soundcloud\.com/)!;
      await poll(async () => (await fx<{ method?: string }[]>(sf, "fx.got")).filter((d) => d.method === "addEventListener").length === 4, "sc subscriptions");
      await fx(sf, "fx.progress(30000, 0.25)");
      await poll(async () => (await page.getByTestId("sa-clock").textContent())?.includes("0:30 / 2:00") ?? false, "sc clock from relative position");
      await fx(sf, "fx.end()");
      await poll(async () => (await page.locator("[data-testid=sa-lib] li[data-current]").textContent())?.includes("Two") ?? false, "sc finish → next");
      ok(new URL((await page.getByTestId("sa-frame").getAttribute("src"))!).searchParams.get("auto_play") === "true", "next track asks to autoplay");
      // Spotify (TT29): object protocol — ready → ack; our Play sends the confirmed toggle; the clock follows
      // playback_update; paused at the end → inferred 'ended' → auto-next into a NEW Spotify player that is asked to play
      await page.locator("[data-testid=sa-item-play]", { has: page.locator(".fs-stream-item-title", { hasText: /^Spot$/ }) }).click();
      await poll(async () => !!playerFrame(page, /open\.spotify\.com/), "spotify frame");
      const pf = playerFrame(page, /open\.spotify\.com/)!;
      await poll(async () => (await page.getByTestId("sa-clock").getAttribute("data-connected")) === "1", "spotify connected");
      const acks = await fx<{ command?: string }[]>(pf, "fx.got");
      ok(acks.length === 1 && typeof acks[0] === "object" && acks[0].command === "load_complete_ack", `ready → one ack object ${JSON.stringify(acks)}`);
      ok(await fx<string>(pf, "fx.origin") === new URL(BASE).origin, "the embed sees our exact origin");
      await page.getByTestId("sa-toggle").click();
      await poll(async () => (await fx<{ command?: string }[]>(pf, "fx.got")).some((d) => d.command === "toggle"), "toggle command");
      await poll(async () => (await page.getByTestId("sa-clock").getAttribute("data-status")) === "playing", "spotify playing");
      ok((await page.getByTestId("sa-toggle").textContent())?.trim() === "Pause", "button now offers Pause");
      await fx(pf, "fx.progress(12000, false)");
      await poll(async () => (await page.getByTestId("sa-clock").textContent())?.includes("0:12 / 0:30") ?? false, "spotify clock");
      await fx(pf, "fx.progress(28000, true)");   // a user pause 2 s before the end is a pause, not an end
      await poll(async () => (await page.getByTestId("sa-clock").getAttribute("data-status")) === "paused", "near-end pause stays a pause");
      await new Promise((r) => setTimeout(r, 300));
      ok((await page.locator("[data-testid=sa-lib] li[data-current]").textContent())?.includes("Spot") && !(await page.locator("[data-testid=sa-lib] li[data-current]").textContent())?.includes("Second"), "no advance on a pause");
      await fx(pf, "fx.progress(29800, true)");   // paused at the end → ended → auto-next
      await poll(async () => (await page.locator("[data-testid=sa-lib] li[data-current]").textContent())?.includes("Second spot") ?? false, "spotify end → next");
      await poll(async () => { const f2 = playerFrame(page, /open\.spotify\.com/); return !!f2 && f2 !== pf && (await fx<{ command?: string }[]>(f2, "fx.got").catch(() => [])).some((d) => d.command === "toggle"); }, "next Spotify player is asked to play (ack + toggle)");
    } finally { await close(); }
  });
  /* ---------------------------------------------------------------- gazetteer (MP-04 / MP-05) */
  await test("offline gazetteer (MP-04/MP-05): API answers 'Paris, TX' and 'In Raleigh' with attribution; Maps search lists cities, flies there, 'Save as place' writes it; new places are named by the nearest city; hover says how far from which city; zero third-party requests", { "MP-04": "full", "MP-05": "full" }, async () => {
    const s = await api("GET", "/api/places/search?q=" + encodeURIComponent("Paris, TX"));
    ok(s.status === 200 && s.json.results[0]?.label === "Paris, TX, United States" && /GeoNames/.test(s.json.attribution), `search API ${JSON.stringify(s.json.results?.[0])}`);
    const n = await api("GET", "/api/places/near?lat=35.7796&lng=-78.6382");
    ok(n.status === 200 && n.json.results[0]?.description === "In Raleigh", `near API ${JSON.stringify(n.json.results?.[0])}`);
    ok((await api("GET", "/api/places/near?lat=abc&lng=1")).status === 400 && (await api("GET", "/api/places/near?lat=95&lng=1")).status === 400, "bad coordinates → 400");
    ok((await api("GET", "/api/places/search?q=" + "x".repeat(5000))).json.results.length === 0, "huge query is harmless");
    const placesBackup = await readFile(PLACES);
    await removeFile(PLACES);
    const { page, close } = await boot([win("m1", "maps")]);
    const foreign: string[] = [];
    page.on("request", (r) => { const u = r.url(); if (!u.startsWith(ORIGIN) && !u.startsWith("data:") && !u.startsWith("blob:")) foreign.push(u); });
    try {
      await poll(async () => (await page.getByTestId("mp-map").getAttribute("data-ready")) === "1", "map ready", 20_000);
      await page.getByTestId("mp-search").fill("Raleigh");
      const city = page.locator("[data-testid=mp-result][data-kind=city]").first();
      await poll(async () => ((await city.textContent()) ?? "").startsWith("Raleigh, NC, United States"), "city result");
      await city.click();
      await poll(async () => (await page.getByTestId("mp-found").getAttribute("data-city")) === "Raleigh", "found card");
      // regression (screenshot review): the pin must stay pin-sized DURING the fly animation, not balloon over the map
      for (let i = 0; i < 8; i++) {
        const b = await page.locator(".fs-maps-found-pin").boundingBox().catch(() => null);
        ok(!b || (b.width <= 30 && b.height <= 30), `found pin ${b?.width}×${b?.height} during flight`);
        await new Promise((r) => setTimeout(r, 120));
      }
      await poll(async () => { const m = page.getByTestId("mp-map"); return Math.abs(Number(await m.getAttribute("data-lat")) - 35.78) < 0.1 && Math.abs(Number(await m.getAttribute("data-lng")) + 78.64) < 0.1; }, "flew to Raleigh", 10_000);
      ok(/GeoNames/.test((await page.getByTestId("mp-found").textContent()) ?? ""), "attribution in the card");
      await page.getByTestId("mp-found-save").click();
      await poll(async () => { const f = await readFile(PLACES); return !!f && JSON.parse(f).features.some((x: { properties: { name: string } }) => x.properties.name === "Raleigh"); }, "Save as place → Places.geojson", 10_000);
      // Add at centre: the map centre is downtown Raleigh, so the place is named after it and gets a "where" note
      await page.getByTestId("mp-add-centre").click();
      await poll(async () => (await page.getByTestId("mp-place").count()) === 2, "second place");
      await poll(async () => (await page.getByTestId("mp-place-name").inputValue()) === "Raleigh", "auto-named by nearest city");
      await poll(async () => /In Raleigh|km .* of Raleigh/.test((await page.getByTestId("mp-status").textContent()) ?? ""), "status describes the spot");
      // hover: rest the pointer on the map → "… of <city>" / "In <city>"
      const box = (await page.getByTestId("mp-map").boundingBox())!;
      await page.mouse.move(box.x + box.width / 2 + 3, box.y + box.height / 2 + 2);
      await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2 + 3);
      await poll(async () => /Raleigh/.test((await page.getByTestId("mp-hover-near").textContent().catch(() => "")) ?? ""), "hover names the nearest city");
      // a user-typed name is never overwritten by the late gazetteer answer
      await page.getByTestId("mp-add-centre").click();
      await poll(async () => (await page.getByTestId("mp-place").count()) === 3, "third place");
      await page.getByTestId("mp-place-name").fill("My spot");
      await new Promise((r) => setTimeout(r, 900));
      { const v = await page.getByTestId("mp-place-name").inputValue(); const names = await page.locator("[data-testid=mp-place] .fs-maps-place-name").allTextContents(); ok(v === "My spot", `manual name kept: input=${JSON.stringify(v)} list=${JSON.stringify(names)}`); }
      ok(foreign.length === 0, `third-party requests: ${foreign.slice(0, 3).join(", ")}`);
    } finally {
      await close();
      if (placesBackup === null) await removeFile(PLACES); else await writeFile(PLACES, placesBackup);
    }
  });

  /* ---------------------------------------------------------------- ask dialog (SH-15) */
  await test("in-app ask dialog (SH-15) replaces prompt(): focus lands in the field with the default selected; Tab is trapped; global shortcuts are blocked while it is open (modal); Enter creates, Escape cancels and focus returns to the opener; passphrases are masked, double-entered and validated in place", { "SH-15": "full" }, async () => {
    const RUN = Date.now().toString(36);
    const DIR = `/Documents/tt28-ask-${RUN}`;
    await api("POST", "/api/fs", { op: "mkdir", path: DIR });
    await api("POST", "/api/fs", { op: "write", path: `${DIR}/secret.txt`, content: "attack at dawn" });
    const { page, close } = await boot([win("f1", "files", { path: DIR }, { x: 60, y: 40, w: 900, h: 600 })]);
    const nativeDialogs: string[] = [];
    page.on("dialog", (d) => { nativeDialogs.push(d.type()); void d.dismiss(); });
    const list = async () => ((await api("GET", `/api/fs?op=list&path=${encodeURIComponent(DIR)}`)).json.nodes ?? []).map((x: { name: string }) => x.name) as string[];
    try {
      const fw = page.locator("[data-win-id=f1]");
      await fw.getByRole("button", { name: "New folder" }).click();
      const dlg = page.getByRole("dialog", { name: "New folder name" });
      await dlg.waitFor();
      ok(await dlg.getAttribute("aria-modal") === "true", "aria-modal");
      const sel = await page.evaluate(() => { const a = document.activeElement as HTMLInputElement; return { id: a.dataset.testid, s: a.selectionStart, e: a.selectionEnd, v: a.value }; });
      ok(sel.id === "ask-input-value" && sel.s === 0 && sel.e === sel.v.length && sel.v === "New folder", `focus/selection ${JSON.stringify(sel)}`);
      for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
      ok(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=ask-dialog]")), "Tab stays inside the dialog");
      await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Shift+Tab");
      ok(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=ask-dialog]")), "Shift+Tab stays inside too");
      // modal: the palette chord and a window chord must do nothing behind the dialog
      const before = await fw.boundingBox();
      await page.keyboard.press("Control+Space"); await page.keyboard.press("Meta+ArrowLeft"); await page.keyboard.press("Alt+F4");
      await new Promise((r) => setTimeout(r, 300));
      ok(await page.locator('[aria-label="Command palette"]').count() === 0, "palette blocked");
      const after = await fw.boundingBox();
      ok(!!after && before!.x === after.x && before!.width === after.width, "window chords blocked (not tiled, not closed)");
      await page.getByTestId("ask-input-value").fill(`made-${RUN}`);
      await page.keyboard.press("Enter");
      await dlg.waitFor({ state: "detached" });
      await poll(async () => (await list()).includes(`made-${RUN}`), "Enter → folder created");
      // Escape cancels: nothing created, focus back on the opener
      await fw.getByRole("button", { name: "New folder" }).click();
      await dlg.waitFor();
      await page.keyboard.press("Escape");
      await dlg.waitFor({ state: "detached" });
      ok(await page.evaluate(() => document.activeElement?.textContent?.trim()) === "New folder", "focus returned to the opener");
      ok(!(await list()).includes("New folder"), "Escape created nothing");
      // passphrase: masked, two fields, mismatch / too short stay open with an alert, then a match encrypts
      await fw.getByText("secret.txt", { exact: true }).click({ button: "right" });
      await page.locator("[role=menu]").getByText(/^Encrypt/).click();
      const enc = page.getByRole("dialog", { name: /Encrypt “secret\.txt”/ });
      await enc.waitFor();
      ok(await page.getByTestId("ask-input-pass").getAttribute("type") === "password" && await page.getByTestId("ask-input-again").getAttribute("type") === "password", "masked");
      ok(await page.getByTestId("ask-input-pass").getAttribute("autocomplete") === "off", "no autocomplete");
      await page.getByTestId("ask-input-pass").fill("short"); await page.getByTestId("ask-input-again").fill("short"); await page.keyboard.press("Enter");
      await poll(async () => /at least 8/.test((await page.getByTestId("ask-error").textContent()) ?? ""), "too short → inline error");
      await page.getByTestId("ask-input-pass").fill("correct horse"); await page.getByTestId("ask-input-again").fill("correct hors"); await page.getByTestId("ask-ok").click();
      await poll(async () => /don't match/.test((await page.getByTestId("ask-error").textContent()) ?? ""), "mismatch → inline error");
      ok(await enc.count() === 1, "dialog still open after invalid input");
      await page.getByTestId("ask-show-pass").check();
      ok(await page.getByTestId("ask-input-pass").getAttribute("type") === "text", "Show reveals on request");
      await page.getByTestId("ask-input-again").fill("correct horse"); await page.getByTestId("ask-ok").click();
      await enc.waitFor({ state: "detached" });
      await poll(async () => (await list()).includes("secret.txt.fvault"), "encrypted copy written");
      const env = await readFile(`${DIR}/secret.txt.fvault`);
      ok(!!env && !env.includes("attack at dawn"), "ciphertext only");
      ok(nativeDialogs.length === 0, `native dialogs used: ${nativeDialogs}`);
    } finally {
      await close();
      for (const p of [`${DIR}/secret.txt.fvault`, `${DIR}/secret.txt`, `${DIR}/made-${RUN}`, DIR]) await removeFile(p);
    }
  });

  /* ---------------------------------------------------------------- Business Snap (LY-16 / LY-17) */
  await test("Business Snap (LY-16/LY-17): hovering Maximise opens the layouts flyout; a quarter zone places the window exactly; Snap Assist offers the other windows for the remaining zones in order; a title-bar drag into a corner shows a live preview and snaps to that quarter; the Snap layouts chord opens the flyout with keyboard focus", { "LY-16": "full", "LY-17": "full" }, async () => {
    await setSetting("appearance.layout", "business");
    const { page, close } = await boot([
      win("a", "files", {}, { x: 80, y: 60, w: 640, h: 420 }), win("b", "notes", {}, { x: 160, y: 120, w: 640, h: 420 }), win("c", "editor", {}, { x: 240, y: 180, w: 640, h: 420 }),
    ]);
    const rectOf = (id: string) => page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(`[data-win-id="${id}"]`)!; const d = el.parentElement!.getBoundingClientRect(); const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - d.left), y: Math.round(r.top - d.top), w: Math.round(r.width), h: Math.round(r.height), dw: Math.round(d.width), dh: Math.round(d.height) };
    }, id);
    try {
      await page.locator('[data-win-id="a"] .fs-cap-maximize').hover();
      await page.getByTestId("snap-flyout").waitFor({ timeout: 4000 });
      ok(await page.locator("[data-testid=snap-flyout] [role=group]").count() >= 5, "five or more layouts");
      await page.locator('[data-testid=snap-zone][data-layout=quarters][data-zone=tl]').click();
      await poll(async () => { const r = await rectOf("a"); return r.x === 0 && r.y === 0 && r.w === Math.round(r.dw / 2) && Math.abs(r.h - r.dh / 2) <= 1; }, "a → top-left quarter");
      const assist = page.getByTestId("snap-assist");
      await poll(async () => (await assist.getAttribute("data-zone")) === "tr", "assist offers top-right first");
      ok(await page.getByTestId("snap-candidate").count() === 2, "the two other windows are offered");
      await page.locator("[data-testid=snap-candidate][data-win=b]").click();
      await poll(async () => { const r = await rectOf("b"); return r.x === Math.round(r.dw / 2) && r.y === 0 && Math.abs(r.h - r.dh / 2) <= 1; }, "b → top-right");
      await poll(async () => (await assist.getAttribute("data-zone")) === "bl", "then bottom-left");
      ok(await page.getByTestId("snap-candidate").count() === 1, "b is no longer offered");
      await page.getByTestId("snap-assist-skip").click();
      await assist.waitFor({ state: "detached" });
      // drag c by its title bar into the bottom-right corner: live preview, then the quarter. c's title bar is under a and
      // b now, so first raise it by clicking its still-visible lower edge (as a user would).
      const cb = (await page.locator('[data-win-id="c"]').boundingBox())!;
      await page.mouse.click(cb.x + 30, cb.y + cb.height - 12);
      await poll(async () => (await page.locator('[data-win-id="c"]').getAttribute("data-focused")) === "true", "c raised");
      const t = (await page.locator('[data-win-id="c"] .fs-titlebar').boundingBox())!;
      const desk = await page.evaluate(() => { const r = document.querySelector<HTMLElement>('[data-win-id="c"]')!.parentElement!.getBoundingClientRect(); return { r: r.right, b: r.bottom }; });
      await page.mouse.move(t.x + 60, t.y + t.height / 2); await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(t.x + 60 + (desk.r - 2 - t.x - 60) * i / 12, t.y + t.height / 2 + (desk.b - 2 - t.y - t.height / 2) * i / 12);
      await poll(async () => (await page.getByTestId("snap-preview").getAttribute("data-key")) === "br", "live preview shows the quarter");
      const pv = (await page.getByTestId("snap-preview").boundingBox())!;
      ok(pv.width > 300 && pv.height > 200, `preview size ${pv.width}×${pv.height}`);
      await page.mouse.up();
      await poll(async () => { const r = await rectOf("c"); return r.x === Math.round(r.dw / 2) && Math.abs(r.y - r.dh / 2) <= 1 && r.x + r.w === r.dw; }, "c → bottom-right");
      ok(await page.getByTestId("snap-preview").count() === 0, "preview removed on drop");
      await poll(async () => (await assist.count()) === 1, "assist after a drag-snap");
      await page.keyboard.press("Escape");
      await assist.waitFor({ state: "detached" });
      // a drag that ends in the middle does not snap
      const t2 = (await page.locator('[data-win-id="b"] .fs-titlebar').boundingBox())!;
      await page.mouse.move(t2.x + 80, t2.y + t2.height / 2); await page.mouse.down(); await page.mouse.move(t2.x - 300, t2.y + 300, { steps: 6 });
      ok(await page.getByTestId("snap-preview").count() === 0, "no preview in the middle");
      await page.mouse.up();
      // keyboard: Snap layouts chord → focus inside the flyout → Enter picks the first zone (left half)
      await page.locator('[data-win-id="a"] .fs-titlebar').click();
      await page.keyboard.press("Meta+z");
      await page.getByTestId("snap-flyout").waitFor();
      ok(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid) === "snap-zone", "focus moved into the flyout");
      await page.keyboard.press("Enter");
      await poll(async () => { const r = await rectOf("a"); return r.x === 0 && r.y === 0 && r.w === Math.round(r.dw / 2) && r.h === r.dh; }, "a → left half by keyboard");
      await page.keyboard.press("Escape");
    } finally { await close(); }
  });

  /* ---------------------------------------------------------------- Art dock (LY-18 / LY-19) */
  await test("Art dock (LY-18/LY-19): auto-hide slides the dock off-screen and gives windows the space; the bottom edge reveals it; it stays ≥ 400 ms after leaving and hides by ~600 ms; keyboard focus reveals it; minimise plays the genie into the dock tile (clip-path funnel), and not at all under reduced motion", { "LY-18": "full", "LY-19": "full" }, async () => {
    await setSetting("appearance.layout", "art"); await setSetting("appearance.dockAutoHide", "on");
    let { page, close } = await boot([win("w1", "notes", {}, { x: 200, y: 80, w: 700, h: 460 })]);
    try {
      const row = page.getByTestId("dock-row");
      await poll(async () => (await row.getAttribute("data-autohide")) === "on" && (await row.getAttribute("data-shown")) === "0", "auto-hide on");
      const vh = page.viewportSize()!.height;
      await poll(async () => ((await page.getByTestId("dock").boundingBox())?.y ?? 0) >= vh, "dock is off-screen");
      const deskBottom = await page.evaluate(() => document.querySelector<HTMLElement>('[data-win-id="w1"]')!.parentElement!.getBoundingClientRect().bottom);
      ok(deskBottom >= vh - 1, `desk reaches the bottom edge (${deskBottom} vs ${vh})`);
      await page.mouse.move(700, vh - 1);
      await poll(async () => (await row.getAttribute("data-shown")) === "1", "bottom edge reveals");
      await poll(async () => { const b = await page.getByTestId("dock").boundingBox(); return !!b && b.y + b.height <= vh; }, "dock slid fully in");
      await page.mouse.move(700, 300);
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 380));
      ok(await row.getAttribute("data-shown") === "1", "still shown just after leaving");
      await poll(async () => (await row.getAttribute("data-shown")) === "0", "hides after the delay", 3000);
      const hidMs = Date.now() - t0; ok(hidMs < 1500, `hid after ${hidMs} ms`);
      await page.getByTestId("dock-launchpad").focus();
      await poll(async () => (await row.getAttribute("data-shown")) === "1", "keyboard focus reveals");
      await page.evaluate(() => (document.activeElement as HTMLElement).blur());
      await poll(async () => (await row.getAttribute("data-shown")) === "0", "blur hides again", 3000);
      await close();
      // genie (auto-hide off so the tile is on screen)
      await setSetting("appearance.dockAutoHide", "off");
      ({ page, close } = await boot([win("w1", "notes", {}, { x: 200, y: 80, w: 700, h: 460 })]));
      await page.locator('[data-win-id="w1"] .fs-tl-minimize').click();
      const ghost = page.getByTestId("genie-ghost");
      await poll(async () => (await ghost.count()) === 1, "genie ghost appears", 2000);
      const clip = await ghost.evaluate((g) => getComputedStyle(g).clipPath).catch(() => "");
      ok(/polygon/.test(clip), `funnel clip-path: ${clip}`);
      ok(await page.getByTestId("dock-min-w1").count() === 1, "flies into the minimised tile");
      await poll(async () => (await ghost.count()) === 0, "ghost removed after the animation", 2500);
      await close();
      // reduced motion: no genie at all
      ({ page, close } = await boot([win("w1", "notes", {}, { x: 200, y: 80, w: 700, h: 460 })], 1440, 900, {}));
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.locator('[data-win-id="w1"] .fs-tl-minimize').click();
      let seenGhost = false; const t1 = Date.now(); const ghost2 = page.getByTestId("genie-ghost");
      while (Date.now() - t1 < 700) { if (await ghost2.count()) seenGhost = true; await new Promise((r) => setTimeout(r, 50)); }
      ok(!seenGhost && await page.getByTestId("dock-min-w1").count() === 1, "reduced motion: minimised without the animation");
    } finally { await close(); }
  });
  /* ---------------------------------------------------------------- accessibility tree (AX-13) */
  await test("accessibility tree (AX-13): Playwright ariaSnapshot of the live page in Fusion, Business and Art: landmarks and names a screen reader would announce (dock / taskbar navigation, named window dialogs, no unnamed buttons or text fields); the ask dialog and the snap flyout expose their roles and names", { "AX-13": "full" }, async () => {
    const unnamed = (snap: string) => snap.split("\n").filter((l) => /^\s*- '?(button|textbox|checkbox|link|combobox)'?\s*(\[[^\]]*\])?\s*:?\s*$/.test(l));
    for (const layout of ["fusion", "business", "art"] as const) {
      await setSetting("appearance.layout", layout);
      const { page, close } = await boot([win("n1", "notes", {}, { x: 120, y: 60, w: 760, h: 480 })]);
      try {
        await new Promise((r) => setTimeout(r, 600));
        const snap = await page.locator("body").ariaSnapshot();
        ok(/- dialog "notes"/.test(snap), `${layout}: the window is a named dialog`);
        if (layout === "art") ok(/- navigation "Dock"/.test(snap), "art: Dock navigation landmark");
        if (layout === "business") ok(/- (navigation|toolbar|region) "[^"]*[Tt]askbar[^"]*"/.test(snap) || /taskbar/i.test(snap), "business: taskbar exposed");
        const bad = unnamed(snap);
        ok(bad.length === 0, `${layout}: unnamed controls: ${bad.slice(0, 5).join(" | ")}`);
        if (layout === "business") {
          await page.locator('[data-win-id="n1"] .fs-cap-maximize').hover();
          await page.getByTestId("snap-flyout").waitFor();
          const fs = await page.getByTestId("snap-flyout").ariaSnapshot();
          ok(/- dialog "Snap layouts"/.test(fs) || /- group "Four quarters"/.test(fs), "flyout dialog");
          ok(/- group "Four quarters"/.test(fs) && /- '?button "Four quarters: [^"]+"/.test(fs), `flyout groups/buttons named: ${fs.slice(0, 200)}`);
          await page.mouse.move(700, 700); await page.keyboard.press("Escape");
        }
      } finally { await close(); }
    }
    // ask dialog: role, name, labelled field, buttons
    const { page, close } = await boot([win("f1", "files", { path: "/Documents" }, { x: 60, y: 40, w: 900, h: 600 })]);
    try {
      await page.locator("[data-win-id=f1]").getByRole("button", { name: "New folder" }).click();
      await page.getByTestId("ask-dialog").waitFor();
      const a = await page.getByTestId("ask-dialog").ariaSnapshot();
      ok(/- dialog "New folder name"/.test(a) || /- heading "New folder name"/.test(a), `ask dialog role/name: ${a.slice(0, 200)}`);
      ok(/- textbox "New folder name"/.test(a) && /- button "Cancel"/.test(a) && /- button "Create"/.test(a), `ask fields/buttons: ${a.slice(0, 300)}`);
      await page.keyboard.press("Escape");
    } finally { await close(); }
  });
} finally {
  for (const k of SETTINGS) if (savedSettings[k] !== undefined) await setSetting(k, savedSettings[k]!);
  if (libBackup === null) await removeFile(LIB); else await writeFile(LIB, libBackup);
  await desktop([]);
  await browser.close();
}
finish();
