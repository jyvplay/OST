/**
 * TT53 — MD-08 lossless video/audio trim (from-scratch ISO-BMFF + Matroska remuxers, src/lib/media/).
 *
 * External evidence (independent of our code): FFmpeg via PyAV (test-only, LGPL, never shipped) demuxes + decodes every
 * file we write (scripts/oracle/media_check.py) and compares it with the original: decoded frames hash-equal in order,
 * presentation times, packet bytes all present in the source (lossless), duration. Chromium (the browser Fusion runs in)
 * plays the WebM output and a real MediaRecorder recording is trimmed. Fixtures: scripts/oracle/media_fixtures.py.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt53-media.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { trimMp4, parseMovie, ptOf, MediaError as BErr } from "../src/lib/media/bmff.ts";
import { trimWebm, parseMatroska, MediaError as EErr } from "../src/lib/media/ebml.ts";
import { detectContainer, losslessTrim } from "../src/lib/media/trim.ts";
import { rewrite, list, be32 } from "./tt53/bmffedit.ts";

const { test: test0, finish } = makeHarness("tt53-media");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const PY = "/home/user/tools/venv/bin/python";
const FIX = "/tmp/tt53-media"; const OUT = join(FIX, "out");
const COV = { "MD-08": "full" } as const;
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const have = existsSync(PY) && (() => { try { execFileSync(PY, ["-c", "import av"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (have && !existsSync(join(FIX, "vp9-opus.webm"))) execFileSync(PY, ["scripts/oracle/media_fixtures.py", FIX], { stdio: "inherit", timeout: 300_000 });
mkdirSync(OUT, { recursive: true });
const rd = (f: string) => new Uint8Array(readFileSync(join(FIX, f)));
interface Chk { decode_errors: number; video_expected: number; video_got: number; video_match: boolean; time_err_max: number; time_err_rel: number; time_shift: number; packets_foreign: number; audio_packets: number; audio_first: number | null; audio_last: number | null; duration: number | null }
function check(orig: string, bytes: Uint8Array, name: string, t0: number, t1: number): Chk {
  const out = join(OUT, name); writeFileSync(out, bytes);
  return JSON.parse(execFileSync(PY, ["scripts/oracle/media_check.py", orig, out, String(t0), String(t1)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }));
}
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function assertGood(c: Chk, what: string, start: number, end: number, hasVideo: boolean) {
  ok(c.decode_errors === 0, `${what}: ${c.decode_errors} decode errors`);
  ok(c.packets_foreign === 0, `${what}: ${c.packets_foreign} packets not byte-identical to the source`);
  ok(c.video_match, `${what}: displayed frames ${c.video_got} ≠ expected ${c.video_expected} (or different pictures)`);
  ok(!hasVideo || c.video_got > 0, `${what}: no video frames`);
  ok(c.time_err_rel <= 0.002 && c.time_shift <= 0.002 && c.time_shift > -0.0345, `${what}: frame timing (spacing error ${c.time_err_rel}, first-frame shift ${c.time_shift})`);
  ok(c.duration !== null && Math.abs(c.duration - (end - start)) <= 0.05, `${what}: duration ${c.duration} vs ${(end - start).toFixed(3)}`);
  ok(c.audio_first === null || c.audio_first >= -0.03, `${what}: audio starts at ${c.audio_first}`);
}
/** ISO 14496-12 timing through our own reader: every output sample's presentation time (edit list applied) equals its
 *  source sample's time minus the start, to within one media tick — matched by sample bytes, per track */
