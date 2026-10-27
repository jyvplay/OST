import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeHarness } from "./harness.mts";
import { encodeTarget, UA, upstreamHeaders } from "../src/lib/wp-core.ts";
import {
  clearUaOverride, createSession, dropSession, normalizeUaSite, publicStats,
  setUaOverride, uaForSite, uaOverrideForSite, WP_MAX_UA_OVERRIDES,
} from "../src/lib/server/wp-sessions.ts";

const { test, finish } = makeHarness("tt85-identity");

await test("PR-07h: a session defaults to Desktop, applies only the selected host override within that session, can clear one override, and accepts URL-derived hosts", { "PR-07h": "full" }, () => {
  const session = createSession();
  const isolated = createSession();
  try {
    assert.equal(uaForSite(session, "pypi.org"), "desktop");
    assert.equal(uaOverrideForSite(session, "pypi.org"), null);
    assert.equal(normalizeUaSite("PYPI.ORG"), "pypi.org");
    assert.equal(normalizeUaSite("pypi.org:443"), "pypi.org", "default HTTPS port canonicalizes to the same site");
    assert.equal(uaForSite(session, new URL("https://pypi.org/sponsors/")), "desktop");

    assert.equal(setUaOverride(session, "pypi.org", "mobile"), true);
    assert.equal(uaForSite(session, "pypi.org"), "mobile");
    assert.equal(uaForSite(isolated, "pypi.org"), "desktop", "another RAM-only session must not inherit this host override");
    assert.equal(uaForSite(session, "registry.npmjs.org"), "desktop", "a host override must not become a session-wide identity");
    assert.equal(uaOverrideForSite(session, "pypi.org"), "mobile");
    assert.equal(setUaOverride(session, "registry.npmjs.org", "desktop"), true);
    assert.equal(uaForSite(session, "registry.npmjs.org"), "desktop");
    assert.equal(uaOverrideForSite(session, "registry.npmjs.org"), "desktop", "an explicit Desktop choice is distinct from no override");

    assert.equal(clearUaOverride(session, "pypi.org"), true);
    assert.equal(uaForSite(session, "pypi.org"), "desktop");
    assert.equal(uaForSite(session, "registry.npmjs.org"), "desktop");
    assert.equal(uaOverrideForSite(session, "registry.npmjs.org"), "desktop", "clearing one host leaves another host's choice intact");
  } finally { dropSession(session.sid); dropSession(isolated.sid); }
});

await test("PR-07h: malformed site keys and identity values are rejected without growing the override map", { "PR-07h": "full" }, () => {
  const session = createSession();
  try {
    for (const bad of ["", " pypi.org", "pypi.org ", "pypi.org/path", "pypi.org?x=1", "pypi.org#fragment", "user@pypi.org", "https://pypi.org", "pypi.org\\\\evil", "x".repeat(301)]) {
      assert.equal(normalizeUaSite(bad), null, `site should be refused: ${JSON.stringify(bad)}`);
      assert.equal(setUaOverride(session, bad, "mobile"), false, `override should be refused: ${JSON.stringify(bad)}`);
    }
    assert.equal(setUaOverride(session, "pypi.org", "tablet"), false);
    assert.equal(setUaOverride(session, "pypi.org", true), false);
    assert.equal(session.uaOverrides.size, 0);
  } finally { dropSession(session.sid); }
});

await test("PR-07h: override storage is capped at 64 hosts and evicts the oldest entry", { "PR-07h": "full" }, () => {
  const session = createSession();
  try {
    for (let i = 0; i < WP_MAX_UA_OVERRIDES + 4; i++) assert.equal(setUaOverride(session, `site-${i}.example`, i % 2 ? "mobile" : "desktop"), true);
    assert.equal(session.uaOverrides.size, WP_MAX_UA_OVERRIDES);
    assert.equal(uaOverrideForSite(session, "site-0.example"), null);
    assert.equal(uaOverrideForSite(session, "site-3.example"), null);
    assert.equal(uaOverrideForSite(session, "site-4.example"), "desktop");
    assert.equal(uaOverrideForSite(session, `site-${WP_MAX_UA_OVERRIDES + 3}.example`), "mobile");
  } finally { dropSession(session.sid); }
});

