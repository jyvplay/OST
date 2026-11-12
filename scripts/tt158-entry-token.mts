import assert from "node:assert/strict";
import { issueToken, redeemToken } from "../src/lib/automation-entry.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt158-entry-token");
await test("presented secret and routine binding precede one-time consumption", {}, () => {
  const t = issueToken("42", 1000, 10000);
  assert.equal(redeemToken(t, "wrong", "42", 1001).ok, false, "wrong secret");
  assert.equal(t.used, false, "bad secret must not consume the token");
  assert.equal(redeemToken(t, t.value, "43", 1001).ok, false, "wrong routine");
  assert.equal(t.used, false);
  assert.equal(redeemToken(t, t.value, "42", 1001).ok, true);
  assert.equal(redeemToken(t, t.value, "42", 1002).ok, false, "replay must fail");
  const boundary = issueToken("42", 1000, 10000);
  assert.equal(redeemToken(boundary, boundary.value, "42", boundary.expiresAt).ok, false, "expiry is exclusive");
  assert.equal(redeemToken(undefined, "", "42", 1000).ok, false);
  const corrupt = issueToken("42", 1000, NaN);
  assert.equal(redeemToken(corrupt, corrupt.value, "42", 1001).ok, false, "non-finite expiry fails closed");
});
finish();
