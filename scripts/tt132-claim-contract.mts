/** Isolated callback-exception contract, with an injected LockManager boundary.
 * This is NOT evidence of a real browser lock or OS notification. The real
 * cross-page Web Lock race remains in e2e-tt132-alarms.mts. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { claimAlarm } from "../src/lib/clock-alarm-claim.ts";

const { test, finish } = makeHarness("tt132-claim-contract");
const covers = { "CK-01": "partial" } as const;
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
function boundary(request: (...args: any[]) => Promise<unknown>) {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { locks: { request } }, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem() { throw new Error("injected storage denial"); } }, configurable: true });
}
try {
  await test("an exception after entering a claim callback is propagated, never retried outside the lock", covers, async () => {
    boundary(async (_name, callback) => callback()); let calls = 0;
    await assert.rejects(claimAlarm("claim-test", Date.now(), () => true, () => { calls++; throw new Error("delivery failed after entry"); }), /delivery failed after entry/);
    assert.equal(calls, 1, "retrying the callback would duplicate a partially completed delivery");
  });
  await test("a lock API failure before callback entry uses the fallback exactly once", covers, async () => {
    boundary(async () => { throw new Error("lock unavailable"); }); let calls = 0;
    const result = await claimAlarm("claim-test", Date.now(), () => true, () => { calls++; });
    assert.equal(result, true); assert.equal(calls, 1);
  });
  await test("a scheduling predicate exception is propagated without a second predicate evaluation", covers, async () => {
    boundary(async (_name, callback) => callback()); let predicates = 0, deliveries = 0;
    await assert.rejects(claimAlarm("claim-test", Date.now(), () => { predicates++; throw new Error("predicate failure"); }, () => { deliveries++; }), /predicate failure/);
    assert.equal(predicates, 1); assert.equal(deliveries, 0);
  });
} finally {
  for (const [key, descriptor] of [["window", windowDescriptor], ["navigator", navigatorDescriptor], ["localStorage", storageDescriptor]] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}
finish();
