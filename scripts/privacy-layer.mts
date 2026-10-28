/**
 * TT18 privacy suite 2 — the transport layer against the REAL server + Postgres.
 *
 * The same PrivacyLayer class the browser installs as its fetch guard is built here over real HTTP;
 * every "the host never sees X" claim is checked by reading Postgres directly (vfs_nodes,
 * vfs_versions, index_docs, desktop_state, notes) — not by trusting the layer's own responses.
 *
 * Run: BASE=http://localhost:3999 DATABASE_URL=… node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/privacy-layer.mts
 */
import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
import { PrivacyLayer } from "../src/lib/privacy/layer.ts";
import { ENC_MIME, createVolume, encryptPath, type KdfParams } from "../src/lib/privacy/pcrypt.ts";
import { Workbook, workbookToJson } from "../src/lib/formula/index.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("privacy-layer");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const raw = (url: string, init?: RequestInit) => fetch(BASE + url, init);
const FAST: KdfParams = { kdf: "argon2id", m: 19456, t: 2, p: 1 };
const RUN = Math.random().toString(36).slice(2, 8);
const WORD = `zyxprivacy${RUN}`; // unique token: must never become searchable on the host

const { keys } = await createVolume("integration passphrase", { kdf: FAST, withRecovery: false });
const L = new PrivacyLayer(raw);
L.keys = keys;
const call = async (layer: PrivacyLayer, url: string, init?: RequestInit) => {
  const r = await layer.handle(url, init);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const get = (layer: PrivacyLayer, op: string, path: string) => call(layer, `/api/fs?op=${op}&path=${encodeURIComponent(path)}`);
const post = (layer: PrivacyLayer, body: unknown, url = "/api/fs") => call(layer, url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rows = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const DIR = `/Private/it-${RUN}`;

await test("write through the layer: the host row has no plaintext name, content, size or index entry; read decrypts", { "SC-10": "full" }, async () => {
  const text = `Meeting notes ${WORD}: move the funds on Friday.`;
  const w = await post(L, { op: "write", path: `${DIR}/plans ${WORD}.txt`, content: text, reason: "it" });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.path, `${DIR}/plans ${WORD}.txt`); assert.equal(w.body.encrypted, true);
  const hostPath = await encryptPath(keys, `${DIR}/plans ${WORD}.txt`);
  const [row] = await rows("select path, name, content, mime, encoding, size from vfs_nodes where path = $1", [hostPath]);
  assert.ok(row, "ciphertext row exists at the encrypted path");
  const dump = JSON.stringify(row);
  assert.ok(!dump.includes(WORD) && !dump.includes("plans") && !dump.includes("Meeting"), "no plaintext anywhere in the row");
  assert.equal(row.mime, ENC_MIME); assert.equal(row.encoding, "base64");
  assert.ok(row.content.startsWith("RkVOMQ"), "FEN1 blob");
  assert.ok(row.size > text.length, "stored size is the padded ciphertext, not the plaintext length");
  assert.equal((await rows("select count(*)::int n from vfs_nodes where content like $1 or path like $1", [`%${WORD}%`]))[0].n, 0);
  assert.equal((await rows("select count(*)::int n from index_docs where body like $1 or title like $1 or ref like $1", [`%${WORD}%`]))[0].n, 0, "nothing indexed");
  const s = await raw(`/api/search?q=${WORD}`).then((r) => r.json()) as { hits: unknown[] };
  assert.equal(s.hits.length, 0, "host search cannot find it");
  const r = await get(L, "read", `${DIR}/plans ${WORD}.txt`);
  assert.equal(r.body.node.content, text); assert.equal(r.body.node.mime, "text/plain"); assert.equal(r.body.node.size, Buffer.byteLength(text));
});

await test("list decrypts and sorts names; a second write keeps an encrypted version that decrypts; rename/move stay encrypted server-side", { "SC-10": "full" }, async () => {
  await post(L, { op: "write", path: `${DIR}/b.md`, content: "# v1", reason: "it" });
  await post(L, { op: "write", path: `${DIR}/b.md`, content: "# v2", reason: "it" });
  await post(L, { op: "mkdir", path: `${DIR}/Sub` });
  const ls = await get(L, "list", DIR);
  const names = (ls.body.nodes as { name: string }[]).map((n) => n.name);
  assert.deepEqual(names, ["Sub", "b.md", `plans ${WORD}.txt`]);
  const v = await get(L, "versions", `${DIR}/b.md`);
  assert.equal(v.body.versions[0].content, "# v1", "old version decrypts");
  const [vr] = await rows("select content from vfs_versions where path = $1", [await encryptPath(keys, `${DIR}/b.md`)]);
  assert.ok(vr.content.startsWith("RkVOMQ") && !vr.content.includes("v1"), "the host's version row is ciphertext");
  assert.equal((await post(L, { op: "rename", path: `${DIR}/b.md`, name: "renamed.md" })).status, 200);
  assert.equal((await post(L, { op: "move", src: `${DIR}/renamed.md`, dst: `${DIR}/Sub/inner.md` })).status, 200);
  assert.equal((await get(L, "read", `${DIR}/Sub/inner.md`)).body.node.content, "# v2");
  // Public files (including Orbit's rename fixtures) are allowed to have these names. Check the
  // protected namespace, and exact plaintext segments, rather than unrelated host paths or ciphertext substrings.
  const leakedNames = "path like '/Private/%' and (name in ('renamed.md', 'inner.md') or path like '%/renamed.md' or path like '%/inner.md')";
  assert.equal((await rows(`select count(*)::int n from vfs_nodes where ${leakedNames}`))[0].n, 0, "new private names are encrypted too");
  const [moved] = await rows("select name, content from vfs_nodes where path=$1", [await encryptPath(keys, `${DIR}/Sub/inner.md`)]);
  assert.ok(moved && moved.name !== "inner.md" && moved.content.startsWith("RkVOMQ"), "moved row exists with encrypted name and bytes");
  // Attack the scoped predicate itself: it must detect a plaintext Private leak but allow an ordinary public file.
  const controls = await rows(`select path from (values ('/Private/attack/inner.md', 'inner.md'), ('/Documents/inner.md', 'inner.md')) as vfs_nodes(path,name) where ${leakedNames}`);
  assert.deepEqual(controls.map(r => r.path), ["/Private/attack/inner.md"]);
});

await test("locked: /Private lists opaque entries, reads are refused (423), header hidden; tags & host-side compress refused inside", { "SC-10": "full" }, async () => {
  const locked = new PrivacyLayer(raw);
  const ls = await get(locked, "list", "/Private");
  assert.equal(ls.status, 200); assert.equal(ls.body.locked, true);
  assert.ok((ls.body.nodes as { name: string }[]).every((n) => n.name.startsWith("~")), "only ciphertext names visible");
  const rd = await get(locked, "read", `${DIR}/Sub/inner.md`);
  assert.equal(rd.status, 423); assert.match(rd.body.error, /locked/);
  assert.equal((await post(L, { op: "tag", path: `${DIR}/Sub/inner.md`, tags: "secret" })).status, 422);
  assert.equal((await post(L, { op: "compress", path: `${DIR}/Sub` })).status, 422);
  assert.equal((await post(L, { op: "write", path: "/Private/.keyslots.json", content: "{}" })).status, 403, "header not writable as a file");
});

await test("cross-store moves happen in the browser: host file → /Private arrives encrypted (source trashed); /Private → host is an explicit decrypting copy", { "SC-10": "full" }, async () => {
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: `/Documents/in-${RUN}.txt`, content: `incoming ${WORD}` }) });
  const mv = await post(L, { op: "move", src: `/Documents/in-${RUN}.txt`, dst: `${DIR}/incoming.txt` });
  assert.equal(mv.status, 200, JSON.stringify(mv.body)); assert.equal(mv.body.crossStore, "host→private");
  const [row] = await rows("select content, mime from vfs_nodes where path = $1", [await encryptPath(keys, `${DIR}/incoming.txt`)]);
  assert.ok(row.content.startsWith("RkVOMQ") && row.mime === ENC_MIME);
  const [src] = await rows("select trashed from vfs_nodes where path = $1", [`/Documents/in-${RUN}.txt`]);
  assert.equal(src.trashed, true, "source moved to the host trash (user can purge it)");
  const cp = await post(L, { op: "copy", src: `${DIR}/incoming.txt`, dst: `/Documents/out-${RUN}.txt` });
  assert.equal(cp.body.crossStore, "private→host");
  const [out] = await rows("select content from vfs_nodes where path = $1", [`/Documents/out-${RUN}.txt`]);
  assert.equal(out.content, `incoming ${WORD}`, "explicit export is plaintext by design");
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path: `/Documents/out-${RUN}.txt` }) });
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path: `/Documents/in-${RUN}.txt` }) });
});

