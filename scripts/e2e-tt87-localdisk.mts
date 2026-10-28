/** Real Chromium Origin Private File System handles + actual Fusion HTTP/PostgreSQL; no mocked file handles. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("e2e-tt87-localdisk");
const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `tt87-${Date.now().toString(36)}`;
const TARGET = `/Sync/${RUN}`;
const IMPORT = `${RUN}-import.bin`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json(); return { status: r.status, json };
};
const must = async (method: string, path: string, body?: unknown) => {
  const r = await api(method, path, body); assert.ok(r.status < 300 && r.json.ok !== false, `${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`); return r.json;
};
const fs = (op: string, path: string, extra: object = {}) => must("POST", "/api/fs", { op, path, ...extra });
const read = async (path: string) => (await must("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node;
const desktop = await must("GET", "/api/state?id=default");
const rev = Number(desktop.row?.revision ?? 1) + 1000;
await must("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); context.setDefaultTimeout(20_000);
const page = await context.newPage(); const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const dlg = () => page.getByRole("dialog", { name: "Local disk", exact: true }).last();
const report = () => dlg().getByTestId("localdisk-report");
const writeLocal = (name: string, data: string) => page.evaluate(async ({ dir, name, data }) => {
  const root = await navigator.storage.getDirectory(); const h = await root.getDirectoryHandle(dir);
  const w = await (await h.getFileHandle(name, { create: true })).createWritable(); await w.write(data); await w.close();
}, { dir: RUN, name, data });
const readLocal = (name: string) => page.evaluate(async ({ dir, name }) => {
  const root = await navigator.storage.getDirectory(); const h = await root.getDirectoryHandle(dir);
  const bytes = new Uint8Array(await (await (await h.getFileHandle(name)).getFile()).arrayBuffer());
  return { size: bytes.length, text: new TextDecoder().decode(bytes), first: [...bytes.slice(0, 8)], last: [...bytes.slice(-8)] };
}, { dir: RUN, name });
const sync = async () => { await dlg().getByRole("button", { name: `Sync ⇄ ${TARGET}` }).click(); await report().getByText(/pushed .*pulled .*conflicts/).waitFor(); };
const conflictButton = (name: string) => dlg().locator("section").filter({ hasText: "Conflict inbox" }).locator("div.fs-row").filter({ hasText: "conflict.txt" }).first().getByRole("button", { name });

try {
  await test("BK-02 real browser folder handle survives IndexedDB reload and a first sync preserves skipped names and binary data", { "BK-02": "partial", "FM-08": "partial" }, async () => {
    await fs("mkdir", TARGET);
    await fs("write", `${TARGET}/large.txt`, { content: "Fusion must not replace large local file" });
    await fs("write", `${TARGET}/folder.txt`, { content: "Fusion must not replace local directory" });
    await fs("write", `${TARGET}/invalid.txt`, { content: "Fusion must not replace invalid UTF-8" });
    await fs("write", `${TARGET}/binary.txt`, { encoding: "base64", content: Buffer.from([0, 1, 255]).toString("base64"), mime: "application/octet-stream" });
    await fs("write", `${TARGET}/conflict.txt`, { content: "Fusion first" });
    await fs("write", `${TARGET}/same.txt`, { content: "identical" });
    await fs("write", `${TARGET}/pull.md`, { content: "from Fusion" });
    await fs("write", `${TARGET}/not-text.bin`, { content: "unsupported extension" });
    await fs("write", `/Documents/${IMPORT}`, { content: "existing document" });
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate(async ({ dir, importName }) => {
      const root = await navigator.storage.getDirectory(); const h = await root.getDirectoryHandle(dir, { create: true });
      async function write(name: string, data: string | Uint8Array) {
        const w = await (await h.getFileHandle(name, { create: true })).createWritable(); await w.write(data as FileSystemWriteChunkType); await w.close();
      }
      await write("large.txt", "L".repeat(1024 * 1024 + 1));
      await h.getDirectoryHandle("folder.txt", { create: true });
      await write("invalid.txt", new Uint8Array([255, 254, 0, 7]));
      await write("binary.txt", "local UTF-8");
      await write("conflict.txt", "local first");
      await write("same.txt", "identical");
      await write("new.md", "\uFEFFnew local café");
      await write(importName, new Uint8Array([0, 1, 255, 100]));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open("fusion-handles", 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("h")) r.result.createObjectStore("h"); };
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
      });
      await new Promise<void>((resolve, reject) => { const t = db.transaction("h", "readwrite"); t.objectStore("h").put(h, "mount"); t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); }); db.close();
    }, { dir: RUN, importName: IMPORT });
    await page.goto(`${BASE}/?open=localdisk`, { waitUntil: "domcontentloaded" });
    await dlg().waitFor({ timeout: 30_000 }); await dlg().getByText(`${RUN} · permission granted`).waitFor();
    await sync();
    assert.equal((await readLocal("large.txt")).size, 1024 * 1024 + 1);
    assert.equal((await readLocal("invalid.txt")).first.join(","), "255,254,0,7");
    assert.equal((await readLocal("binary.txt")).text, "local UTF-8");
    assert.equal((await readLocal("pull.md")).text, "from Fusion");
    assert.equal((await read(`${TARGET}/large.txt`)).content, "Fusion must not replace large local file");
    assert.equal((await read(`${TARGET}/new.md`)).content, "\uFEFFnew local café");
    assert.equal((await read(`${TARGET}/binary.txt`)).encoding, "base64");
    await dlg().getByText("Local subfolders are not synced", { exact: false }).first().waitFor();
    await dlg().getByText("Local file exceeds 1 MiB", { exact: false }).waitFor();
    await dlg().getByText("Local file is not valid UTF-8", { exact: false }).waitFor();
    await dlg().getByText("conflict.txt", { exact: false }).first().waitFor();
  });

  await test("BK-02 conflict choices reject stale local and server copies; explicit resolution preserves a Fusion version", { "BK-02": "partial" }, async () => {
    await writeLocal("conflict.txt", "local newer");
    await conflictButton("Keep local").click();
    await report().getByText(/changed since this conflict was listed/i).waitFor();
    assert.equal((await read(`${TARGET}/conflict.txt`)).content, "Fusion first");
    await sync(); await conflictButton("Keep local").click();
    await report().getByText(/Kept local copy/).waitFor();
    assert.equal((await read(`${TARGET}/conflict.txt`)).content, "local newer");
    const versions = (await must("GET", `/api/fs?op=versions&path=${encodeURIComponent(`${TARGET}/conflict.txt`)}`)).versions;
    assert.ok(versions.some((v: any) => v.content === "Fusion first" && v.reason === "conflict-keep-local"));
    await fs("write", `${TARGET}/conflict.txt`, { content: "Fusion second" });
    await sync();
    await fs("write", `${TARGET}/conflict.txt`, { content: "Fusion changed after scan" });
    page.once("dialog", (d) => void d.accept());
    await conflictButton("Keep Fusion copy").click();
    await report().getByText(/changed since this conflict was listed/i).waitFor();
    assert.equal((await readLocal("conflict.txt")).text, "local newer");
    await sync(); page.once("dialog", (d) => void d.accept());
    await conflictButton("Keep Fusion copy").click();
    await report().getByText(/Kept Fusion copy/).waitFor();
    assert.equal((await readLocal("conflict.txt")).text, "Fusion changed after scan");
  });

  await test("FM-08 import selects a conflict-free name and keeps the original Fusion file byte-for-byte", { "FM-08": "partial" }, async () => {
    await dlg().getByRole("button", { name: `Import ${IMPORT}` }).click();
    const copy = `/Documents/${RUN}-import 2.bin`;
    await page.getByText(`Imported as ${copy} (no existing document overwritten)`).waitFor();
    assert.equal((await read(`/Documents/${IMPORT}`)).content, "existing document");
    assert.deepEqual(Buffer.from((await read(copy)).content, "base64"), Buffer.from([0, 1, 255, 100]));
  });

  await test("FM-08 conditional write rejects missing preconditions, existing names and changed versions without modifying data", { "FM-08": "partial", "BK-02": "partial" }, async () => {
    const path = `${TARGET}/same.txt`; const node = await read(path);
    assert.equal((await api("POST", "/api/fs", { op: "writeIfUnchanged", path, content: "unsafe" })).status, 400);
    assert.equal((await api("POST", "/api/fs", { op: "writeIfUnchanged", path, content: "unsafe", expected: null })).status, 409);
    await fs("write", path, { content: "concurrent update" });
    const stale = await api("POST", "/api/fs", { op: "writeIfUnchanged", path, content: "unsafe", expected: { id: node.id, version: node.version, sha256: node.sha256 } });
    assert.equal(stale.status, 409); assert.equal((await read(path)).content, "concurrent update");
    // A same-byte write still advances the version; digest comparison alone must not pass an ABA-like stale preview.
    const sameBytes = await read(path);
    await fs("write", path, { content: "concurrent update" });
    const staleVersion = await api("POST", "/api/fs", { op: "writeIfUnchanged", path, content: "unsafe", expected: { id: sameBytes.id, version: sameBytes.version, sha256: sameBytes.sha256 } });
    assert.equal(staleVersion.status, 409); assert.equal((await read(path)).content, "concurrent update");
    assert.equal((await api("POST", "/api/fs", { op: "writeIfUnchanged", path: `${TARGET}/bad.bin`, content: "%%%", encoding: "base64", expected: null })).status, 400);
  });
  await test("TT87 local disk browser session has no uncaught page errors", { "BK-02": "partial" }, () => assert.deepEqual(errors, []));
} finally {
  await page.evaluate(async (dir) => { const root = await navigator.storage.getDirectory(); await root.removeEntry(dir, { recursive: true }).catch(() => undefined); }, RUN).catch(() => undefined);
  await context.close(); await browser.close();
  await fs("purge", TARGET).catch(() => undefined);
  await fs("purge", `/Documents/${IMPORT}`).catch(() => undefined);
  await fs("purge", `/Documents/${RUN}-import 2.bin`).catch(() => undefined);
  const current = await must("GET", "/api/state?id=default");
  if (desktop.row?.state) await must("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: desktop.row.state }).catch(() => undefined);
}
finish();
