/**
 * TT69 FF-15 document lifecycle — pure logic, adversarial timing, the real server and the real privacy layer.
 *
 *  1. planClose / enqueueAsk: quantifier order — EVERY close path closes clean windows now and asks about EVERY dirty
 *     one exactly once, in window order; force skips the question; unknown ids are ignored.
 *  2. draftPathFor: injective keys (the readable "/"→"_" scheme sent /a_b and /a/b to one file), private documents'
 *     drafts under /Private, untitled ids validated, unknown kinds refused.
 *  3. the draft codec refuses every malformed shape (wrong version / kind, NaN time, bad sha, bad base64, oversize,
 *     arrays, junk) and draftOffer never offers another document's draft; stale is flagged.
 *  4. DraftWriter under a fake clock and hand-released I/O: debounce, max-wait, newest-wins, one write in flight,
 *     clear() during a write / during serialisation can never leave a draft behind, oversize skipped, errors recover.
 *  5. server: draft writes in the recovery folders keep no version snapshots (every other write still does);
 *     "%"-encoded names round-trip.
 *  6. privacy: a /Private document's draft written through the real PrivacyLayer leaves no plaintext name, content or
 *     version on the host (Postgres read directly); the legacy Editor scheme demonstrably did.
 *
 * Run: BASE=http://localhost:3999 DATABASE_URL=… node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt69-lifecycle.mts
 */
import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
import {
  DraftWriter, MAX_DRAFT_CHARS, UNTITLED_RE, decodeDraft, draftKey, draftOffer, draftPathFor, encodeDraft, enqueueAsk,
  planClose, recoveryRoot, registerDocGuard, isDocDirty, anyDirtyDoc, liveDraftKeys, type DraftRecord, type Timers,
} from "../src/lib/doc-lifecycle.ts";
import { PrivacyLayer } from "../src/lib/privacy/layer.ts";
import { createVolume, encryptPath, type KdfParams } from "../src/lib/privacy/pcrypt.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("tt69-lifecycle");
const FULL = { "FF-15": "full" } as const;
const RUN = Math.random().toString(36).slice(2, 8);

/* ------------------------------------------------------------------ 1. close planning */
await test("planClose: clean windows close now, every dirty one is asked exactly once in window order; force skips; unknown ids ignored; closeAll covers all", FULL, () => {
  const ids = ["w1", "w2", "w3", "w4"]; const dirty = new Set(["w2", "w4"]); const d = (id: string) => dirty.has(id);
  assert.deepEqual(planClose({ t: "close", id: "w1" }, ids, d), { closeNow: ["w1"], ask: [] });
  assert.deepEqual(planClose({ t: "close", id: "w2" }, ids, d), { closeNow: [], ask: ["w2"] });
  assert.deepEqual(planClose({ t: "close", id: "w2", force: true }, ids, d), { closeNow: ["w2"], ask: [] });
  assert.deepEqual(planClose({ t: "close", id: "nope" }, ids, d), { closeNow: [], ask: [] });
  assert.deepEqual(planClose({ t: "closeAll" }, ids, d), { closeNow: ["w1", "w3"], ask: ["w2", "w4"] });
  assert.deepEqual(planClose({ t: "closeAll", force: true }, ids, d), { closeNow: ids, ask: [] });
  // exhaustive: for every dirty subset of 4 windows, closeAll partitions the windows exactly (no window lost or doubled)
  for (let m = 0; m < 16; m++) {
    const ds = (id: string) => ((m >> ids.indexOf(id)) & 1) === 1;
    const p = planClose({ t: "closeAll" }, ids, ds);
    assert.deepEqual([...p.closeNow, ...p.ask].sort(), [...ids].sort(), `mask ${m}`);
    assert.ok(p.ask.every(ds) && p.closeNow.every((x) => !ds(x)), `mask ${m} partition`);
    assert.deepEqual(p.ask, ids.filter(ds), `mask ${m} order`);
  }
  // a second close / Quit while asking: the head stays first, nothing is asked twice
  assert.deepEqual(enqueueAsk(["w2"], ["w4", "w2"]), ["w2", "w4"]);
  assert.deepEqual(enqueueAsk([], ["w4", "w4"]), ["w4"]);
});

