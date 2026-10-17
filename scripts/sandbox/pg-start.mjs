// Start a throwaway local PostgreSQL for dev/test in a sandbox without a system Postgres.
// Uses the real PostgreSQL binaries shipped in the `@embedded-postgres/linux-x64` npm package (installed into
// TOOLS_DIR by scripts/sandbox/bootstrap.sh). We drive initdb/postgres directly rather than the package's
// wrapper class, which failed in this sandbox (TT2x notes). Idempotent: if the port answers, it does nothing.
//
//   node scripts/sandbox/pg-start.mjs        → postgres on 127.0.0.1:5432, user/password postgres, db app_db
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, openSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";

const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
const DATA = process.env.PGDATA_DIR ?? path.join(TOOLS, "pgdata");
const PORT = Number(process.env.PGPORT ?? 5432);
const pkgDir = path.join(TOOLS, "node_modules", "@embedded-postgres", "linux-x64");
const bin = (n) => path.join(pkgDir, "native", "bin", n);
const env = { ...process.env, LD_LIBRARY_PATH: [path.join(pkgDir, "native", "lib"), process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(":") };

const listening = () => new Promise((res) => { const s = connect(PORT, "127.0.0.1", () => { s.end(); res(true); }); s.on("error", () => res(false)); });

if (await listening()) { console.log(`postgres already listening on ${PORT}`); process.exit(0); }
for (const n of ["initdb", "postgres"]) if (!existsSync(bin(n))) throw new Error(`missing ${bin(n)} — run scripts/sandbox/bootstrap.sh`);
spawnSync("chmod", ["+x", ...["initdb", "postgres", "pg_ctl"].map(bin)]);

if (!existsSync(path.join(DATA, "PG_VERSION"))) {
  mkdirSync(DATA, { recursive: true });
  const pw = path.join(TOOLS, ".pgpw"); writeFileSync(pw, "postgres\n");
  const r = spawnSync(bin("initdb"), ["-D", DATA, "-U", "postgres", "--pwfile", pw, "-A", "md5", "-E", "UTF8", "--locale=C"], { env, stdio: "inherit" });
  if (r.status !== 0) throw new Error("initdb failed");
  // The package ships no psql, so create the app database in single-user mode before the server starts.
  const c = spawnSync(bin("postgres"), ["--single", "-D", DATA, "postgres"], { env, input: "CREATE DATABASE app_db;\n", encoding: "utf8" });
  if (c.status !== 0) throw new Error("create database failed: " + c.stderr);
}
const log = openSync(path.join(TOOLS, "postgres.log"), "a");
const child = spawn(bin("postgres"), ["-D", DATA, "-p", String(PORT), "-k", "/tmp", "-c", "listen_addresses=127.0.0.1,::1"], { env, detached: true, stdio: ["ignore", log, log] });
child.unref();
for (let i = 0; i < 60 && !(await listening()); i++) await new Promise((r) => setTimeout(r, 250));
if (!(await listening())) throw new Error("postgres did not start; see " + path.join(TOOLS, "postgres.log"));
console.log(`postgres pid ${child.pid} on 127.0.0.1:${PORT}, db app_db (data ${DATA})`);
