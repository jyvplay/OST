/**
 * TT53 e2e — MD-08 lossless cut through the real Media app UI (Chromium 143): upload a clip, set the range, press
 * "Lossless cut", read the saved file back through /api/fs and verify it with FFmpeg (PyAV, test-only oracle:
 * frames hash-equal to the source, packets byte-identical, timing). Fixtures: scripts/oracle/media_fixtures.py.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt53-media.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `m${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt53-media");
const COV = { "MD-08": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python"; const FIX = "/tmp/tt53-media"; const SHOTS = process.env.SHOTS ?? "/tmp"; const OUT = join(FIX, "e2e"); mkdirSync(OUT, { recursive: true });
if (!existsSync(join(FIX, "vp9-opus.webm"))) execFileSync(PY, ["scripts/oracle/media_fixtures.py", FIX], { stdio: "inherit" });
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> }; }; // eslint-disable-line @typescript-eslint/no-explicit-any
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const created: string[] = [];
async function upload(path: string, bytes: Uint8Array, mime: string) { created.push(path); const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime, encoding: "base64" }); ok(r.status < 300, `upload ${path}: ${r.status}`); }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return Uint8Array.from(Buffer.from(r.json.node.content, "base64")); }
const check = (orig: string, out: string, t0: number, t1: number) => JSON.parse(execFileSync(PY, ["scripts/oracle/media_check.py", orig, out, String(t0), String(t1)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function cut(file: string, mime: string, from: number, to: number, opts: { exact?: boolean; shot?: string } = {}) {
  const src = `/Documents/${RUN}-${file}`; await upload(src, readFileSync(join(FIX, file)), mime); await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=media&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const start = page.getByLabel("Start seconds"), end = page.getByLabel("End seconds"); await start.waitFor({ timeout: 30_000 });
  await start.fill(String(from)); await end.fill(String(to));
  if (opts.exact === false) await page.locator('[data-testid="trim-exact"]').uncheck();
  const btn = page.locator('[data-testid="trim-lossless"]'); await btn.scrollIntoViewIfNeeded();
  for (let i = 0; i < 60 && await btn.isDisabled(); i++) await page.waitForTimeout(250); // src loads from the VFS first
  const t0 = Date.now(); await btn.click();
  const status = page.locator('[data-testid="media-status"]'); await status.filter({ hasText: /Lossless cut/ }).waitFor({ timeout: 20_000 });
  const ms = Date.now() - t0; const text = await status.innerText();
  ok(await page.locator('[data-testid="trim-reencode"]').isVisible(), "re-encode path still offered");
  if (opts.shot) await page.screenshot({ path: join(SHOTS, opts.shot) });
  await ctx.close(); return { text, ms };
}
const parse = (text: string) => { const m = /Lossless cut ([\d.]+)–([\d.]+) s .*saved to (\/Documents\/\S+)/.exec(text); ok(m, `status: ${text}`); created.push(m![3]); return { start: Number(m![1]), end: Number(m![2]), path: m![3] }; };
const good = (c: Record<string, any>, what: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(c.decode_errors === 0 && c.packets_foreign === 0 && c.video_match && c.video_got > 0, `${what}: ${JSON.stringify(c)}`);
  ok(c.time_err_rel <= 0.002 && c.time_shift <= 0.002 && c.time_shift > -0.0345, `${what}: timing ${JSON.stringify(c)}`);
};

await test("MP4 (H.264 B-frames + AAC) exact-start lossless cut from the Media app: saved .mp4 verified by FFmpeg, starts at the requested time", COV, async () => {
  const r = await cut("h264-aac.mp4", "video/mp4", 1.25, 3.5, { shot: "e2e53-mp4.png" }); const p = parse(r.text);
  ok(Math.abs(p.start - 1.25) < 1e-3 && Math.abs(p.end - 3.5) < 1e-3 && p.path.endsWith(".mp4") && /edit list/.test(r.text), r.text);
  const local = join(OUT, "ui.mp4"); writeFileSync(local, await readBytes(p.path)); good(check(join(FIX, "h264-aac.mp4"), local, p.start, p.end), "mp4");
  ok(r.ms < 10_000, `took ${r.ms} ms — should be instant, not real-time`);
});
await test("MP4 with 'exact start' off snaps to the key frame (1.000 s) and says so", COV, async () => {
  const r = await cut("h264-aac.mp4", "video/mp4", 1.25, 3.5, { exact: false }); const p = parse(r.text);
  ok(Math.abs(p.start - 1) < 1e-3 && /snapped to the key frame/.test(r.text), r.text);
  const local = join(OUT, "ui-key.mp4"); writeFileSync(local, await readBytes(p.path)); good(check(join(FIX, "h264-aac.mp4"), local, p.start, p.end), "mp4 key");
});
await test("WebM (VP9 + Opus) lossless cut: start snaps to the previous key frame, the status line says where, output verified by FFmpeg", COV, async () => {
  const r = await cut("vp9-opus.webm", "video/webm", 2.4, 4.2, { shot: "e2e53-webm.png" }); const p = parse(r.text);
  ok(Math.abs(p.start - 2) < 1e-3 && /no edit list/.test(r.text) && p.path.endsWith(".webm"), r.text);
  const local = join(OUT, "ui.webm"); writeFileSync(local, await readBytes(p.path)); good(check(join(FIX, "vp9-opus.webm"), local, p.start, p.end), "webm");
});
await test("MOV keeps its .mov extension; audio-only MP4 is saved as .m4a", COV, async () => {
  const a = parse((await cut("h264-aac.mov", "video/quicktime", 0.5, 2)).text); ok(a.path.endsWith(".mov"), a.path);
  const b = parse((await cut("aac-only.mp4", "audio/mp4", 0.5, 2)).text); ok(b.path.endsWith(".m4a"), b.path);
  const local = join(OUT, "ui.m4a"); writeFileSync(local, await readBytes(b.path)); const c = check(join(FIX, "aac-only.mp4"), local, b.start, b.end);
  ok(c.decode_errors === 0 && c.packets_foreign === 0 && c.audio_packets > 60, `m4a: ${JSON.stringify(c)}`);
});
await test("a file that is not MP4/WebM gets a clear 'not possible' message instead of a broken file", COV, async () => {
  const src = `/Documents/${RUN}-fake.mp4`; await upload(src, new TextEncoder().encode("this is not a video file at all, just text padding......"), "video/mp4"); await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await ctx.newPage();
  await page.goto(`${BASE}/?open=media&path=${encodeURIComponent(src)}`, { waitUntil: "domcontentloaded" });
  const btn = page.locator('[data-testid="trim-lossless"]'); await btn.waitFor({ timeout: 30_000 }); for (let i = 0; i < 60 && await btn.isDisabled(); i++) await page.waitForTimeout(250);
  await btn.click(); const st = page.locator('[data-testid="media-status"]'); await st.filter({ hasText: /not possible/ }).waitFor({ timeout: 10_000 });
  ok(/not an MP4\/MOV or WebM\/MKV file/.test(await st.innerText()), await st.innerText()); await ctx.close();
});
await test("no page errors during the run", COV, () => { ok(!errors.length, errors.join(" | ")); });
await browser.close();
for (const p of created) { await api("POST", "/api/fs", { op: "trash", path: p }); await api("POST", "/api/fs", { op: "purge", path: p }); } // leave the desktop as it was
finish();