await test("office on encrypted files: Export .xlsx into /Private (rewritten to export + encrypted write), import from /Private inlined; the bare server refuses the blob", { "SC-10": "full", "FF-20": "partial" }, async () => {
  const wb = new Workbook();
  const s = wb.addSheet("Budget");
  s.setCell(0, 0, "Rent"); s.setCell(1, 0, "1200"); s.setCell(1, 1, "=B1*12");
  wb.recalculate();
  const ex = await post(L, { op: "saveXlsxToVfs", workbook: workbookToJson(wb), dest: `${DIR}/budget.xlsx` }, "/api/sheet");
  assert.equal(ex.status, 200, JSON.stringify(ex.body)); assert.equal(ex.body.encrypted, true);
  const [row] = await rows("select content, mime from vfs_nodes where path = $1", [await encryptPath(keys, `${DIR}/budget.xlsx`)]);
  assert.ok(row.content.startsWith("RkVOMQ"), "the xlsx is stored encrypted");
  const im = await post(L, { op: "importXlsx", path: `${DIR}/budget.xlsx` }, "/api/sheet");
  assert.equal(im.status, 200, JSON.stringify(im.body));
  assert.ok(JSON.stringify(im.body.workbook).includes("14400") || JSON.stringify(im.body.values).includes("14400"), "formula value survived the encrypted round trip");
  const bare = await raw("/api/sheet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "importXlsx", path: await encryptPath(keys, `${DIR}/budget.xlsx`) }) });
  const bb = await bare.json() as { ok: boolean; error: string };
  assert.equal(bb.ok, false); assert.match(bb.error, /encrypted Persistent Storage/);
});

await test("TT87 conditional VFS writes respect privacy boundaries and still work for ordinary unlocked-host files", { "SC-10": "full", "SC-13": "full", "BK-02": "partial" }, async () => {
  const host = `/Documents/conditional-${RUN}.txt`;
  const privatePath = `/Private/conditional-${RUN}.txt`;
  const amnesicPath = `/Documents/conditional-amnesic-${RUN}.txt`;
  const conditional = (path: string) => ({ op: "writeIfUnchanged", path, content: WORD, expected: null });
  const locked = new PrivacyLayer(raw);
  const A = new PrivacyLayer(raw); A.amnesic = true; A.keys = keys;
  try {
    assert.equal((await post(L, conditional(host))).status, 200, "ordinary host conditional create works while volume is unlocked");
    assert.equal((await post(L, conditional(host))).status, 409, "conditional create cannot overwrite");
    assert.equal((await post(L, conditional(privatePath))).status, 422, "unlocked private conditional write refused");
    assert.equal((await post(locked, conditional(privatePath))).status, 422, "locked private conditional write refused");
    assert.equal((await post(A, conditional(amnesicPath))).status, 423, "amnesic conditional write refused");
    assert.equal((await post(A, { op: "futureUnreviewedWrite", path: amnesicPath })).status, 423, "unknown amnesic operations fail closed");
    assert.equal((await post(L, { op: "futureUnreviewedWrite", path: privatePath })).status, 422, "unknown private operations fail closed");
    assert.equal((await rows("select count(*)::int n from vfs_nodes where path = any($1::text[])", [[privatePath, amnesicPath]]))[0].n, 0, "no plaintext or RAM fixture reached the host");
    assert.ok(A.blocked.some((b) => b.what === "fs.writeIfUnchanged"));
  } finally {
    for (const path of [host, privatePath, amnesicPath]) await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path }) });
  }
});

