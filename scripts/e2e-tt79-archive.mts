/**
 * TT79 real-browser suite for the Archive app (FF-71) — Playwright + headless Chromium against the production server.
 * Every saved archive is judged by independent readers (pyzipper for AES, Info-ZIP unzip for ZipCrypto / plain).
 *  1. open a pyzipper AES-256 archive from Files: folders derived from paths, double-click navigates, a text entry
 *     previews "locked"; MODAL SHORTCUT: while the password dialog is open, Delete / F2 / Ctrl+A in the page delete,
 *     rename and select nothing; a wrong password is asked again; the right one shows the exact text; a PNG previews
 *  2. keyboard edits: Delete (confirm) removes an entry, F2 renames, New folder; Save → pyzipper decrypts the renamed
 *     entry with the original password (raw copy, no re-encryption) and the deleted one is gone; Undo restores
 *  3. Extract all → Files: bytes equal pyzipper's; a zip-slip archive shows "unsafe" badges and extraction writes only
 *     the safe entries
 *  4. New archive from device files → Encrypted copy (AES-256) → pyzipper decrypts; ZipCrypto copy → unzip -P -t
 *  5. Files integration: double-clicking a .zip opens Archive; the server extract asks for a password (401
 *     needPassword) and then extracts; "Compress with password" via the API → pyzipper decrypts
 *  6. Test: every entry verified; a corrupted archive reports the damaged entry
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `t79a${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt79-archive");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "e2e79a-"));
const UI = { "FF-71": "full", "FM-05": "full" } as const;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const upload = async (path: string, bytes: Uint8Array) => { const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime: "application/zip" }); ok(r.status < 300, `upload ${path} ${r.status} ${JSON.stringify(r.json)}`); };
const read = async (path: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json?.node, "missing " + path); return Buffer.from(r.json.node.content, r.json.node.encoding === "base64" ? "base64" : "utf8"); };
const exists = async (path: string) => (await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(path)}`)).json?.node != null;
const py = (code: string, ...args: string[]) => execFileSync(PY, ["-c", code, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
const PYLIST = `import sys,json,hashlib,pyzipper
z=pyzipper.AESZipFile(sys.argv[1]); pw=sys.argv[2]
if pw: z.setpassword(pw.encode())
print(json.dumps({i.filename: (None if i.is_dir() else hashlib.sha256(z.read(i.filename)).hexdigest()) for i in z.infolist()}))`;
const pyList = (bytes: Buffer, pw = "") => { const f = join(tmp, `l${Math.random().toString(36).slice(2)}.zip`); writeFileSync(f, bytes); return JSON.parse(py(PYLIST, f, pw)) as Record<string, string | null>; };
const sha = (s: string | Buffer) => py("import sys,hashlib;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())", (() => { const f = join(tmp, "s" + Math.random().toString(36).slice(2)); writeFileSync(f, s); return f; })()).trim();

/* fixture: AES-256 archive with folders (no explicit folder entries), text, PNG, bzip2 entry */
const FIX = join(tmp, "aes.zip");
py(`import sys,pyzipper,zlib,struct
def png(w,h):
    raw=b"".join(b"\\x00"+b"".join(bytes([(x*40)%256,(y*60)%256,128]) for x in range(w)) for y in range(h))
    def ch(t,d): return struct.pack(">I",len(d))+t+d+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    return b"\\x89PNG\\r\\n\\x1a\\n"+ch(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b"")
with pyzipper.AESZipFile(sys.argv[1],"w",compression=pyzipper.ZIP_DEFLATED,encryption=pyzipper.WZ_AES) as z:
    z.setpassword(b"open sesame"); z.setencryption(pyzipper.WZ_AES,nbits=256)
    z.writestr("docs/readme.txt", "Hello from inside an AES-256 archive.\\nSecond line ✓\\n")
    z.writestr("docs/notes/plan.md", "# Plan\\n- ship TT79\\n")
    z.writestr("img/pixel.png", png(6,4))
    z.writestr("data/big.csv", "\\n".join(f"{i},{i*i}" for i in range(4000)), compress_type=pyzipper.ZIP_BZIP2)
    z.writestr("top.txt", "top level file")
`, FIX);

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openArchive(path: string): Promise<{ page: Page; dlg: Locator }> {
  await putDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=archive&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator(`[role=dialog][aria-label="Archive"]`).last(); await dlg.waitFor({ state: "visible", timeout: 25_000 });
  return { page, dlg };
}
const ask = (page: Page) => page.getByTestId("ask-dialog");
const rowNames = async (dlg: Locator) => dlg.getByTestId("archive-row").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));
const row = (dlg: Locator, name: string) => dlg.locator(`[data-testid="archive-row"][data-name="${name}"]`);
const btn = (dlg: Locator, name: string) => dlg.getByRole("button", { name, exact: true });