function exactTimes(src: Uint8Array, out: Uint8Array, start: number, what: string, cutLen: number) {
  const a = parseMovie(src), b = parseMovie(out);
  // header durations (mvhd in movie ticks; each tkhd in movie ticks) equal the cut length
  const dur = (bx: { data: number }, v1: number, v0: number) => { const dv = new DataView(out.buffer, out.byteOffset); const v = out[bx.data]; return v === 1 ? dv.getUint32(bx.data + v1) * 2 ** 32 + dv.getUint32(bx.data + v1 + 4) : dv.getUint32(bx.data + v0); };
  const mv = dur(b.mvhd, 24, 16) / b.timescale;
  for (const t of b.tracks) { const td = dur(t.tkhd, 28, 20) / b.timescale; ok(Math.abs(td - mv) <= 1 / b.timescale + 1e-9, `${what}: track ${t.id} tkhd duration ${td} ≠ mvhd ${mv}`); }
  ok(Math.abs(mv - cutLen) < 1.5 / b.timescale + 1e-9, `${what}: mvhd duration ${mv} ≠ cut length ${cutLen}`);
  for (const tb of b.tracks) {
    const ta = a.tracks.find((t) => t.id === tb.id)!; const byBytes = new Map<string, number[]>();
    const key = (bb: Uint8Array, o: number, n: number) => Buffer.from(bb.subarray(o, o + n)).toString("base64");
    ta.off.forEach((o, i) => { const k = key(src, o, ta.size[i]); (byBytes.get(k) ?? byBytes.set(k, []).get(k)!).push(i); });
    tb.off.forEach((o, i) => {
      const cand = byBytes.get(key(out, o, tb.size[i])); ok(cand?.length, `${what}: track ${tb.id} sample ${i} not in the source`);
      const got = ptOf(tb, i); let bi = 0; cand.forEach((c, j) => { if (Math.abs(ptOf(ta, c) - start - got) < Math.abs(ptOf(ta, cand[bi]) - start - got)) bi = j; }); // identical packets (steady tone) are interchangeable
      const want = ptOf(ta, cand.splice(bi, 1)[0]) - start;
      ok(Math.abs(got - want) <= 1.01 / tb.timescale + 1e-9, `${what}: track ${tb.id} sample ${i} at ${got.toFixed(6)} s, source says ${want.toFixed(6)}`);
      ok(tb.sync[i] === ta.sync[ta.off.findIndex((o, j) => Math.abs(ptOf(ta, j) - start - got) < 1.01 / ta.timescale && ta.size[j] === tb.size[i])], `${what}: track ${tb.id} sample ${i} sync flag differs from the source (stss)`);
    });
  }
}
const MP4S = ["h264-aac.mp4", "h264-aac-faststart.mp4", "h264-frag.mp4", "h264-aac.mov", "h264-only.mp4", "aac-only.mp4"];
const MKVS = ["vp8-opus.webm", "vp9-opus.webm", "h264-aac.mkv", "opus-only.webm"];
const stats = { mp4Cuts: 0, mkvCuts: 0, frames: 0 };

await test("container detection by magic bytes routes MP4/MOV and WebM/MKV; anything else is refused", COV, () => {
  if (!have) return;
  for (const f of MP4S) ok(detectContainer(rd(f)) === "mp4", f);
  for (const f of MKVS) ok(detectContainer(rd(f)) === "webm", f);
  ok(detectContainer(new TextEncoder().encode("RIFF....AVI LIST")) === null, "AVI");
  let threw = false; try { losslessTrim(new Uint8Array(64), 0, 1, true); } catch (e) { threw = e instanceof BErr; } ok(threw, "zeros refused");
  ok(losslessTrim(rd("aac-only.mp4"), 1, 2, true).mime === "audio/mp4", "audio-only MP4 → audio/mp4 (.m4a)");
});

await test("MP4/MOV sweep (progressive, faststart, fragmented, MOV, video-only, audio-only) × exact + key-frame starts: FFmpeg decodes, frames hash-equal, packets byte-identical", COV, () => {
  if (!have) return;
  const R = rng(53);
  for (const f of MP4S) for (let k = 0; k < 6; k++) {
    const from = +(R() * 4.6).toFixed(3); const to = +Math.min(6.2, from + 0.3 + R() * 3).toFixed(3);
    for (const mode of ["exact", "keyframe"] as const) {
      const r = trimMp4(rd(f), from, to, { mode });
      ok(mode === "keyframe" || Math.abs(r.start - from) < 1e-9, `${f} exact start ${r.start} ≠ ${from}`);
      ok(r.start <= from + 1e-6 && r.keyframe <= from + 1e-6, `${f} key frame ${r.keyframe} after the start ${from}`);
      const c = check(join(FIX, f), r.bytes, `${mode}-${k}-${f}`, r.start, r.end);
      assertGood(c, `${f} ${mode} ${from}–${to}`, r.start, r.end, !f.startsWith("aac"));
      ok(c.audio_first === null || c.audio_first <= 0.0011, `${f} ${mode} ${from}–${to}: audio begins at ${c.audio_first} s — the frame overlapping the start is missing`);
      exactTimes(rd(f), r.bytes, r.start, `${f} ${mode} ${from}–${to}`, r.end - r.start);
      stats.mp4Cuts++; stats.frames += c.video_got;
    }
  }
});