await test("TT94 photo guards preserve unlocked host checks without leaking private or RAM recipes", { "SC-10": "partial", "SC-11": "partial", "MD-03": "partial" }, async () => {
  const host = `/Documents/tt94-photo-${RUN}.jpg`, moved = `/Documents/tt94-moved-${RUN}.jpg`, hostSide = `/Documents/.tt94-photo-${RUN}.jpg.edit.json`;
  const privatePhoto = `${DIR}/secret-${RUN}.jpg`, privateSide = `${DIR}/.secret-${RUN}.jpg.edit.json`, ramSide = `/Documents/.tt94-ram-${RUN}.jpg.edit.json`;
  const captured: string[] = [];
  const observed = new PrivacyLayer((url, init) => { if (typeof init?.body === "string") captured.push(init.body); return raw(url, init); }); observed.keys = keys;
  const A = new PrivacyLayer(raw); A.amnesic = true;
  try {
    const created = await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: host, content: "image", mime: "image/jpeg" }) }); assert.equal(created.status, 200);
    const [n] = await rows("select id,version,sha256 from vfs_nodes where path=$1", [host]); const guard = { path: host, id: n.id, version: n.version, sha256: n.sha256 };
    assert.equal((await post(L, { op: "write", path: hostSide, content: "host edits", expectedPhoto: guard, expectedRecipe: null })).status, 200);
    assert.equal((await post(L, { op: "write", path: hostSide, content: "stale recipe", expectedPhoto: guard, expectedRecipe: null })).status, 409, "host forwarding must retain the recipe precondition");
    assert.equal((await rows("select content from vfs_nodes where path=$1", [hostSide]))[0].content, "host edits");
    assert.equal((await post(L, { op: "move", src: host, dst: moved })).status, 200);
    assert.equal((await post(L, { op: "write", path: hostSide, content: "stale", expectedPhoto: guard })).status, 409, "unlocked host forwarding must retain the identity guard");
    assert.equal((await rows("select count(*)::int n from vfs_nodes where path=$1", [hostSide]))[0].n, 0);
    assert.equal((await post(L, { op: "write", path: hostSide, content: "bad", expectedPhoto: { ...guard, path: privatePhoto } })).status, 422, "private owner path cannot be forwarded to a host target");
    const secretGuard = { path: privatePhoto, id: 1, version: 1, sha256: "a".repeat(64) };
    assert.equal((await post(L, { op: "write", path: hostSide, content: "bad", expectedRecipe: null })).status, 400, "a host recipe precondition without an owner cannot be dropped");
    assert.equal((await post(observed, { op: "write", path: privateSide, content: `private-${WORD}`, expectedPhoto: secretGuard, expectedRecipe: null })).status, 422, "Private recipe CAS is refused, not silently downgraded");
    assert.equal((await post(observed, { op: "write", path: privateSide, content: `private-${WORD}`, expectedPhoto: secretGuard })).status, 200);
    assert.equal((await get(observed, "read", privateSide)).body.node.content, `private-${WORD}`);
    assert.ok(captured.every((x) => !x.includes(privatePhoto) && !x.includes(privateSide) && !x.includes(WORD) && !x.includes("expectedRecipe")), "private guards and contents must not reach the host in clear");
    assert.equal((await post(observed, { op: "purge", path: privateSide, expectedPhoto: secretGuard, expectedRecipe: null })).status, 422);
    assert.equal((await post(observed, { op: "purge", path: privateSide, expectedPhoto: secretGuard })).status, 200);
    assert.equal((await post(A, { op: "write", path: ramSide, content: `ram-${WORD}`, expectedPhoto: guard, expectedRecipe: null })).status, 422, "RAM recipe CAS is refused, not silently downgraded");
    assert.equal((await post(A, { op: "write", path: ramSide, content: `ram-${WORD}`, expectedPhoto: guard })).status, 200);
    assert.equal((await get(A, "read", ramSide)).body.node.content, `ram-${WORD}`);
    assert.equal((await rows("select count(*)::int n from vfs_nodes where path=$1 or content like $2", [ramSide, `%ram-${WORD}%`]))[0].n, 0);
    assert.equal((await post(A, { op: "purge", path: ramSide, expectedPhoto: guard })).status, 200);
  } finally {
    for (const path of [host, moved, hostSide, `/Documents/.tt94-moved-${RUN}.jpg.edit.json`]) await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path }) });
    A.ram.wipe();
  }
});

