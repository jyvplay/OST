/** Service-worker logic in a deliberately in-memory CacheStorage model.
 * These are not browser or deployment tests; see e2e-tt129-offline.mts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt129-worker-unit");
const oldRoot = '<link rel="stylesheet" href="/_next/static/chunks/old.css"><script src="/_next/static/chunks/old.js"></script>';
const nextRoot = '<link rel="stylesheet" href="/_next/static/chunks/old.css"><script src="/_next/static/chunks/new.js"></script>';
const html = (text: string) => new Response(text, { headers: { "content-type": "text/html" } });
function model(root = oldRoot) {
  const stored = new Map<string, Response>(), calls: string[][] = [], assetFetches: string[] = [], fail = new Set<string>();
  const bodies = new Map<string, Response>([
    ["/", html(root)], ["/offline.html", html("offline")], ["/manifest.webmanifest", new Response("{}")],
    ["/icon.svg", new Response("icon")], ["/icon-192.png", new Response("icon")],
    ["/wallpapers/poolside.svg", new Response("wallpaper")],
    ["/_next/static/chunks/old.js", new Response("old javascript", { headers: { "content-type": "application/javascript" } })],
    ["/_next/static/chunks/new.js", new Response("new javascript", { headers: { "content-type": "application/javascript" } })],
    ["/_next/static/chunks/old.css", new Response('a{src:url(../media/font.woff2)} b{src:url("/fonts/local.woff2")} c{background:url(/wallpapers/poolside.svg)} d{src:url(/api/private)} e{src:url(https://elsewhere.test/other.woff2)} f{src:url(/fonts/secret.woff2?token=x)}', { headers: { "content-type": "text/css" } })],
    ["/_next/static/media/font.woff2", new Response("font")], ["/fonts/local.woff2", new Response("font")],
  ]);
  const cache = {
    match: async (key: string) => stored.get(key)?.clone(),
    put: async (key: string, value: Response) => { stored.set(key, value.clone()); },
    addAll: async (paths: string[]) => {
      calls.push([...paths]);
      for (const path of paths) if (fail.has(path) || !bodies.has(path)) throw new Error(`injected missing asset: ${path}`);
      for (const path of paths) stored.set(path, bodies.get(path)!.clone());
    },
  };
  const listeners: Record<string, (event: any) => void> = {};
  let network = html(nextRoot);
  runInNewContext(readFileSync("public/sw.js", "utf8"), {
    self: { location: { origin: "https://app.test" }, addEventListener: (name: string, callback: (event: any) => void) => { listeners[name] = callback; } },
    caches: { open: async () => cache }, URL, Response, fetch: async (input: unknown) => {
      if (typeof input !== "string") return network.clone();
      assetFetches.push(input);
      if (fail.has(input) || !bodies.has(input)) throw new Error(`injected missing asset: ${input}`);
      return bodies.get(input)!.clone();
    },
  });
  const install = async () => {
    let task: Promise<unknown> | undefined; listeners.install({ waitUntil: (p: Promise<unknown>) => { task = p; } });
    assert.ok(task); await task;
  };
  const navigate = async (response: Response) => {
    network = response; const tasks: Promise<unknown>[] = []; let result: Promise<Response> | undefined;
    // Dispatch the VM's captured handler, not a network fetch.
    const dispatch = listeners["fetch"];
    dispatch({ request: { method: "GET", url: "https://app.test/", mode: "navigate" }, respondWith: (p: Promise<Response>) => { result = p; }, waitUntil: (p: Promise<unknown>) => tasks.push(p) });
    assert.ok(result); const returned = await result; await Promise.all(tasks); return returned;
  };
  return { stored, bodies, calls, assetFetches, fail, install, navigate };
}
await test("worker discovers shell assets and only permitted same-origin CSS resources", { "SH-14": "partial" }, async () => {
  const m = model(oldRoot + '<script>"/_next/static/../../api/leak.js"</script>'); await m.install();
  const keys = [...m.stored.keys()];
  assert.ok(keys.includes("/_next/static/chunks/old.js") && keys.includes("/_next/static/chunks/old.css"));
  assert.ok(keys.includes("/_next/static/media/font.woff2") && keys.includes("/fonts/local.woff2"));
  assert.ok(!keys.some((path) => path.includes("/api/") || path.includes("?token") || path.includes("elsewhere")));
});
await test("worker installation rejects missing JS and missing CSS dependencies", { "AP-04": "partial" }, async () => {
  for (const path of ["/_next/static/chunks/old.js", "/_next/static/media/font.woff2"]) {
    const m = model(); m.fail.add(path); await assert.rejects(m.install(), /injected missing asset/);
  }
  await assert.rejects(model("<p>not a shell</p>").install(), /no discoverable JavaScript/);
});
await test("failed refresh retains the previous root, then commits once assets succeed", { "SH-14": "partial" }, async () => {
  const m = model(); await m.install(); m.fail.add("/_next/static/chunks/new.js");
  assert.equal(await (await m.navigate(html(nextRoot))).text(), nextRoot, "online navigation still gets the network response");
  assert.equal(await m.stored.get("/")!.text(), oldRoot, "the offline root did not change");
  m.fail.clear(); await m.navigate(html(nextRoot));
  assert.equal(await m.stored.get("/")!.text(), nextRoot);
  assert.ok(m.stored.has("/_next/static/chunks/new.js"));
});
await test("unchanged root refresh does not refetch already cached shell assets", { "SH-14": "partial" }, async () => {
  const m = model(); await m.install(); const calls = m.calls.length, fetches = m.assetFetches.length;
  await m.navigate(html(oldRoot)); assert.equal(m.calls.length, calls); assert.equal(m.assetFetches.length, fetches);
});
await test("HTML masquerading as a chunk is rejected without poisoning the cache", { "AP-04": "partial" }, async () => {
  const m = model(); m.bodies.set("/_next/static/chunks/old.js", html("login page"));
  await assert.rejects(m.install(), /invalid.*content type/i);
  assert.equal(m.stored.has("/_next/static/chunks/old.js"), false, "invalid response was never written to CacheStorage");
  m.bodies.set("/_next/static/chunks/old.js", new Response("javascript", { headers: { "content-type": "text/javascript" } }));
  await m.install(); assert.ok(m.stored.has("/_next/static/chunks/old.js"));
});
finish();
