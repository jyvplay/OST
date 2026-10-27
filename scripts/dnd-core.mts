/**
 * Unit suite "dnd-core" — TT87 FM-14 pure helpers, no browser, no DB.
 * Verifies the security boundary, the DownloadURL contract and the cycle guard.
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import {
  DRAG_TYPE, PRIVATE_ROOT, DESKTOP_DIR,
  isPrivatePath, isVfsPath, parseFusionPaths, encodeFusionPaths,
  canDragOut, downloadUrlValue, classifyDrop, intentFor, dropCreatesCycle, dedupeName,
} from "../src/lib/dnd-core.ts";

const { test, finish } = makeHarness("dnd-core");

await test("DRAG_TYPE and PRIVATE_ROOT constants", { "FM-14": "full" }, () => {
  assert.equal(DRAG_TYPE, "application/x-fusion-paths");
  assert.equal(PRIVATE_ROOT, "/Private");
  assert.equal(DESKTOP_DIR, "/Documents");
});

await test("isPrivatePath: exact boundary", { "FM-14": "full" }, () => {
  assert.equal(isPrivatePath("/Private"), true);
  assert.equal(isPrivatePath("/Private/a.txt"), true);
  assert.equal(isPrivatePath("/Private/sub/dir/file.pdf"), true);
  assert.equal(isPrivatePath("/PrivateNotes"), false);
  assert.equal(isPrivatePath("/Documents/file.txt"), false);
  assert.equal(isPrivatePath("/"), false);
  assert.equal(isPrivatePath("/private"), false); // case-sensitive
});

await test("isVfsPath: absolute, no double slash, no NUL", { "FM-14": "full" }, () => {
  assert.equal(isVfsPath("/a/b/c"), true);
  assert.equal(isVfsPath("/Documents/file.txt"), true);
  assert.equal(isVfsPath("/"), true);
  assert.equal(isVfsPath("a/b"), false);
  assert.equal(isVfsPath("/a//b"), false);
  assert.equal(isVfsPath("/a\0b"), false);
  assert.equal(isVfsPath(""), false);
});

await test("encode/parse Fusion paths round-trip, hostile input rejected", { "FM-14": "full" }, () => {
  assert.deepEqual(parseFusionPaths(encodeFusionPaths(["/a.txt", "/b/c.pdf"])), ["/a.txt", "/b/c.pdf"]);
  assert.deepEqual(parseFusionPaths(null), []);
  assert.deepEqual(parseFusionPaths(undefined), []);
  assert.deepEqual(parseFusionPaths("not json"), []);
  assert.deepEqual(parseFusionPaths('{"a":1}'), []);
  assert.deepEqual(parseFusionPaths(JSON.stringify(["/ok", "relative/bad", "/ok2"])), ["/ok", "/ok2"]);
  assert.deepEqual(parseFusionPaths(JSON.stringify(["/ok", "/a//b"])), ["/ok"]); // double slash filtered
  assert.deepEqual(parseFusionPaths(JSON.stringify([])), []);
  // non-string entries filtered
  assert.deepEqual(parseFusionPaths(JSON.stringify(["/ok", 123, null, "/ok2"])), ["/ok", "/ok2"]);
  // nested payload ignored
  assert.deepEqual(parseFusionPaths(JSON.stringify([["/nested"]])), []);
  // XSS via path content stays as string (rendering layer must escape)
  const xss = "/x/<script>.txt";
  assert.deepEqual(parseFusionPaths(encodeFusionPaths([xss])), [xss]);
});

await test("canDragOut: all outside /Private, none inside", { "FM-14": "full" }, () => {
  assert.equal(canDragOut(["/Documents/a.txt"]), true);
  assert.equal(canDragOut(["/Documents/a.txt", "/Pictures/b.jpg"]), true);
  assert.equal(canDragOut(["/Private/a.txt"]), false);
  assert.equal(canDragOut(["/Documents/a.txt", "/Private/b.txt"]), false);
  assert.equal(canDragOut([]), false);
  assert.equal(canDragOut(["/Private"]), false);
});

await test("downloadUrlValue: sanitises name and mime, preserves URL", { "FM-14": "full" }, () => {
  const v = downloadUrlValue("text/plain", "hello.txt", "https://example.com/raw?path=/a");
  assert.equal(v, "text/plain:hello.txt:https://example.com/raw?path=/a");
  // colon in name replaced
  assert.equal(downloadUrlValue("text/plain", "a:b.txt", "https://x/y"), "text/plain:a_b.txt:https://x/y");
  // slash in name replaced
  assert.equal(downloadUrlValue("text/plain", "a/b.txt", "https://x/y"), "text/plain:a_b.txt:https://x/y");
  // bad mime falls back
  assert.equal(downloadUrlValue("", "a.txt", "https://x/y"), "application/octet-stream:a.txt:https://x/y");
  assert.equal(downloadUrlValue("not a mime!!", "a.txt", "https://x/y"), "application/octet-stream:a.txt:https://x/y");
  // mime with plus is allowed
  assert.equal(downloadUrlValue("image/svg+xml", "logo.svg", "https://x/y"), "image/svg+xml:logo.svg:https://x/y");
});

await test("classifyDrop: distinguishes fusion/files/mixed/none", { "FM-14": "full" }, () => {
  assert.equal(classifyDrop([DRAG_TYPE], false), "fusion");
  assert.equal(classifyDrop(["Files"], true), "files");
  assert.equal(classifyDrop([DRAG_TYPE, "Files"], true), "mixed");
  assert.equal(classifyDrop(["text/plain"], false), "none");
  assert.equal(classifyDrop([], false), "none");
  assert.equal(classifyDrop([], true), "files"); // FilesList present even if types empty — hasFiles flag wins
});

await test("intentFor: Ctrl/Alt = copy, otherwise move", { "FM-14": "full" }, () => {
  assert.equal(intentFor(false), "move");
  assert.equal(intentFor(true), "copy");
});

await test("dropCreatesCycle: folder into itself or descendant blocked", { "FM-14": "full" }, () => {
  assert.equal(dropCreatesCycle(["/a"], "/a"), true);
  assert.equal(dropCreatesCycle(["/a"], "/a/b"), true);
  assert.equal(dropCreatesCycle(["/a"], "/a/b/c/d"), true);
  assert.equal(dropCreatesCycle(["/a/b"], "/a"), false);
  assert.equal(dropCreatesCycle(["/a", "/b"], "/a/c"), true); // one cycle is enough
  assert.equal(dropCreatesCycle(["/a"], "/b"), false);
  assert.equal(dropCreatesCycle(["/a"], "/ab"), false); // prefix but not descendant
  assert.equal(dropCreatesCycle([], "/a"), false);
  // trailing slash normalisation
  assert.equal(dropCreatesCycle(["/a"], "/a/"), true);
});

await test("dedupeName: collision-free names for flat OS drops", { "FM-14": "full" }, () => {
  const taken = new Set(["file.txt"]);
  assert.equal(dedupeName("file.txt", taken), "file 2.txt");
  assert.equal(dedupeName("file.txt", taken), "file 3.txt");
  assert.equal(dedupeName("other.txt", taken), "other.txt");
  assert.equal(taken.has("other.txt"), true);
  // no extension
  const t2 = new Set<string>();
  assert.equal(dedupeName("README", t2), "README");
  assert.equal(dedupeName("README", t2), "README 2");
  // dotfiles
  const t3 = new Set([".env"]);
  assert.equal(dedupeName(".env", t3), ".env 2");
});

await finish();