await test("amnesic: VFS writes live in RAM (no row), host files can be hidden but are untouched, moves copy into RAM; wipe forgets everything", { "SC-11": "full" }, async () => {
  const A = new PrivacyLayer(raw); A.amnesic = true;
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: `/Documents/host-${RUN}.txt`, content: "on the host" }) });
  const w = await post(A, { op: "write", path: `/Documents/ram-${RUN}/note.txt`, content: `ram only ${WORD}` });
  assert.equal(w.status, 200); assert.equal(w.body.amnesic, true);
  assert.equal((await rows("select count(*)::int n from vfs_nodes where path like $1", [`%ram-${RUN}%`]))[0].n, 0, "nothing written to the host");
  assert.equal((await get(A, "read", `/Documents/ram-${RUN}/note.txt`)).body.node.content, `ram only ${WORD}`);
  const ls = await get(A, "list", "/Documents");
  const names = (ls.body.nodes as { name: string }[]).map((n) => n.name);
  assert.ok(names.includes(`ram-${RUN}`) && names.includes(`host-${RUN}.txt`), "merged view: RAM over host");
  assert.equal((await post(A, { op: "trash", path: `/Documents/host-${RUN}.txt` })).status, 200);
  assert.ok(!((await get(A, "list", "/Documents")).body.nodes as { name: string }[]).some((n) => n.name === `host-${RUN}.txt`), "hidden this session");
  assert.equal((await get(A, "read", `/Documents/host-${RUN}.txt`)).status, 404);
  const [h] = await rows("select trashed, content from vfs_nodes where path = $1", [`/Documents/host-${RUN}.txt`]);
  assert.equal(h.trashed, false); assert.equal(h.content, "on the host", "host copy untouched");
  const mv = await post(A, { op: "rename", path: `/Documents/ram-${RUN}/note.txt`, name: "renamed.txt" });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal((await get(A, "read", `/Documents/ram-${RUN}/renamed.txt`)).body.node.content, `ram only ${WORD}`);
  assert.equal((await post(A, { op: "compress", path: "/Documents" })).status, 423, "host-side compress refused");
  A.ram.wipe();
  assert.equal((await get(A, "read", `/Documents/ram-${RUN}/renamed.txt`)).status, 404);
  assert.equal((await get(A, "read", `/Documents/host-${RUN}.txt`)).status, 200, "after wipe the host view returns");
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path: `/Documents/host-${RUN}.txt` }) });
});