const SRC = `/Documents/${RUN}-aes.zip`;
await test("1 AES archive: derived folders, navigation, locked preview; MODAL SHORTCUT (Delete/F2/Ctrl+A inert behind the password dialog); wrong → asked again; right → exact text; PNG preview", UI, async () => {
  await upload(SRC, await import("node:fs").then((f) => f.readFileSync(FIX)));
  const { page, dlg } = await openArchive(SRC);
  await poll(async () => (await rowNames(dlg)).length === 4, "root rows");
  eq(await rowNames(dlg), ["data", "docs", "img", "top.txt"], "root: folders first, then files");
  ok((await dlg.getByTestId("archive-encrypted").innerText()).includes("AES-256"), "AES badge");
  await row(dlg, "docs").dblclick();
  await poll(async () => JSON.stringify(await rowNames(dlg)) === JSON.stringify(["notes", "readme.txt"]), "inside docs");
  await row(dlg, "readme.txt").click();
  await poll(async () => (await dlg.getByTestId("archive-preview-note").innerText()).includes("AES-256 encrypted"), "locked preview");
  await dlg.getByTestId("archive-preview").getByRole("button", { name: "Enter password" }).click();
  await ask(page).waitFor();
  // modal shortcut test: keys pressed while the dialog is up must not reach the archive list
  const before = await rowNames(dlg);
  await page.keyboard.press("Delete"); await page.keyboard.press("F2"); await page.keyboard.press("Control+a");
  await page.waitForTimeout(400);
  ok(await ask(page).count() === 1, "still exactly one dialog (no delete-confirm or rename stacked)");
  eq(await rowNames(dlg), before, "rows unchanged behind the modal");
  await page.getByTestId("ask-input-value").fill("wrong one"); await page.getByTestId("ask-ok").click();
  await poll(async () => (await ask(page).innerText()).includes("did not work"), "asked again after a wrong password");
  await page.getByTestId("ask-input-value").fill("open sesame"); await page.getByTestId("ask-ok").click();
  await poll(async () => (await dlg.getByTestId("archive-preview-text").innerText()) === "Hello from inside an AES-256 archive.\nSecond line ✓\n", "decrypted text");
  ok((await dlg.getByTestId("archive-encrypted").innerText()).includes("unlocked"), "unlocked badge");
  await dlg.getByTestId("archive-crumb-root").click(); await row(dlg, "img").dblclick(); await row(dlg, "pixel.png").click();
  await poll(async () => (await dlg.getByTestId("archive-preview-image").evaluate((i) => (i as HTMLImageElement).naturalWidth)) === 6, "PNG decoded (6 px wide)");
  await dlg.screenshot({ path: "docs/screens/tt79-archive.png" });
  await page.context().close();
});

await test("2 keyboard edits: Delete + F2 + New folder → Save → pyzipper decrypts the renamed entry with the ORIGINAL password; Undo restores", UI, async () => {
  const { page, dlg } = await openArchive(SRC);
  await poll(async () => (await rowNames(dlg)).length === 4, "rows");
  await row(dlg, "top.txt").click(); await page.keyboard.press("Delete");
  await ask(page).waitFor(); await page.getByTestId("ask-ok").click();
  await poll(async () => !(await rowNames(dlg)).includes("top.txt"), "top.txt deleted");
  await btn(dlg, "Undo").click(); await poll(async () => (await rowNames(dlg)).includes("top.txt"), "undo restores");
  await row(dlg, "top.txt").click(); await page.keyboard.press("Delete"); await ask(page).waitFor(); await page.getByTestId("ask-ok").click();
  await poll(async () => !(await rowNames(dlg)).includes("top.txt"), "deleted again");
  await row(dlg, "docs").click(); await page.keyboard.press("F2"); await ask(page).waitFor();
  await page.getByTestId("ask-input-value").fill("Documents ü"); await page.getByTestId("ask-ok").click();
  await poll(async () => (await rowNames(dlg)).includes("Documents ü"), "folder renamed");
  await btn(dlg, "New folder").click(); await ask(page).waitFor(); await page.getByTestId("ask-input-value").fill("empty"); await page.getByTestId("ask-ok").click();
  await poll(async () => (await rowNames(dlg)).includes("empty"), "new folder");
  await dlg.getByTestId("archive-save").click();
  await poll(async () => (await dlg.getByTestId("archive-status").innerText()).startsWith("Saved"), "saved");
  const l = pyList(await read(SRC), "open sesame");
  const orig = pyList(await import("node:fs").then((f) => f.readFileSync(FIX)), "open sesame");
  ok(!("top.txt" in l), "deleted entry gone");
  eq(l["Documents ü/readme.txt"], orig["docs/readme.txt"], "renamed entry decrypts to the same bytes");
  eq(l["Documents ü/notes/plan.md"], orig["docs/notes/plan.md"], "subtree renamed");
  ok("empty/" in l, "folder entry written: " + Object.keys(l).join(","));
  await page.context().close();
});

