import assert from "node:assert/strict";
import { MAX_BROWSER_SAVE_BYTES, downloadMime, readBrowserSave, saveBrowserDownload, saveName } from "../src/lib/browser-download.ts";
import { privacy } from "../src/lib/privacy/session.ts";
import { PrivacyLayer } from "../src/lib/privacy/layer.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt91-browser-download");
const covers = { "PR-07m": "partial" } as const;
const signal = () => new AbortController().signal;

await test("download names cannot escape Downloads and malformed percent escapes do not crash", covers, () => {
  assert.equal(saveName("https://example.test/docs/report", "text/html; charset=utf-8"), "report.html");
  assert.equal(saveName("https://example.test/a/photo.png?token=secret", "image/png"), "photo.png");
  assert.equal(saveName("https://example.test/a/%2Fetc%2Fpasswd", "text/plain"), "_etc_passwd");
  assert.equal(saveName("https://example.test/a/%E0%A4%A", "text/plain"), "%E0%A4%A");
  assert.equal(saveName("https://example.test/a/%E2%80%AEsecret.txt", "text/plain"), "_secret.txt");
  assert.equal(saveName("https://example.test/", "text/html"), "example.test.html");
  assert.equal(saveName("not a url", "text/html"), "page.html");
});
await test("MIME metadata is canonicalised and control characters or invalid shapes are refused", covers, () => {
  assert.equal(downloadMime("TEXT/HTML; charset=utf-8"), "text/html");
  assert.equal(downloadMime("application/ld+json"), "application/ld+json");
  for (const type of ["", "text", "text/html\r\nX: evil", "image/" + "x".repeat(250)]) assert.equal(downloadMime(type), "application/octet-stream");
});
await test("a streamed body up to and including 8 MiB is read exactly, with real byte progress", covers, async () => {
  const block = new Uint8Array(1024 * 1024); block[0] = 23; block[block.length - 1] = 91;
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < 8; i++) c.enqueue(block); c.close(); } });
  const events: number[] = []; const result = await readBrowserSave(new Response(stream), signal(), (n) => events.push(n));
  assert.equal(result.byteLength, MAX_BROWSER_SAVE_BYTES); assert.equal(result[0], 23); assert.equal(result[result.length - 1], 91);
  assert.deepEqual(events, Array.from({ length: 8 }, (_, i) => (i + 1) * block.length));
  assert.equal((await readBrowserSave(new Response(null, { status: 204 }), signal())).byteLength, 0);
});
await test("oversized declared length cancels before buffering the body", covers, async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(1)); c.close(); }, cancel() { cancelled = true; } });
  await assert.rejects(() => readBrowserSave(new Response(stream, { headers: { "content-length": String(MAX_BROWSER_SAVE_BYTES + 1) } }), signal()), /8 MiB/);
  assert.equal(cancelled, true);
});
await test("missing or dishonest content length cannot evade the actual-byte limit", covers, async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(MAX_BROWSER_SAVE_BYTES)); c.enqueue(Uint8Array.of(7)); c.enqueue(Uint8Array.of(8)); c.close(); }, cancel() { cancelled = true; } });
  await assert.rejects(() => readBrowserSave(new Response(stream, { headers: { "content-length": "1" } }), signal()), /8 MiB/);
  assert.equal(cancelled, true);
});
await test("HTTP errors and partial responses are not saved as complete downloads", covers, async () => {
  for (const status of [206, 404, 500]) await assert.rejects(() => readBrowserSave(new Response("x", { status }), signal()), /partial|HTTP/i);
});
await test("an abort interrupts a stalled reader without returning a partial file", covers, async () => {
  const controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(1, 2)); }, cancel() { cancelled = true; } });
  const pending = readBrowserSave(new Response(stream), controller.signal); controller.abort();
  await assert.rejects(() => pending, (e: Error) => e.name === "AbortError"); assert.equal(cancelled, true);
});
await test("a broken response body fails rather than publishing the earlier chunks", covers, async () => {
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Uint8Array.of(1)); c.error(new Error("upstream reset")); } });
  await assert.rejects(() => readBrowserSave(new Response(stream), signal()), /upstream reset/);
});
await test("server import refuses an uninstalled privacy guard", covers, async () => {
  await assert.rejects(() => saveBrowserDownload("https://example.test/a", "text/plain", Uint8Array.of(1)), /unavailable/);
});
await test("an installed amnesic privacy layer refuses before any fetch or host write", covers, async () => {
  let calls = 0; const old = privacy.layer;
  privacy.layer = new PrivacyLayer(async () => { calls++; throw new Error("unexpected fetch"); }); privacy.layer.amnesic = true;
  try { await assert.rejects(() => saveBrowserDownload("https://example.test/a", "text/plain", Uint8Array.of(1)), /amnesic/); assert.equal(calls, 0); }
  finally { privacy.layer = old; }
});
finish();
