/** Focused regression tests for TT126; run with scripts/register-hook.mjs. */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { makeHarness } from "./harness.mts";
import { zoomOptions } from "../src/lib/zoom-pick.ts";
import { expandAlias } from "../src/lib/alias-map.ts";

const { test, finish } = makeHarness("tt126-regressions");
await test("zoom: bounded grid samples, tiny steps, nonaligned max and invalid capabilities", {}, () => {
  assert.deepEqual(zoomOptions({ min: 1, max: 4, step: 1 }), [1, 2, 3, 4]);
  assert.deepEqual(zoomOptions({ min: 1, max: 2, step: .3 }), [1, 1.3, 1.6, 1.9]);
  assert.deepEqual(zoomOptions({ min: 1, max: 2 }), [1, 2]);
  const tiny = zoomOptions({ min: 1, max: 2, step: .000001 });
  assert.equal(tiny.length, 12); assert.equal(tiny[0], 1); assert.equal(tiny.at(-1), 2);
  for (const z of tiny) assert.ok(Math.abs((z - 1) / .000001 - Math.round((z - 1) / .000001)) < 1e-6);
  assert.deepEqual(zoomOptions({ min: 1, max: Infinity, step: 1 }), []);
  assert.deepEqual(zoomOptions({ min: 1, max: 2, step: 0 }), []);
  assert.deepEqual(zoomOptions({ min: 1, max: 2, step: Number.MIN_VALUE }), []);
});
await test("aliases: inherited names are commands unless explicitly defined", {}, () => {
  assert.equal(expandAlias("constructor arg", {}), "constructor arg");
  assert.equal(expandAlias("toString", {}), "toString");
  assert.equal(expandAlias("constructor arg", { constructor: "echo ok" }), "echo ok arg");
  assert.equal(expandAlias("g test", { g: "echo" }), "echo test");
});

// Exercise the actual service worker handlers with an in-memory CacheStorage
// model, including navigation responses; this is not a real-browser test.
await test("service worker: unrelated caches survive and only the canonical successful shell refreshes root", {}, async () => {
  const listeners: Record<string, (e: any) => void> = {};
  const writes: string[] = [], deleted: string[] = [];
  let response = new Response("desktop", { headers: { "content-type": "text/html" } });
  const caches = {
    keys: async () => ["fusion-v5", "fusion-v6", "another-app"],
    delete: async (key: string) => { deleted.push(key); return true; },
    open: async () => ({ put: async (key: string) => { writes.push(key); }, match: async () => undefined, addAll: async () => {} }),
    match: async () => undefined,
  };
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: { location: { origin: "https://example.test" }, addEventListener: (name: string, fn: any) => { listeners[name] = fn; }, skipWaiting: () => {} },
    caches, URL, Response, fetch: async () => response,
  });
  let active: Promise<unknown> = Promise.resolve();
  listeners.activate({ waitUntil: (p: Promise<unknown>) => { active = p; } }); await active;
  assert.deepEqual(deleted, ["fusion-v5"]);
  const navigate = async (path: string, res: Response) => {
    response = res; let result: Promise<Response> | undefined;
    listeners.fetch({ request: { method: "GET", url: `https://example.test${path}`, mode: "navigate" }, respondWith: (p: Promise<Response>) => { result = p; } });
    assert.ok(result); await result; await new Promise((r) => setImmediate(r));
  };
  const html = () => new Response("ok", { headers: { "content-type": "text/html" } });
  await navigate("/present", html()); await navigate("/?secret=x", html());
  await navigate("/", new Response("server error", { status: 500, headers: { "content-type": "text/html" } }));
  await navigate("/", new Response("not html", { headers: { "content-type": "text/plain" } }));
  assert.deepEqual(writes, []);
  await navigate("/", html()); assert.deepEqual(writes, ["/"]);
});

await test("browser gate rejects a process that prints success then exits nonzero", {}, () => {
  const dir = mkdtempSync(join(tmpdir(), "ost-gate-"));
  try {
    const node = join(dir, "node"), curl = join(dir, "curl");
    writeFileSync(node, '#!/bin/sh\necho "1 passed, 0 failed"\ncase "$*" in *e2e-tt125.mts*) exit 7;; esac\n');
    writeFileSync(curl, '#!/bin/sh\nexit 0\n'); chmodSync(node, 0o755); chmodSync(curl, 0o755);
    const p = spawnSync("bash", ["scripts/run-gate.sh"], { cwd: resolve("."), env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BASE: "http://unused", DATABASE_URL: "unused", JOBS: "2" }, encoding: "utf8", timeout: 30000 });
    assert.equal(p.status, 1, p.stdout + p.stderr); assert.match(p.stdout, /GATE FAILED \(browser\):.*e2e-tt125/);
    // Also check that successful processes do not produce a false failure.
    writeFileSync(node, '#!/bin/sh\necho "1 passed, 0 failed"\n'); chmodSync(node, 0o755);
    const ok = spawnSync("bash", ["scripts/run-gate.sh"], { cwd: resolve("."), env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, BASE: "http://unused", DATABASE_URL: "unused", JOBS: "2" }, encoding: "utf8", timeout: 30000 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr); assert.match(ok.stdout, /GATE PASSED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await test("fast default retains the external oracle and propagates its failure", {}, () => {
  const dir = mkdtempSync(join(tmpdir(), "ost-fast-"));
  try {
    const node = join(dir, "node");
    writeFileSync(node, '#!/bin/sh\necho "1 passed, 0 failed"\ncase "$*" in *oracle-ai.mts*) exit 7;; esac\n'); chmodSync(node, 0o755);
    const result = spawnSync("bash", ["scripts/run-fast.sh"], { cwd: resolve("."), env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, JOBS: "2" }, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /network-dependent oracle-ai/);
    assert.match(result.stdout, /FAILED oracle-ai/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
finish();
