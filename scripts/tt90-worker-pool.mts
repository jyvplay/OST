import assert from "node:assert/strict";
import { ThumbnailWorkerPool, WorkerUnavailable, thumbnailWorkerLimit } from "../src/lib/thumbs/worker-pool.ts";
import { makeHarness } from "./harness.mts";

type Request = { token: string };
type Reply = { id: number; value: string };
class FakeWorker {
  onmessage: ((e: MessageEvent<Reply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: { id: number; token: string }[] = [];
  terminated = false;
  failPost = false;
  postMessage(v: { id: number; token: string }) { if (this.failPost) throw new Error("DataCloneError"); this.sent.push(v); }
  terminate() { this.terminated = true; }
  reply(id: number, value: string) { this.onmessage?.({ data: { id, value } } as MessageEvent<Reply>); }
  crash() { this.onerror?.({ preventDefault() {} } as ErrorEvent); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setup = (limit = 2, idle = 1000, timeout = 1000, maxPending = 64) => {
  const made: FakeWorker[] = [];
  const pool = new ThumbnailWorkerPool<Request, Reply>(() => { const w = new FakeWorker(); made.push(w); return w as unknown as Worker; }, limit, idle, timeout, maxPending);
  return { made, pool };
};
const { test, finish } = makeHarness("tt90-worker-pool");
const cov = { "FF-13": "partial" } as const; // canonical HW-02 is Android ADPF, not a browser worker pool
await test("CPU and low-memory caps are conservative and malformed pool limits are rejected", cov, () => {
  assert.equal(thumbnailWorkerLimit(undefined), 1); assert.equal(thumbnailWorkerLimit(1), 1);
  assert.equal(thumbnailWorkerLimit(2), 1); assert.equal(thumbnailWorkerLimit(3), 2);
  assert.equal(thumbnailWorkerLimit(512), 2); assert.equal(thumbnailWorkerLimit(NaN), 1);
  assert.equal(thumbnailWorkerLimit(16, 4), 1); assert.equal(thumbnailWorkerLimit(16, 8), 2);
  for (const limit of [0, -1, 1.5, 3, NaN]) assert.throws(() => setup(limit));
});
await test("lazy pool bounds parallelism, ignores wrong IDs and schedules queued jobs FIFO", cov, async () => {
  const { made, pool } = setup();
  try {
    assert.equal(made.length, 0);
    const one = pool.run({ token: "one" }); const two = pool.run({ token: "two" }); const three = pool.run({ token: "three" }); const four = pool.run({ token: "four" });
    for (const p of [one, two, three, four]) void p.catch(() => {}); // cleanup still settles pending work if an assertion fails
    assert.deepEqual(pool.stats(), { workers: 2, busy: 2, queued: 2, capacity: 2 });
    made[0].reply(999, "wrong"); assert.equal(pool.stats().queued, 2);
    made[0].reply(made[0].sent[0].id, "first");
    assert.equal(made[0].sent[1].token, "three");
    made[1].reply(made[1].sent[0].id, "second"); assert.equal(made[1].sent[1].token, "four");
    made[0].reply(made[0].sent[1].id, "third"); made[1].reply(made[1].sent[1].id, "fourth");
    assert.deepEqual((await Promise.all([one, two, three, four])).map((r) => r.value), ["first", "second", "third", "fourth"]);
    assert.equal(pool.stats().busy, 0);
  } finally { pool.close(); }
});
await test("completed workers are reused then actually terminated after idle", cov, async () => {
  const { made, pool } = setup(1, 35, 1000);
  try {
    const one = pool.run({ token: "one" }); made[0].reply(made[0].sent[0].id, "1"); await one;
    const two = pool.run({ token: "two" }); assert.equal(made.length, 1); made[0].reply(made[0].sent[1].id, "2"); await two;
    await sleep(65); assert.equal(made[0].terminated, true); assert.equal(pool.stats().workers, 0);
    const three = pool.run({ token: "three" }); assert.equal(made.length, 2); made[1].reply(made[1].sent[0].id, "3"); await three;
  } finally { pool.close(); }
});
await test("deadline kills a hung worker and a later queued job proceeds on a new worker", cov, async () => {
  const { made, pool } = setup(1, 1000, 80);
  try {
    const bad = pool.run({ token: "hang" }); const badResult = assert.rejects(bad, /timed out/);
    await sleep(35); const next = pool.run({ token: "next" });
    await badResult; assert.equal(made[0].terminated, true); assert.equal(made.length, 2);
    assert.equal(made[1].sent[0].token, "next"); made[1].reply(made[1].sent[0].id, "ok"); assert.equal((await next).value, "ok");
  } finally { pool.close(); }
});
await test("a deadline also removes a waiting job, even if the worker never answers", cov, async () => {
  const { made, pool } = setup(1, 1000, 40);
  try {
    const one = assert.rejects(pool.run({ token: "hang" }), /timed out/);
    const two = assert.rejects(pool.run({ token: "queued" }), /timed out/);
    await Promise.all([one, two]); assert.equal(pool.stats().queued, 0); assert.ok(made.every((w) => w.terminated));
  } finally { pool.close(); }
});
await test("crash, unreadable reply and postMessage failure release capacity without losing subsequent jobs", cov, async () => {
  const { made, pool } = setup(1);
  try {
    const a = assert.rejects(pool.run({ token: "crash" }), /crashed/); made[0].crash(); await a;
    const b = assert.rejects(pool.run({ token: "message" }), /could not be read/); made[1].onmessageerror?.(); await b;
    const c = pool.run({ token: "ok" }); made[2].reply(made[2].sent[0].id, "ok"); assert.equal((await c).value, "ok");
    made[2].failPost = true; await assert.rejects(pool.run({ token: "clone failure" }), /could not receive/);
    const d = pool.run({ token: "after" }); made[3].reply(made[3].sent[0].id, "after"); assert.equal((await d).value, "after");
    assert.ok(made.slice(0, 3).every((w) => w.terminated));
  } finally { pool.close(); }
});
await test("worker startup failure is distinguished for fallback; partial capacity remains usable", cov, async () => {
  const failed = new ThumbnailWorkerPool<Request, Reply>(() => { throw new Error("denied"); }, 1);
  await assert.rejects(failed.run({ token: "x" }), WorkerUnavailable); await assert.rejects(failed.run({ token: "y" }), WorkerUnavailable); failed.close();
  const w = new FakeWorker(); let calls = 0;
  const pool = new ThumbnailWorkerPool<Request, Reply>(() => { if (++calls > 1) throw new Error("too many"); return w as unknown as Worker; }, 2);
  try {
    const one = pool.run({ token: "one" }); const two = pool.run({ token: "two" });
    assert.equal(pool.stats().capacity, 1); w.reply(w.sent[0].id, "one");
    assert.equal(w.sent[1].token, "two"); w.reply(w.sent[1].id, "two"); await Promise.all([one, two]);
  } finally { pool.close(); }
});
await test("cancellation removes queued work, terminates only its active worker, and does not cancel another job", cov, async () => {
  const { made, pool } = setup(2); const first = new AbortController(); const queued = new AbortController();
  try {
    const a = assert.rejects(pool.run({ token: "private" }, first.signal), /cancelled/);
    const b = pool.run({ token: "public" });
    const c = assert.rejects(pool.run({ token: "queued" }, queued.signal), /cancelled/);
    queued.abort(); assert.equal(pool.stats().queued, 0); first.abort(); await Promise.all([a, c]);
    assert.equal(made[0].terminated, true); assert.equal(made[1].terminated, false);
    made[1].reply(made[1].sent[0].id, "public"); assert.equal((await b).value, "public");
    await assert.rejects(pool.run({ token: "already" }, first.signal), /cancelled/);
    const d = pool.run({ token: "new" }); made[1].reply(made[1].sent[1].id, "new"); assert.equal((await d).value, "new");
  } finally { pool.close(); }
});
await test("queue limit and close settle every promise and never dispatch post-close work", cov, async () => {
  const { made, pool } = setup(1, 1000, 1000, 1);
  const one = assert.rejects(pool.run({ token: "one" }), /closed/); const two = assert.rejects(pool.run({ token: "two" }), /closed/);
  await assert.rejects(pool.run({ token: "third" }), /queue full/);
  pool.close(); pool.close(); await Promise.all([one, two]); assert.equal(made[0].terminated, true);
  assert.equal(made[0].sent.length, 1); await assert.rejects(pool.run({ token: "late" }), /closed/);
});
finish();
