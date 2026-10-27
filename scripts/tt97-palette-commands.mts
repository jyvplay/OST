/** Pure parser invariants: no network, storage or shell access. */
import assert from "node:assert/strict";
import { parsePaletteAction, PALETTE_ACTION_LIMIT } from "../src/lib/palette-actions.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt97-palette-commands");
const cov = { "SR-06": "partial" } as const;
await test("notes require an explicit command and preserve punctuation as plain text", cov, () => {
  assert.deepEqual(parsePaletteAction(" NOTE  "), { kind: "note", text: "" });
  assert.deepEqual(parsePaletteAction("note <script> ; focus off"), { kind: "note", text: "<script> ; focus off" });
  assert.equal(parsePaletteAction("notebook test"), null); assert.equal(parsePaletteAction("new note test"), null);
});
await test("focus actions accept only exact toggle, on and off", cov, () => {
  assert.deepEqual(parsePaletteAction(" focus "), { kind: "focus", mode: "toggle" });
  assert.deepEqual(parsePaletteAction("FOCUS ON"), { kind: "focus", mode: "on" });
  assert.deepEqual(parsePaletteAction("focus off"), { kind: "focus", mode: "off" });
  for (const input of ["focus maybe", "focus on; closeAll", "focused", "focus off now"]) assert.equal(parsePaletteAction(input), null, input);
});
await test("settings and routine filters are bounded and cannot become commands", cov, () => {
  assert.deepEqual(parsePaletteAction("setting  appearance.theme  "), { kind: "setting", query: "appearance.theme" });
  assert.deepEqual(parsePaletteAction("RUN Daily Focus"), { kind: "routine", query: "Daily Focus" });
  assert.deepEqual(parsePaletteAction("run"), { kind: "routine", query: "" });
  for (const input of ["setting", `setting ${"x".repeat(201)}`, `run ${"x".repeat(201)}`, "runaway", "cast to device"]) assert.equal(parsePaletteAction(input), null, input);
});
await test("4096-code-unit limit includes padding; the boundary is accepted exactly", cov, () => {
  assert.equal(PALETTE_ACTION_LIMIT, 4096);
  assert.equal(parsePaletteAction(`note ${"a".repeat(4091)}`)?.kind, "note");
  assert.equal(parsePaletteAction(`note ${"a".repeat(4092)}`), null);
  assert.equal(parsePaletteAction(`${" ".repeat(4093)}run `), null);
});
finish();