await test("guard registry: dirty() is consulted live; a throwing dirty() counts as dirty (fail safe); unregister only removes its own guard; live untitled keys are reported", FULL, async () => {
  let dirty = false;
  const g = { winId: `t-${RUN}`, kind: "writer" as const, title: () => "T", dirty: () => dirty, save: async () => true, flushDraft: async () => undefined, draftKey: () => "abcd1234" };
  const off = registerDocGuard(g);
  assert.equal(isDocDirty(g.winId), false); dirty = true; assert.equal(isDocDirty(g.winId), true); assert.equal(anyDirtyDoc(), true);
  assert.ok(liveDraftKeys().has("abcd1234"));
  const g2 = { ...g, dirty: () => { throw new Error("boom"); } };
  const off2 = registerDocGuard(g2); // the same window re-registers (remount)
  assert.equal(isDocDirty(g.winId), true, "throwing dirty() must not let a close skip the question");
  off(); // the stale unregister of the first guard must not remove the second
  assert.equal(isDocDirty(g.winId), true);
  off2(); assert.equal(isDocDirty(g.winId), false); assert.equal(anyDirtyDoc(), false);
});

/* ------------------------------------------------------------------ 2. draft locations */
await test("draftPathFor: injective keys (/a_b ≠ /a/b, a:b ≠ a?b), private drafts stay under /Private, untitled ids validated, unknown kinds refused", FULL, () => {
  assert.notEqual(draftPathFor("writer", "/a_b"), draftPathFor("writer", "/a/b"), "the readable scheme collided here");
  assert.notEqual(draftPathFor("sheet", "/D/a:b.xlsx"), draftPathFor("sheet", "/D/a?b.xlsx"));
  assert.notEqual(draftPathFor("writer", "/D/x.docx"), draftPathFor("sheet", "/D/x.docx"), "kinds never share a draft");
  // injectivity, randomised: 3 000 random paths over a hostile alphabet → 3 000 distinct draft paths, each decodable
  const alpha = "/_-.%: ?*abAB01~'()"; const seen = new Map<string, string>();
  for (let i = 0; i < 3000; i++) {
    let p = "/"; const n = 1 + Math.floor(Math.random() * 10); for (let j = 0; j < n; j++) p += alpha[Math.floor(Math.random() * alpha.length)];
    const d = draftPathFor("editor", p); const prev = seen.get(d);
    assert.ok(prev === undefined || prev === p, `collision: ${prev} vs ${p}`); seen.set(d, p);
    assert.equal(decodeURIComponent(d.slice(d.lastIndexOf("/") + "editor-".length + 1, -".draft".length)), p);
  }
  assert.equal(draftPathFor("writer", "/Documents/Plan.docx"), "/System/Recovery/writer-%2FDocuments%2FPlan.docx.draft");
  assert.ok(draftPathFor("writer", "/Private/tax/2026.docx").startsWith("/Private/.Recovery/"), "private → encrypted store");
  assert.equal(recoveryRoot("/Privateer/x"), "/System/Recovery", "only the real /Private tree is private");
  assert.equal(draftPathFor("sheet", "", "a1b2c3d4"), "/System/Recovery/sheet_untitled-a1b2c3d4.draft");
  assert.ok(UNTITLED_RE.test("sheet_untitled-a1b2c3d4.draft"));
  assert.throws(() => draftPathFor("sheet", ""), /untitled draft needs an id/);
  assert.throws(() => draftPathFor("sheet", "", "../../x"), /untitled draft needs an id/);
  assert.throws(() => draftPathFor("pdf" as never, "/a"), /unknown document kind/);
  assert.equal(draftKey("/a/b"), "%2Fa%2Fb");
});