await test("WebM/MKV sweep (VP8+Opus, VP9+Opus, H.264+AAC with B-frames in MKV, Opus-only): start snaps to the key frame, FFmpeg decodes, frames hash-equal, packets byte-identical", COV, () => {
  if (!have) return;
  const R = rng(530);
  for (const f of MKVS) for (let k = 0; k < 6; k++) {
    const from = +(R() * 4.6).toFixed(3); const to = +Math.min(6.2, from + 0.3 + R() * 3).toFixed(3);
    const r = trimWebm(rd(f), from, to);
    ok(r.start <= from + 1e-3, `${f}: start ${r.start} after ${from}`);
    if (!f.startsWith("opus")) ok(Math.abs(r.start - Math.floor(from + 1e-6)) < 1e-3, `${f}: start ${r.start} is not the 1 s-GOP key frame before ${from}`);
    const c = check(join(FIX, f), r.bytes, `mkv-${k}-${f}`, r.start, r.end);
    assertGood(c, `${f} ${from}–${to}`, r.start, r.end, !f.startsWith("opus"));
    stats.mkvCuts++; stats.frames += c.video_got;
  }
});

await test("WebM output is self-indexed: Duration, Cues pointing at key-frame clusters, SeekHead positions; re-parse gives rebased block times", COV, () => {
  if (!have) return;
  const src = rd("vp9-opus.webm"); const r = trimWebm(src, 2.5, 4.5); const p = parseMatroska(r.bytes); const q = parseMatroska(src);
  ok(p.duration !== null && Math.abs(p.duration * p.scale / 1e9 - (r.end - r.start)) < 0.01, `Duration ${p.duration}`);
  const sh = Math.round(r.start * 1e9 / q.scale); const pool = new Map<string, number>();
  const k = (bb: Uint8Array, x: { track: number; time: number; tsAt: number; end: number }, t: number) => `${x.track}@${t}:${Buffer.from(bb.subarray(x.tsAt + 2, x.end)).toString("base64")}`;
  for (const x of q.blocks) { const kk = k(src, x, x.time - sh); pool.set(kk, (pool.get(kk) ?? 0) + 1); }
  const missing = p.blocks.filter((x) => { const kk = k(r.bytes, x, x.time); const n = pool.get(kk) ?? 0; if (!n) return true; pool.set(kk, n - 1); return false; });
  ok(!missing.length, `${missing.length} output blocks do not equal a source block at (time − start): first ${JSON.stringify(missing[0])}`);
  // FFmpeg seeks through our Cues; the Cues element exists inside the Segment
  writeFileSync(join(OUT, "idx.webm"), r.bytes);
  const ff = execFileSync(PY, ["-c", "import av,sys\nc=av.open(sys.argv[1]);c.seek(int(1.2e6));f=next(c.decode(video=0));print(round(float(f.pts*f.time_base),3))", join(OUT, "idx.webm")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
  ok(Number(ff) <= 1.2 + 1e-6 && Number(ff) >= 0, `FFmpeg seek to 1.2 s via our Cues landed at ${ff}`);
  ok(Buffer.from(r.bytes).includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])), "Cues element written");
});

