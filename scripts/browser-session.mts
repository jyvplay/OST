/**
 * Suite "browser-session": src/lib/browserSession.ts (PR-07 tab/session model, TT16). Pure, headless.
 * Expected behaviour follows desktop browsers (Chrome/Edge/Firefox): pinned tabs sit left and survive batch close;
 * closing the active tab activates its neighbour; the HTML sandbox rule that same-origin + allow-scripts frames can
 * un-sandbox themselves motivates the self-origin URL refusal.
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import {
  activate, allowAttribute, batchClose, closeTab, createGroup, makeTab, normalizeSession, removeGroup, safeBrowserUrl, setGroup,
  sleepInactive, sleepTab, toggleCollapse, togglePin, visibleTabs, type Session,
} from "../src/lib/browserSession.ts";

const { test, finish } = makeHarness("browser-session");
const SELF = "http://localhost:3999";
const S = (urls: string[], active = 0): Session => { const tabs = urls.map((u, i) => makeTab(u, `t${i}`)); return { tabs, active: tabs[active].id, groups: [], perms: {} }; };
const ids = (s: Session) => s.tabs.map((t) => t.id);

await test("URL guard: http(s) only, bare hosts get https, credentials and own origin refused", { "PR-07": "partial", "PR-07l": "partial" }, () => {
  assert.equal(safeBrowserUrl("example.com/a b"), null, "whitespace");
  assert.equal(safeBrowserUrl("example.com/x"), "https://example.com/x");
  assert.equal(safeBrowserUrl("HTTP://Example.COM"), "http://example.com/");
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "file:///etc/passwd", "blob:http://x/1", "about:srcdoc", "https://bank.com@evil.example/", "https://user:pw@example.com", "", "http://", "vbscript:x"])
    assert.equal(safeBrowserUrl(bad), null, bad);
  assert.equal(safeBrowserUrl(`${SELF}/api/fs?op=raw&path=/x.html`, SELF), null, "same origin would escape the sandbox");
  assert.equal(safeBrowserUrl("http://localhost:4000/", SELF), "http://localhost:4000/", "other port = other origin");
});

await test("restore normalisation: hostile/invalid tabs dropped, groups/perms validated, active repaired, pinned first", { "PR-07": "full", "PR-07r": "partial" }, () => {
  const raw = {
    tabs: [
      { id: "a", url: "https://example.com", title: "A", group: "g1", pinned: false },
      { id: "b", url: "javascript:alert(1)" }, { id: "c", url: `${SELF}/api/fs?op=raw` }, { id: "a", url: "https://dup.example" },
      { id: "d", url: "https://wikipedia.org", pinned: true, group: "nope" }, { id: "<x>", url: "https://x.example" }, "junk",
    ],
    groups: [{ id: "g1", name: "Work", color: "red" }, { id: "bad id!", name: "x", color: "#123456" }],
    perms: { "example.com": ["camera", "usb", "geolocation"], "bad host/": ["camera"] }, active: "b",
  };
  const n = normalizeSession(raw, SELF);
  assert.deepEqual(ids(n), ["d", "a"]); assert.equal(n.dropped, 5); assert.equal(n.active, "d");
  assert.equal(n.groups.length, 1); assert.equal(n.groups[0].color, "#5b8cff", "invalid colour replaced");
  assert.equal(n.tabs.find((t) => t.id === "d")!.group, "", "unknown group cleared");
  assert.deepEqual(n.perms, { "example.com": ["camera", "geolocation"] });
  const empty = normalizeSession({ tabs: [{ id: "z", url: "javascript:x" }] }, SELF, "javascript:y");
  assert.equal(empty.tabs.length, 1); assert.equal(empty.tabs[0].url, "https://example.com/", "unsafe fallback replaced");
  assert.ok(normalizeSession({ tabs: Array.from({ length: 150 }, (_, i) => ({ id: `t${i}`, url: `https://e${i}.example` })) }).tabs.length === 100, "100-tab cap");
});

await test("close: active tab hands focus to its neighbour (regression: view went blank); last tab replaced", { "PR-07a": "partial" }, () => {
  const s = S(["https://a.example", "https://b.example", "https://c.example"], 1);
  const c = closeTab(s, "t1"); assert.deepEqual(ids(c), ["t0", "t2"]); assert.equal(c.active, "t2");
  assert.equal(closeTab(S(["https://a.example", "https://b.example"], 1), "t1").active, "t0");
  assert.equal(closeTab(s, "t0").active, "t1", "closing an inactive tab keeps focus");
  const one = closeTab(S(["https://a.example"]), "t0"); assert.equal(one.tabs.length, 1); assert.equal(one.active, one.tabs[0].id);
});

await test("batch actions: close others / to the right / duplicates keep pinned tabs and the anchor", { "PR-07q": "full" }, () => {
  let s = S(["https://a.example", "https://b.example", "https://a.example", "https://c.example", "https://b.example"], 4);
  s = togglePin(s, "t3"); assert.deepEqual(ids(s), ["t3", "t0", "t1", "t2", "t4"], "pinned moved left");
  const o = batchClose(s, "t1", "others"); assert.deepEqual(ids(o.session), ["t3", "t1"]); assert.equal(o.closed, 3); assert.equal(o.session.active, "t1");
  const r = batchClose(s, "t1", "right"); assert.deepEqual(ids(r.session), ["t3", "t0", "t1"]); assert.equal(r.session.active, "t1", "active t4 closed → anchor");
  const d = batchClose(s, "t0", "duplicates"); assert.deepEqual(ids(d.session), ["t3", "t0", "t1"]); assert.equal(d.closed, 2);
  assert.equal(d.session.active, "t0", "active t4 (dup of b) closed → focus goes to the anchor, as with 'right'");
});

await test("pin, groups (create/assign/collapse/remove), search, sleep invariants, allow attribute", { "PR-07c": "full", "PR-07f": "full", "PR-07g": "full", "PR-07b": "partial", "PR-07l": "full" }, () => {
  let s = S(["https://a.example", "https://b.example", "https://news.example/x", "https://d.example"], 0);
  s = createGroup(s, "t1", "  Research  "); assert.equal(s.groups[0].name, "Research"); assert.equal(s.tabs[1].group, "g1");
  s = setGroup(s, "t2", "g1"); s = setGroup(s, "t3", "missing"); assert.equal(s.tabs[3].group, "");
  s = toggleCollapse(s, "g1"); assert.deepEqual(visibleTabs(s).map((t) => t.id), ["t0", "t3"], "collapsed group hidden");
  s = activate(s, "t2"); assert.deepEqual(visibleTabs(s).map((t) => t.id), ["t0", "t2", "t3"], "active tab stays visible");
  assert.deepEqual(visibleTabs(s, "NEWS").map((t) => t.id), ["t2"], "search ignores collapse");
  s = removeGroup(s, "g1"); assert.equal(s.groups.length, 0); assert.equal(s.tabs.length, 4, "ungroup never closes");
  s = togglePin(s, "t3");
  assert.equal(sleepTab(s, "t2", null), s, "active never sleeps"); assert.equal(sleepTab(s, "t3", null), s, "pinned never sleeps");
  assert.equal(sleepTab(s, "t0", "t0"), s, "split partner never sleeps");
  const sl = sleepInactive(s, null); assert.equal(sl.slept, 2); assert.deepEqual(sl.session.tabs.filter((t) => t.asleep).map((t) => t.id).sort(), ["t0", "t1"]);
  assert.equal(activate(sl.session, "t0").tabs.find((t) => t.id === "t0")!.asleep, false, "activating wakes");
  const allow = allowAttribute({ "a.example": ["camera"] }, "https://a.example/page");
  assert.match(allow, /camera https:\/\/a\.example;/); assert.match(allow, /microphone 'none'/); assert.match(allowAttribute({}, "https://b.example"), /^camera 'none'; microphone 'none'/);
});
finish();