/* ------------------------------------------------------------------ 3. codec + offer */
const rec = (o: Partial<DraftRecord> = {}): DraftRecord => ({ v: 1, kind: "writer", path: "/D/a.docx", title: "a", savedAt: 1_700_000_000_000, baseSha: "a".repeat(64), encoding: "base64", payload: "UEsDBA==", ...o });
await test("draft codec: round-trips; refuses wrong version / kind, NaN or negative time, malformed sha, non-base64 payload, unknown encoding, arrays, junk and oversize text", FULL, () => {
  assert.deepEqual(decodeDraft(encodeDraft(rec()), "writer"), rec());
  assert.deepEqual(decodeDraft(encodeDraft(rec({ baseSha: null, encoding: "utf8", payload: "x" })), "writer"), rec({ baseSha: null, encoding: "utf8", payload: "x" }));
  const bad: [string, string][] = [
    ["v2", encodeDraft({ ...rec(), v: 2 } as never)], ["other kind", encodeDraft(rec({ kind: "sheet" }))],
    ["NaN time", encodeDraft(rec()).replace("1700000000000", "null")], ["negative time", encodeDraft(rec({ savedAt: -5 }))],
    ["short sha", encodeDraft(rec({ baseSha: "abc" }))], ["upper sha", encodeDraft(rec({ baseSha: "A".repeat(64) }))],
    ["bad base64", encodeDraft(rec({ payload: "<script>" }))], ["encoding", encodeDraft({ ...rec(), encoding: "hex" } as never)],
    ["array", "[1,2]"], ["junk", "{not json"], ["null", "null"], ["number path", encodeDraft({ ...rec(), path: 5 } as never)],
    ["oversize", JSON.stringify({ ...rec(), payload: "A".repeat(MAX_DRAFT_CHARS + 8192) })],
  ];
  for (const [why, t] of bad) assert.equal(decodeDraft(t, "writer"), null, why);
  // prototype keys in the JSON never reach the returned object
  const polluted = decodeDraft(JSON.stringify({ ...rec(), __proto__: { evil: 1 }, extra: 1 }), "writer") as unknown as Record<string, unknown>;
  assert.ok(polluted && !("extra" in polluted) && polluted.evil === undefined);
});

await test("draftOffer: only a draft OF this document is offered; stale when the file's sha changed since; unknown shas are not called stale", FULL, () => {
  assert.deepEqual(draftOffer(null, "/D/a.docx", null), { offer: false });
  assert.deepEqual(draftOffer(rec(), "/D/b.docx", null), { offer: false }, "another document's draft (e.g. a key collision) is never restored here");
  assert.deepEqual(draftOffer(rec(), "/D/a.docx", "a".repeat(64)), { offer: true, stale: false });
  assert.deepEqual(draftOffer(rec(), "/D/a.docx", "b".repeat(64)), { offer: true, stale: true });
  assert.deepEqual(draftOffer(rec(), "/D/a.docx", null), { offer: true, stale: false });
  assert.deepEqual(draftOffer(rec({ baseSha: null }), "/D/a.docx", "b".repeat(64)), { offer: true, stale: false });
});

/* ------------------------------------------------------------------ 4. DraftWriter timing */
class FakeClock implements Timers {
  t = 0; private q: { at: number; fn: () => void; id: number }[] = []; private n = 0;
  set(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ at: this.t + ms, fn, id }); return id; }
  clear(h: unknown) { this.q = this.q.filter((x) => x.id !== h); }
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.q.sort((a, b) => a.at - b.at); const nx = this.q[0];
      if (!nx || nx.at > end) break;
      this.q.shift(); this.t = nx.at; nx.fn(); await settle();
    }
    this.t = end; await settle();
  }
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** I/O whose writes complete only when the test releases them */
class GatedIo {
  store = new Map<string, string>(); log: string[] = []; inflight = 0; maxInflight = 0; gate = false; fail = false;
  private waiters: (() => void)[] = [];
  release() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  async write(p: string, c: string) {
    this.inflight++; this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (this.gate) await new Promise<void>((r) => this.waiters.push(r));
      if (this.fail) throw new Error("store offline");
      this.store.set(p, c); this.log.push(`w:${c}`);
    } finally { this.inflight--; }
  }
  async remove(p: string) { this.store.delete(p); this.log.push("rm"); }
}
const mk = (text: string) => async () => ({ path: "/System/Recovery/x.draft", text });

await test("DraftWriter: 5 changes inside the idle window → ONE write with the newest content; continuous typing still drafts by the max-wait; nothing written before idle", FULL, async () => {
  const c = new FakeClock(); const io = new GatedIo(); const w = new DraftWriter(io, 2000, 10000, c, () => c.t);
  for (let i = 1; i <= 5; i++) { w.schedule(mk(`v${i}`)); await c.advance(300); }
  assert.equal(io.log.length, 0, "no write while typing");
  await c.advance(2000);
  assert.deepEqual(io.log, ["w:v5"]);
  // keystroke every second for 15 s: idle never reached, but max-wait (10 s) forces a draft
  for (let i = 0; i < 15; i++) { w.schedule(mk(`t${i}`)); await c.advance(1000); }
  assert.ok(io.log.length >= 2 && io.log[1].startsWith("w:t"), `max-wait draft expected: ${io.log.join(",")}`);
  const firstMax = Number(io.log[1].slice(3));
  assert.ok(firstMax <= 10, `drafted by the 10 s max-wait (got t${firstMax})`);
});