await test("amnesic deny-by-default: notes/settings/presets refused with nothing written; state kept in memory; compute endpoints still work; /Private still persists (Tails' Persistent folder)", { "SC-11": "full" }, async () => {
  const A = new PrivacyLayer(raw); A.amnesic = true; A.keys = keys;
  const before = (await rows("select count(*)::int n from notes"))[0].n;
  const n = await post(A, { title: `amnesic ${WORD}`, body: "x" }, "/api/notes");
  assert.equal(n.status, 423); assert.match(n.body.error, /amnesic/);
  assert.equal((await rows("select count(*)::int n from notes"))[0].n, before);
  const st = await call(A, "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "theme", value: "light" }) });
  assert.equal(st.status, 423);
  const stateRow = async () => (await rows("select revision, state::text s from desktop_state where id = 'privacy-amnesic'"))[0] ?? null;
  const pre = await stateRow();
  const put = await call(A, "/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "privacy-amnesic", revision: 5, state: { windows: [{ title: WORD }] } }) });
  assert.equal(put.status, 200); assert.equal(put.body.amnesic, true);
  assert.deepEqual(await stateRow(), pre, "desktop_state untouched");
  assert.equal((await call(A, "/api/state?id=privacy-amnesic")).body.row.state.windows[0].title, WORD, "readable within the session");
  assert.equal((await call(A, "/api/state?id=default")).body.row, null, "amnesic boots a clean desktop");
  const wb = new Workbook(); wb.addSheet("S").setCell(0, 0, "=1+2");
  const rc = await post(A, { op: "recalculate", workbook: workbookToJson(wb) }, "/api/sheet");
  assert.equal(rc.status, 200, "pure compute allowed");
  const pw = await post(A, { op: "write", path: `${DIR}/from-amnesic.txt`, content: "persists encrypted" });
  assert.equal(pw.status, 200);
  const [row] = await rows("select content from vfs_nodes where path = $1", [await encryptPath(keys, `${DIR}/from-amnesic.txt`)]);
  assert.ok(row?.content.startsWith("RkVOMQ"), "Persistent Storage writes reach the host encrypted even in amnesia");
  assert.ok(A.blocked.length >= 2, "blocked attempts are logged in memory for the Privacy panel");
});

await raw("/api/state?id=session:privacy-it", { method: "DELETE" });
await test("desktop state: /Private paths are sealed before reaching the host and reopened when unlocked; locked seal never leaks", { "SC-10": "full" }, async () => {
  const state = { windows: [{ module: "editor", props: { path: `/Private/case ${WORD}/statement.txt` } }, { props: { path: "/Documents/public.txt" } }] };
  const put = await call(L, "/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "session:privacy-it", revision: 1, state }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const [row] = await rows("select state::text s from desktop_state where id = 'session:privacy-it'");
  assert.ok(!row.s.includes(WORD) && !row.s.includes("statement"), "no plaintext private path on the host");
  assert.ok(row.s.includes("/Documents/public.txt"), "non-private paths untouched");
  const back = await call(L, "/api/state?id=session:privacy-it");
  assert.equal(back.body.row.state.windows[0].props.path, `/Private/case ${WORD}/statement.txt`);
  const locked = new PrivacyLayer(raw);
  const sealed = JSON.stringify(await locked.sealState(state));
  assert.ok(!sealed.includes(WORD) && sealed.includes("/Private/[locked]"));
  await raw("/api/state?id=session:privacy-it", { method: "DELETE" });
});

await test("audit walks /Private on the host and flags anything stored in clear (a planted plaintext file is caught)", { "SC-10": "full", "SC-14": "partial" }, async () => {
  const encDir = await encryptPath(keys, DIR);
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: `${encDir}/planted-${RUN}.txt`, content: "host wrote this in clear" }) });
  const rep = await L.audit();
  assert.ok(rep.encryptedContent >= 4, `encrypted files ${rep.encryptedContent}`);
  assert.ok(rep.plainNames.some((p) => p.endsWith(`planted-${RUN}.txt`)), "plaintext name flagged");
  assert.ok(rep.plainContent.some((p) => p.endsWith(`planted-${RUN}.txt`)), "plaintext content flagged");
  const listed = ((await get(L, "list", DIR)).body.nodes as { name: string; undecryptable?: boolean }[]).find((n) => n.name === `[clear] planted-${RUN}.txt`);
  assert.ok(listed?.undecryptable, "listing marks the clear entry");
  const r = await get(L, "read", `${DIR}/[clear] planted-${RUN}.txt`);
  assert.equal(r.body.node.plaintextInPrivate, true, "reader is told the file is not protected");
  // attack on the [clear] addressing patch: a user-typed reserved name must not create a cleartext name
  for (const req of [{ op: "write", path: `${DIR}/[clear] leak-${RUN}.txt`, content: "x" }, { op: "mkdir", path: `${DIR}/[clear] dir-${RUN}` }, { op: "rename", path: `${DIR}/Sub/inner.md`, name: `[clear] leak-${RUN}.md` }]) {
    const res = await post(L, req);
    assert.equal(res.status, 422, `${req.op}: ${JSON.stringify(res.body)}`);
  }
  assert.equal((await rows("select count(*)::int n from vfs_nodes where path like $1", [`%leak-${RUN}%`]))[0].n, 0, "no cleartext name created");
  assert.equal((await rows("select count(*)::int n from vfs_nodes where path like $1", [`%dir-${RUN}%`]))[0].n, 0);
  // writing to the EXISTING planted entry is allowed and its content becomes ciphertext (name stays flagged)
  assert.equal((await post(L, { op: "write", path: `${DIR}/[clear] planted-${RUN}.txt`, content: "now protected" })).status, 200);
  const [pl] = await rows("select content from vfs_nodes where path like $1", [`%/planted-${RUN}.txt`]);
  assert.ok(pl.content.startsWith("RkVOMQ"), "content re-sealed");
  // attack on the "rename to seal" route: plant ANOTHER clear file and rename it to a normal name. A server-side
  // rename would give plaintext content an encrypted name (invisible to audit). It must be re-sealed instead.
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: `${encDir}/planted2-${RUN}.txt`, content: "second clear secret" }) });
  const mv = await post(L, { op: "move", src: `${DIR}/[clear] planted2-${RUN}.txt`, dst: `${DIR}/sealed-${RUN}.txt` });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal((await get(L, "read", `${DIR}/sealed-${RUN}.txt`)).body.node.content, "second clear secret");
  const leaked = await rows("select path, content from vfs_nodes where trashed = false and (path like $1 or path like $2 or content like $3)", [`%planted2-${RUN}%`, `%sealed-${RUN}%`, "%second clear secret%"]);
  assert.deepEqual(leaked, [], "no live row keeps the clear name or clear content");
  // attack on the index choke point: a RAW client (not the layer) moves a plaintext host file under /Private —
  // the server must not index it there, whichever op delivered it
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: `/Documents/raw-${RUN}.txt`, content: "raw client indexed secret" }) });
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "move", src: `/Documents/raw-${RUN}.txt`, dst: `${encDir}/raw-${RUN}.txt` }) });
  await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "copy", src: `${encDir}/raw-${RUN}.txt`, dst: `${encDir}/raw2-${RUN}.txt` }) });
  assert.equal((await rows("select count(*)::int n from index_docs where ref like '/Private/%' or body like '%raw client indexed secret%'"))[0].n, 0, "server indexed a /Private path");
  const after = await L.audit();
  assert.ok(!after.plainContent.some((p) => p.includes(`sealed`)) && !after.plainNames.some((p) => p.includes(`planted2-${RUN}`)), JSON.stringify(after));
});

