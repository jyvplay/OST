/** Targeted fault injection for explicit amnesic boot when localStorage is
 * inaccessible. This is an isolated document double, not a browser/OS test. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { privacy } from "../src/lib/privacy/session.ts";

const { test, finish } = makeHarness("tt130-privacy-boot");
await test("explicit amnesic boot remains fail-closed when localStorage access throws", { "SC-11": "partial" }, async () => {
  const sent: string[] = [];
  class StorageStub {
    getItem(_key: string): string | null { return null; }
    setItem(_key: string, _value: string) {}
    removeItem(_key: string) {}
    clear() {}
  }
  const target = globalThis as unknown as { window: unknown; Storage: unknown };
  target.Storage = StorageStub;
  target.window = {
    location: { search: "?amnesia=1", origin: "https://example.test" },
    get localStorage(): never { throw new DOMException("storage denied", "SecurityError"); },
    addEventListener() {},
    fetch: async (url: string, init?: RequestInit) => {
      sent.push(`${init?.method ?? "GET"} ${url}`);
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    },
  };
  privacy.install();
  assert.equal(privacy.status().amnesic, true, "storage failure must not override an explicit amnesia request");
  // Invoke the installed guard over the in-memory stub above; this process has
  // no real window, browser, server connection or network fetch.
  const guarded = (target.window as { fetch: typeof fetch }).fetch;
  const response = await guarded("/api/notes", { method: "POST", body: JSON.stringify({ title: "private" }) });
  assert.equal(response.status, 423, "host-persisting writes must be refused");
  assert.equal(sent.some((entry) => entry === "POST /api/notes"), false, "the denied write must not reach the host fetch");
});
finish();
