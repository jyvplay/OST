/**
 * TT142 platform suite — desktop identity (DP-03 / DP-04).
 *
 * Two halves, and the second half is the point of the first:
 *
 *  · the pure resolver: the shared desktop is the default, a named desktop is an
 *    opt-in link, a typo is reported instead of silently opening something else,
 *    and reserved names cannot be repurposed;
 *  · the live proof, in a real browser: `?desk=` really changes the row the server
 *    renders, two named desktops do not see each other's windows, the shared row
 *    still does, and a stale revision cannot clobber a newer desktop.
 *
 * A per-browser identity was built earlier this turn and reverted (see
 * src/proxy.ts); the tests below are shaped so that a future attempt has to keep
 * every one of these properties, including the shared-row ones it would break.
 */
import { makeHarness } from "./harness.mts";
import { chooseDesktopId, isValidDesktopId, shareLink, describeSource, shortDesktopId, DEFAULT_DESKTOP_ID, RESERVED_DESKTOP_IDS } from "../src/lib/desktop-id.ts";
import { sharedChromium, releaseSharedChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const { test, finish } = makeHarness("tt142-platform");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const throws = (fn: () => unknown, m: string) => { try { fn(); } catch { return; } throw new Error(`expected a refusal: ${m}`); };

const named = (n: number) => `tt142-${n}`;

await test("DP-03 · no name means the shared desktop, so every screen shows one desktop", { "DP-03": "full" }, () => {
  // The premise of the app: a display host and a laptop are projections of ONE
  // desktop. A per-browser default would break that, and did (measured: 184
  // fixtures plus every multi-screen case). Absence of a name must therefore mean
  // the shared row, never a minted one.
  const plain = chooseDesktopId({});
  eq(plain.id, DEFAULT_DESKTOP_ID, "the default is the shared row");
  eq(plain.source, "default", "and is labelled as shared");
  eq(plain.warning, null, "nothing to warn about");
  eq(chooseDesktopId({ param: null }).id, DEFAULT_DESKTOP_ID, "an absent parameter is not a name");
  eq(chooseDesktopId({ param: "" }).id, DEFAULT_DESKTOP_ID, "an empty parameter is not a name");
  eq(chooseDesktopId({ param: "   " }).id, DEFAULT_DESKTOP_ID, "a blank parameter is not a name");
});

await test("DP-03 · a named desktop is opt-in, valid, and openly shared", { "DP-03": "full" }, () => {
  const withName = chooseDesktopId({ param: "work" });
  eq(withName.id, "work", "the link's name is honoured");
  eq(withName.source, "named", "and is labelled as link-provided");
  eq(chooseDesktopId({ param: "  work  " }).id, "work", "surrounding space is trimmed, not rejected");
  ok(describeSource("named").includes("anyone with the link"), "the disclosure is about the link");
  ok(describeSource("default").includes("other screens"), "and the shared case says it is on the other screens");
  // Two different names are two different rows — the whole point of the feature.
  ok(chooseDesktopId({ param: named(1) }).id !== chooseDesktopId({ param: named(2) }).id, "two names, two desktops");
});

await test("DP-03 · an unusable name is reported, and the reserved rows cannot be taken", { "DP-03": "full" }, () => {
  const bad = chooseDesktopId({ param: "Not A Name!" });
  eq(bad.id, DEFAULT_DESKTOP_ID, "falls back to the shared desktop");
  eq(bad.source, "default", "and is labelled as shared");
  ok(!!bad.warning && bad.warning.includes("not a usable desktop name"), "the typo is surfaced, not swallowed");
  ok(bad.warning!.length < 240, "the warning stays one sentence even for a pathological input");
  const long = chooseDesktopId({ param: "x".repeat(400) });
  ok(long.warning!.length < 240, "a 400-character name does not become a 400-character toast");
  ok(long.warning!.includes("…"), "a long name is elided rather than echoed whole");
  // `default` is shared: a link must not be able to rename it into a private row.
  eq(chooseDesktopId({ param: DEFAULT_DESKTOP_ID }).source, "default", "“default” is not a nameable desktop");
  for (const reserved of RESERVED_DESKTOP_IDS) {
    eq(chooseDesktopId({ param: reserved }).source, "default", `“${reserved}” is a projection host, not a desktop`);
  }
  for (const tooShort of ["", "a", "ab", "d-"]) eq(isValidDesktopId(tooShort), false, `“${tooShort}” is too short`);
  for (const fine of ["abc", "work", "team-2026", "w".repeat(48)]) eq(isValidDesktopId(fine), true, `“${fine}” is usable`);
  eq(isValidDesktopId("w".repeat(49)), false, "48 characters is the limit, 49 is not");
  for (const badShape of ["UPPER", "has space", "trailing-", "-lead", "under_score", "dot.dot"]) eq(isValidDesktopId(badShape), false, `“${badShape}” has the wrong shape`);
});

await test("DP-03 · a share link is a real URL that refuses to be built for a bad name", { "DP-03": "full" }, () => {
  const link = shareLink("https://fusion.example/", "work");
  eq(new URL(link).searchParams.get("desk"), "work", "the link carries the name");
  ok(link.startsWith("https://fusion.example/?"), "and keeps the origin it was given");
  throws(() => shareLink("https://fusion.example/", "Not A Name"), "an unusable name cannot become a link");
  throws(() => shareLink("https://fusion.example/", DEFAULT_DESKTOP_ID), "the shared desktop needs no link");
  // Round trip: the link the settings surface copies is the link the page reads.
  eq(chooseDesktopId({ param: new URL(link).searchParams.get("desk") }).id, "work", "link → resolve round trip");
  eq(shortDesktopId("tt142-alphabet"), "…alphabet", "the short form is the discriminating tail");
  eq(shortDesktopId("work"), "work", "a short name is shown whole");
  eq(shortDesktopId("a".repeat(40)).length, 9, "a long name is reduced to an ellipsis plus eight characters");
});

await test("DP-03 · live: ?desk= changes the row the server renders, before the first paint", { "DP-03": "full" }, async () => {
  const browser = await sharedChromium();
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    const res = await page.goto(`${BASE}/?desk=${named(9)}`, { waitUntil: "domcontentloaded" });
    ok(res && res.ok(), `shell did not load: ${res?.status()}`);
    // The label is server-rendered: it is in the HTML response, not added by an
    // effect, which is what makes "before the first paint" testable at all.
    eq(await page.locator("[data-desktop-id]").first().getAttribute("data-desktop-id"), named(9), "the named desktop is what rendered");
    eq(await page.locator("[data-desktop-id]").first().getAttribute("data-desktop-source"), "named", "and it says it came from a link");
    const html = await res!.text();
    ok(html.includes(`data-desktop-id="${named(9)}"`), "the name is in the server HTML, not patched in on the client");
    // A bad name renders the shared desktop AND says so in the toast.
    const p2 = await ctx.newPage();
    await p2.goto(`${BASE}/?desk=NOT%20A%20NAME`, { waitUntil: "domcontentloaded" });
    eq(await p2.locator("[data-desktop-id]").first().getAttribute("data-desktop-id"), DEFAULT_DESKTOP_ID, "a bad name falls back to the shared desktop");
    await p2.getByText(/not a usable desktop name/).first().waitFor({ timeout: 20_000 });
  } finally { await ctx.close(); }
});