await test("TT19 private search: /Private is searchable from an in-tab index; scoped queries never reach the host; index follows write/move/trash and dies on lock", { "SC-16": "full" }, async () => {
  const seen: string[] = [];
  const spy = (url: string, init?: RequestInit) => { seen.push(url); return raw(url, init); };
  const S = new PrivacyLayer(spy); S.keys = keys;
  const TOK = `qq${RUN}needle`;
  await post(S, { op: "write", path: `${DIR}/srch/ledger.md`, content: `alpha bravo ${TOK} charlie\n`.repeat(3), reason: "it" });
  await post(S, { op: "write", path: `${DIR}/srch/${TOK}-photo.png`, content: "iVBORw0KGgo=", encoding: "base64", reason: "it" });
  const q = (query: string, scope = "") => call(S, `/api/search?q=${encodeURIComponent(query)}${scope ? `&scope=${encodeURIComponent(scope)}` : ""}`);
  seen.length = 0;
  const a = await q(TOK, "/Private");
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.hostQueried, false);
  assert.deepEqual(a.body.hits.map((h: any) => h.ref).sort(), [`${DIR}/srch/${TOK}-photo.png`, `${DIR}/srch/ledger.md`].sort(), "content hit + name-only hit for a binary");
  assert.ok(a.body.hits.every((h: any) => h.how === "private-local" && h.source === "file"));
  assert.match(a.body.hits.find((h: any) => h.ref.endsWith("ledger.md")).snippet, new RegExp(TOK));
  assert.equal(seen.filter((u) => u.startsWith("/api/search")).length, 0, "the query text never went to the host");
  assert.ok(a.body.private.indexed >= 2);
  assert.equal((await q(`alpha ${TOK}`, "/Private")).body.hits.length, 1, "AND of tokens");
  assert.equal((await q(`alpha zzznothere${RUN}`, "/Private")).body.hits.length, 0);
  // unscoped: host files are still searched (the query text DOES reach the host — declared), private hits merged first
  const u = await q(TOK);
  assert.equal(u.body.hostQueried, true); assert.ok(seen.some((x) => x.startsWith("/api/search")));
  assert.equal(u.body.hits.filter((h: any) => h.how === "private-local").length, 2);
  assert.equal((await rows("select count(*)::int n from index_docs where body like $1 or title like $1 or ref like $1", [`%${TOK}%`]))[0].n, 0, "host index still has nothing");
  // incremental: write / move / trash without a rebuild
  const built = a.body.private.buildMs;
  await post(S, { op: "write", path: `${DIR}/srch/new.txt`, content: `late ${TOK}2 entry`, reason: "it" });
  const n1 = await q(`${TOK}2`, "/Private");
  assert.deepEqual(n1.body.hits.map((h: any) => h.ref), [`${DIR}/srch/new.txt`]); assert.equal(n1.body.private.buildMs, built, "no rebuild");
  await post(S, { op: "move", src: `${DIR}/srch/new.txt`, dst: `${DIR}/srch/moved.txt` });
  assert.deepEqual((await q(`${TOK}2`, `${DIR}/srch`)).body.hits.map((h: any) => h.ref), [`${DIR}/srch/moved.txt`]);
  await post(S, { op: "trash", path: `${DIR}/srch/moved.txt` });
  assert.equal((await q(`${TOK}2`, "/Private")).body.hits.length, 0, "trashed files leave the index");
  // lock: index dropped, scoped search answers locally with nothing, still no host request
  S.keys = null; seen.length = 0;
  const l = await q(TOK, "/Private");
  assert.equal(l.body.locked, true); assert.equal(l.body.hits.length, 0); assert.equal(seen.length, 0);
  assert.equal((S as any).pidx, null, "decrypted index discarded");
  S.keys = keys; S.dropPrivateIndex();
  assert.equal((await q(TOK, "/Private")).body.hits.length, 2, "rebuilt after unlock");
});

