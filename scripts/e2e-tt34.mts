/**
 * Real-browser suite "e2e-tt34" (TT34) in headless Chromium against the production build:
 *   - SM-09/SM-10 transport: seek, ±10 s, volume, mute, speed and provider-playlist next/prev on YouTube; Vimeo with
 *     speed DISABLED by the creator (the speed shown must not change); SoundCloud (seek + playlist, no volume);
 *     keyboard shortcuts in the player, and none while typing
 *   - SM-09/SM-11 native audio file: the same transport drives <audio> (currentTime, volume, muted, playbackRate);
 *     library Shuffle (distinct picks) and Previous (retraces them)
 *   - MP-06/07/08 Maps: Plus Code search (full; short + city), the selected place's Plus Code, ellipsoidal distance
 *     and area of a measured shape, GPX / KML export (downloaded and parsed) and GPX import
 *   - LY-22 repair: a double-click on a resting wall whose hover-lift timer expires BETWEEN the two clicks still makes
 *     that wall the main view (the e2e-tabletop "west is main" race), and plain hover still lifts walls
 *
 * Honesty: provider hosts are NOT reachable from this sandbox. Requests to their player hosts are answered with a
 * PROTOCOL FIXTURE — a small page that speaks the documented player-side messages (YouTube IFrame API, Vimeo
 * player.js, SoundCloud widget API) and records what it receives. This proves our side of each protocol against the
 * published formats; it does not prove the live players' current behaviour. The audio file is a WAV generated here.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt34.mts
 */