await test("DraftWriter: one write in flight; newer content during a slow write lands last (never an older draft over a newer one)", FULL, async () => {
  const c = new FakeClock(); const io = new GatedIo(); io.gate = true; const w = new DraftWriter(io, 100, 1000, c, () => c.t);
  w.schedule(mk("old")); await c.advance(100); // write of "old" is now blocked in flight
  w.schedule(mk("new")); await c.advance(100); // the follow-up waits for the in-flight write
  const f = w.flush();
  assert.equal(io.maxInflight, 1);
  io.release(); await settle(); io.release(); await f; await settle(); io.release(); await settle();
  assert.equal(io.store.get("/System/Recovery/x.draft"), "new", io.log.join(","));
  assert.equal(io.maxInflight, 1, "never two writes at once");
});

await test("DraftWriter.clear: a write in flight when Save clears is awaited and then deleted — a late draft can never resurrect after Save; clear during serialisation writes nothing", FULL, async () => {
  const c = new FakeClock(); const io = new GatedIo(); io.gate = true; const w = new DraftWriter(io, 100, 1000, c, () => c.t);
  w.schedule(mk("before-save")); await c.advance(100); // blocked in flight
  const cl = w.clear("/System/Recovery/x.draft");
  w.schedule(mk("scheduled-after-clear-started")); // a change racing the save
  io.release(); await cl; await settle();
  assert.equal(io.store.has("/System/Recovery/x.draft"), false, `draft resurrected: ${io.log.join(",")}`);
  assert.deepEqual(io.log.slice(0, 2), ["w:before-save", "rm"], "wait for the write, then delete");
  // clear while make() (serialising the document) is still running
  const c2 = new FakeClock(); const io2 = new GatedIo(); const w2 = new DraftWriter(io2, 100, 1000, c2, () => c2.t);
  let releaseMake = () => undefined as void; const slow = () => new Promise<{ path: string; text: string }>((r) => { releaseMake = () => r({ path: "/System/Recovery/y.draft", text: "late" }); });
  w2.schedule(slow); await c2.advance(100);
  const cl2 = w2.clear("/System/Recovery/y.draft"); releaseMake(); await cl2; await settle();
  assert.equal(io2.store.has("/System/Recovery/y.draft"), false, "a draft serialised before Save must not land after it");
  assert.deepEqual(io2.log, ["rm"], "not written at all (TT69 mutant: write-then-delete hid a late write)");
  // Save As: the late draft is of the OLD path; clear() deletes the NEW path's draft — the old one must not be orphaned
  const c3 = new FakeClock(); const io3 = new GatedIo(); const w3 = new DraftWriter(io3, 100, 1000, c3, () => c3.t);
  let rel3 = () => undefined as void; w3.schedule(() => new Promise<{ path: string; text: string }>((r) => { rel3 = () => r({ path: "/System/Recovery/old.draft", text: "late" }); }));
  await c3.advance(100);
  const cl3 = w3.clear("/System/Recovery/new.draft"); rel3(); await cl3; await settle();
  assert.equal(io3.store.has("/System/Recovery/old.draft"), false, "an orphan draft of the old path was written after Save As");
});

await test("DraftWriter: oversize drafts are skipped with a reason; a failing store sets lastError and the next change drafts again; flush() writes immediately", FULL, async () => {
  const c = new FakeClock(); const io = new GatedIo(); const w = new DraftWriter(io, 100, 1000, c, () => c.t);
  w.schedule(async () => ({ path: "/System/Recovery/big.draft", text: "x".repeat(MAX_DRAFT_CHARS + 1) })); await c.advance(100);
  assert.equal(io.store.size, 0); assert.match(w.lastError, /exceeds/);
  io.fail = true; w.schedule(mk("a")); await c.advance(100); assert.match(w.lastError, /store offline/);
  io.fail = false; w.schedule(mk("b")); await w.flush(); assert.equal(io.store.get("/System/Recovery/x.draft"), "b"); assert.equal(w.lastError, "");
  assert.equal(w.pending, false);
});