await test("TT19 amnesic search: RAM-only files are searchable in place and hidden host files drop out of results", { "SC-16": "partial", "SC-13": "partial" }, async () => {
  const A = new PrivacyLayer(raw); A.amnesic = true;
  const TOK = `rr${RUN}ramonly`;
  await post(A, { op: "write", path: `/Documents/amn-${RUN}.txt`, content: `ram ${TOK}`, reason: "it" });
  const r = await call(A, `/api/search?q=${TOK}`);
  assert.deepEqual(r.body.hits.map((h: any) => [h.ref, h.how]), [[`/Documents/amn-${RUN}.txt`, "amnesic-ram"]]);
  assert.equal((await rows("select count(*)::int n from index_docs where body like $1 or ref like $1", [`%${TOK}%`]))[0].n, 0);
  A.ram.wipe();
  assert.equal((await call(A, `/api/search?q=${TOK}`)).body.hits.length, 0, "wiped RAM is gone from search");
});

// Cleanup only this run's cryptographically unique subtree, including orphan versions.
// Prefix comparison is literal: base64url paths may contain SQL LIKE wildcards.
const encryptedRunDir = await encryptPath(keys, DIR);
await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "purge", path: encryptedRunDir }) });
await db.query("DELETE FROM vfs_versions WHERE path = $1 OR left(path, char_length($1) + 1) = $1 || '/'", [encryptedRunDir]);
await db.end();
finish();
