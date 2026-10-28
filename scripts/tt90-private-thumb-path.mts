import assert from "node:assert/strict";
import { isPrivateThumbnailPath } from "../src/lib/thumbs/service.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt90-private-thumb-path");
await test("private thumbnail routing normalizes path aliases without treating lookalike names as private", { "SC-10": "partial" }, () => {
  for (const path of ["/Private", "/Private/a.jpg", "/x/../Private/a.jpg", "//Private//sub/./a", "/Priva\u0000te/a", "Private/a"]) assert.equal(isPrivateThumbnailPath(path), true, path);
  for (const path of ["/", "/Private2/a", "/private/a", "/Private/../Public/a", "/x/Private/a", "/Private/../../x"]) assert.equal(isPrivateThumbnailPath(path), false, path);
});
finish();
