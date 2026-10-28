import assert from "node:assert/strict";
import { classifyContext, defaultContextConfig, parseContextConfig, changeContextProfile } from "../src/lib/context-profiles.ts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt90-context-unit");
await test("default is opt-out; every profile follows the shared text size", { "ST-09": "partial" }, () => {
  const d = defaultContextConfig();
  assert.equal(d.enabled, false);
  assert.deepEqual(Object.values(d.profiles).map((p) => p.textScale), [null, null, null]);
  const other = defaultContextConfig(); d.profiles.extended.density = "touch";
  assert.equal(other.profiles.extended.density, "compact");
});
await test("multiple screens override primary pointer; single-screen pointer classification ignores viewport size", { "ST-09": "partial" }, () => {
  assert.equal(classifyContext(true, true).kind, "extended");
  assert.equal(classifyContext(true, false).kind, "extended");
  assert.equal(classifyContext(false, true).kind, "single-touch");
  assert.equal(classifyContext(false, false).kind, "single-pointer");
  assert.deepEqual(classifyContext(undefined, true), { kind: "single-touch", displayDetection: false, primaryCoarse: true });
});
await test("round trip accepts only a boolean opt-in, valid densities and bounded integer text sizes", { "ST-09": "partial" }, () => {
  let d = defaultContextConfig(); d.enabled = true;
  d = changeContextProfile(d, "single-pointer", { density: "compact", textScale: 100 });
  d = changeContextProfile(d, "extended", { density: "touch", textScale: 300 });
  assert.deepEqual(parseContextConfig(JSON.stringify(d)), d);
  const changed = changeContextProfile(d, "extended", { density: "balanced", textScale: null });
  assert.equal(d.profiles.extended.density, "touch"); assert.equal(changed.profiles.extended.density, "balanced");
  assert.throws(() => changeContextProfile(d, "extended", { density: "bogus" as never, textScale: 125 }));
  assert.throws(() => changeContextProfile(d, "extended", { density: "touch", textScale: 301 }));
});
await test("malformed, overlong and prototype-shaped storage cannot turn on a partial or invalid profile", { "ST-09": "partial" }, () => {
  const d = defaultContextConfig(); d.enabled = true;
  const bad: unknown[] = ["not json", "x".repeat(5000), "null", "[]", JSON.stringify({ ...d, version: 2 }),
    JSON.stringify({ ...d, enabled: "true" }), JSON.stringify({ ...d, profiles: {} }),
    JSON.stringify({ ...d, profiles: { ...d.profiles, extended: { density: "constructor", textScale: null } } }),
    JSON.stringify({ ...d, profiles: { ...d.profiles, extended: { density: "touch", textScale: 99 } } }),
    JSON.stringify({ ...d, profiles: { ...d.profiles, extended: { density: "touch", textScale: 125.5 } } }),
    JSON.stringify({ ...d, profiles: { ...d.profiles, extended: { density: "touch", textScale: "200" } } }),
    '{"version":1,"enabled":true,"profiles":{"__proto__":{"density":"touch","textScale":200}}}'];
  for (const raw of bad) assert.deepEqual(parseContextConfig(raw as string), defaultContextConfig(), String(raw).slice(0, 80));
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});
finish();