await test("real Chromium MediaRecorder WebM (unknown-size Segment and Clusters, no Cues, no Duration) is trimmed losslessly and plays back in Chromium", COV, async () => {
  if (!have) return;
  const { launchChromium } = await import("./browser-launch.mts");
  const br = await launchChromium(["--autoplay-policy=no-user-gesture-required"]);
  try {
    const page = await br.newPage();
    const b64: string = await page.evaluate(async () => {
      const cv = document.createElement("canvas"); cv.width = 160; cv.height = 96; document.body.appendChild(cv); const g = cv.getContext("2d")!;
      const ac = new AudioContext(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
      const st = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dst.stream.getAudioTracks()]);
      const rec = new MediaRecorder(st, { mimeType: "video/webm;codecs=vp8,opus", videoKeyFrameIntervalDuration: 500 } as MediaRecorderOptions);
      const parts: Blob[] = []; rec.ondataavailable = (e) => parts.push(e.data);
      let i = 0; const t = setInterval(() => { g.fillStyle = `hsl(${(i * 13) % 360} 80% 50%)`; g.fillRect(0, 0, 160, 96); g.fillStyle = "#000"; g.fillRect((i * 4) % 160, 20, 12, 50); i++; }, 33);
      rec.start(250); await new Promise((r) => setTimeout(r, 4200)); rec.stop(); await new Promise((r) => { rec.onstop = r; }); clearInterval(t);
      const u8 = new Uint8Array(await new Blob(parts).arrayBuffer()); let s = ""; for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode(...u8.subarray(k, k + 0x8000)); return btoa(s);
    });
    const rec = Uint8Array.from(Buffer.from(b64, "base64")); writeFileSync(join(OUT, "recorder.webm"), rec);
    const p = parseMatroska(rec);
    ok(p.duration === null, "MediaRecorder writes no Duration (live)"); ok(p.blocks.length > 60, `blocks ${p.blocks.length}`);
    ok(rec.includes(0x01) && Buffer.from(rec).includes(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), "unknown-size Cluster present in the recording");
    const keys = p.blocks.filter((b) => b.key && b.track === p.trackList.find((t) => t.type === 1)!.number).map((b) => b.time / 1000);
    const r = trimWebm(rec, 1.6, 3.4);
    const c = check(join(OUT, "recorder.webm"), r.bytes, "recorder-trim.webm", r.start, r.end);
    assertGood(c, `recorder 1.6–3.4 (key frames at ${keys.map((k) => k.toFixed(2)).join(",")})`, r.start, r.end, true);
    stats.frames += c.video_got;
    // Chromium plays our output: finite duration, seek works, no media error
    const out64 = Buffer.from(r.bytes).toString("base64");
    const res = await page.evaluate(async (s) => {
      const bin = atob(s); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
      const v = document.createElement("video"); v.muted = true; v.src = URL.createObjectURL(new Blob([u], { type: "video/webm" })); document.body.appendChild(v);
      await new Promise((ok2, bad) => { v.onloadedmetadata = ok2; v.onerror = () => bad(new Error(String(v.error?.message))); });
      const d = v.duration; v.currentTime = d / 2; await new Promise((ok2) => { v.onseeked = ok2; });
      await v.play(); await new Promise((ok2) => setTimeout(ok2, 400)); return { d, t: v.currentTime, err: v.error ? v.error.code : 0, w: v.videoWidth };
    }, out64);
    ok(res.err === 0 && Number.isFinite(res.d) && Math.abs(res.d - (r.end - r.start)) < 0.1 && res.t > res.d / 2 && res.w === 160, `Chromium playback ${JSON.stringify(res)} vs ${(r.end - r.start).toFixed(3)} s`);
  } finally { await br.close(); }
});

await test("modal-shortcut failure: cutting WebM at the requested frame without its key frame is caught by the oracle (frames differ or fail to decode)", COV, () => {
  if (!have) return;
  const src = rd("vp8-opus.webm").slice(); const p = parseMatroska(src);
  for (const b of p.blocks) if (b.track === 1) src[b.tsAt + 2] |= 0x80; // lie: every frame is a key frame → trimmer starts mid-GOP
  const r = trimWebm(src, 1.5, 3.0); ok(Math.abs(r.start - 1.5) < 0.02, `shortcut starts at ${r.start}`);
  const c = check(join(FIX, "vp8-opus.webm"), r.bytes, "shortcut.webm", r.start, r.end);
  ok(c.decode_errors > 0 || !c.video_match, `the oracle failed to notice a cut without its key frame: ${JSON.stringify(c)}`);
});