await test("DP-04 · live: two named desktops are isolated, and a stale revision cannot win", { "DP-04": "full" }, async () => {
  const browser = await sharedChromium();
  const ctx = await browser.newContext();
  try {
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    const nameA = named(11);
    const nameB = named(12);
    await Promise.all([
      a.goto(`${BASE}/?desk=${nameA}`, { waitUntil: "domcontentloaded" }),
      b.goto(`${BASE}/?desk=${nameB}`, { waitUntil: "domcontentloaded" }),
    ]);
    eq(await a.locator("[data-desktop-id]").first().getAttribute("data-desktop-id"), nameA, "A is on its named desktop");
    eq(await b.locator("[data-desktop-id]").first().getAttribute("data-desktop-id"), nameB, "B is on a different one");

    const rev = 7001;
    const desktop = (moduleId: string, title: string) => ({
      windows: [{ id: `w-${moduleId}`, module: moduleId, title, x: 20, y: 20, w: 900, h: 600, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} }],
      focus: `w-${moduleId}`, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20,
      viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev,
    });
    const put = await a.request.put(`${BASE}/api/state`, {
      headers: { "content-type": "application/json", origin: BASE },
      data: { id: nameA, revision: rev, state: desktop("notes", "Notes") },
    });
    ok(put.ok(), `state write into A failed: ${put.status()}`);
    eq((await put.json()).revision, rev, "A's write was accepted at the revision it claimed");

    // A sees its own window; B, reloaded after A's write, still does not.
    await a.reload({ waitUntil: "domcontentloaded" });
    await a.getByRole("dialog", { name: "Notes", exact: true }).last().waitFor({ timeout: 30_000 });
    await b.reload({ waitUntil: "domcontentloaded" });
    await b.waitForTimeout(1500);
    eq(await b.getByRole("dialog", { name: "Notes", exact: true }).count(), 0, "B rendered the window A wrote");
    const rowB = await b.request.get(`${BASE}/api/state?id=${nameB}`);
    const stateB = (await rowB.json()).row?.state ?? {};
    ok(!(stateB.windows ?? []).some((w: { module?: string }) => w.module === "notes" && stateB.revision === rev), "B's stored row took A's desktop");

    // Optimistic concurrency: an older revision is refused, not applied.
    const stale = await a.request.put(`${BASE}/api/state`, {
      headers: { "content-type": "application/json", origin: BASE },
      data: { id: nameA, revision: rev - 5, state: desktop("editor", "Editor") },
    });
    eq(stale.status(), 409, "a stale write is refused with 409");
    const rowA = await (await a.request.get(`${BASE}/api/state?id=${nameA}`)).json();
    eq(rowA.row?.revision, rev, "the newer revision survived");
    ok((rowA.row?.state?.windows ?? []).every((w: { module?: string }) => w.module === "notes"), "and the older desktop did not replace it");
  } finally { await ctx.close(); await releaseSharedChromium(); }
});

finish();
