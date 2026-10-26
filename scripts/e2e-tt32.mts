/**
 * Suite "e2e-tt32" (TT32): Fusion Voice speaks for the Narrator in a real browser that has NO system voices (AX-15).
 *
 * Headless Chromium here reports speechSynthesis.getVoices().length === 0 (checked, not assumed). We observe the audio
 * the page actually produces by wrapping AudioBufferSourceNode.prototype.start/stop (the real calls still go through)
 * and copying each buffer's PCM. That PCM is what Web Audio would play; whether a speaker is attached is outside
 * the sandbox (no audio device), so loudspeaker output itself is NOT verified — the waveform is, by an independent
 * speech recogniser (PocketSphinx, scripts/oracle/asr.py, test-only).
 *
 * Gate declared before measuring: forced choice among every focus announcement captured in the run, top-1 ≥ 75 %.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt32.mts
 */
import type { Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { launchChromium } from "./browser-launch.mts";
import { toWav } from "../src/lib/voice-synth.ts";
import { loadCmudict, PY } from "./oracle/g2p-sets.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt32");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
const KEYS = ["appearance.layout", "accessibility.narrator", "accessibility.narratorRate", "accessibility.narratorCaptions", "accessibility.narratorSpeech", "accessibility.narratorVoice", "accessibility.fusionVoice"];
const saved: Record<string, string> = {};
for (const r of (await api("GET", "/api/settings")).rows as { key: string; value: string }[]) if (KEYS.includes(r.key)) saved[r.key] = r.value;
const set = (k: string, v: string) => api("PUT", "/api/settings", { key: k, value: v });
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;
const win = (id: string, module: string, i: number) => ({ id, module, title: module, x: 40 + i * 28, y: 40 + i * 18, w: 900, h: 600, z: 11 + i, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
async function desktop(windows: ReturnType<typeof win>[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { revision: rev, windows, focus: windows.at(-1)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 60 } });
}

const DIR = join(tmpdir(), "fusion-voice-e2e"); mkdirSync(DIR, { recursive: true });
let ds = 12345;
const rnd = () => { ds = (Math.imul(ds, 1103515245) + 12345) >>> 0; return ds / 4294967296 - 0.5; };
const pad = (x: Float32Array) => { const n = 4800, y = new Float32Array(x.length + 2 * n); y.set(x, n); for (let i = 0; i < y.length; i++) y[i] += rnd() * 0.002; return y; };
let fileN = 0;
function asr(jobs: { pcm: Float32Array; words: string[] }[]): (string | null)[] {
  const req = jobs.map((j) => { const f = join(DIR, `u${fileN++}.wav`); writeFileSync(f, toWav(pad(j.pcm), 16000)); return { wav: f, mode: "grammar", words: j.words }; });
  return (JSON.parse(execFileSync(PY, ["scripts/oracle/asr.py"], { input: JSON.stringify({ jobs: req }) }).toString()).results as { hyp: string | null }[]).map((r) => r.hyp);
}

const browser = await launchChromium(["--autoplay-policy=no-user-gesture-required"]);
async function boot(windows: ReturnType<typeof win>[]): Promise<Page> {
  await desktop(windows);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route(/(youtube|ytimg|vimeo|soundcloud|spotify|openstreetmap)\./i, (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.addInitScript(() => {
    // observe (not replace): record what Web Audio is asked to play and what speechSynthesis is asked to say
    const w = window as unknown as { __audio: { sr: number; pcm: number[]; t: number }[]; __stops: number; __speak: string[] };
    w.__audio = []; w.__stops = 0; w.__speak = [];
    const P = AudioBufferSourceNode.prototype, start = P.start, stop = P.stop;
    P.start = function (this: AudioBufferSourceNode, ...a: Parameters<typeof start>) {
      if (this.buffer) w.__audio.push({ sr: this.buffer.sampleRate, pcm: Array.from(this.buffer.getChannelData(0)), t: performance.now() });
      return start.apply(this, a);
    } as typeof start;
    P.stop = function (this: AudioBufferSourceNode, ...a: Parameters<typeof stop>) { w.__stops++; return stop.apply(this, a); } as typeof stop;
    const ss = window.speechSynthesis;
    if (ss) { const speak = ss.speak.bind(ss); ss.speak = (u: SpeechSynthesisUtterance) => { w.__speak.push(u.text); speak(u); }; }
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await sleep(2500);
  return page;
}
type Cap = { sr: number; pcm: number[]; t: number };
const takeAudio = async (p: Page): Promise<Cap[]> => p.evaluate(() => { const w = window as unknown as { __audio: Cap[] }; const a = w.__audio; w.__audio = []; return a; });
const join16 = (caps: Cap[]) => { const n = caps.reduce((s, c) => s + c.pcm.length, 0), out = new Float32Array(n); let o = 0; for (const c of caps) { out.set(c.pcm, o); o += c.pcm.length; } return out; };
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));
const lastCaption = async (p: Page) => (await p.locator('[data-testid="narrator-line"]').allInnerTexts()).at(-1) ?? "";
const words = (s: string) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);

try {
  await test("environment + engine choice: this Chromium has 0 system voices; Narrator (Automatic) speaks through Fusion Voice — the caption bar says so, Web Audio receives non-silent 16 kHz speech for the start-up announcement, and speechSynthesis.speak is never called", { "AX-15": "full", "AX-14": "partial" }, async () => {
    await set("appearance.layout", "fusion"); await set("accessibility.narrator", "on"); await set("accessibility.narratorRate", "1");
    await set("accessibility.narratorSpeech", "on"); await set("accessibility.narratorCaptions", "on"); await set("accessibility.narratorVoice", "auto"); await set("accessibility.fusionVoice", "standard");
    const page = await boot([win("n1", "notes", 0)]);
    const voices = await page.evaluate(() => new Promise<number>((res) => { const ss = window.speechSynthesis; if (!ss) return res(-1); let n = ss.getVoices().length; ss.addEventListener("voiceschanged", () => { n = ss.getVoices().length; }); setTimeout(() => res(n), 1200); }));
    ok(voices === 0, `this test assumes a voiceless browser; getVoices() = ${voices}`);
    await page.locator('[data-testid="narrator-title"][data-engine="fusion"]').waitFor({ timeout: 8000 });
    ok(/fusion voice/i.test(await page.locator('[data-testid="narrator-title"]').innerText()), "caption bar does not name the engine");
    const caps = await takeAudio(page);
    const pcm = join16(caps);
    ok(caps.length >= 2 && caps.every((c) => c.sr === 16000), `buffers: ${caps.length} @ ${caps.map((c) => c.sr).join(",")}`);
    ok(pcm.length / 16000 > 2 && rms(pcm) > 0.03, `start-up speech too short/quiet: ${(pcm.length / 16000).toFixed(2)} s, rms ${rms(pcm).toFixed(3)}`);
    const spoke = await page.evaluate(() => (window as unknown as { __speak: string[] }).__speak.length);
    ok(spoke === 0, `speechSynthesis.speak was called ${spoke}× in Automatic mode with 0 voices`);
    await page.context().close();
  });

  await test("intelligibility in the browser (declared gate ≥ 75 %): focus announcements captured from Web Audio on the real page, forced choice among all captured announcements by PocketSphinx", { "AX-15": "full" }, async () => {
    await set("accessibility.narrator", "on"); await set("accessibility.narratorVoice", "auto");
    const page = await boot([win("s1", "settings", 0)]);
    await sleep(1500); await takeAudio(page);
    const dict = loadCmudict();
    // candidate controls: visible buttons whose announcement words are all in the recogniser's dictionary
    const handles = await page.locator('button:visible, [role="button"]:visible, a[href]:visible').elementHandles();
    const got: { caption: string; pcm: Float32Array }[] = [];
    const seen = new Set<string>();
    for (const h of handles) {
      if (got.length >= 14) break;
      await h.evaluate((el) => (el as HTMLElement).focus());
      await sleep(1300);
      const caption = await lastCaption(page);
      const caps = await takeAudio(page);
      const ws = words(caption);
      if (!caption || seen.has(ws.join(" ")) || ws.length === 0 || ws.length > 8 || !ws.every((w) => dict.has(w)) || !caps.length) continue;
      seen.add(ws.join(" "));
      got.push({ caption: ws.join(" "), pcm: join16(caps) });
    }
    ok(got.length >= 8, `only ${got.length} usable announcements`);
    const cands = got.map((g) => g.caption);
    const hyps = asr(got.map((g) => ({ pcm: g.pcm, words: cands })));
    const right = hyps.filter((h, i) => h === cands[i]).length;
    console.log(`    ${right}/${got.length} (chance ${(100 / got.length).toFixed(0)} %): ${got.map((g, i) => (hyps[i] === g.caption ? "✓ " : "✗ ") + g.caption + (hyps[i] === g.caption ? "" : ` → ${hyps[i]}`)).join(" | ")}`);
    ok(right / got.length >= 0.75, `${right}/${got.length}`);
    await page.context().close();
  });

  await test("control: Ctrl stops Fusion Voice mid-sentence (queued buffers are stopped, nothing new starts)", { "AX-15": "full" }, async () => {
    await set("accessibility.narrator", "on"); await set("accessibility.narratorVoice", "fusion"); await set("accessibility.narratorRate", "1");
    const page = await boot([win("n1", "notes", 0)]);
    await sleep(1500); await takeAudio(page);
    // a long utterance: the Narrator help (Caps Lock + F1)
    await page.keyboard.down("CapsLock"); await page.keyboard.press("F1"); await page.keyboard.up("CapsLock");
    await sleep(400);
    const before = await page.evaluate(() => (window as unknown as { __stops: number }).__stops);
    await page.keyboard.press("Escape"); // close the help list, then silence with Ctrl
    await page.keyboard.press("Control");
    await sleep(300);
    const stops = await page.evaluate(() => (window as unknown as { __stops: number }).__stops) - before;
    await takeAudio(page); await sleep(1200);
    const after = await takeAudio(page);
    ok(stops >= 1, "Ctrl did not stop any queued Fusion Voice buffer");
    ok(after.length === 0, `${after.length} buffers started after Ctrl`);
    await page.context().close();
  });

  await test("modal: while the Narrator's modal help dialog is open and Fusion Voice is reading it, Ctrl stops the audio (not swallowed by the modal), the dialog stays open, and Escape then closes it", { "AX-15": "full", "AX-14": "partial" }, async () => {
    await set("accessibility.narrator", "on"); await set("accessibility.narratorVoice", "fusion"); await set("accessibility.narratorRate", "1");
    const page = await boot([win("n1", "notes", 0)]);
    await sleep(1500); await takeAudio(page);
    await page.keyboard.down("CapsLock"); await page.keyboard.press("F1"); await page.keyboard.up("CapsLock");
    const dlg = page.locator('[data-testid="narrator-help"]');
    await dlg.waitFor({ timeout: 4000 });
    await sleep(500);
    const playing = await takeAudio(page);
    ok(playing.length >= 2, `help text not being spoken (${playing.length} buffers)`);
    const before = await page.evaluate(() => (window as unknown as { __stops: number }).__stops);
    await page.keyboard.press("Control");
    await sleep(300);
    const stops = await page.evaluate(() => (window as unknown as { __stops: number }).__stops) - before;
    await sleep(1200);
    const after = await takeAudio(page);
    ok(stops >= 1, "Ctrl inside the modal did not stop Fusion Voice");
    ok(after.length === 0, `${after.length} buffers started after Ctrl`);
    ok(await dlg.isVisible(), "Ctrl closed the modal (it should only silence speech)");
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 3000 });
    await page.context().close();
  });

  await test("speed: the Settings speed control changes Fusion Voice live — the same announcement at 2× is ≥ 30 % shorter than at 1× (and both are real speech)", { "AX-15": "full" }, async () => {
    await set("accessibility.narrator", "on"); await set("accessibility.narratorVoice", "fusion"); await set("accessibility.narratorRate", "1");
    const page = await boot([win("s1", "settings", 0)]);
    await sleep(1500);
    const a = page.locator('[data-testid="settings-narrator-captions"]'), b = page.locator('[data-testid="settings-narrator-speech"]');
    await a.scrollIntoViewIfNeeded();
    // A → B → A: measure the second A (same window context both times)
    const measure = async () => { await b.focus(); await sleep(1300); await takeAudio(page); await a.focus(); await sleep(1500); const c = await takeAudio(page); return { s: join16(c).length / 16000, cap: await lastCaption(page) }; };
    await a.focus(); await sleep(1300);
    const d1 = await measure();
    await page.locator('[data-testid="settings-narrator-rate"]').selectOption("2"); await sleep(1500);
    const d2 = await measure();
    console.log(`    "${d1.cap}" 1×: ${d1.s.toFixed(2)} s; "${d2.cap}" 2×: ${d2.s.toFixed(2)} s`);
    ok(d1.cap === d2.cap, "different announcements compared");
    ok(d1.s > 0.5 && d2.s > 0.3, `missing speech: 1× ${d1.s.toFixed(2)} s, 2× ${d2.s.toFixed(2)} s`);
    ok(d2.s < d1.s * 0.7, `1× ${d1.s.toFixed(2)} s vs 2× ${d2.s.toFixed(2)} s`);
    await page.context().close();
  });

  await test("settings: the Voice selector is in Settings → Narrator and persists; forcing System voice uses speechSynthesis (no Web Audio speech), as the user chose", { "AX-15": "full" }, async () => {
    await set("accessibility.narrator", "off"); await set("accessibility.narratorVoice", "auto"); await set("accessibility.narratorRate", "1");
    const page = await boot([win("s1", "settings", 0)]);
    const sel = page.locator('[data-testid="settings-narrator-voice"]');
    await sel.scrollIntoViewIfNeeded();
    ok((await sel.locator("option").allInnerTexts()).some((t) => /Fusion Voice/.test(t)), "no Fusion Voice option");
    await sel.selectOption("system");
    await sleep(800);
    ok((await getSetting("accessibility.narratorVoice")) === "system", "selection not saved");
    ok(await page.locator('[data-testid="settings-fusion-voice"] option').count() === 3, "fusion voice presets missing");
    await page.locator('[data-testid="settings-narrator-on"]').check();
    await page.locator('[data-testid="narrator-title"][data-engine="system"]').waitFor({ timeout: 8000 });
    await sleep(1500);
    const spoke = await page.evaluate(() => (window as unknown as { __speak: string[] }).__speak.slice());
    const caps = await takeAudio(page);
    ok(spoke.some((t) => /Narrator on/.test(t)), `speechSynthesis not used: ${JSON.stringify(spoke)}`);
    ok(caps.length === 0, `${caps.length} Fusion Voice buffers played while System voice was forced`);
    await page.context().close();
  });
} finally {
  for (const k of KEYS) {
    if (k in saved) await set(k, saved[k]);
    else await set(k, ({ "accessibility.narrator": "off", "accessibility.narratorVoice": "auto", "accessibility.fusionVoice": "standard", "accessibility.narratorRate": "1", "accessibility.narratorSpeech": "on", "accessibility.narratorCaptions": "on", "appearance.layout": "fusion" } as Record<string, string>)[k]);
  }
  await desktop([]);
  await browser.close();
}
finish();
