/**
 * TT146 — numerical independence for LN-05/LN-06.
 *
 * The unit suite proves the resampler is self-consistent. This suite proves it
 * agrees with a *different* implementation written in another language (numpy,
 * float64), and — as a band, not a match — with Pillow's own Lanczos. A bug
 * shared between the two would have to be a bug in the definition, which the
 * tests state explicitly (normalised separable sinc, widened support, premultiplied alpha).
 *
 * Python is a test-only oracle from the sandbox venv; if it is absent the suite
 * FAILS rather than passing vacuously (the repo's rule for oracle suites).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { applyRelight, resample, type RgbaImage } from "../src/lib/lens/resample";

const PY = process.env.FUSION_PY ?? "/home/user/tools/venv/bin/python";
const ORACLE = "scripts/oracle/resample_oracle.py";
const { test, finish } = makeHarness("tt146-oracle");

/**
 * TT148 speed-up: one long-lived numpy process instead of one per question.
 *
 * The old path paid a full interpreter start plus a numpy import for every
 * case (~13 of them). The numbers are produced by the same functions with the
 * same inputs; only the process lifetime changed. `oneShot` is kept for the
 * case where the streaming process cannot start (a restricted sandbox), so the
 * suite never degrades into "skipped" silently.
 */
let stream: { write(line: string): Promise<number[]>; close(): void } | null = null;
function streaming(): NonNullable<typeof stream> {
  if (stream) return stream;
  const child = spawn(PY, [ORACLE], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout! });
  const waiters: { resolve: (v: number[]) => void; reject: (e: Error) => void }[] = [];
  let stderr = "";
  child.stderr!.on("data", (d) => { stderr += String(d).slice(0, 400); });
  lines.on("line", (line) => {
    const w = waiters.shift();
    if (!w) return;
    try {
      const parsed = JSON.parse(line) as { data?: number[]; error?: string };
      if (parsed.error) w.reject(new Error(`oracle error: ${parsed.error}`));
      else w.resolve(parsed.data ?? []);
    } catch (e) { w.reject(new Error(`oracle reply was not JSON: ${line.slice(0, 200)}`)); }
  });
  child.on("exit", (code) => {
    for (const w of waiters.splice(0)) w.reject(new Error(`oracle exited (${code}): ${stderr}`));
    stream = null;
  });
  stream = {
    write: (line) => new Promise<number[]>((resolve, reject) => { waiters.push({ resolve, reject }); child.stdin!.write(line + "\n"); }),
    close: () => { try { child.stdin!.end(); } catch { /* already gone */ } },
  };
  return stream;
}
async function oracle(payload: unknown): Promise<number[]> {
  try {
    return await streaming().write(JSON.stringify(payload));
  } catch {
    // Fall back to the one-shot protocol rather than skipping a case.
    const r = spawnSync(PY, [ORACLE], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 256 << 20 });
    if (r.status !== 0) throw new Error(`oracle failed: ${r.stderr?.slice(0, 400)}`);
    return (JSON.parse(r.stdout) as { data: number[] }).data;
  }
}
process.on("exit", () => stream?.close());