/* ------------------------------------------------------------------ 5. server */
const api = async (body: unknown) => { const r = await fetch(`${BASE}/api/fs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() as Record<string, any> }; };
const versions = async (p: string) => ((await (await fetch(`${BASE}/api/fs?op=versions&path=${encodeURIComponent(p)}`)).json()) as { versions: unknown[] }).versions.length;
const purge = async (p: string) => { await api({ op: "trash", path: p }); await api({ op: "purge", path: p }); };

await test("server: draft writes in /System/Recovery keep NO version snapshots (3 writes → 0 versions); the same reason elsewhere and plain writes still snapshot; %-encoded names round-trip", FULL, async () => {
  const d = draftPathFor("writer", `/Documents/tt69 ${RUN}/a_b.docx`);
  for (let i = 0; i < 3; i++) assert.equal((await api({ op: "write", path: d, content: `draft ${i}`, reason: "recovery-draft" })).status, 200);
  assert.equal(await versions(d), 0, "a draft every few seconds must not grow the version table");
  const r = await (await fetch(`${BASE}/api/fs?op=read&path=${encodeURIComponent(d)}`)).json() as { node: { content: string; name: string } };
  assert.equal(r.node.content, "draft 2"); assert.equal(r.node.name, d.split("/").pop());
  const elsewhere = `/Documents/tt69-${RUN}-notdraft.txt`;
  for (let i = 0; i < 3; i++) await api({ op: "write", path: elsewhere, content: `x${i}`, reason: "recovery-draft" });
  assert.equal(await versions(elsewhere), 2, "outside the recovery folders the reason alone skips nothing");
  const plain = `/System/Recovery/plain-${RUN}.txt`;
  for (let i = 0; i < 2; i++) await api({ op: "write", path: plain, content: `p${i}`, reason: "write" });
  assert.equal(await versions(plain), 1, "inside the folder a normal write still snapshots");
  for (const p of [d, elsewhere, plain]) await purge(p);
});

/* ------------------------------------------------------------------ 6. privacy */
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const FAST: KdfParams = { kdf: "argon2id", m: 19456, t: 2, p: 1 };
const { keys } = await createVolume("tt69 passphrase", { kdf: FAST, withRecovery: false });
const L = new PrivacyLayer((url, init) => fetch(BASE + url, init)); L.keys = keys;
const lpost = async (body: unknown) => { const r = await L.handle("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as Record<string, any> }; };
const WORD = `zyxdraft${RUN}`;

await test("privacy: a /Private document's draft written through the real PrivacyLayer leaves no plaintext name, content or version on the host (Postgres read directly); the legacy Editor draft path put the same text on the host in the clear", FULL, async () => {
  const doc = `/Private/tt69-${RUN}/secret ${WORD}.txt`;
  const dp = draftPathFor("editor", doc);
  assert.ok(dp.startsWith("/Private/.Recovery/"));
  const text = encodeDraft({ v: 1, kind: "editor", path: doc, title: "secret", savedAt: Date.now(), baseSha: null, encoding: "utf8", payload: `the plan ${WORD}` });
  for (let i = 0; i < 2; i++) { const w = await lpost({ op: "write", path: dp, content: text, reason: "recovery-draft" }); assert.equal(w.status, 200, JSON.stringify(w.body)); }
  const leak = (await db.query("select count(*)::int n from vfs_nodes where path like $1 or name like $1 or content like $1", [`%${WORD}%`])).rows[0].n;
  assert.equal(leak, 0, "no plaintext name or content on the host");
  const hostPath = await encryptPath(keys, dp);
  const vers = (await db.query("select count(*)::int n from vfs_versions where path = $1", [hostPath])).rows[0].n;
  assert.equal(vers, 0, "the encrypted draft keeps no version history either");
  const back = await L.handle(`/api/fs?op=read&path=${encodeURIComponent(dp)}`);
  assert.equal(decodeDraft(((await back.json()) as { node: { content: string } }).node.content, "editor")?.payload, `the plan ${WORD}`, "the layer decrypts it back");
  // before-evidence: TT68's Editor wrote `/System/Recovery${path.replace(/\//g, "_")}.draft` — a host path
  const legacy = `/System/Recovery${doc.replace(/\//g, "_")}.draft`;
  await lpost({ op: "write", path: legacy, content: `the plan ${WORD}`, reason: "recovery-draft" });
  const leaked = (await db.query("select count(*)::int n from vfs_nodes where path = $1 and content like $2", [legacy, `%${WORD}%`])).rows[0].n;
  assert.equal(leaked, 1, "the legacy scheme stored the private text in the clear (and beside /System/Recovery, not in it)");
  await purge(legacy);
  await lpost({ op: "trash", path: dp }); await lpost({ op: "purge", path: dp });
});

await db.end();
finish();