const refuses = (fn: () => unknown, re: RegExp, what: string) => { let m = ""; try { fn(); } catch (e) { ok(e instanceof BErr || e instanceof EErr, `${what}: threw a non-media error ${(e as Error).message} ${process.env.DBG ? (e as Error).stack : ""}`); m = (e as Error).message; } ok(m && re.test(m), `${what}: expected refusal ${re}, got "${m || "no error"}"`); };
await test("negative shapes (≥15): ranges, truncation, damaged sizes, DRM, multi-edit lists, several sample descriptions, bogus sample counts, EBML damage — clear refusals, never garbage", COV, () => {
  if (!have) return;
  const mp4 = rd("h264-aac.mp4"); const webm = rd("vp9-opus.webm");
  refuses(() => trimMp4(mp4, 3, 3), /end must be after/, "1 t1 = t0");
  refuses(() => trimMp4(mp4, 4, 2), /end must be after/, "2 t1 < t0");
  refuses(() => trimMp4(mp4, 50, 60), /outside the file/, "3 range past the end");
  refuses(() => trimWebm(webm, 50, 60), /after the last frame/, "4 WebM range past the end");
  refuses(() => trimMp4(mp4.subarray(0, mp4.length - 3000), 1, 2), /damaged|truncated|past|moov/, "5 truncated moov");
  const moovAt = list(mp4, 0, mp4.length).find((b) => b.type === "moov")!;
  const big = mp4.slice(); big.set(be32(0x7fffffff), moovAt.start); refuses(() => trimMp4(big, 1, 2), /damaged|truncated|moov/, "6 box size past EOF");
  const tiny = mp4.slice(); tiny.set(be32(3), moovAt.start); refuses(() => trimMp4(tiny, 1, 2), /damaged|moov/, "7 box size < 8");
  const enc = rewrite(mp4, (_p, t, b) => (t === "stsd" ? (() => { const o = b.slice(); const i = Buffer.from(o).indexOf("avc1"); if (i < 0) return undefined; o.set([0x65, 0x6e, 0x63, 0x76], i); return o; })() : undefined));
  refuses(() => trimMp4(enc, 1, 2), /encrypted/, "8 encv sample entry (CENC)");
  const multi = rewrite(mp4, (path, t, b) => (t === "elst" && path.includes("trak") ? (() => { const v = new DataView(b.buffer, b.byteOffset); const e = b.subarray(8, 8 + (b[0] === 1 ? 20 : 12)); const o = new Uint8Array(8 + e.length * 2); o.set(b.subarray(0, 4)); o.set(be32(2), 4); o.set(e, 8); o.set(e, 8 + e.length); void v; return o; })() : undefined));
  refuses(() => trimMp4(multi, 1, 2), /more than one media edit/, "9 multi-edit elst");
  const twoSd = rewrite(mp4, (path, t, b) => {
    if (t === "stsd" && path.includes("trak")) { const ent = b.subarray(8); const o = new Uint8Array(8 + ent.length * 2); o.set(b.subarray(0, 4)); o.set(be32(2), 4); o.set(ent, 8); o.set(ent, 8 + ent.length); return o; }
    if (t === "stsc") { const n = new DataView(b.buffer, b.byteOffset).getUint32(4); const o = b.slice(); if (n >= 1) { const last = 8 + (n - 1) * 12; o.set(be32(2), last + 8); } if (n >= 2) return o; const o2 = new Uint8Array(o.length + 12); o2.set(o); o2.set(be32(2), 4); o2.set(be32(new DataView(b.buffer, b.byteOffset).getUint32(8) + 3), o.length); o2.set(b.subarray(12, 16), o.length + 4); o2.set(be32(2), o.length + 8); o2.set(be32(1), 16); return o2; }
    return undefined;
  });
  refuses(() => trimMp4(twoSd, 0.5, 5), /several sample descriptions/, "10 several sample descriptions in the range");
  const bogus = rewrite(mp4, (_p, t, b) => (t === "stsz" ? (() => { const o = b.slice(); o.set(be32(4), 4); o.set(be32(40_000_000), 8); return o; })() : undefined));
  refuses(() => trimMp4(bogus, 1, 2), /too many samples/, "11 stsz claims 40 M samples of 4 bytes in a small file");
  const shortStco = rewrite(mp4, (_p, t, b) => (t === "stco" ? (() => { const o = b.slice(); o.set(be32(new DataView(b.buffer, b.byteOffset).getUint32(4) + 1000), 4); return o; })() : undefined));
  refuses(() => trimMp4(shortStco, 1, 2), /truncated|damaged|past/, "12 stco count runs past its box");
  const noMoov = mp4.slice(); noMoov.set([0x66, 0x72, 0x65, 0x65], moovAt.start + 4); refuses(() => trimMp4(noMoov, 1, 2), /no moov/, "13 no moov");
  const ebmlBad = webm.slice(); ebmlBad[0] = 0x00; refuses(() => trimWebm(ebmlBad, 1, 2), /no EBML header|invalid element/, "14 damaged EBML header");
  const q = parseMatroska(webm); const tracksAt = (() => { const B = Buffer.from(webm); let i = -1; do { i = B.indexOf(Buffer.from([0x16, 0x54, 0xae, 0x6b]), i + 1); } while (i > 0 && B[i - 3] === 0x53 && B[i - 2] === 0xab); return i; })(); // skip the SeekHead's SeekID copy
  const noTracks = webm.slice(); noTracks.set([0x1a, 0x54, 0xae, 0x6b], tracksAt); refuses(() => trimWebm(noTracks, 1, 2), /no Tracks|invalid element/, "15 WebM without Tracks"); void q;
  // 16: an encrypted Matroska track (ContentEncodings/ContentEncoding/ContentEncryption) is refused
  const te = Buffer.from(webm).indexOf(Buffer.from([0xd7, 0x81, 0x01])); // TrackNumber 1
  const ins = Uint8Array.from([0x6d, 0x80, 0x86, 0x62, 0x40, 0x83, 0x50, 0x35, 0x80]);
  const encW = new Uint8Array(webm.length + ins.length); encW.set(webm.subarray(0, te)); encW.set(ins, te); encW.set(webm.subarray(te), te + ins.length);
  // grow the TrackEntry + Tracks sizes (both use fixed-width size fields in FFmpeg output: patch by re-reading their size vints)
  const grow = (idAt: number, idLen: number) => { const p = idAt + idLen; const len = 8 - Math.floor(Math.log2(encW[p])); let v = encW[p] & (0xff >> len); for (let i = 1; i < len; i++) v = v * 256 + encW[p + i]; v += ins.length; for (let i = len - 1; i >= 1; i--) { encW[p + i] = v & 255; v = Math.floor(v / 256); } encW[p] = (encW[p] & ~(0xff >> len)) | v; };
  grow(tracksAt, 4); const entryAt = encW.lastIndexOf(0xae, te); grow(entryAt, 1);
  refuses(() => trimWebm(encW, 1, 2), /encrypted/, "16 encrypted Matroska track");
  // 17: truncated fragmented download — keeps only the gap-free part, reports the true end, decodes clean
  const cut = rd("h264-frag.mp4").subarray(0, 40_000); const r17 = trimMp4(cut, 1, 2, { mode: "exact" });
  ok(r17.end < 2, `17 truncated fragmented MP4 claims to reach ${r17.end}`);
  assertGood(check(join(FIX, "h264-frag.mp4"), r17.bytes, "trunc-frag.mp4", r17.start, r17.end), "17 truncated fragmented MP4", r17.start, r17.end, true);
  refuses(() => trimMp4(cut, 1.5, 2), /outside the file/, "18 range entirely in the lost part of a truncated file");
});

