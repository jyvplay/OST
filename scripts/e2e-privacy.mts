/**
 * Real-browser suite "e2e-privacy" (TT18): the Tails-like privacy layer driven through the actual shell in
 * Chromium against the production server and Postgres. Every privacy claim is checked on the HOST side
 * (SQL over vfs_nodes / index_docs / audit_log), not by asking the browser what it thinks it did.
 *
 * Safety: refuses to run if keyslots, any existing /Private child or any /Private version exists; its
 * destructive recovery tests are still suitable only for an explicitly disposable server/database.
 * Run: BASE=http://localhost:3999 DATABASE_URL=… node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-privacy.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing destructive privacy tests without TT89_DISPOSABLE_DATABASE=1 and an explicit exclusive matching disposable server/database.");
const BASE = process.env.BASE ?? "http://localhost:3999";
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const RUN = Date.now().toString(36);
const PASS = "correct horse battery staple orbit";
const SECRET = `SSN-${RUN}-123-45-6789`;
const { test, finish } = makeHarness("e2e-privacy");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const rows = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const hostApi = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) };
};

const pre = await hostApi("GET", "/api/fs?op=read&path=/Private/.keyslots.json");
const hostPrivate = await hostApi("GET", "/api/fs?op=list&path=/Private");
const existingPrivate = await rows(`SELECT
  EXISTS (SELECT 1 FROM vfs_nodes WHERE path LIKE '/Private/%') AS nodes,
  EXISTS (SELECT 1 FROM vfs_versions WHERE path = '/Private' OR path LIKE '/Private/%') AS versions`);
// A missing keyslot does NOT mean the host directory is empty: plaintext or orphaned
// ciphertext can still be there. The later destructive restore tests must never erase it.
if (pre.status !== 404 || hostPrivate.status !== 200 || !Array.isArray(hostPrivate.json.nodes) || hostPrivate.json.nodes.length > 0 || existingPrivate[0]?.nodes || existingPrivate[0]?.versions) {
  console.error("Existing /Private data or versions found — refusing destructive privacy tests.");
  process.exit(2);
}
// The host fixtures are also removed at teardown. Never assume their randomly
// generated paths are ours until both the API and the database report them absent.
for (const root of [`/Documents/meta-${RUN}`, `/Documents/bench-${RUN}`]) {
  const stat = await hostApi("GET", `/api/fs?op=stat&path=${encodeURIComponent(root)}`);
  if (stat.status !== 200 || stat.json.node) throw new Error(`Refusing occupied privacy fixture ${root}`);
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) {
    const existing = await rows(`select 1 from ${table} where ${col}=$1 or left(${col},char_length($1)+1)=$1||'/' limit 1`, [root]);
    if (existing.length) throw new Error(`Refusing occupied privacy fixture ${root} in ${table}`);
  }
}

const fx = mkdtempSync(join(tmpdir(), "e2e-priv-")); mkdirSync(join(fx, "out"));
execFileSync(PY, ["scripts/oracles/metaclean_oracle.py", "make", join(fx, "src")], { encoding: "utf8" });
const jpegB64 = readFileSync(join(fx, "src", "photo.jpg")).toString("base64");

async function putDesktop(windows: unknown[]) {
  const cur = await hostApi("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await hostApi("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows[0] as { id?: string })?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const win = (id: string, module: string, props: Record<string, unknown> = {}, x = 40) => ({ id, module, title: module[0].toUpperCase() + module.slice(1), x, y: 40, w: 760, h: 700, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
const browser: Browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
let page: Page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => void d.accept());
const inPage = <T,>(f: (a: string) => Promise<T>, arg = "") => page.evaluate(f, arg);
const pfetch = (method: string, path: string, body?: unknown) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p as string, { method: m as string, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
}, [method, path, body] as const);
const privacyRoot = () => page.locator('[data-testid="privacy"]').first();
async function boot(url = "/") {
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  if (url.includes("amnesia=1")) {
    // an amnesic session starts with a FRESH desktop (Tails-like: nothing restored) — open Privacy from the badge
    await page.locator('[data-testid="amnesic-badge"]').click({ timeout: 30_000 });
  }
  await privacyRoot().waitFor({ timeout: 30_000 });
}
const tab = (name: string) => privacyRoot().getByRole("tab", { name, exact: true }).first();

let created = false;
await putDesktop([win("wp", "privacy")]);

await test("create Persistent Storage in the UI: Argon2id keyslots + recovery key; nothing secret reaches the host; top bar shows the unlocked state", { "SC-10": "full", "SC-11": "full" }, async () => {
  await boot();
  await privacyRoot().locator('[data-testid="pp1"]').waitFor({ timeout: 20_000 });
  await privacyRoot().locator('[data-testid="pp1"]').fill(PASS);
  await privacyRoot().locator('[data-testid="pp2"]').fill(PASS);
  await privacyRoot().locator('[data-testid="create"]').click();
  const rk = await privacyRoot().locator('[data-testid="recovery-key"]').innerText({ timeout: 30_000 });
  created = true;
  ok(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7,}$/.test(rk.trim()), `recovery key format: ${rk}`);
  (globalThis as { __rk?: string }).__rk = rk.trim();
  const [h] = await rows("select content from vfs_nodes where path = '/Private/.keyslots.json'");
  const header = JSON.parse(h.content);
  ok(header.slots.length === 2 && header.slots.every((s: { kdf: { kdf: string; m: number } }) => s.kdf.kdf === "argon2id" && s.kdf.m === 65536), `slots ${h.content.slice(0, 300)}`);
  const leak = await rows("select count(*)::int n from vfs_nodes where content like $1 or content like $2", [`%${PASS}%`, `%${rk.trim().slice(0, 9)}%`]);
  ok(leak[0].n === 0, "passphrase or recovery key stored on host");
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 5_000 });
});

await test("files written by the shell into /Private reach the host as ciphertext only: no name, no content, no index entry, no audit path", { "SC-10": "full" }, async () => {
  const w = await pfetch("POST", "/api/fs", { op: "write", path: `/Private/Taxes ${RUN}/return.txt`, content: `my ${SECRET}` });
  ok(w.status === 200, JSON.stringify(w.json));
  const back = await pfetch("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Private/Taxes ${RUN}/return.txt`)}`);
  ok(back.json.node?.content === `my ${SECRET}`, `read back ${JSON.stringify(back.json).slice(0, 200)}`);
  const hits = await rows("select path from vfs_nodes where path like $1 or content like $2 or name like $1", [`%Taxes ${RUN}%`, `%${SECRET}%`]);
  ok(hits.length === 0, `host rows in clear: ${JSON.stringify(hits)}`);
  const idx = await rows("select count(*)::int n from index_docs where body like $1 or ref like '/Private/%'", [`%${SECRET}%`]);
  ok(idx[0].n === 0, "search index holds /Private content");
  const aud = await rows("select count(*)::int n from audit_log where detail like $1", [`%Taxes ${RUN}%`]);
  ok(aud[0].n === 0, "audit log holds the clear path");
  const s = await hostApi("GET", `/api/search?q=${encodeURIComponent(SECRET)}`);
  ok(!JSON.stringify(s.json).includes(SECRET), "server search finds the secret");
});

await test("TT87 conditional writes work for ordinary host files while unlocked, but never write plaintext inside Persistent Storage", { "SC-10": "full", "BK-02": "partial" }, async () => {
  const normal = `/Documents/conditional-${RUN}.txt`; const privatePath = `/Private/conditional-${RUN}.txt`;
  const body = (path: string) => ({ op: "writeIfUnchanged", path, content: `conditional ${RUN}`, expected: null });
  try {
    ok((await pfetch("POST", "/api/fs", body(normal))).status === 200, "normal host create refused while unlocked");
    ok((await pfetch("POST", "/api/fs", body(normal))).status === 409, "conditional create overwrote existing host file");
    ok((await pfetch("POST", "/api/fs", body(privatePath))).status === 422, "plaintext private conditional write not refused");
    ok((await rows("select count(*)::int n from vfs_nodes where path=$1", [privatePath]))[0].n === 0, "private plaintext reached host");
  } finally { await hostApi("POST", "/api/fs", { op: "purge", path: normal }); await hostApi("POST", "/api/fs", { op: "purge", path: privatePath }); }
});

await test("lock from the top bar → 423; unlock with the RECOVERY key in the UI → readable; a reload forgets the key (memory only)", { "SC-11": "full" }, async () => {
  await page.locator('[data-testid="storage-badge"]').click();
  const locked = await pfetch("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Private/Taxes ${RUN}/return.txt`)}`);
  ok(locked.status === 423, `locked read ${locked.status}`);
  await privacyRoot().locator('[data-testid="unlock-pass"]').fill((globalThis as { __rk?: string }).__rk!.toLowerCase().replace(/-/g, " "));
  await privacyRoot().locator('[data-testid="unlock"]').click();
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 30_000 });
  const r = await pfetch("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Private/Taxes ${RUN}/return.txt`)}`);
  ok(r.json.node?.content === `my ${SECRET}`, "unlocked with recovery key");
  await boot();
  const after = await pfetch("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Private/Taxes ${RUN}/return.txt`)}`);
  ok(after.status === 423, `after reload ${after.status}`);
  await privacyRoot().locator('[data-testid="unlock-pass"]').fill(PASS);
  await privacyRoot().locator('[data-testid="unlock-pass"]').press("Enter");
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 30_000 });
});

await test("TT19 private search in the UI: the palette finds an encrypted /Private file by content; Find '/Private only' searches in the tab and sends NO search request to the host", { "SC-16": "full" }, async () => {
  const sent: string[] = [];
  const onReq = (r: { url: () => string }) => { if (r.url().includes("/api/search")) sent.push(r.url()); };
  page.on("request", onReq);
  try {
    await page.keyboard.press("Control+Space");
    const pal = page.locator('[role=dialog][aria-label="Command palette"]');
    await pal.waitFor({ timeout: 5000 });
    await page.keyboard.type(SECRET);
    await pal.getByText("return.txt").first().waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Space"); await pal.waitFor({ timeout: 5000 });
    await page.keyboard.type("Find");
    await pal.getByText("Index search with provenance").first().click();
    const find = page.locator('[role=dialog][aria-label="Find"]').first();
    await find.waitFor({ timeout: 8000 });
    await find.getByLabel("Search query").fill(SECRET);
    await find.getByRole("button", { name: "/Private only" }).click();
    sent.length = 0;
    await find.getByRole("button", { name: "Search", exact: true }).click();
    await find.getByText("return.txt").first().waitFor({ timeout: 15_000 });
    const info = await find.locator('[data-testid="private-search-info"]').innerText();
    ok(/query never left this tab/.test(info) && /files indexed in this tab/.test(info), `badges: ${info}`);
    ok(await find.getByText(/encrypted · file · private-local/).first().isVisible(), "provenance badge");
    ok(sent.length === 0, `search requests reached the network: ${sent.join(" ")}`);
    const idx = await rows("select count(*)::int n from index_docs where body like $1", [`%${SECRET}%`]);
    ok(idx[0].n === 0, "host index never received the secret");
  } finally {
    page.off("request", onReq);
    const find = page.locator('[role=dialog][aria-label="Find"]').first();
    if (await find.count()) await find.getByRole("button", { name: "Close window" }).click().catch(() => undefined);
  }
});

await test("Remove metadata on an encrypted photo in the UI: cleaned in the browser, copy stays encrypted, Pillow confirms only Orientation remains", { "SC-12": "full" }, async () => {
  const up = await pfetch("POST", "/api/fs", { op: "write", path: `/Private/photo-${RUN}.jpg`, content: jpegB64, encoding: "base64", mime: "image/jpeg" });
  ok(up.status === 200, JSON.stringify(up.json));
  await tab("Remove metadata").click();
  await privacyRoot().locator('[data-testid="clean-path"]').fill(`/Private/photo-${RUN}.jpg`);
  await privacyRoot().locator('[data-testid="clean"]').click();
  const rep = await privacyRoot().locator('[data-testid="clean-report"]').innerText({ timeout: 15_000 });
  ok(/Make: Canon/.test(rep) && /GPS/.test(rep) && /Orientation=6/.test(rep), rep);
  const c = await pfetch("GET", `/api/fs?op=read&path=${encodeURIComponent(`/Private/photo-${RUN}.clean.jpg`)}`);
  ok(c.status === 200 && c.json.node?.encoding === "base64", `clean copy ${c.status}`);
  writeFileSync(join(fx, "out", "photo.jpg"), Buffer.from(c.json.node.content, "base64"));
  const v = JSON.parse(execFileSync(PY, ["scripts/oracles/metaclean_oracle.py", "verify", join(fx, "src"), join(fx, "out")], { encoding: "utf8" }));
  ok(v["photo.jpg"].problems.length === 0, JSON.stringify(v["photo.jpg"]));
  const plain = await rows("select count(*)::int n from vfs_nodes where name like $1 or path like $1", [`%photo-${RUN}%`]);
  ok(plain[0].n === 0, "photo name in clear on host");
});

await test("Files ▸ Remove metadata (copy) on a host .docx; overwrite mode also forgets the version that still held the author", { "SC-12": "full", "FM-01": "partial" }, async () => {
  const docB64 = readFileSync(join(fx, "src", "doc.docx")).toString("base64");
  await hostApi("POST", "/api/fs", { op: "write", path: `/Documents/meta-${RUN}/plan.docx`, content: docB64, encoding: "base64", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  await putDesktop([win("wf", "files", { path: `/Documents/meta-${RUN}` })]);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const item = page.locator(".fs-list-item", { hasText: "plan.docx" }).first();
  await item.waitFor({ timeout: 25_000 });
  await item.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^More actions/ }).click(); // TT55: privacy actions live in the full menu
  await page.getByRole("menu").getByText("Remove metadata (copy)").click();
  let copy: { content: string } | undefined;
  for (let i = 0; i < 50 && !copy; i++) { [copy] = await rows("select content from vfs_nodes where path = $1", [`/Documents/meta-${RUN}/plan.clean.docx`]); if (!copy) await page.waitForTimeout(200); }
  ok(copy, "clean copy not written");
  writeFileSync(join(fx, "out", "doc.docx"), Buffer.from(copy!.content, "base64"));
  const v = JSON.parse(execFileSync(PY, ["scripts/oracles/metaclean_oracle.py", "verify", join(fx, "src"), join(fx, "out")], { encoding: "utf8" }));
  ok(v["doc.docx"].problems.length === 0, JSON.stringify(v["doc.docx"]));
  // overwrite mode (Privacy tab toggle): write the cleaned bytes over the original, then forget its history
  await hostApi("POST", "/api/fs", { op: "write", path: `/Documents/meta-${RUN}/plan.docx`, content: copy!.content, encoding: "base64", reason: "metadata-clean" });
  const before = await rows("select count(*)::int n from vfs_versions where path = $1", [`/Documents/meta-${RUN}/plan.docx`]);
  const dv = await pfetch("POST", "/api/fs", { op: "dropVersions", path: `/Documents/meta-${RUN}/plan.docx` });
  const after = await rows("select count(*)::int n from vfs_versions where path = $1", [`/Documents/meta-${RUN}/plan.docx`]);
  ok(before[0].n >= 1 && dv.json.dropped === before[0].n && after[0].n === 0, `versions ${before[0].n} → dropped ${dv.json.dropped} → ${after[0].n}`);
  const stillAuthor = await rows("select count(*)::int n from vfs_versions where path like $1", [`/Documents/meta-${RUN}/%`]);
  ok(stillAuthor[0].n === 0, "an old version with the author survives");
});

await test("amnesic session: AMNESIC badge, files in RAM only, notes refused + logged, localStorage and IndexedDB leave no trace, /Private still persists", { "SC-13": "full", "SC-10": "partial" }, async () => {
  await putDesktop([win("wp", "privacy")]);
  await boot("/?amnesia=1");
  const st = await pfetch("GET", "/api/state?id=default");
  ok(st.json.amnesic === true && st.json.row === null, `amnesic desktop must start fresh: ${JSON.stringify(st.json).slice(0, 120)}`);
  const w = await pfetch("POST", "/api/fs", { op: "write", path: `/Documents/amnesic-${RUN}.txt`, content: "ephemeral" });
  ok(w.status === 200 && w.json.amnesic === true, JSON.stringify(w.json));
  ok((await rows("select count(*)::int n from vfs_nodes where path like $1", [`%amnesic-${RUN}%`]))[0].n === 0, "RAM file reached the host");
  const note = await pfetch("POST", "/api/notes", { title: `amnesic-${RUN}`, body: "x" });
  ok(note.status === 423, `notes ${note.status}`);
  ok((await rows("select count(*)::int n from notes where title like $1", [`%amnesic-${RUN}%`]).catch(() => [{ n: 0 }]))[0].n === 0, "note persisted");
  await inPage(async (k) => { localStorage.setItem(k, "trace"); }, `amnesic-ls-${RUN}`);
  const idb = await inPage(async () => { try { indexedDB.open("amnesic-test"); return "opened"; } catch (e) { return (e as Error).name; } });
  ok(idb === "SecurityError", `IndexedDB: ${idb}`);
  await tab("Amnesia").click();
  const log = await privacyRoot().locator('[data-testid="blocked-log"]').innerText({ timeout: 5_000 });
  ok(/notes/.test(log), `blocked log: ${log}`);
  // /Private still persists inside amnesia once unlocked
  await tab("Persistent Storage").click();
  await privacyRoot().locator('[data-testid="unlock-pass"]').fill(PASS);
  await privacyRoot().locator('[data-testid="unlock"]').click();
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 30_000 });
  const pw = await pfetch("POST", "/api/fs", { op: "write", path: `/Private/kept-${RUN}.txt`, content: "persistent" });
  ok(pw.status === 200 && !pw.json.amnesic, JSON.stringify(pw.json));
  ok((await rows("select count(*)::int n from vfs_nodes where path like '/Private/~%' and mime = 'application/x-fusion-encrypted'"))[0].n >= 3, "persistent write missing");
  await boot("/");
  ok((await inPage(async (k) => localStorage.getItem(k), `amnesic-ls-${RUN}`)) === null, "localStorage trace survived");
  const gone = await pfetch("GET", `/api/fs?op=read&path=/Documents/amnesic-${RUN}.txt`);
  ok(gone.status === 404, `RAM file after restart ${gone.status}`);
});

await test("emergency shutdown chord: keys + RAM files gone, page blanked via location.replace (no history entry with the shell)", { "SC-15": "full" }, async () => {
  await putDesktop([win("wp", "privacy")]);
  await boot("/?amnesia=1");
  await pfetch("POST", "/api/fs", { op: "write", path: `/Documents/panic-${RUN}.txt`, content: "x" });
  await page.locator("body").click({ position: { x: 700, y: 880 } });
  await page.keyboard.press("Control+Alt+Shift+Backspace");
  await page.waitForURL("about:blank", { timeout: 10_000 });
  ok((await page.evaluate(() => document.body?.childElementCount ?? 0)) === 0, "page not blanked");
  ok((await rows("select count(*)::int n from vfs_nodes where path like $1", [`%panic-${RUN}%`]))[0].n === 0, "RAM file reached host");
  page = await ctx.newPage(); page.on("dialog", (d) => void d.accept());
});

await test("privacy headers: no-referrer, no DNS prefetch, nosniff, object-src none; API bodies are never written to the HTTP disk cache", { "SC-13": "partial" }, async () => {
  const r = await fetch(BASE + "/");
  ok(r.headers.get("referrer-policy") === "no-referrer", `referrer ${r.headers.get("referrer-policy")}`);
  ok(r.headers.get("x-dns-prefetch-control") === "off", "dns prefetch");
  ok(/object-src 'none'/.test(r.headers.get("content-security-policy") ?? ""), "csp");
  const a = await fetch(BASE + "/api/fs?op=list&path=/");
  ok(/no-store/.test(a.headers.get("cache-control") ?? ""), `api cache-control ${a.headers.get("cache-control")}`);
});

await test("no performance degradation: real AES-GCM throughput in the browser, and /Private saves vs host saves measured end-to-end", { "SC-10": "partial" }, async () => {
  await putDesktop([win("wp", "privacy")]);
  await boot();
  await privacyRoot().locator('[data-testid="unlock-pass"]').fill(PASS);
  await privacyRoot().locator('[data-testid="unlock"]').click();
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 30_000 });
  await tab("Audit & speed").click();
  await privacyRoot().locator('[data-testid="bench"]').click();
  const b = await privacyRoot().locator('[data-testid="bench-result"]').innerText({ timeout: 60_000 });
  const mbps = Number(/Encrypt\s*(\d+) MB\/s/.exec(b)?.[1] ?? 0);
  // Keep a failed latest measurement visible instead of leaving an older passing
  // result as if it were current. No save timing is available before the gate.
  const record = { at: new Date().toISOString(), bench: b, throughputGate: { minimumMBps: 50, passed: mbps >= 50 }, saveMs: null as null | { host: number; priv: number }, saveGate: null as null | boolean };
  writeFileSync("docs/privacy-bench.json", JSON.stringify(record, null, 1));
  ok(mbps >= 50, `encrypt throughput ${mbps} MB/s: ${b}`);
  const timing = await page.evaluate(async (run) => {
    const body = "x".repeat(256 * 1024);
    const one = async (p: string) => {
      const t = performance.now();
      const r = await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: p, content: body }) });
      const result = await r.json();
      if (!r.ok || result.ok !== true) throw new Error(`Benchmark save was rejected (${r.status}); no timing claim is valid.`);
      return performance.now() - t;
    };
    const host: number[] = []; const priv: number[] = [];
    for (let i = 0; i < 8; i++) { host.push(await one(`/Documents/bench-${run}/h${i}.txt`)); priv.push(await one(`/Private/bench-${run}/p${i}.txt`)); }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
    return { host: med(host), priv: med(priv) };
  }, RUN);
  console.log(`    bench: encrypt ${mbps} MB/s · 256 KiB save median host ${timing.host.toFixed(1)} ms vs /Private ${timing.priv.toFixed(1)} ms`);
  record.saveMs = timing;
  record.saveGate = timing.priv <= timing.host * 1.3 + 8;
  writeFileSync("docs/privacy-bench.json", JSON.stringify(record, null, 1));
  ok(record.saveGate, `/Private save ${timing.priv.toFixed(1)} ms vs host ${timing.host.toFixed(1)} ms`);
});

await test("host audit in the UI: a plaintext file planted by another client is flagged and 'Encrypt it' seals it (name + content)", { "SC-14": "full" }, async () => {
  const [dir] = await rows("select path from vfs_nodes where parent = '/Private' and kind = 'dir' and path like '/Private/~%' limit 1");
  await hostApi("POST", "/api/fs", { op: "write", path: `${dir.path}/planted-${RUN}.txt`, content: "written in clear by a script" });
  await privacyRoot().locator('[data-testid="audit"]').click();
  const res = privacyRoot().locator('[data-testid="audit-result"]');
  await res.getByText(`[clear] planted-${RUN}.txt`, { exact: false }).waitFor({ timeout: 20_000 });
  await res.getByRole("button", { name: "Encrypt it" }).first().click();
  for (let i = 0; i < 50; i++) { if ((await rows("select count(*)::int n from vfs_nodes where trashed = false and (path like $1 or content like $2)", [`%planted-${RUN}%`, "%written in clear%"]))[0].n === 0) break; await page.waitForTimeout(200); }
  ok((await rows("select count(*)::int n from vfs_nodes where trashed = false and (path like $1 or content like $2)", [`%planted-${RUN}%`, "%written in clear%"]))[0].n === 0, "planted file still in clear");
  await privacyRoot().locator('[data-testid="audit"]').click();
  await res.getByText("nothing stored in clear").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: "docs/screenshots/tt18-privacy.png" });
});

const unlockUi = async () => {
  await tab("Persistent Storage").click();
  await privacyRoot().locator('[data-testid="unlock-pass"]').fill(PASS);
  await privacyRoot().locator('[data-testid="unlock"]').click();
  await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 30_000 });
  await privacyRoot().locator('[data-testid="backup-download"]').waitFor({ timeout: 10_000 });
};
const liveRows = async () => new Map((await rows("select path, content from vfs_nodes where path like '/Private/%' and trashed = false")).map((r) => [r.path as string, r.content as string | null]));

await test("TT20 backup in the UI: download one encrypted file, verify it, wipe the host volume, restore it from the file — byte-identical ciphertext", { "SC-17": "full" }, async () => {
  await putDesktop([win("wp", "privacy")]);
  await boot("/");
  await unlockUi();
  const [dl] = await Promise.all([page.waitForEvent("download"), privacyRoot().locator('[data-testid="backup-download"]').click()]);
  const file = join(fx, "out", dl.suggestedFilename());
  await dl.saveAs(file);
  ok(/^fusion-private-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  const text = readFileSync(file, "utf8");
  ok(JSON.parse(text).format === "fusion-private-backup-1", "format");
  for (const leak of [SECRET, `kept-${RUN}`, `meta-${RUN}`, "Documents"]) ok(!text.includes(leak), `backup leaks ${leak}`);
  await privacyRoot().locator('[data-testid="backup-report"]').getByText("Backup made").waitFor({ timeout: 10_000 });
  await privacyRoot().locator('[data-testid="backup-file"]').first().setInputFiles(file);
  await privacyRoot().locator('[data-testid="backup-verify"]').click();
  const rep = privacyRoot().locator('[data-testid="backup-report"]');
  await rep.getByText(/Backup OK/).waitFor({ timeout: 20_000 }).catch(async (e) => {
    // TT70: say WHAT the report shows (DAMAGED / an error / still verifying) instead of only "timeout"
    const shown = await rep.innerText().catch(() => "(no report)");
    const errText = await privacyRoot().locator('[role="alert"]').allInnerTexts().catch(() => []);
    throw new Error(`${(e as Error).message.split("\n")[0]} — report: ${shown.slice(0, 300)} · alerts: ${errText.join(" | ").slice(0, 300)}`);
  });
  const before = await liveRows();
  ok(before.size >= 3, `expected a populated volume, got ${before.size}`);
  // simulate losing the host volume entirely
  await db.query("delete from vfs_versions where path like '/Private/%'");
  await db.query("delete from vfs_nodes where path like '/Private/%'");
  await boot("/");
  await privacyRoot().locator('[data-testid="backup-restore"]').waitFor({ timeout: 20_000 });
  await privacyRoot().locator('[data-testid="backup-file"]').first().setInputFiles(file);
  await privacyRoot().locator('[data-testid="backup-pass"]').first().fill(PASS);
  await privacyRoot().locator('[data-testid="backup-restore"]').click();
  await rep.getByText(/Restored: \d+ files written/).waitFor({ timeout: 30_000 });
  const after = await liveRows();
  for (const [p, c] of before) ok(after.get(p) === c, `row not restored identically: ${p.slice(0, 40)}`);
  await page.locator('[data-testid="storage-badge"]').or(privacyRoot().locator('[data-testid="unlock-pass"]')).first().waitFor({ timeout: 10_000 });
  await unlockUi();
  const r = await pfetch("GET", `/api/fs?op=read&path=/Private/kept-${RUN}.txt`);
  ok(r.status === 200 && r.json.node?.content === "persistent", `restored file reads back: ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
});

await test("TT20 amnesic unsaved-work guard: RAM-only files listed, leaving asks first, 'Keep all' moves them into /Private encrypted; emergency shutdown never asks", { "SC-18": "full" }, async () => {
  await putDesktop([win("wp", "privacy")]);
  // TT20 repair regression: in a normal session the boot toggle flips visibly and stores the pref; in a ?amnesia=1
  // session it shows the SAVED preference (off), not "this session is amnesic"
  await boot("/");
  await tab("Amnesia").click();
  const sw = privacyRoot().getByRole("switch", { name: "Always start amnesic on this device" });
  ok((await sw.getAttribute("aria-checked")) === "false", "boot pref starts off");
  await sw.click();
  ok((await sw.getAttribute("aria-checked")) === "true", "toggle did not flip after click");
  ok((await inPage(async () => localStorage.getItem("fusion.privacy.bootAmnesic"))) === "1", "pref not stored");
  await sw.click();
  ok((await sw.getAttribute("aria-checked")) === "false" && (await inPage(async () => localStorage.getItem("fusion.privacy.bootAmnesic"))) === null, "pref not cleared");
  await boot("/?amnesia=1");
  await tab("Amnesia").click();
  ok((await sw.getAttribute("aria-checked")) === "false", "a one-off ?amnesia=1 session must not show 'always start amnesic' as on");
  await unlockUi();
  await pfetch("POST", "/api/fs", { op: "write", path: `/Documents/draft-${RUN}.txt`, content: `draft ${SECRET}` });
  await tab("Amnesia").click();
  const list = privacyRoot().locator('[data-testid="ram-files"]');
  await list.getByText(`/Documents/draft-${RUN}.txt`).waitFor({ timeout: 10_000 });
  const guard = () => page.evaluate(() => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
  ok(await guard(), "leaving with RAM-only files must ask");
  // a real reload with a real browser prompt: dismissing it keeps the page and the RAM file
  page.removeAllListeners("dialog");
  const seen: string[] = [];
  page.on("dialog", (d) => { seen.push(d.type()); void (d.type() === "beforeunload" ? d.dismiss() : d.accept()); });
  await page.evaluate(() => { location.reload(); }).catch(() => undefined);
  await page.waitForTimeout(800);
  ok(seen.includes("beforeunload"), `browser prompt not shown (dialogs: ${seen.join(",") || "none"})`);
  await list.getByText(`/Documents/draft-${RUN}.txt`).waitFor({ timeout: 5_000 });
  await privacyRoot().locator('[data-testid="rescue-all"]').click();
  await privacyRoot().getByText("No RAM-only files").waitFor({ timeout: 15_000 });
  ok(!(await guard()), "nothing left to lose — no prompt");
  ok((await rows("select count(*)::int n from vfs_nodes where path like $1 or content like $2", [`%draft-${RUN}%`, `%${SECRET}%`]))[0].n === 0, "rescued file reached the host in clear");
  const kept = await pfetch("GET", `/api/fs?op=read&path=/Private/Rescued/Documents/draft-${RUN}.txt`);
  ok(kept.status === 200 && kept.json.node?.content === `draft ${SECRET}`, `rescued file ${kept.status}`);
  // emergency shutdown with a NEW unsaved file: no beforeunload prompt may block it
  await pfetch("POST", "/api/fs", { op: "write", path: `/Documents/panic2-${RUN}.txt`, content: "x" });
  ok(await guard(), "guard armed again");
  seen.length = 0;
  await page.locator("body").click({ position: { x: 700, y: 880 } });
  await page.keyboard.press("Control+Alt+Shift+Backspace");
  await page.waitForURL("about:blank", { timeout: 10_000 });
  ok(!seen.includes("beforeunload"), `emergency shutdown was blocked by a prompt: ${seen.join(",")}`);
  page = await ctx.newPage(); page.on("dialog", (d) => void d.accept()); page.on("pageerror", (e) => errors.push(e.message));
});

await test("no page errors across the privacy flows", { "SC-10": "partial" }, () => {
  const real = errors.filter((e) => !/amnesic session|IndexedDB/.test(e));
  ok(real.length === 0, real.join(" | "));
});

// cleanup: everything this run created; /Private returns to "absent"
if (created) {
  const owned = [`/Documents/meta-${RUN}`, `/Documents/bench-${RUN}`];
  const scoped = (col: string) => `(${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' OR ${col}=$2 OR left(${col},char_length($2)+1)=$2||'/')`;
  await db.query(`delete from vfs_versions where path like '/Private/%' or ${scoped("path")}`, owned);
  await db.query(`delete from vfs_nodes where path like '/Private/%' or ${scoped("path")}`, owned);
  await db.query(`delete from index_docs where source='file' and ${scoped("ref")}`, owned);
  await test("privacy fixture cleanup leaves no host nodes, versions or search rows for its owned paths", { "SC-10": "partial" }, async () => {
    for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
      ok((await rows(`select count(*)::int n from ${table} where ${scoped(col)}`, owned))[0].n === 0, `${table} cleanup left fixture rows`);
  });
}
await db.end();
await browser.close();
finish();
