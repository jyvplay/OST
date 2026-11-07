#!/usr/bin/env node
/**
 * TT139 — one command that makes this checkout testable on a bare sandbox.
 *
 * Why this exists: the browser and the database are the two things every
 * browser/HTTP suite needs, and in this sandbox neither is installed by the
 * image (`apt-get install libnss3` has no network route; there is no postgres
 * package at all). Before this script each session re-derived the same recovery
 * by hand. This script does it once, idempotently, and prints a receipt of what
 * it actually found or produced.
 *
 * What it does, in order, and nothing more:
 *   1. Chromium: asks @sparticuz/chromium (installed in TOOLS_DIR, outside the
 *      app's dependencies) for its packed binary. That package decompresses a
 *      Chromium build plus the exact NSS/NSPR/libexpat shared objects it links
 *      against into /tmp. We then run the binary and fail loudly if it cannot
 *      start — "unpacked" is not "runnable".
 *   2. PostgreSQL: initialises a cluster under .cache/pg (git-ignored), starts
 *      it on a free loopback port, creates the application database, and writes
 *      .cache/pg/env with DATABASE_URL so later commands do not guess.
 *   3. Prints one JSON receipt: paths, versions, ports, and what was skipped
 *      because it was already present.
 *
 * Honest limits: this is a *test* environment bootstrap. It is not a production
 * deployment, it does not harden PostgreSQL (trust auth on loopback, disposable
 * data), and the Chromium build comes from a test-only dependency, not from the
 * app's runtime dependencies.
 *
 * Usage:
 *   node scripts/env-bootstrap.mjs              # prepare everything, keep it running
 *   node scripts/env-bootstrap.mjs --json       # same, machine-readable only
 *   node scripts/env-bootstrap.mjs --check      # verify, never install
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
const CACHE = join(ROOT, ".cache");
const PG_ROOT = join(CACHE, "pg");
const PG_DATA = join(PG_ROOT, "data");
const PG_LOG = join(PG_ROOT, "server.log");
const PG_ENV = join(PG_ROOT, "env");
const CHROMIUM = process.env.PW_CHROMIUM ?? "/tmp/chromium";
const PREFERRED_PG_PORT = Number(process.env.OST_PG_PORT ?? 5599);
const DB_NAME = process.env.OST_DB_NAME ?? "ost_gate";
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const JSON_ONLY = args.has("--json");
const log = (...a) => { if (!JSON_ONLY) console.log(...a); };
const receipt = { at: new Date().toISOString(), steps: [], ok: false };

function step(name, status, detail) {
  receipt.steps.push({ name, status, detail });
  log(`${status === "ok" ? "✓" : status === "skip" ? "•" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. PostgreSQL binaries ────────────────────────────────────────────────────
const pgBinDir = (() => {
  const candidates = [
    process.env.PG_BIN,
    join(TOOLS, "node_modules/@embedded-postgres/linux-x64/native/bin"),
    "/usr/lib/postgresql/16/bin",
    "/usr/lib/postgresql/15/bin",
    "/usr/lib/postgresql/17/bin",
    "/usr/lib/postgresql/18/bin",
    "",
  ].filter((p) => p !== undefined && p !== null);
  for (const dir of candidates) {
    const initdb = dir ? join(dir, "initdb") : "initdb";
    const probe = spawnSync(initdb, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return dir;
  }
  return null;
})();

function pgBin(name) {
  return pgBinDir ? join(pgBinDir, name) : name;
}

// ── 2. Chromium ──────────────────────────────────────────────────────────────
async function ensureChromium() {
  if (existsSync(CHROMIUM)) {
    const v = spawnSync(CHROMIUM, ["--version"], { encoding: "utf8", env: { ...process.env, LD_LIBRARY_PATH: libPath() } });
    if (v.status === 0) return step("chromium", "skip", `${CHROMIUM} (${v.stdout.trim()})`);
  }
  if (CHECK_ONLY) return step("chromium", "fail", `missing ${CHROMIUM} (--check does not install)`);
  let req;
  try {
    req = createRequire(join(TOOLS, "package.json"));
    req.resolve("@sparticuz/chromium");
  } catch {
    return step("chromium", "fail", `@sparticuz/chromium is not installed under ${TOOLS}; run: (cd ${TOOLS} && npm i @sparticuz/chromium)`);
  }
  // The package only unpacks its NSS/NSPR/libexpat bundle when it believes it is
  // running on Lambda; that bundle is exactly what a bare Debian image is missing.
  process.env.AWS_EXECUTION_ENV ??= "AWS_Lambda_nodejs22.x";
  const mod = req("@sparticuz/chromium");
  const sp = mod.default ?? mod;
  const path = await sp.executablePath();
  const check = spawnSync(path, ["--version"], { encoding: "utf8", env: { ...process.env, LD_LIBRARY_PATH: libPath() } });
  if (check.status !== 0) return step("chromium", "fail", `unpacked but not runnable: ${check.stderr?.slice(0, 300)}`);
  return step("chromium", "ok", `${path} (${check.stdout.trim()})`);
}

function libPath() {
  return ["/tmp/al2023/lib", "/tmp", process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(":");
}

// ── 3. PostgreSQL cluster ────────────────────────────────────────────────────
function freePort(from) {
  return new Promise((res, rej) => {
    const tryPort = (port) => {
      const srv = createServer();
      srv.once("error", () => (port > from + 40 ? rej(new Error("no free port")) : tryPort(port + 1)));
      srv.once("listening", () => srv.close(() => res(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryPort(from);
  });
}

function pgIsRunning(port) {
  const out = spawnSync(pgBin("pg_ctl"), ["-D", PG_DATA, "status"], { encoding: "utf8" });
  if (out.status !== 0) return false;
  const r = spawnSync(process.execPath, [
    "-e",
    `const {Client}=require(${JSON.stringify(join(ROOT, "node_modules/pg"))});` +
      `const c=new Client({connectionString:"postgresql://postgres@127.0.0.1:${port}/postgres"});` +
      `c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));`,
  ], { encoding: "utf8" });
  return r.status === 0;
}

async function ensurePostgres() {
  if (!pgBinDir) {
    step("postgres", "fail", "no initdb/pg_ctl found; install a PostgreSQL server or @embedded-postgres/linux-x64 under TOOLS_DIR");
    return null;
  }
  const version = spawnSync(pgBin("postgres"), ["--version"], { encoding: "utf8" }).stdout?.trim();
  if (!existsSync(join(PG_DATA, "PG_VERSION"))) {
    if (CHECK_ONLY) return step("postgres", "fail", `no cluster at ${PG_DATA}`), null;
    mkdirSync(PG_ROOT, { recursive: true });
    const init = spawnSync(pgBin("initdb"), ["-D", PG_DATA, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { encoding: "utf8" });
    if (init.status !== 0) return step("postgres", "fail", `initdb: ${(init.stderr || init.stdout).slice(0, 400)}`), null;
    step("postgres", "ok", `initialised ${PG_DATA}`);
  } else {
    step("postgres", "skip", `cluster already at ${PG_DATA}`);
  }
  // Reuse a recorded port so a running cluster and the receipts stay consistent.
  let port = PREFERRED_PG_PORT;
  if (existsSync(PG_ENV)) {
    const rec = readFileSync(PG_ENV, "utf8").match(/OST_PG_PORT=(\d+)/);
    if (rec) port = Number(rec[1]);
  }
  let running = pgIsRunning(port);
  if (!running && !CHECK_ONLY) {
    port = await freePort(port);
    const start = spawnSync(pgBin("pg_ctl"), [
      "-D", PG_DATA, "-l", PG_LOG, "-w", "-t", "30",
      "-o", `-p ${port} -k ${PG_ROOT} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c synchronous_commit=off`,
      "start",
    ], { encoding: "utf8" });
    if (start.status !== 0) return step("postgres", "fail", `pg_ctl start: ${(start.stderr || start.stdout).slice(0, 400)}`), null;
    running = pgIsRunning(port);
  }
  if (!running) return step("postgres", "fail", `cluster exists but is not answering on 127.0.0.1:${port}${CHECK_ONLY ? " (--check)" : ""}`), null;

  // Create the application database through the driver we actually ship with.
  const { Client } = createRequire(join(ROOT, "package.json"))("pg");
  const admin = new Client({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres` });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname=$1", [DB_NAME]);
  if (!exists.rowCount && !CHECK_ONLY) await admin.query(`create database "${DB_NAME}"`);
  await admin.end();

  const url = `postgresql://postgres@127.0.0.1:${port}/${DB_NAME}`;
  if (!CHECK_ONLY) writeFileSync(PG_ENV, `OST_PG_PORT=${port}\nDATABASE_URL=${url}\n`);
  const v = await (async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    const q = await c.query("select version() as v, current_database() as d");
    await c.end();
    return q.rows[0];
  })();
  step("postgres", "ok", `${version}; db=${v.d} port=${port}`);
  return url;
}

// ── main ─────────────────────────────────────────────────────────────────────
const chrom = await ensureChromium();
const databaseUrl = await ensurePostgres();
receipt.chromium = { executable: CHROMIUM, ldLibraryPath: libPath(), present: existsSync(CHROMIUM) };
receipt.databaseUrl = databaseUrl ?? null;
receipt.ok = existsSync(CHROMIUM) && Boolean(databaseUrl);
receipt.runtime = { node: process.version, cpus: os.availableParallelism(), ramBytes: os.totalmem() };
if (!CHECK_ONLY) {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(join(CACHE, "env-receipt.json"), JSON.stringify(receipt, null, 2));
}
if (JSON_ONLY) console.log(JSON.stringify(receipt, null, 2));
else {
  log("");
  log(receipt.ok
    ? `ready — export DATABASE_URL="${databaseUrl}"  and run: BASE=http://127.0.0.1:3000 npm run test:gate`
    : "not ready — see the ✗ lines above");
  log(`receipt: ${join(CACHE, "env-receipt.json")}`);
}
process.exitCode = receipt.ok ? 0 : 1;