await test("unusual-but-valid shapes: size-0 (to EOF) mdat, 64-bit largesize mdat, co64 chunk offsets, truncated live WebM recording — all trim and verify", COV, () => {
  if (!have) return;
  const fs0 = rd("h264-aac-faststart.mp4"); const mdat = list(fs0, 0, fs0.length).find((b) => b.type === "mdat")!;
  ok(mdat.end === fs0.length, "faststart mdat is last");
  const z = fs0.slice(); z.set(be32(0), mdat.start);
  let r = trimMp4(z, 1.2, 2.8, { mode: "exact" }); assertGood(check(join(FIX, "h264-aac-faststart.mp4"), r.bytes, "size0.mp4", r.start, r.end), "size-0 mdat", r.start, r.end, true);
  // largesize: 16-byte mdat header → chunk offsets move by +8
  const shift = rewrite(fs0, (_p, t, b) => (t === "stco" ? (() => { const o = b.slice(); const v = new DataView(o.buffer); const n = v.getUint32(4); for (let i = 0; i < n; i++) v.setUint32(8 + i * 4, v.getUint32(8 + i * 4) + 8); return o; })() : undefined));
  const mm = list(shift, 0, shift.length).find((b) => b.type === "mdat")!; const body = shift.subarray(mm.start + 8, mm.end);
  const L = new Uint8Array(mm.start + 16 + body.length); L.set(shift.subarray(0, mm.start)); L.set([0, 0, 0, 1, 0x6d, 0x64, 0x61, 0x74, 0, 0, 0, 0], mm.start); L.set(be32(body.length + 16), mm.start + 12); L.set(body, mm.start + 16);
  r = trimMp4(L, 1.2, 2.8, { mode: "exact" }); assertGood(check(join(FIX, "h264-aac-faststart.mp4"), r.bytes, "largesize.mp4", r.start, r.end), "largesize mdat", r.start, r.end, true);
  // 64-bit largesize on moov itself (moov after mdat, so no offsets move)
  { const src2 = rd("h264-aac.mp4"); const mv2 = list(src2, 0, src2.length).find((b) => b.type === "moov")!; const body2 = src2.subarray(mv2.start + 8, mv2.end);
    const W = new Uint8Array(src2.length + 8); W.set(src2.subarray(0, mv2.start)); W.set([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x76, 0, 0, 0, 0], mv2.start); W.set(be32(body2.length + 16), mv2.start + 12); W.set(body2, mv2.start + 16); W.set(src2.subarray(mv2.end), mv2.start + 16 + body2.length);
    r = trimMp4(W, 1.2, 2.8, { mode: "exact" }); assertGood(check(join(FIX, "h264-aac.mp4"), r.bytes, "largesize-moov.mp4", r.start, r.end), "largesize moov", r.start, r.end, true); }
  // co64 instead of stco (moov after mdat, so offsets keep their values)
  const mp4 = rd("h264-aac.mp4");
  const c64 = (() => { // replace each stco by a co64 box with the same offsets
    const out = rewrite(mp4, (_p, t, b) => { if (t !== "stbl") return undefined; const kids = list(b, 0, b.length); const parts: Uint8Array[] = [];
      for (const k of kids) { const kb = b.subarray(k.start, k.end); if (k.type !== "stco") { parts.push(kb); continue; } const v = new DataView(kb.buffer, kb.byteOffset + 8); const n = v.getUint32(4); const o = new Uint8Array(16 + n * 8); const ov = new DataView(o.buffer); ov.setUint32(0, o.length); o.set([0x63, 0x6f, 0x36, 0x34], 4); ov.setUint32(12, n); for (let i = 0; i < n; i++) { ov.setUint32(16 + i * 8, 0); ov.setUint32(20 + i * 8, v.getUint32(8 + i * 4)); } parts.push(o); }
      let n2 = 0; for (const p of parts) n2 += p.length; const o2 = new Uint8Array(n2); let q2 = 0; for (const p of parts) { o2.set(p, q2); q2 += p.length; } return o2; });
    return out; })();
  ok(Buffer.from(c64).includes("co64") && !Buffer.from(c64).includes("stco"), "fixture uses co64");
  r = trimMp4(c64, 1.2, 2.8, { mode: "exact" }); assertGood(check(join(FIX, "h264-aac.mp4"), r.bytes, "co64.mp4", r.start, r.end), "co64", r.start, r.end, true);
  // truncated live recording (cut mid-cluster): what is complete is kept
  const rec = existsSync(join(OUT, "recorder.webm")) ? new Uint8Array(readFileSync(join(OUT, "recorder.webm"))) : null;
  if (rec) { const cut = rec.subarray(0, Math.floor(rec.length * 0.7)); const r2 = trimWebm(cut, 0.5, 10); const c = check(join(OUT, "recorder.webm"), r2.bytes, "truncated-rec.webm", r2.start, r2.end); ok(c.decode_errors === 0 && c.packets_foreign === 0 && c.video_got > 20, `truncated recording: ${JSON.stringify(c)}`); }
  void parseMovie;
});

