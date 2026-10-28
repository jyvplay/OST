/** Real isolated PostgreSQL only: do not run this fault/permission suite against a user database. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { BACKUP_VERSION, makeBackup, verifyBackup, type BackupEntry, type BackupPayload } from "../src/lib/backup/bundle.ts";
import { drillBackup } from "../src/lib/server/backup-drill.ts";
import { pool } from "../src/db/index.ts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1") {
  throw new Error("Refusing PostgreSQL fault/permission tests: set TT89_DISPOSABLE_DATABASE=1 only for a disposable test database and server.");
}
const { test, finish } = makeHarness("tt89-drill-db");
const partial = { "BK-05": "partial" } as const;
const run = randomBytes(5).toString("hex");
const now = "2026-10-01T12:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const file = (path: string, content: string, encoding: "utf8" | "base64" = "utf8", mime = "text/plain"): BackupEntry => ({ path, kind: "file", mime, encoding, content,
  size: encoding === "utf8" ? Buffer.byteLength(content) : Buffer.from(content, "base64").length, sha256: hash(content), tags: "test" });
const dir = (path: string): BackupEntry => ({ path, kind: "dir", mime: "inode/directory", encoding: "utf8", content: "", size: 0, sha256: hash(""), tags: "folder" });
const note = { title: `tt89-${run}`, body: "note café 😀", tags: "test", pinned: true, createdAt: now, updatedAt: now };
const data: BackupPayload = { version: BACKUP_VERSION, exportedAt: now, kind: "data", entries: [
  dir(`/tt89-${run}`), dir(`/tt89-${run}/empty`), file(`/tt89-${run}/unicode.txt`, "hello café 😀"),
  file(`/tt89-${run}/bytes.bin`, Buffer.from([0, 1, 2, 255]).toString("base64"), "base64", "application/octet-stream"),
  file(`/Private/opaque-${run}`, "opaque-ciphertext", "utf8", "application/x-fusion-encrypted"),
], notes: [note, note], settings: [] };
const config: BackupPayload = { version: BACKUP_VERSION, exportedAt: now, kind: "config", entries: [], notes: [], settings: [
  { key: "appearance.theme", value: "light" }, { key: "system.seedVersion", value: "ignored-locked" }, { key: `tt89.unknown.${run}`, value: "ignored-unknown" },
] };
const verified = async (payload: BackupPayload) => {
  const v = await verifyBackup(await makeBackup(payload));
  assert.equal(v.ok, true); if (!v.ok) throw new Error("bad test bundle"); return v;
};
const dv = await verified(data), cv = await verified(config);
const tables = ["vfs_nodes", "vfs_versions", "file_ops", "settings", "settings_history", "notes", "index_docs", "audit_log"];
const serial = tables.filter((name) => name !== "settings");
const causedBy = (pattern: RegExp) => (error: unknown) => {
  let current: any = error; const messages: string[] = [];
  for (let i = 0; i < 5 && current; i++, current = current.cause) messages.push(String(current.message ?? current));
  assert.match(messages.join("\n"), pattern); return true;
};
async function snapshot() {
  const out: Record<string, unknown> = {};
  for (const table of tables) {
    const column = table === "settings" ? "key" : "id";
    const r = await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY "${column}"), '[]'::jsonb)::text AS value FROM public."${table}" t`);
    out[table] = hash(r.rows[0].value);
  }
  for (const table of serial) {
    const r = await pool.query(`SELECT last_value::text, is_called FROM public."${table}_id_seq"`);
    out[`${table}_sequence`] = r.rows[0];
  }
  return out;
}

// Proxy a real checked-out client to inject one fault, preserving all other PostgreSQL I/O.
function faultSource(intercept: (text: string, call: () => Promise<any>, client: PoolClient) => Promise<any>, releases: boolean[]) {
  return { connect: async () => {
    const client = await pool.connect();
    return new Proxy(client, { get(target, property) {
      if (property === "query") return (...args: any[]) => {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text ?? "";
        return intercept(text, () => (target.query as any)(...args), target);
      };
      if (property === "release") return (discard?: boolean) => { releases.push(!!discard); target.release(discard); };
      const v = Reflect.get(target, property, target); return typeof v === "function" ? v.bind(target) : v;
    } }) as PoolClient;
  } } as Pick<Pool, "connect">;
}

try {
  // Bootstrap the app before measuring; its one-time seed and privacy cleanup are outside the drill.
  const res = await fetch((process.env.BASE ?? "http://localhost:3000") + "/api/features"); assert.equal(res.ok, true); await res.json();
  await test("scratch data drill restores Unicode, binary, empty folders, duplicate notes and private-index exclusion without touching production", partial, async () => {
    const before = await snapshot(); const result = await drillBackup(dv.payload, dv.digest); const after = await snapshot();
    assert.deepEqual(result.sampled, { files: 3, folders: 2, notes: 2, settings: 0 });
    assert.deepEqual(result.total, result.sampled); assert.equal(result.skippedSettings, 0); assert.deepEqual(after, before);
  });
  await test("config drill writes a sentinel then reads real values back; reports locked and unknown keys without changing settings or sequences", partial, async () => {
    const before = await snapshot(); const result = await drillBackup(cv.payload, cv.digest); const after = await snapshot();
    assert.equal(result.sampled.settings, 3); assert.equal(result.skippedSettings, 2); assert.deepEqual(after, before);
  });
  await test("empty backup and all-unknown configuration cannot become a successful drill", partial, async () => {
    const empty = await verified({ ...data, entries: [], notes: [] });
    await assert.rejects(() => drillBackup(empty.payload, empty.digest), /empty/);
    const unknown = await verified({ ...config, settings: [{ key: `missing.${run}`, value: "x" }] });
    const before = await snapshot();
    await assert.rejects(() => drillBackup(unknown.payload, unknown.digest), /None of the sampled settings/);
    assert.deepEqual(await snapshot(), before);
  });
  await test("invalid known setting aborts and preserves every public table and sequence", partial, async () => {
    const invalid = await verified({ ...config, settings: [{ key: "appearance.theme", value: "not-a-theme" }] });
    const before = await snapshot(); await assert.rejects(() => drillBackup(invalid.payload, invalid.digest), /Invalid setting/);
    assert.deepEqual(await snapshot(), before);
  });
  await test("an actual SQL fault after scratch file writes rolls back rather than reporting success", partial, async () => {
    let injected = 0; const releases: boolean[] = []; const before = await snapshot();
    const source = faultSource(async (text, call) => { if (/insert into "notes"/i.test(text)) { injected++; throw new Error("injected scratch failure"); } return call(); }, releases);
    await assert.rejects(() => drillBackup(dv.payload, dv.digest, source), causedBy(/injected scratch failure/));
    assert.equal(injected, 1); assert.deepEqual(releases, [false]); assert.deepEqual(await snapshot(), before);
  });
  await test("read-back is mandatory: suppressing actual scratch file rows makes the drill fail", partial, async () => {
    let altered = 0; const releases: boolean[] = []; const before = await snapshot();
    const source = faultSource(async (text, call) => {
      const result = await call();
      if (/^select .* from "vfs_nodes"$/i.test(text.trim())) { altered++; return { ...result, rows: [] }; }
      return result;
    }, releases);
    await assert.rejects(() => drillBackup(dv.payload, dv.digest, source), /read-back/);
    assert.equal(altered, 1); assert.deepEqual(await snapshot(), before);
  });
  await test("private-index leakage introduced in the scratch database is detected on read-back", partial, async () => {
    let injected = 0; const releases: boolean[] = []; const before = await snapshot();
    const source = faultSource(async (text, call, client) => {
      if (/^select .* from "index_docs"$/i.test(text.trim())) {
        injected++; await client.query("INSERT INTO pg_temp.index_docs (source, ref, title, body) VALUES ($1, $2, $3, $4)", ["file", `/Private/opaque-${run}`, "leaked", "sensitive"]);
      }
      return call();
    }, releases);
    await assert.rejects(() => drillBackup(dv.payload, dv.digest, source), /read-back/);
    assert.equal(injected, 1); assert.deepEqual(await snapshot(), before);
  });
  await test("an unshadowed relation is unavailable under the drill search path", partial, async () => {
    let reached = 0; const releases: boolean[] = []; const before = await snapshot();
    const source = faultSource(async (text, call, client) => {
      const r = await call(); if (/^SET LOCAL search_path/i.test(text.trim())) { reached++; await client.query("SELECT 1 FROM features LIMIT 1"); }
      return r;
    }, releases);
    await assert.rejects(() => drillBackup(dv.payload, dv.digest, source), causedBy(/relation.*features.*does not exist/i));
    assert.equal(reached, 1); assert.deepEqual(await snapshot(), before);
  });
  await test("lost rollback acknowledgement discards the client and never returns a successful drill", partial, async () => {
    let lost = 0; const releases: boolean[] = []; const before = await snapshot();
    const source = faultSource(async (text, call) => {
      const r = await call(); if (text === "ROLLBACK") { lost++; throw new Error("lost rollback acknowledgement"); } return r;
    }, releases);
    await assert.rejects(() => drillBackup(dv.payload, dv.digest, source), /lost rollback acknowledgement/);
    assert.equal(lost, 1); assert.deepEqual(releases, [true]); assert.deepEqual(await snapshot(), before);
  });
  await test("unexpected rollback command tag discards the client and cannot be reported as a pass", partial, async () => {
    let changed = 0; const releases: boolean[] = []; const before = await snapshot();
    const source = faultSource(async (text, call) => {
      const r = await call(); if (text === "ROLLBACK") { changed++; return { ...r, command: "COMMIT" }; } return r;
    }, releases);
    await assert.rejects(() => drillBackup(dv.payload, dv.digest, source), /did not confirm the rollback/);
    assert.equal(changed, 1); assert.deepEqual(releases, [true]); assert.deepEqual(await snapshot(), before);
  });
  await test("a single pooled PostgreSQL connection is reusable after success and failure without scratch tables or search-path leakage", partial, async () => {
    const isolated = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }); const before = await snapshot();
    try {
      const initial = await isolated.query("SHOW search_path");
      await drillBackup(dv.payload, dv.digest, isolated);
      const unknown = await verified({ ...config, settings: [{ key: `missing.${run}`, value: "x" }] });
      await assert.rejects(() => drillBackup(unknown.payload, unknown.digest, isolated), /None of the sampled settings/);
      await drillBackup(dv.payload, dv.digest, isolated);
      const check = await isolated.query("SELECT pg_catalog.to_regclass('pg_temp.vfs_nodes') AS nodes, pg_catalog.to_regclass('pg_temp.index_docs') AS idx, 1 AS usable");
      assert.deepEqual(check.rows[0], { nodes: null, idx: null, usable: 1 });
      assert.deepEqual((await isolated.query("SHOW search_path")).rows, initial.rows);
      assert.deepEqual(await snapshot(), before);
    } finally { await isolated.end(); }
  });
  await test("a pre-existing shadow table is refused instead of using an unknown scratch schema", partial, async () => {
    const isolated = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 }); const before = await snapshot();
    try {
      const c = await isolated.connect(); await c.query("CREATE TEMP TABLE vfs_nodes (unexpected integer)"); c.release();
      await assert.rejects(() => drillBackup(dv.payload, dv.digest, isolated), /isolated scratch tables/);
      assert.deepEqual(await snapshot(), before);
    } finally { await isolated.end(); }
  });
  await test("a real PostgreSQL role without TEMP privilege is refused, with public data unchanged", partial, async () => {
    const role = `tt89_notemp_${run}`; const releases: boolean[] = []; const before = await snapshot(); let reached = 0;
    const privilege = await pool.query(`SELECT quote_ident(datname) AS name, EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(datacl, acldefault('d', datdba))) a
      WHERE a.grantee = 0 AND a.privilege_type = 'TEMPORARY'
    ) AS public_temp FROM pg_database WHERE datname = current_database()`);
    const database = privilege.rows[0].name as string;
    const publicTemp = privilege.rows[0].public_temp as boolean;
    let createdRole = false;
    try {
      await pool.query(`CREATE ROLE "${role}" NOLOGIN`); createdRole = true;
      await pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await pool.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
      const source = faultSource(async (text, call, client) => {
        const r = await call(); if (/^BEGIN/.test(text)) { reached++; await client.query(`SET LOCAL ROLE "${role}"`); } return r;
      }, releases);
      await assert.rejects(() => drillBackup(cv.payload, cv.digest, source), causedBy(/permission denied.*(database|temporary)/i));
      assert.equal(reached, 1); assert.deepEqual(await snapshot(), before);
    } finally {
      if (publicTemp) await pool.query(`GRANT TEMPORARY ON DATABASE ${database} TO PUBLIC`);
      if (createdRole) { await pool.query(`DROP OWNED BY "${role}"`); await pool.query(`DROP ROLE "${role}"`); }
    }
  });
} finally { await pool.end(); }
finish();