import type { Browser, BrowserContext, Frame, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import * as G from "../src/lib/geodesy.ts";
import * as PC from "../src/lib/pluscode.ts";
import * as X from "../src/lib/geo-formats.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test: run, finish } = makeHarness("e2e-tt34");
const ONLY = process.env.ONLY ?? ""; // debugging aid: run only tests whose name contains this
const test: typeof run = ((name: string, rows: Record<string, string>, fn: () => Promise<void>) => (!ONLY || name.includes(ONLY) ? run(name, rows as never, fn) : Promise.resolve())) as typeof run;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const readFile = async (p: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(p)}`); return r.status === 200 ? String(r.json.node.content) : null; };
const getSetting = async (key: string) => (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === key)?.value as string | undefined;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const writeFile = (p: string, content: string, mime = "application/json") => api("POST", "/api/fs", { op: "write", path: p, content, mime });
const removeFile = async (p: string) => { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); };
async function desktop(windows: unknown[], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev, ...extra } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn().catch(() => false)) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); }
const win = (id: string, module: string, props: Record<string, unknown> = {}, r = { x: 10, y: 10, w: 1380, h: 820 }) => ({ id, module, title: module, ...r, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });

/* ------------------------------------------------------------------ protocol fixtures (player side) */
const FIX_COMMON = `window.fx={got:[],origin:null};addEventListener("message",function(e){var d=e.data;if(typeof d==="string"){try{d=JSON.parse(d)}catch(x){return}}fx.got.push(d);fx.origin=e.origin;fx.on&&fx.on(d)});`;
const FIXTURES: Record<string, string> = {
  // YouTube IFrame API, player side: initialDelivery carries volume / muted / rate / rates / playlist; every setter
  // is acknowledged with an infoDelivery delta, as the real player does
  youtube: `${FIX_COMMON}
    fx.post=function(o){o.id=fx.id||1;o.channel="widget";parent.postMessage(JSON.stringify(o),"*")};
    fx.info=function(i){fx.post({event:"infoDelivery",info:i})};
    fx.on=function(d){
      if(d.event==="listening"){fx.id=d.id;fx.post({event:"initialDelivery",info:{playerState:2,currentTime:0,duration:120,volume:100,muted:false,playbackRate:1,availablePlaybackRates:[0.25,0.5,1,1.5,2],playlist:["x1","x2","x3"],playlistIndex:0}});fx.post({event:"onReady"})}
      if(d.event!=="command")return;
      var a=d.args||[];
      if(d.func==="playVideo")fx.post({event:"onStateChange",info:1});
      if(d.func==="pauseVideo")fx.post({event:"onStateChange",info:2});
      if(d.func==="seekTo")fx.info({currentTime:a[0]});
      if(d.func==="setVolume")fx.info({volume:a[0]});
      if(d.func==="mute")fx.info({muted:true});
      if(d.func==="unMute")fx.info({muted:false});
      if(d.func==="setPlaybackRate")fx.info({playbackRate:a[0]});
      if(d.func==="nextVideo")fx.info({playlistIndex:1});
      if(d.func==="loadVideoById"){fx.loaded=a[0];fx.info({playerState:1,currentTime:0,duration:90})}
    };`,
  // Vimeo player.js, player side — this video's owner has speed DISABLED: setPlaybackRate is ignored (no event)
  vimeo: `${FIX_COMMON}
    fx.post=function(o){parent.postMessage(JSON.stringify(o),"*")};
    fx.vol=1;fx.muted=false;
    fx.on=function(d){
      if(d.method==="play")fx.post({event:"play"});
      if(d.method==="setVolume"){fx.vol=d.value;fx.post({event:"volumechange",data:{volume:fx.vol,muted:fx.muted}})}
      if(d.method==="setMuted"){fx.muted=d.value;fx.post({event:"volumechange",data:{volume:fx.vol,muted:fx.muted}})}
      if(d.method==="setCurrentTime")fx.post({event:"timeupdate",data:{seconds:d.value,duration:60,percent:d.value/60}});
    };
    addEventListener("load",function(){fx.post({event:"ready",player_id:"x"});setTimeout(function(){fx.post({event:"timeupdate",data:{seconds:5,duration:60,percent:0.08}})},150)});`,
  // SoundCloud widget, player side: a 3-sound set; answers getSounds
  soundcloud: `${FIX_COMMON}
    fx.post=function(o){parent.postMessage(JSON.stringify(o),"*")};
    fx.on=function(d){
      if(d.method==="getSounds")fx.post({method:"getSounds",value:[{id:1},{id:2},{id:3}]});
      if(d.method==="seekTo")fx.post({method:"playProgress",value:{currentPosition:d.value,relativePosition:d.value/180000,loadedProgress:1}});
    };
    addEventListener("load",function(){fx.post({method:"ready",value:null});setTimeout(function(){fx.post({method:"playProgress",value:{currentPosition:4000,relativePosition:4000/180000,loadedProgress:1}})},150)});`,
};
const fixtureFor = (host: string): string | null => /youtube(-nocookie)?\.com$/.test(host) ? "youtube" : host === "player.vimeo.com" ? "vimeo" : host === "w.soundcloud.com" ? "soundcloud" : null;

/** 30 s of a quiet 440 Hz tone, 8 kHz 8-bit mono PCM WAV (generated, no external file) */
function wav(seconds = 30, rate = 8000): Buffer {
  const n = seconds * rate, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(20 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return b;
}
const WAV = wav();

const EXTERNAL = /(youtube|youtube-nocookie|ytimg|googlevideo|soundcloud|sndcdn|vimeo|openstreetmap|media\.fixture)\./i;
const browser: Browser = await launchChromium();
async function boot(windows: unknown[], vw = 1440, vh = 900, extra: Record<string, unknown> = {}): Promise<{ page: Page; ctx: BrowserContext; close: () => Promise<void> }> {
  await desktop(windows, extra);
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, acceptDownloads: true });
  await ctx.route(EXTERNAL, async (route) => {
    const r = route.request(), u = new URL(r.url());
    if (u.hostname === "media.fixture.test") {
      // byte ranges, as any real file server: Chromium can only seek media whose server answers Range requests
      const m = /bytes=(\d*)-(\d*)/.exec(r.headers()["range"] ?? "");
      if (!m) { await route.fulfill({ status: 200, contentType: "audio/wav", body: WAV, headers: { "accept-ranges": "bytes" } }); return; }
      const start = m[1] ? Number(m[1]) : Math.max(0, WAV.length - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), WAV.length - 1) : WAV.length - 1;
      await route.fulfill({ status: 206, contentType: "audio/wav", body: WAV.subarray(start, end + 1), headers: { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${WAV.length}` } });
      return;
    }
    const fx = fixtureFor(u.hostname);
    if (fx && r.resourceType() === "document") await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>protocol fixture: ${fx}</title><body style="background:#111;color:#eee">fixture ${fx}<script>${FIXTURES[fx]}</script>` });
    else await route.fulfill({ status: 204, body: "" });
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock], [data-testid=taskbar]").count()) > 0, "shell chrome", 30_000);
  return { page, ctx, close: () => ctx.close() };
}
const playerFrame = (page: Page, host: RegExp): Frame | undefined => page.frames().find((f) => { try { return host.test(new URL(f.url()).hostname); } catch { return false; } });
const fx = <T,>(f: Frame, js: string) => f.evaluate(js) as Promise<T>;
type Got = { func?: string; args?: unknown[]; method?: string; value?: unknown };
const got = (f: Frame) => fx<Got[]>(f, "fx.got");
const lastCall = async (f: Frame, func: string) => (await got(f)).filter((d) => d.func === func).at(-1);

const SETTINGS = ["media.embeds", "appearance.desktopView"];
const saved: Record<string, string | undefined> = {};
for (const k of SETTINGS) saved[k] = await getSetting(k);
const LIB = "/Documents/Streams.json", PLACES = "/Documents/Places.geojson";
const libBackup = await readFile(LIB), placesBackup = await readFile(PLACES);
const lib = (items: { id: string; url: string; title: string }[]) => JSON.stringify({ v: 1, items: items.map((i) => ({ ...i, provider: "x", kind: "x", added: "2026-10-17T00:00:00Z" })) });
const yt = (c: string) => `https://www.youtube.com/watch?v=${c.repeat(11)}`;

