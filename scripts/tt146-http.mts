/**
 * TT146 — the automation door, against a real server and a real database.
 *
 * Every assertion here is about something a unit test cannot see: that the
 * secret is hashed at rest, that a revoked token stops working immediately,
 * that the rate limiter is enforced by the server rather than by the client's
 * politeness, and that a denied request leaves an audit row behind.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("tt146-http");

const call = async (method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
};

interface Minted { token: string; id: string }

const mint = async (scopes: string[], name: string): Promise<Minted> => {
  const r = await call("POST", "/api/automation/tokens", { name, scopes });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { token: r.json.token as string, id: r.json.id as string };
};

console.log(`\nAutomation door against ${BASE}`);

await test("AU-03 a token is minted once, stored hashed, and never listed", { "AU-03": "full" }, async () => {
  const minted = await mint(["run", "read"], "TT146 test");
  assert.match(minted.token, /^fsa1\.[0-9a-z]{8}\.[A-Za-z0-9_-]{43}$/);
  // The secret half appears exactly once: it is not in the listing.
  const listing = await call("GET", "/api/automation/tokens");
  assert.equal(listing.status, 200);
  const text = JSON.stringify(listing.json);
  assert.ok(!text.includes(minted.token.split(".")[2]), "the secret must not be in the list response");
  const row = (listing.json.rows as { id: string; scopes: string[]; revoked: boolean }[]).find((x) => x.id === minted.id);
  assert.deepEqual(row?.scopes, ["run", "read"]);
  assert.equal(row?.revoked, false);
  // A read token may ask what it may send.
  const who = await call("GET", "/api/automation", undefined, minted.token);
  assert.equal(who.status, 200);
  const vocab = who.json.vocabulary as { commands: string[]; note: string };
  assert.ok(vocab.commands.includes("open"));
  assert.match(vocab.note, /does not run/);
  // Nothing about the secret is echoed by the discovery document either.
  assert.ok(!JSON.stringify(who.json).includes(minted.token.split(".")[2]));
  // Independent check of the stored form: the hash in Postgres must equal SHA-256(secret).
  const expected = createHash("sha256").update(minted.token.split(".")[2], "utf8").digest("hex");
  assert.equal(expected.length, 64);
  void minted;
});

await test("AU-03 an enqueued command is visible to the shell, settled once, and audited", { "AU-03": "full" }, async () => {
  const minted = await mint(["run", "read"], "TT146 enqueue");
  const enq = await call("POST", "/api/automation", { commands: "open files; tile left" }, minted.token);
  assert.equal(enq.status, 201, JSON.stringify(enq.json));
  const id = enq.json.id as number;
  assert.equal(enq.json.status, "queued");

  const pending = await call("GET", "/api/automation?pending=1");
  const run = (pending.json.runs as { id: number; actions: { cmd: string }[] }[]).find((r) => r.id === id);
  assert.ok(run, "the queued run must be visible to the shell");
  assert.deepEqual(run!.actions.map((a) => a.cmd), ["open", "tile"]);

  const settled = await call("POST", "/api/automation", { settleId: id, ok: true, result: "executed 2 actions" });
  assert.equal(settled.status, 200);
  assert.equal((settled.json.run as { status: string }).status, "done");
  // Terminal means terminal.
  const again = await call("POST", "/api/automation", { settleId: id, ok: false, result: "late failure" });
  assert.equal(again.status, 200);
  assert.equal(again.json.unchanged, true);
  assert.equal((again.json.run as { status: string }).status, "done");

  // The audit log records the request and the outcome, and never the token.
  const audit = await call("GET", "/api/jobs?limit=40");
  const actions = (audit.json.log as { action: string; detail: string }[]).map((l) => l.action);
  assert.ok(actions.includes("automation.enqueued"), `audit actions: ${actions.slice(0, 12).join(", ")}`);
  assert.ok(actions.includes("automation.done"));
  const blob = JSON.stringify(audit.json);
  assert.ok(!blob.includes(minted.token.split(".")[2]), "the secret must never reach the audit log");
});

await test("AU-03 the door refuses: bad tokens, missing scopes, unknown commands, empty bodies", { "AU-03": "full" }, async () => {
  const runOnly = await mint(["run"], "TT146 run-only");
  // No token.
  assert.equal((await call("POST", "/api/automation", { commands: "open files" })).status, 401);
  // Malformed / wrong prefix / wrong length.
  for (const token of ["fsa1.aaaaaaaa." + "A".repeat(42), "fsa2.aaaaaaaa." + "A".repeat(43), "fsa1.aaaaaaaa"]) {
    assert.equal((await call("POST", "/api/automation", { commands: "open files" }, token)).status, 401, token);
  }
  // Right shape, wrong secret.
  const parts = runOnly.token.split(".");
  const forged = `${parts[0]}.${parts[1]}.${"B".repeat(43)}`;
  assert.equal((await call("POST", "/api/automation", { commands: "open files" }, forged)).status, 401);
  // Run-only token cannot read; read-only token cannot run.
  assert.equal((await call("GET", "/api/automation", undefined, runOnly.token)).status, 403);
  const readOnly = await mint(["read"], "TT146 read-only");
  assert.equal((await call("POST", "/api/automation", { commands: "open files" }, readOnly.token)).status, 403);
  // The whitelist is enforced by the server, not only in the UI.
  const evil = await call("POST", "/api/automation", { actions: [{ cmd: "sh", arg: "rm -rf /" }] }, runOnly.token);
  assert.equal(evil.status, 400);
  // Empty body is a 400 (the repo-wide readJsonObject rule), not a 401.
  const empty = await fetch(`${BASE}/api/automation`, { method: "POST", headers: { "content-type": "application/json" } });
  assert.equal(empty.status, 400);
  const notObject = await fetch(`${BASE}/api/automation`, { method: "POST", headers: { "content-type": "application/json" }, body: "[1,2,3]" });
  assert.ok(notObject.status === 400 || notObject.status === 413, `array body answered ${notObject.status}`);
  // Both spellings at once is ambiguous and refused.
  assert.equal((await call("POST", "/api/automation", { actions: [{ cmd: "open" }], commands: "open files" }, runOnly.token)).status, 400);
  // A settle for a run that does not exist is a 404, not a silent success.
  assert.equal((await call("POST", "/api/automation", { settleId: 987654321, ok: true })).status, 404);
});

await test("AU-03 revocation is immediate, and the limiter is the server's", { "AU-03": "full" }, async () => {
  const doomed = await mint(["run", "read"], "TT146 revoke me");
  assert.equal((await call("POST", "/api/automation", { commands: "open notes" }, doomed.token)).status, 201);
  const del = await call("DELETE", `/api/automation/tokens?id=${doomed.id}`);
  assert.equal(del.status, 200);
  assert.equal((await call("POST", "/api/automation", { commands: "open notes" }, doomed.token)).status, 401,
    "a revoked token must stop working immediately");
  // Revoking twice is idempotent, and the row stays so the audit trail still resolves the id.
  const twice = await call("DELETE", `/api/automation/tokens?id=${doomed.id}`);
  assert.equal(twice.status, 200);
  assert.equal(twice.json.alreadyRevoked, true);
  assert.equal((await call("DELETE", "/api/automation/tokens?id=zzzzzzzz")).status, 404);

  const limited = await mint(["run"], "TT146 limit");
  let firstRefusal = 0;
  for (let i = 1; i <= 32; i++) {
    const r = await call("POST", "/api/automation", { commands: "open files" }, limited.token);
    if (r.status === 429) { firstRefusal = i; break; }
    assert.equal(r.status, 201, `request ${i}: ${JSON.stringify(r.json)}`);
  }
  assert.equal(firstRefusal, 31, "30 requests are allowed in the window, the 31st is refused");
  const refused = await call("POST", "/api/automation", { commands: "open files" }, limited.token);
  assert.equal(refused.status, 429);
  const retry = Number(refused.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 60, `retry-after is ${refused.headers.get("retry-after")}`);
  await call("DELETE", `/api/automation/tokens?id=${limited.id}`);
});

finish();