await test("3 Extract all → Files equals pyzipper; zip-slip archive: 'unsafe' badges, only safe entries written", UI, async () => {
  const { page, dlg } = await openArchive(SRC);
  await poll(async () => (await rowNames(dlg)).length >= 3, "rows");
  const dest = `/Documents/${RUN}-out`;
  await btn(dlg, "Extract all…").click(); await ask(page).waitFor(); await page.getByTestId("ask-input-value").fill(dest); await page.getByTestId("ask-ok").click();
  await ask(page).waitFor(); await page.getByTestId("ask-input-value").fill("open sesame"); await page.getByTestId("ask-ok").click();
  await poll(async () => (await dlg.getByTestId("archive-status").innerText()).startsWith("Extracted 4 file(s)"), "extracted 4");
  const l = pyList(await read(SRC), "open sesame");
  for (const n of ["Documents ü/readme.txt", "Documents ü/notes/plan.md", "img/pixel.png", "data/big.csv"]) eq(sha(await read(`${dest}/${n}`)), l[n], "extracted " + n);
  await page.context().close();
  // zip-slip
  const slip = join(tmp, "slip.zip");
  py(`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],"w") as z:
    z.writestr("../escape.txt","x"); z.writestr("safe/ok.txt","fine"); z.writestr("a/../../escape2.txt","y")`, slip);
  const SL = `/Documents/${RUN}-slip.zip`; await upload(SL, await import("node:fs").then((f) => f.readFileSync(slip)));
  const o = await openArchive(SL);
  await poll(async () => (await o.dlg.getByText("unsafe", { exact: true }).count()) >= 1, "unsafe badge");
  ok((await o.dlg.getByTestId("archive-issues").innerText()).includes("zip-slip"), "issue banner");
  const d2 = `/Documents/${RUN}-slipout`;
  await btn(o.dlg, "Extract all…").click(); await ask(o.page).waitFor(); await o.page.getByTestId("ask-input-value").fill(d2); await o.page.getByTestId("ask-ok").click();
  await poll(async () => /Extracted 1 file\(s\).*2 blocked/.test(await o.dlg.getByTestId("archive-status").innerText()), "1 written, 2 blocked");
  ok(await exists(`${d2}/safe/ok.txt`) && !(await exists(`/Documents/escape.txt`)) && !(await exists(`/Documents/${RUN}-escape.txt`)), "only the safe entry");
  await o.page.context().close();
});

await test("4 New archive from device files → Encrypted copy AES-256 (pyzipper) and ZipCrypto (unzip -P -t)", UI, async () => {
  const { page, dlg } = await openArchive(`/Documents/${RUN}-none.zip`);
  await btn(dlg, "New").click();
  await poll(async () => (await dlg.getByTestId("archive-crumb-root").innerText()).includes("New archive.zip"), "new archive");
  await dlg.getByTestId("archive-add-input").setInputFiles([
    { name: "alpha.txt", mimeType: "text/plain", buffer: Buffer.from("alpha ".repeat(500)) },
    { name: "beta.bin", mimeType: "application/octet-stream", buffer: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256)) },
  ]);
  await poll(async () => JSON.stringify(await rowNames(dlg)) === JSON.stringify(["alpha.txt", "beta.bin"]), "added");
  const out = `/Documents/${RUN}-new (encrypted).zip`;
  await btn(dlg, "Encrypted copy…").click(); await ask(page).waitFor();
  await page.getByTestId("ask-input-pw").fill("n3w-pass"); await page.getByTestId("ask-input-pw2").fill("n3w-pass"); await page.getByTestId("ask-input-path").fill(out);
  await page.getByTestId("ask-ok").click();
  await poll(async () => (await dlg.getByTestId("archive-status").innerText()).startsWith("Saved encrypted copy"), "encrypted copy");
  const l = pyList(await read(out), "n3w-pass");
  eq(l["alpha.txt"], sha(Buffer.from("alpha ".repeat(500))), "pyzipper decrypts alpha");
  let refused = false; try { pyList(await read(out), "nope"); } catch { refused = true; } ok(refused, "wrong password refused by pyzipper");
  const out2 = `/Documents/${RUN}-legacy.zip`;
  await btn(dlg, "Encrypted copy…").click(); await ask(page).waitFor();
  await page.getByTestId("ask-input-pw").fill("old"); await page.getByTestId("ask-input-pw2").fill("old"); await page.getByTestId("ask-input-method").fill("zipcrypto"); await page.getByTestId("ask-input-path").fill(out2);
  await page.getByTestId("ask-ok").click();
  await poll(async () => (await dlg.getByTestId("archive-status").innerText()).includes("ZipCrypto"), "zipcrypto copy");
  const f = join(tmp, "legacy.zip"); writeFileSync(f, await read(out2));
  const t = spawnSync("unzip", ["-P", "old", "-t", f], { encoding: "utf8" }); ok(/No errors detected/.test(t.stdout), t.stdout + t.stderr);
  await page.context().close();
});