await test("PR-07h: upstream header builder uses the selected host identity, overwrites spoofed UA/client hints, and public stats do not disclose the full override map", { "PR-07h": "full" }, () => {
  const session = createSession();
  try {
    setUaOverride(session, "pypi.org", "mobile");
    const incoming: [string, string][] = [["user-agent", "attacker-controlled"], ["sec-ch-ua", "fingerprint"], ["accept-language", "de-CH"]];
    const target = new URL("https://pypi.org/project/requests/");
    const chosen = upstreamHeaders(incoming, target, { ua: uaForSite(session, target.host), cookie: "", method: "GET" });
    assert.equal(chosen["user-agent"], UA.mobile);
    assert.equal(chosen["accept-language"], "en-US,en;q=0.9");
    assert.equal("sec-ch-ua" in chosen, false);
    const other = upstreamHeaders(incoming, new URL("https://registry.npmjs.org/@playwright/test"), { ua: uaForSite(session, "registry.npmjs.org"), cookie: "", method: "GET" });
    assert.equal(other["user-agent"], UA.desktop);
    const siteStats = publicStats(session, "pypi.org");
    assert.equal(siteStats.ua, "mobile");
    assert.equal(siteStats.uaOverride, "mobile");
    assert.equal("uaOverrides" in siteStats, false);
    const generalStats = publicStats(session);
    assert.equal("uaOverride" in generalStats, false);
    assert.equal("uaOverrides" in generalStats, false);
  } finally { dropSession(session.sid); }
});

await test("PR-07h: real HTTP proxy route sends the target host's selected UA upstream and keeps the session default for a different host", { "PR-07h": "full" }, async () => {
  const echo = () => createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ua: req.headers["user-agent"] ?? null, secCh: req.headers["sec-ch-ua"] ?? null }));
  });
  const a = echo(), b = echo();
  const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const close = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve) => server.close(() => resolve()));
  const p1 = await listen(a), p2 = await listen(b);
  const session = createSession("mobile");
  const priorAllowlist = process.env.FUSION_WP_TEST_LOOPBACK_PORTS;
  process.env.FUSION_WP_TEST_LOOPBACK_PORTS = `${p1},${p2}`;
  let dropPools: ((sid: string) => void) | undefined;
  try {
    const route = await import("../src/app/api/wp/s/[sid]/[...rest]/route.ts");
    const { NextRequest } = await import("next/server.js");
    ({ dropPools } = await import("../src/lib/server/wp-connect.ts"));
    assert.equal(setUaOverride(session, `127.0.0.1:${p1}`, "desktop"), true);
    const through = async (port: number) => {
      const path = encodeTarget(`http://127.0.0.1:${port}/ua`, session.sid);
      assert.ok(path);
      const req = new NextRequest(new URL(path, "http://localhost:3999"), { headers: { "user-agent": "caller-browser", "sec-ch-ua": "caller-client-hint" } });
      const response = await route.GET(req);
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as { ua: string | null; secCh: string | null };
    };
    const selected = await through(p1), inherited = await through(p2);
    assert.deepEqual(selected, { ua: UA.desktop, secCh: null }, "the real upstream request must receive the selected host preset and no client hints");
    assert.deepEqual(inherited, { ua: UA.mobile, secCh: null }, "a different host must inherit the session default, not p1's override or the caller's headers");
  } finally {
    dropPools?.(session.sid);
    dropSession(session.sid);
    if (priorAllowlist === undefined) delete process.env.FUSION_WP_TEST_LOOPBACK_PORTS;
    else process.env.FUSION_WP_TEST_LOOPBACK_PORTS = priorAllowlist;
    await Promise.all([close(a), close(b)]);
  }
});

finish();