await test("int16 cluster-relative timestamps: a 100 s audio-only Matroska with 40 s source clusters splits so every relative time fits", COV, () => {
  // synthetic file: TimestampScale 1 ms, one audio track, a block every 20 ms, clusters every 30 s (rel up to 30000)
  const id = (n: number[]) => Uint8Array.from(n); const sz = (n: number) => { const o = new Uint8Array(8); let v = n; for (let i = 7; i >= 1; i--) { o[i] = v & 255; v = Math.floor(v / 256); } o[0] = 0x01; return o; };
  const cat = (ps: Uint8Array[]) => { let n = 0; for (const p of ps) n += p.length; const o = new Uint8Array(n); let q = 0; for (const p of ps) { o.set(p, q); q += p.length; } return o; };
  const el = (i: number[], ...ps: Uint8Array[]) => { const b = cat(ps); return cat([id(i), sz(b.length), b]); };
  const u = (v: number) => { const o: number[] = []; let x = v; do { o.unshift(x & 255); x = Math.floor(x / 256); } while (x); return Uint8Array.from(o); };
  const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], new TextEncoder().encode("webm")));
  const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], u(1_000_000)));
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], u(1)), el([0x83], u(2)), el([0x86], new TextEncoder().encode("A_OPUS"))));
  const clusters: Uint8Array[] = [];
  for (let c0 = 0; c0 < 100_000; c0 += 30_000) { const bl: Uint8Array[] = [el([0xe7], u(c0))]; for (let t = c0; t < Math.min(c0 + 30_000, 100_000); t += 20) { const rel = t - c0; bl.push(el([0xa3], Uint8Array.of(0x81, rel >> 8, rel & 255, 0x80, t & 255, (t >> 8) & 255))); } clusters.push(el([0x1f, 0x43, 0xb6, 0x75], ...bl)); }
  const file = cat([header, el([0x18, 0x53, 0x80, 0x67], info, tracks, ...clusters)]);
  const r = trimWebm(file, 5, 95); const p = parseMatroska(r.bytes);
  ok(r.clusters >= 3, `clusters ${r.clusters}`); ok(p.blocks.length === (95_000 - 5_000) / 20, `blocks ${p.blocks.length}`);
  ok(p.blocks.every((b, i) => b.time === i * 20), "every block time rebased exactly (int16 split kept the times)");
  ok(p.blocks.every((b) => r.bytes[b.tsAt + 3] === (((b.time + 5000) & 255))), "payload bytes untouched");
});