await test("5 Files integration: .zip opens Archive; server extract → 401 needPassword then extracts; compress with password → pyzipper", { "FF-71": "full", "FM-05": "full", "FF-70": "full" }, async () => {
  const { appForFile } = await import("../src/lib/open-with.ts");
  eq(appForFile("x.ZIP", "application/zip"), "archive", "routing");
  const a = await api("POST", "/api/fs", { op: "extract", path: SRC, dst: `/Documents/${RUN}-srv` });
  ok(a.status === 401 && a.json?.needPassword, `needPassword: ${a.status} ${JSON.stringify(a.json)}`);
  const b = await api("POST", "/api/fs", { op: "extract", path: SRC, dst: `/Documents/${RUN}-srv`, password: "open sesame" });
  ok(b.status === 200 && b.json.written === 4, JSON.stringify(b.json));
  eq((await read(`/Documents/${RUN}-srv/img/pixel.png`)).subarray(1, 4).toString(), "PNG", "server-extracted PNG");
  const c = await api("POST", "/api/fs", { op: "compress", paths: [`/Documents/${RUN}-srv`], dst: `/Documents/${RUN}-srv-enc.zip`, password: "pw!", encryption: "aes256" });
  ok(c.status === 200, JSON.stringify(c.json));
  const l = pyList(await read(`/Documents/${RUN}-srv-enc.zip`), "pw!");
  ok(Object.keys(l).length === 4 && l["data/big.csv"], "pyzipper reads the server's AES archive: " + Object.keys(l).join(","));
  // UI route: Files double-click → Archive window
  await putDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage();
  await page.goto(`${BASE}/?open=files&path=${encodeURIComponent("/Documents")}`, { waitUntil: "domcontentloaded" });
  const files = page.locator(`[role=dialog][aria-label="Files"]`).last(); await files.waitFor({ state: "visible", timeout: 25_000 });
  const item = files.getByText(`${RUN}-srv-enc.zip`, { exact: true }).first(); await item.waitFor({ timeout: 20_000 }); await item.dblclick();
  const aw = page.locator(`[role=dialog][aria-label="${RUN}-srv-enc.zip"]`).last(); await aw.waitFor({ state: "visible", timeout: 20_000 });
  await poll(async () => (await aw.getByTestId("archive-row").count()) === 3, "the Files double-click opened the Archive app on that zip");
  await ctx.close();
});

await test("6 Test: every entry verified; a corrupted archive names the damaged entry", { "FF-71": "full", "FF-72": "full" }, async () => {
  const { page, dlg } = await openArchive(SRC);
  await poll(async () => (await rowNames(dlg)).length >= 3, "rows");
  await btn(dlg, "Test").click(); await ask(page).waitFor(); await page.getByTestId("ask-input-value").fill("open sesame"); await page.getByTestId("ask-ok").click();
  await poll(async () => /Test: all 4 file\(s\) OK/.test(await dlg.getByTestId("archive-status").innerText()), "all OK");
  await page.context().close();
  const plain = join(tmp, "plain.zip"); py(`import zipfile,sys
with zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr("good.txt","good"); z.writestr("bad.txt","B"*500)`, plain);
  const buf = await import("node:fs").then((f) => f.readFileSync(plain)); const i = buf.indexOf(Buffer.from("B".repeat(20))); buf[i + 5] ^= 1;
  const P = `/Documents/${RUN}-bad.zip`; await upload(P, buf);
  const o = await openArchive(P); await poll(async () => (await rowNames(o.dlg)).length === 2, "rows");
  await btn(o.dlg, "Test").click();
  await poll(async () => /Test: 1 OK, 1 damaged — bad\.txt: .*CRC-32 mismatch/.test(await o.dlg.getByTestId("archive-status").innerText()), "damaged named");
  await o.page.context().close();
});

await test("no page errors", { "FF-71": "partial" }, () => { ok(!errors.length, errors.join("\n")); });
await browser.close();
finish();
