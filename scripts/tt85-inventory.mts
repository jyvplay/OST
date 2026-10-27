import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { BACKGROUND_JOBS, getBackgroundInventory, recordBackgroundCallback, subscribeBackgroundInventory, updateBackgroundStatus } from "../src/lib/background-inventory.ts";

const { test, finish } = makeHarness("tt85-inventory");

await test("AP-05: inventory definitions are unique and explicitly describe only app-owned foreground work", { "AP-05": "full" }, () => {
  const ids = BACKGROUND_JOBS.map((job) => job.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["planner-reminders", "routine-triggers", "offline-replay"]);
  assert.ok(BACKGROUND_JOBS.every((job) => /page|foreground/i.test(`${job.scope} ${job.trigger}`)));
  assert.ok(BACKGROUND_JOBS.every((job) => !/all apps|OS wake/i.test(job.scope)));
});

await test("AP-05: only real callback entry increments count; status updates do not invent callbacks; snapshots are detached", { "AP-05": "full" }, () => {
  const before = getBackgroundInventory().find((job) => job.id === "planner-reminders")!;
  const staleCopy = getBackgroundInventory();
  recordBackgroundCallback("planner-reminders", "test callback");
  updateBackgroundStatus("planner-reminders", "completed with a redacted count");
  const after = getBackgroundInventory().find((job) => job.id === "planner-reminders")!;
  assert.equal(after.callbacks, before.callbacks + 1);
  assert.equal(after.lastStatus, "completed with a redacted count");
  staleCopy.find((job) => job.id === "planner-reminders")!.callbacks = 9000;
  assert.equal(getBackgroundInventory().find((job) => job.id === "planner-reminders")!.callbacks, after.callbacks);
  recordBackgroundCallback("unknown-job" as never, "ignored");
});

await test("AP-05: observers receive bounded snapshots and unsubscribe prevents later notifications", { "AP-05": "full" }, () => {
  const received: number[] = [];
  const off = subscribeBackgroundInventory((jobs) => received.push(jobs.find((job) => job.id === "offline-replay")!.callbacks));
  const start = getBackgroundInventory().find((job) => job.id === "offline-replay")!.callbacks;
  recordBackgroundCallback("offline-replay", "online event");
  off();
  recordBackgroundCallback("offline-replay", "second event");
  assert.deepEqual(received, [start + 1]);
  const job = getBackgroundInventory().find((x) => x.id === "offline-replay")!;
  assert.equal(job.callbacks, start + 2);
});

await test("AP-05: status text is bounded and records do not persist or expose payload fields", { "AP-05": "full" }, () => {
  updateBackgroundStatus("routine-triggers", "x".repeat(1000));
  const job = getBackgroundInventory().find((x) => x.id === "routine-triggers")!;
  assert.equal(job.lastStatus.length, 240);
  assert.equal(job.callbacks, 0);
  assert.equal(typeof job.lastAt, "number", "status timestamp is in-memory and not a persisted counter");
  assert.deepEqual(Object.keys(job).sort(), ["callbacks", "data", "id", "lastAt", "lastStatus", "scope", "title", "trigger"].sort());
});

finish();