try {
  await test("transport + keyboard on YouTube (SM-09, SM-10): +10 s, volume, mute, speed and playlist Next go out as IFrame-API commands and the UI follows the PLAYER's reports; keys J/L/M/>/↓/Shift+N/Shift+P work in the player and do nothing while typing", { "SM-09": "full", "SM-10": "full" }, async () => {
    await setSetting("media.embeds", "allow");
    await writeFile(LIB, lib([{ id: "a", url: yt("a"), title: "First" }, { id: "b", url: yt("b"), title: "Second" }]));
    const { page, close } = await boot([win("v1", "video")]);
    try {
      await page.getByTestId("sv-item-play").first().click();
      await poll(async () => !!playerFrame(page, /youtube-nocookie/), "youtube frame");
      const f = playerFrame(page, /youtube-nocookie/)!;
      await poll(async () => (await page.getByTestId("sv-transport").count()) === 1, "transport shown after the handshake");
      ok((await page.getByTestId("sv-transport").getAttribute("data-caps")) === "seek volume mute rate playlist", `caps ${await page.getByTestId("sv-transport").getAttribute("data-caps")}`);
      await page.getByTestId("sv-fwd10").click();
      await poll(async () => (await lastCall(f, "seekTo"))?.args?.[0] === 10, "seekTo 10");
      await page.getByTestId("sv-volume").fill("40");
      await poll(async () => (await lastCall(f, "setVolume"))?.args?.[0] === 40, "setVolume 40");
      await poll(async () => (await page.getByTestId("sv-volume").getAttribute("aria-valuetext")) === "40 %", "volume follows the player's report");
      await page.getByTestId("sv-mute").click();
      await poll(async () => !!(await lastCall(f, "mute")), "mute sent");
      await poll(async () => (await page.getByTestId("sv-mute").getAttribute("aria-pressed")) === "true" && /Unmute/.test(await page.getByTestId("sv-mute").innerText()), "mute reported");
      await page.getByTestId("sv-rate").selectOption("1.5");
      await poll(async () => (await lastCall(f, "setPlaybackRate"))?.args?.[0] === 1.5, "setPlaybackRate 1.5");
      await poll(async () => (await page.getByTestId("sv-rate").inputValue()) === "1.5", "speed follows the report");
      ok((await page.getByTestId("sv-rate").locator("option").allInnerTexts()).join(" ") === "0.25× 0.5× 1× 1.5× 2×", "the video's own rate list");
      await page.getByTestId("sv-pl-next").click();
      await poll(async () => !!(await lastCall(f, "nextVideo")), "nextVideo sent");
      // keyboard, focus in the player region (not inside the provider's iframe)
      await page.getByTestId("sv-stage").focus();
      await page.keyboard.press("l");
      await poll(async () => (await lastCall(f, "seekTo"))?.args?.[0] === 20, "L → +10 s (from the reported 10 s)");
      await page.keyboard.press("m");
      await poll(async () => !!(await lastCall(f, "unMute")), "M → unMute (state was muted)");
      await page.keyboard.press("Shift+Period");
      await poll(async () => (await lastCall(f, "setPlaybackRate"))?.args?.[0] === 2, "> → 2×");
      await page.keyboard.press("ArrowDown");
      await poll(async () => (await lastCall(f, "setVolume"))?.args?.[0] === 35, "↓ → volume 35");
      await page.keyboard.press("j");
      await poll(async () => (await lastCall(f, "seekTo"))?.args?.[0] === 10, "J → −10 s");
      const n0 = (await got(f)).filter((d) => d.func).length;
      await page.getByTestId("sv-url").click();
      await page.keyboard.type("kjlm k");
      await page.waitForTimeout(400);
      ok((await got(f)).filter((d) => d.func).length === n0, "typing in the link box sends nothing to the player");
      await page.getByTestId("sv-stage").focus();
      await page.keyboard.press("Shift+N");
      await poll(async () => (await page.locator("[data-testid=sv-item][data-current='1']").innerText()).includes("Second"), "Shift+N → next library item");
      await poll(async () => (await fx<string>(f, "fx.loaded")) === "bbbbbbbbbbb", "loaded into the same player");
      await page.keyboard.press("Shift+P");
      await poll(async () => (await page.locator("[data-testid=sv-item][data-current='1']").innerText()).includes("First"), "Shift+P → previous");
    } finally { await close(); }
  });

  await test("transport honesty (SM-09): Vimeo with speed disabled by its owner — setPlaybackRate is sent but the speed shown stays unreported 1×; volume uses 0–1 and follows volumechange; seek slider → setCurrentTime. SoundCloud: seek + playlist next, no volume control at all", { "SM-09": "full" }, async () => {
    await setSetting("media.embeds", "allow");
    await writeFile(LIB, lib([{ id: "v", url: "https://vimeo.com/76979871", title: "Vim" }, { id: "s", url: "https://soundcloud.com/forss/sets/soulhack", title: "Set" }]));
    const { page, close } = await boot([win("v1", "video", {}, { x: 4, y: 10, w: 712, h: 820 }), win("m1", "music", {}, { x: 724, y: 10, w: 712, h: 820 })]);
    try {
      await page.getByTestId("sv-item-play").first().click();
      await poll(async () => !!playerFrame(page, /player\.vimeo\.com/), "vimeo frame");
      const v = playerFrame(page, /player\.vimeo\.com/)!;
      await poll(async () => (await page.getByTestId("sv-transport").count()) === 1, "vimeo transport");
      ok((await page.getByTestId("sv-transport").getAttribute("data-caps")) === "seek volume mute rate", "vimeo caps");
      const subs = (await got(v)).filter((d) => d.method === "addEventListener").map((d) => d.value);
      ok(subs.includes("volumechange") && subs.includes("playbackratechange"), `subscribed ${subs}`);
      await page.getByTestId("sv-rate").selectOption("2");
      await poll(async () => (await got(v)).some((d) => d.method === "setPlaybackRate" && d.value === 2), "setPlaybackRate sent");
      await page.waitForTimeout(600);
      ok((await page.getByTestId("sv-rate").inputValue()) === "1" && (await page.getByTestId("sv-rate").getAttribute("data-reported")) === "0", "speed NOT shown as changed without the player's confirmation");
      await page.getByTestId("sv-volume").fill("40");
      await poll(async () => (await got(v)).some((d) => d.method === "setVolume" && d.value === 0.4), "setVolume 0.4");
      await poll(async () => (await page.getByTestId("sv-volume").getAttribute("aria-valuetext")) === "40 %", "volumechange reflected");
      await poll(async () => (await page.getByTestId("sv-seek").count()) === 1, "seek slider (duration known)");
      await page.getByTestId("sv-seek").fill("30");
      await poll(async () => (await got(v)).some((d) => d.method === "setCurrentTime" && d.value === 30), "setCurrentTime 30");
      // SoundCloud in Music
      await page.getByTestId("sa-item-play").first().click();
      await poll(async () => !!playerFrame(page, /w\.soundcloud\.com/), "soundcloud frame");
      const s = playerFrame(page, /w\.soundcloud\.com/)!;
      await poll(async () => (await page.getByTestId("sa-transport").getAttribute("data-caps")) === "seek playlist", "SoundCloud caps after getSounds");
      ok((await page.getByTestId("sa-volume").count()) === 0 && (await page.getByTestId("sa-mute").count()) === 0, "no SoundCloud volume / mute control");
      await page.getByTestId("sa-pl-next").click();
      await poll(async () => (await got(s)).some((d) => d.method === "next"), "next sent");
      await page.getByTestId("sa-fwd10").click();
      await poll(async () => (await got(s)).some((d) => d.method === "seekTo" && d.value === 14000), "seekTo 14 000 ms (4 s + 10 s)");
      ok(!(await got(s)).some((d) => d.method === "setVolume"), "setVolume never sent to SoundCloud");
    } finally { await close(); }
  });

  await test("native audio + library order (SM-09, SM-11): the transport drives <audio> (seek, volume, mute, speed, J key); Shuffle plays distinct items and Previous retraces them", { "SM-09": "full", "SM-11": "full" }, async () => {
    await writeFile(LIB, lib(["p", "q", "r", "s", "t"].map((c) => ({ id: c, url: `https://media.fixture.test/${c}-tone.wav`, title: `Tone ${c}` }))));
    const { page, close } = await boot([win("m1", "music")]);
    try {
      await page.getByTestId("sa-item-play").first().click();
      await poll(async () => (await page.getByTestId("sa-transport").count()) === 1, "transport for the native file");
      ok((await page.getByTestId("sa-transport").getAttribute("data-caps")) === "seek volume mute rate", "native caps");
      await poll(async () => (await page.getByTestId("sa-media").evaluate((m) => (m as HTMLMediaElement).duration)) > 29, "WAV metadata loaded");
      await page.getByTestId("sa-fwd10").click();
      await poll(async () => Math.abs(await page.getByTestId("sa-media").evaluate((m) => (m as HTMLMediaElement).currentTime) - 10) < 0.3, "+10 s → currentTime 10");
      await page.getByTestId("sa-volume").fill("30");
      await poll(async () => Math.abs(await page.getByTestId("sa-media").evaluate((m) => (m as HTMLMediaElement).volume) - 0.3) < 1e-6, "volume 0.3");
      await page.getByTestId("sa-mute").click();
      await poll(async () => page.getByTestId("sa-media").evaluate((m) => (m as HTMLMediaElement).muted), "muted");
      await page.getByTestId("sa-rate").selectOption("1.5");
      await poll(async () => (await page.getByTestId("sa-media").evaluate((m) => (m as HTMLMediaElement).playbackRate)) === 1.5, "playbackRate 1.5");
      await page.getByTestId("sa-stage").focus();
      await page.keyboard.press("j");
      await poll(async () => (await page.getByTestId("sa-media").evaluate((m) => (m as HTMLMediaElement).currentTime)) < 1, "J → back to 0");
      await page.getByTestId("sa-shuffle").check();
      const cur = async () => (await page.locator("[data-testid=sa-item][data-current='1']").innerText()).trim();
      const order = [await cur()];
      for (let i = 0; i < 4; i++) { await page.getByTestId("sa-next").click(); await poll(async () => (await cur()) !== order.at(-1), `shuffle step ${i}`); order.push(await cur()); }
      ok(new Set(order).size === 5, `shuffle played every item once: ${order.join(" → ")}`);
      for (let i = 3; i >= 0; i--) { await page.getByTestId("sa-prev").click(); await poll(async () => (await cur()) === order[i], `Previous → ${order[i]}`); }
    } finally { await close(); }
  });

  await test("Maps (MP-06, MP-07, MP-08): Plus Code search (full, and short + city); a place's Plus Code; measured distance and area on the ellipsoid match the exported GPX's own points; KML export is a polygon; GPX import adds waypoints and loads the track", { "MP-06": "full", "MP-07": "full", "MP-08": "full" }, async () => {
    await writeFile(PLACES, JSON.stringify({ type: "FeatureCollection", features: [] }), "application/geo+json");
    const { page, close } = await boot([win("mp", "maps")]);
    try {
      await page.getByTestId("mp-app").waitFor({ timeout: 20_000 });
      const host = page.locator(".fs-maps [data-zoom]").first();
      await poll(async () => (await host.getAttribute("data-zoom")) !== null, "map ready", 20_000);
      const search = async (q: string, kind: string, label?: RegExp) => {
        await page.getByTestId("mp-search").fill(q);
        const hit = page.locator(`[data-testid=mp-result][data-kind="${kind}"]`).first();
        await poll(async () => (await hit.count()) > 0 && (!label || label.test(await hit.innerText())), `result for ${q}`, 8000);
        const text = await hit.innerText();
        await hit.click();
        return text;
      };
      await search("8FVC9G8F+6W", "plus code");
      await poll(async () => Math.abs(Number(await host.getAttribute("data-lat")) - 47.36556) < 0.0005 && Math.abs(Number(await host.getAttribute("data-lng")) - 8.52481) < 0.0005, "flew to the Plus Code cell", 10_000);
      const t = await search("9G8F+6W Zurich", "plus code", /near Zürich/);
      ok(/8FVC9G8F\+6W/.test(t), `short code recovered around Zürich: ${t}`);
      await page.getByTestId("mp-add-centre").click();
      await page.getByTestId("mp-place").first().locator("button").click();
      const code = (await page.getByTestId("mp-pluscode").innerText()).trim();
      await poll(async () => { const g = JSON.parse((await readFile(PLACES)) ?? "{}"); return (g.features?.length ?? 0) === 1; }, "place saved", 8000);
      const feat = JSON.parse((await readFile(PLACES))!).features[0];
      ok(code === PC.encode(feat.geometry.coordinates[1], feat.geometry.coordinates[0]), `place Plus Code ${code} = encode(saved place)`);
      // measure a triangle: 3 map centres
      await page.getByTestId("mp-mode-measure").check();
      for (const [la, lo] of [[10, 10], [10, 11], [11, 11]]) {
        await search(`${la}, ${lo}`, "coord");
        await poll(async () => Math.abs(Number(await host.getAttribute("data-lat")) - la) < 2e-4 && Math.abs(Number(await host.getAttribute("data-lng")) - lo) < 2e-4, `centre at ${la},${lo}`, 12_000);
        await page.waitForTimeout(300);
        await page.getByTestId("mp-measure-centre").click();
      }
      await page.getByTestId("mp-measure-closed").check();
      await page.getByTestId("mp-area").waitFor();
      const metres = Number(await page.getByTestId("mp-measure").getAttribute("data-metres"));
      const m2 = Number(await page.getByTestId("mp-area").getAttribute("data-m2"));
      const dl = page.waitForEvent("download");
      await page.getByTestId("mp-export-gpx").click();
      const gpxText = (await (await (await dl).createReadStream()).toArray()).map((b) => b.toString()).join("");
      const gpx = X.parseGPX(gpxText);
      ok(gpx.points.length === 1 && gpx.paths.length === 1 && gpx.paths[0].points.length === 3, `GPX: ${gpx.points.length} wpt, ${gpx.paths.length} path`);
      const pts = gpx.paths[0].points.map((p) => [p.lat, p.lng] as G.LatLng);
      ok(pts.every((p, i) => G.distance(p, [[10, 10], [10, 11], [11, 11]][i] as G.LatLng) < 50), `measured points near the targets ${JSON.stringify(pts)}`);
      ok(Math.abs(metres - Math.round(G.pathLength(pts))) <= 1, `distance ${metres} vs ellipsoid ${G.pathLength(pts)}`);
      ok(Math.abs(m2 - Math.round(G.polygonArea(pts).area)) <= 2, `area ${m2} vs ${G.polygonArea(pts).area}`);
      ok(metres > 200_000 && metres < 225_000, `plausible two-leg distance ${metres}`);
      const dk = page.waitForEvent("download");
      await page.getByTestId("mp-export-kml").click();
      const kml = X.parseKML((await (await (await dk).createReadStream()).toArray()).map((b) => b.toString()).join(""));
      ok(kml.paths.length === 1 && kml.paths[0].kind === "polygon" && kml.paths[0].points.length === 3 && kml.points.length === 1, "KML: one placemark + the measured polygon");
      // import a GPX walk
      const walk = [[35.7796, -78.6382], [35.7810, -78.6400], [35.7830, -78.6390], [35.7850, -78.6420]];
      const gpxIn = X.toGPX({ points: [{ lat: 35.78, lng: -78.64, name: "Start café", note: "" }, { lat: 35.785, lng: -78.642, name: "End", note: "x" }], paths: [{ name: "Walk", kind: "track", points: walk.map(([lat, lng]) => ({ lat, lng })) }] });
      await page.getByTestId("mp-import").setInputFiles({ name: "walk.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(gpxIn) });
      await poll(async () => (await page.getByTestId("mp-place").count()) === 3, "two waypoints added as places");
      await poll(async () => Math.abs(Number(await page.getByTestId("mp-measure").getAttribute("data-metres")) - Math.round(G.pathLength(walk as G.LatLng[]))) <= 1, "the track is loaded into Measure with its ellipsoidal length");
      ok(!(await page.getByTestId("mp-measure-closed").isChecked()), "a track is not a closed shape");
    } finally { await close(); }
  });

  await test("tabletop double-click guard (LY-22): a double-click on a RESTING wall whose 300 ms hover-lift deadline passes between the clicks still makes it the main view (×3 walls, optional TT_CPU load); plain hover still lifts a wall", { "LY-22": "full" }, async () => {
    await setSetting("appearance.desktopView", "tabletop");
    const { page, close } = await boot([], 1440, 900, { table: { v: 2, cards: {}, piles: [], camera: "top" } }); // the race needs walls with room to aim at
    try {
      await page.getByTestId("tabletop").waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1200);
      const RATE = Number(process.env.TT_CPU ?? 0); // optional load: Chromium's own CPU throttling (DevTools "6x slowdown")
      if (RATE > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: RATE });
      const pointOn = async (w: string) => {
        const loc: Locator = page.getByTestId(`tt-wall-${w}`);
        let prev = "";
        for (let i = 0; i < 60; i++) {
          const b = await loc.boundingBox(); const s = JSON.stringify(b);
          if (b && s === prev) {
            const pt = await page.evaluate(([wall, bs]) => {
              const r = JSON.parse(bs) as { x: number; y: number; width: number; height: number };
              const grid: number[][] = [[0.5, 0.5]]; for (const fy of [0.3, 0.5, 0.7, 0.2, 0.8]) for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) grid.push([fx, fy]);
              for (const [fx, fy] of grid) {
                const x = r.x + r.width * fx, y = r.y + r.height * fy;
                const top = document.elementsFromPoint(x, y).map((el) => el.closest("[data-face]") as HTMLElement | null).find((f) => f);
                if (top?.dataset.face === wall && !document.elementFromPoint(x, y)?.closest("[data-wall-tag]")) return { x, y }; // the resting wall surface IS the tt-open button (opens on double-click); a tag opens on ONE click by design, so avoid it
              }
              return null;
            }, [w, s] as const);
            if (pt) return pt;
          }
          prev = s; await page.waitForTimeout(120);
        }
        throw new Error(`no point on ${w}`);
      };
      for (const w of ["west", "north", "east"]) {
        const p = await pointOn(w);
        await page.mouse.move(720, 520); await page.waitForTimeout(120); // start on the floor so the lift timer arms only on arrival
        await page.mouse.move(p.x, p.y, { steps: 2 }); // real movement arms the 300 ms hover-lift
        await page.waitForTimeout(150);
        ok((await page.getByTestId(`tt-wall-${w}`).getAttribute("data-lifted")) === null, `${w} still at rest when the double-click starts (the hover-lift is pending)`);
        await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
        await page.waitForTimeout(260); // the 300 ms hover-lift deadline passes HERE, between the two clicks
        await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
        await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === w, `${w} is main`, 6000);
        await page.getByTestId("tt-back").click();
        await poll(async () => (await page.getByTestId("tabletop").getAttribute("data-main")) === "floor", "back to floor");
        await page.mouse.move(5, 5); await page.waitForTimeout(1300);
      }
      const p = await pointOn("north");
      await page.mouse.move(p.x - 20, p.y + 10); await page.mouse.move(p.x, p.y, { steps: 5 });
      await poll(async () => (await page.getByTestId("tt-wall-north").getAttribute("data-lifted")) === "true", "hover alone still lifts the wall", 3000);
    } finally { await close(); }
  });
} finally {
  for (const k of SETTINGS) if (saved[k] !== undefined) await setSetting(k, saved[k]!);
  if (libBackup !== null) await writeFile(LIB, libBackup); else await removeFile(LIB);
  if (placesBackup !== null) await writeFile(PLACES, placesBackup, "application/geo+json"); else await removeFile(PLACES);
  await desktop([]);
  await browser.close();
}
finish();
