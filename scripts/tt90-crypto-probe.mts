/** Diagnostic only: measure stages of the browser's current AES-GCM-shaped workload.
 * It does not replace the existing /Private benchmark or assert hardware performance. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt90-crypto-probe");
const browser = await launchChromium();
try {
  const page = await browser.newPage();
  await page.goto(`${process.env.BASE ?? "http://localhost:3999"}/manifest.webmanifest`);
  await test("real Chromium raw AES-GCM and copies, each authenticated and read back (diagnostic, not a performance gate)", { "SC-10": "partial" }, async () => {
    const report = await page.evaluate(async () => {
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      // Approximate the 4 MiB + Padmé-padded workload, with synthetic, non-sensitive data.
      const bytes = 4 * 1024 * 1024;
      const padded = bytes + 256 * 1024;
      const source = new Uint8Array(bytes);
      for (let o = 0; o < source.length; o += 65536) crypto.getRandomValues(source.subarray(o, o + 65536));
      const originalHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", source)));
      const enc: number[] = [], dec: number[] = [], prep: number[] = [], pack: number[] = [], unpack: number[] = [];
      for (let i = 0; i < 9; i++) {
        let t = performance.now();
        const body = new Uint8Array(padded); body.set(source, 32);
        prep.push(performance.now() - t);
        // Never reuse a nonce with this throwaway key.
        const iv = crypto.getRandomValues(new Uint8Array(12));
        t = performance.now();
        const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body));
        enc.push(performance.now() - t);
        t = performance.now();
        body.fill(0); const envelope = new Uint8Array(cipher.length + 18); envelope.set(iv, 6); envelope.set(cipher, 18);
        pack.push(performance.now() - t);
        t = performance.now();
        const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.subarray(6, 18) }, key, envelope.subarray(18)));
        dec.push(performance.now() - t);
        t = performance.now();
        const copy = plain.slice(32, 32 + bytes); plain.fill(0);
        unpack.push(performance.now() - t);
        const restoredHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
        if (restoredHash.some((v, j) => v !== originalHash[j])) throw new Error("decrypted data mismatch");
        envelope[envelope.length - 1] ^= 1;
        let rejected = false;
        try { await crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.subarray(6, 18) }, key, envelope.subarray(18)); } catch { rejected = true; }
        if (!rejected) throw new Error("modified ciphertext was accepted");
      }
      const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
      return { userAgent: navigator.userAgent, rawMiB: padded / 1048576, runs: enc.length,
        medianMs: { prep: median(prep), encrypt: median(enc), packWipe: median(pack), decrypt: median(dec), copyWipe: median(unpack) },
        encryptMiBps: Math.round((padded / 1048576) * 1000 / median(enc)), decryptMiBps: Math.round((padded / 1048576) * 1000 / median(dec)) };
    });
    assert.equal(report.runs, 9);
    console.log(`    diagnostic ${JSON.stringify(report)}`);
  });
} finally { await browser.close(); }
finish();
