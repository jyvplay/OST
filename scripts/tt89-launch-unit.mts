import assert from "node:assert/strict";
import { launchModule, protocolModule } from "../src/lib/pwa-launch.ts";
import { decodeLaunchFile, importLaunchFile, MAX_LAUNCH_FILE_BYTES } from "../src/lib/pwa-file-import.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt89-launch-unit");
const pwa = { "SH-13": "partial" } as const;
const protocol = { ...pwa, "AU-03": "partial" } as const;
const ids = ["files", "editor", "settings"];

await test("protocol accepts only the documented, known app intent", protocol, () => {
  assert.equal(protocolModule("web+fusion://open?app=files", ids), "files");
  assert.equal(protocolModule("web+fusion://open/?app=editor", ids), "editor");
  assert.equal(protocolModule("web+fusion://open?app=unknown", ids), null);
  for (const input of ["files", "https://open?app=files", "web+fusion://delete?app=files", "web+fusion://open/files?app=files", "web+fusion://open?app=files&cmd=delete", "web+fusion://open?app=files&app=editor", "web+fusion://user@open?app=files", "web+fusion://open?app=files#fragment", "web+fusion://open?app=files\n", "web+fusion://open?app=files\\evil", "x".repeat(2049)]) assert.equal(protocolModule(input, ids), null, input);
});
await test("existing-window URL is same-origin, root-only, one bounded module parameter", protocol, () => {
  const origin = "https://fusion.example";
  assert.equal(launchModule("/?open=settings", origin, ids), "settings");
  assert.equal(launchModule("/?cmd=" + encodeURIComponent("web+fusion://open?app=files"), origin, ids), "files");
  for (const url of ["https://evil.example/?open=files", "/deep?open=files", "/?open=files&path=/Private/x", "/?open=files&open=editor", "/?cmd=files", "/?open=unknown", "/?open=files#x", "javascript:alert(1)", "//evil.example/?open=files", "/?cmd=" + encodeURIComponent("web+fusion://open?app=files&do=write")]) assert.equal(launchModule(url, origin, ids), null, url);
});
await test("strict UTF-8 text, BOM and MIME are preserved independent of the claimed file type", pwa, async () => {
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("snow 🐚\n")]);
  const file = new File([bytes], "notes.MD", { type: "application/x-dangerous" });
  const got = await decodeLaunchFile(file);
  assert.equal(got.name, "notes.MD"); assert.equal(got.mime, "text/markdown");
  assert.deepEqual(Buffer.from(got.text, "utf8"), bytes);
});
await test("invalid filenames, prototype extensions, control characters and unsupported types fail", pwa, async () => {
  for (const name of ["../bad.txt", "evil\\file.txt", "bad\n.txt", "file.constructor", "file.__proto__", "file.exe", "no-extension", `${"a".repeat(238)}.txt`]) {
    await assert.rejects(() => decodeLaunchFile(new File(["x"], name)), /invalid|supported/i, name);
  }
});
await test("malformed UTF-8, embedded NUL and oversized files are rejected", pwa, async () => {
  await assert.rejects(() => decodeLaunchFile(new File([Uint8Array.of(0xc0, 0x80)], "invalid.txt")), /UTF-8/);
  await assert.rejects(() => decodeLaunchFile(new File(["abc\0def"], "nul.txt")), /NUL/);
  await assert.rejects(() => decodeLaunchFile(new File([new Uint8Array(MAX_LAUNCH_FILE_BYTES + 1).fill(65)], "large.txt")), /1 MiB/);
  assert.equal((await decodeLaunchFile(new File([new Uint8Array(MAX_LAUNCH_FILE_BYTES).fill(65)], "max.txt"))).text.length, MAX_LAUNCH_FILE_BYTES);
});
await test("server import refuses an uninstalled privacy guard", pwa, async () => {
  await assert.rejects(() => importLaunchFile(new File(["sensitive"], "secret.txt")), /unavailable/);
});
finish();