await test("irregular recorder timestamps: the reported end never passes the next real frame (synthetic gaps 40/10 ms)", COV, () => {
  const id = (n: number[]) => Uint8Array.from(n); const sz = (n: number) => { const o = new Uint8Array(8); let v = n; for (let i = 7; i >= 1; i--) { o[i] = v & 255; v = Math.floor(v / 256); } o[0] = 0x01; return o; };
  const cat = (ps: Uint8Array[]) => { let n = 0; for (const p of ps) n += p.length; const o = new Uint8Array(n); let q = 0; for (const p of ps) { o.set(p, q); q += p.length; } return o; };
  const el = (i: number[], ...ps: Uint8Array[]) => { const b = cat(ps); return cat([id(i), sz(b.length), b]); };
  const u = (v: number) => { const o: number[] = []; let x = v; do { o.unshift(x & 255); x = Math.floor(x / 256); } while (x); return Uint8Array.from(o); };
  const times: number[] = []; for (let i = 0, t = 0; i < 40; i++) { times.push(t); t += i % 2 ? 10 : 40; }
  const bl: Uint8Array[] = [el([0xe7], u(0))]; for (const t of times) bl.push(el([0xa3], Uint8Array.of(0x81, t >> 8, t & 255, 0x80, 1, 2, 3)));
  const file = cat([el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], new TextEncoder().encode("webm"))), el([0x18, 0x53, 0x80, 0x67],
    el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], u(1_000_000))), el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], u(1)), el([0x83], u(1)), el([0x86], new TextEncoder().encode("V_VP8")))),
    el([0x1f, 0x43, 0xb6, 0x75], ...bl))]);
  for (const to of [0.095, 0.3, 0.52]) {
    const r = trimWebm(file, 0, to); const next = times.find((t) => t >= to * 1000 - 0.5)!;
    ok(r.end * 1000 <= next + 1e-6 && r.end >= to - 1e-9, `cut to ${to}: reported end ${(r.end * 1000).toFixed(2)} ms, next frame at ${next} ms`);
    const p = parseMatroska(r.bytes); ok(p.blocks.every((b) => b.time < to * 1000), "only frames before the end");
  }
});

await test("Media module wiring: Lossless cut button + exact-start toggle exist, the re-encode path stays, and the old 'not bundled' blocker text is gone", COV, () => {
  const src = readFileSync("src/components/modules/Media.tsx", "utf8");
  ok(src.includes('data-testid="trim-lossless"') && src.includes('data-testid="trim-reencode"') && src.includes('data-testid="trim-exact"'), "buttons");
  ok(src.includes("losslessTrim(") && src.includes("new MediaRecorder("), "both paths present");
  ok(!/which is not bundled/.test(src), "stale blocker text removed");
  console.log(`    stats: ${stats.mp4Cuts} MP4 cuts, ${stats.mkvCuts} Matroska cuts, ${stats.frames} decoded frames hash-verified`);
});

finish();