if (!existsSync(PY)) {
  console.log(`FAILED: the numpy oracle needs ${PY} (run scripts/sandbox/bootstrap.sh)`);
  process.exitCode = 1;
} else {
  const photo = (w: number, h: number): RgbaImage => {
    // A photo-like pattern: smooth gradients, a hard edge, a bright specular
    // spot and a transparent corner — every case a filter can get wrong.
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = Math.round(255 * (0.5 + 0.5 * Math.sin(x / 7) * Math.cos(y / 9)));
      const edge = x > w / 2 ? 40 : 0;
      const spot = Math.hypot(x - w * 0.3, y - h * 0.7) < w * 0.08 ? 120 : 0;
      data[p] = Math.min(255, v + edge);
      data[p + 1] = Math.min(255, v + spot);
      data[p + 2] = Math.min(255, 255 - v);
      data[p + 3] = x < 4 && y < 4 ? 0 : 255;
    }
    return { data, width: w, height: h };
  };

  await test("LN-05 agrees with the numpy float64 reference on upscale, downscale and odd sizes", { "LN-05": "full" }, async () => {
    for (const [w, h, dw, dh] of [[40, 30, 97, 71], [64, 48, 21, 19], [17, 13, 17, 13], [5, 3, 40, 30]] as const) {
      const img = photo(w, h);
      const mine = resample(img, dw, dh, "lanczos3");
      const theirs = await oracle({ op: "resample", width: w, height: h, data: [...img.data], dstW: dw, dstH: dh, kernel: "lanczos3" });
      assert.equal(theirs.length, mine.data.length);
      let worst = 0, sum = 0, mismatches = 0;
      for (let i = 0; i < theirs.length; i++) {
        const d = Math.abs(theirs[i] - mine.data[i]);
        worst = Math.max(worst, d);
        sum += d;
        if (d > 0) mismatches++;
      }
      assert.ok(worst <= 1, `${w}×${h}→${dw}×${dh}: worst channel difference ${worst}`);
      assert.ok(sum / theirs.length < 0.02, `${w}×${h}→${dw}×${dh}: mean difference ${(sum / theirs.length).toFixed(4)}`);
      assert.ok(mismatches / theirs.length < 0.03, `${w}×${h}→${dw}×${dh}: ${mismatches} of ${theirs.length} channels differ at all`);
    }
    // Bilinear and bicubic agree too: the kernel choice is not a special case.
    const img = photo(23, 19);
    for (const kernel of ["linear", "cubic"] as const) {
      const mine = resample(img, 51, 44, kernel);
      const theirs = await oracle({ op: "resample", width: 23, height: 19, data: [...img.data], dstW: 51, dstH: 44, kernel });
      let worst = 0;
      for (let i = 0; i < theirs.length; i++) worst = Math.max(worst, Math.abs(theirs[i] - mine.data[i]));
      assert.ok(worst <= 1, `${kernel}: worst difference ${worst}`);
    }
  });

  await test("LN-05 is in Pillow's band (an independent third-party Lanczos)", { "LN-05": "partial" }, async () => {
    const img = photo(48, 36);
    const mine = resample(img, 96, 72, "lanczos3");
    const pillow = await oracle({ op: "pillow", width: 48, height: 36, data: [...img.data], dstW: 96, dstH: 72 });
    let sum = 0, worst = 0;
    for (let i = 0; i < pillow.length; i++) {
      const d = Math.abs(pillow[i] - mine.data[i]);
      sum += d; worst = Math.max(worst, d);
    }
    const mean = sum / pillow.length;
    // Two correct Lanczos implementations differ at edges (Pillow clamps the
    // kernel differently and works in fixed point); the band proves we are in
    // the same family, not that we are identical.
    assert.ok(mean < 8, `mean |difference| from Pillow is ${mean.toFixed(2)}`);
    assert.ok(worst <= 255);
    console.log(`    Pillow band: mean ${mean.toFixed(2)}, worst ${worst}`);
  });

  await test("LN-06 agrees with the numpy lighting reference across angles and intensities", { "LN-06": "full" }, async () => {
    const grad = photo(41, 33);
    for (const [azimuth, elevation, intensity] of [[0, 35, 0.8], [135, 10, 0.4], [270, 85, 1.5], [45, 0, 0.25]] as const) {
      const mine = applyRelight(grad, { azimuthDeg: azimuth, elevationDeg: elevation, intensity });
      const theirs = await oracle({ op: "relight", width: 41, height: 33, data: [...grad.data], azimuth, elevation, intensity });
      let worst = 0, sum = 0;
      for (let i = 0; i < theirs.length; i++) {
        const d = Math.abs(theirs[i] - mine.data[i]);
        worst = Math.max(worst, d); sum += d;
      }
      assert.ok(worst <= 2, `az ${azimuth} el ${elevation} i ${intensity}: worst ${worst}`);
      assert.ok(sum / theirs.length < 0.2, `mean ${(sum / theirs.length).toFixed(3)}`);
    }
  });

  finish();
  // The oracle process keeps the event loop alive; closing its stdin lets it
  // exit, which is what makes the suite finish as fast as its work.
  stream?.close();
}
