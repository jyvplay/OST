import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt92-ledger-audit"), BASE = process.env.BASE ?? "http://localhost:3000";
const response = await fetch(`${BASE}/api/features`); assert.equal(response.status, 200);
const { rows } = await response.json() as { rows: { code: string; tier: string; status: string; route: string; nuance: string; test: string }[] };
const find = (code: string) => { const row = rows.find((r) => r.code === code); assert.ok(row, `missing ${code}`); return row; };
await test("FM-03 reports bounded database-atomic transfers, not a complete native tier-B spec", { "FM-03": "partial" }, () => {
  const r = find("FM-03"); assert.equal(r.tier, "B"); assert.equal(r.status, "partial"); assert.match(r.nuance, /one PostgreSQL transaction/); assert.match(r.nuance, /cooperative tree gate/); assert.match(r.nuance, /no external temp\/reopen verification/); assert.match(r.nuance, /sidecar trash\/restore\/purge remain separate best-effort/);
});
await test("FM-18 explicitly disclaims the missing native SAF and temp-reopen safe-save contract", { "FM-18": "partial" }, () => {
  const r = find("FM-18"); assert.equal(r.tier, "A"); assert.equal(r.status, "partial"); assert.match(r.nuance, /no \/api\/fs safeSave operation/i); assert.match(r.nuance, /SAF.*not implemented/i);
});
await test("FM-11 states manual retention, legacy ambiguity and noncooperating mutation paths", { "FM-11": "partial" }, () => {
  const r = find("FM-11"); assert.equal(r.tier, "B"); assert.equal(r.status, "partial"); assert.match(r.nuance, /null group.*ambiguous/); assert.match(r.nuance, /Retention is manual/); assert.match(r.nuance, /not secure erasure/);
});
await test("the editor does not advertise its database version snapshots as native SAF safe-save", { "PR-01": "partial" }, () => {
  const r = find("PR-01"); assert.equal(r.status, "partial"); assert.match(r.route, /transactional database writes/); assert.match(r.nuance, /does not implement.*SAF/);
});
await test("MD-03 does not claim native MediaStore, universal HEIC or atomic sidecar follow", { "MD-03": "partial" }, () => {
  const r = find("MD-03"); assert.equal(r.tier, "A"); assert.equal(r.status, "partial"); assert.match(r.nuance, /Trash\/restore\/purge sidecar follow is still best-effort and not atomic/); assert.match(r.nuance, /does not integrate Android MediaStore/); assert.match(r.nuance, /HEIC.*unavailable/i);
});
await test("the web-only offline queue is partial and discloses storage and cross-tab limits", { "SH-14": "partial" }, () => {
  const r = find("SH-14"); assert.equal(r.status, "partial"); assert.match(r.route, /Web-only extension/); assert.match(r.nuance, /without Web Locks, older tabs and direct storage edits do not share that coordination/); assert.match(r.nuance, /lost acknowledgement can cause duplicate work/);
});
await test("Photos owner checks are cooperative and explicitly exclude Private and RAM", { "MD-03": "partial" }, () => {
  const r = find("MD-03"); assert.match(r.nuance, /optional for older callers/); assert.match(r.nuance, /Private\/RAM/); assert.match(r.test, /e2e-tt94-photos-offline/);
});
finish();
