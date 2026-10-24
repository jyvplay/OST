# TT43: cross-tab SharedWorker, `import(x)` + newline + `{`, concurrent session minting

TT42 left a list of blockers. TT43 closed these two with original code:
- **WP-22 (new): cross-tab SharedWorker.** In TT42 a proxied page's SharedWorker was shared only within that one page. Now every tab and nested frame of the same site in the same private-browser profile reaches **one** worker, as in a normal browser.
- **WP-20 upgrade: `import(x)` + newline + `{`.** This shape (a call, then a block by ASI) is now wrapped wherever only a statement can stand. In TT42 it was skipped because, by tokens alone, it looks like a method named `import`.

Found and fixed along the way: tabs of one profile that mounted at the same time minted **separate proxy sessions**, so their cookie jars split. Details are in G.

Prior art was read for ideas only. Ultraviolet and Scramjet are AGPL, so no code was taken. es-module-lexer (MIT) was already studied in TT41. Nothing was copied.

## Runtime honesty

**What ran,** all in the Arena Linux sandbox:
- Node 22.22.3 and Next 16.2.6: production builds, :3999 for the suite, and a private `next start` on :3994 for e2e-tt43.
- Playwright 1.64.1 with headless Chromium. Chromium's **own** SharedWorker (two native browser contexts on a local site) is the oracle for every WP-22 value.
- acorn 8 (test-only, from the repo's node_modules) as the lexer oracle, over 21 adversarial shapes and 12,443 real files.

**Network:** every "site" is a local HTTP server on 127.0.0.1:42881, allowed through the proxy's loopback guard only by the test variable `FUSION_WP_TEST_LOOPBACK_PORTS`.

**Not available, so not tested:**
- **Firefox and Safari/WebKit.** This was measured again: cdn.playwright.dev, playwright.azureedge.net, ftp.mozilla.org and GitHub release assets are all blocked. No second engine could be obtained.
- Real phones; Windows, macOS, GNOME and KDE desktops.
- A real public website. Only pypi.org is reachable, and it serves no SharedWorker.

## A. Formal model

**Broker state,** kept in the Fusion window (`SharedBroker`, DOM-free so it can be unit-tested):
- `who(sid, doc) → {origin, xs} | null` is the server's record of a document: its site, and whether any frame ancestor is cross-site. It is asked once per document and cached.
- `hostKey = sid ⏎ origin ⏎ (xs ? "d:" + doc : "")`. There is one hidden host document per host key.
- `wkey = scriptURL ⏎ name ⏎ type`. There is one worker per (hostKey, wkey), and it lives in the host document.
- A connection is `{id, src (the page's window), hostKey, wkey}`. Its id is chosen by the page and is unique per window.

**Connect(page P, id, sid, doc, url, name, type, port)** is accepted iff **all** of these hold:
1. the sender is an opaque-origin document (origin "null");
2. `who(sid, doc)` exists;
3. `url` is http(s) with the same origin as `who.origin`;
4. `type ∈ {classic, module}` and the id is well formed;
5. a port was transferred.

On acceptance, the port is forwarded to the host as soon as the host is ready, preserving order within a document. Otherwise P gets `{error}`, the port is closed, and nothing is framed.

**Liveness.** A connection is released when **any** of these happens:
- its window is closed;
- its window answers a ping with an `alive` list that omits its id, meaning the window's current document doesn't own it, i.e. the page navigated;
- its window misses `MISSED = 3` consecutive pings (sweep every 1.5 s);
- the page sends `bye` for it (a fast path, not relied on).

A host with no connections is told to end its workers after a 1 s grace and is then removed. A reconnect inside the grace keeps the same worker.

**Native semantics matched** (HTML: SharedWorker constructor, "permissible worker"; Storage partitioning):
- same (storage key, URL, name) gives the same global;
- a different type for the same name gives an error;
- another site's script throws SecurityError;
- a bad URL throws SyntaxError;
- a failed fetch fires an `error` event;
- the worker lives while any owner document is active.

**Lexer: member contexts.** The tokenizer keeps a stack parallel to its brace stack. Each `{` is classified as one of:
- **class:** the first `{` at the paren/brace depth recorded at a `class` keyword. A `class` followed by punctuation other than `{` is a property name, and its record is dropped.
- **obj:** the existing expression-brace rule, or `export default {`.
- **body:** a block, or a function/method/arrow body.
- **tmpl:** a `${`.

An `import(…)` call followed by `{` counts as a **call** only if the innermost context is `body` or top level. Anywhere else it counts as a method, which was TT42's behaviour.

## B. Hypotheses

**H+ (should hold, tested):**
- Two tabs of one profile, plus their nested same-site frames, share one worker: count and connection numbers continue across them.
- Another profile gets its own worker.
- All of these values are identical to native: `self.name`, `self.location`, the worker's cookies, a second named worker, SecurityError, SyntaxError, and the error event.

**H− (must not hold, tested):**
- A forged document id gets a worker.
- Another site's script gets a worker.
- A page reads `__shared-who`.
- A page mints a host through `__shared-host`.
- A window releases another window's connections.
- A forged nonce changes anything.
- The lexer wraps a method named `import`.

**H∂ (partial, disclosed):**
- Third-party contexts are partitioned per document, which is stricter than Chromium's per-top-site partition.
- State ends when the Fusion window closes or the last tab of the site unmounts. Inactive Fusion tabs unmount.
- Release takes up to about 1.5 s + 1 s grace after navigation. A window whose runtime is gone takes up to about 6 s.
- A block right after a label or `case x:` colon is still taken for an object literal, so it stays unwrapped (conservative).

## C. Frontier (now possible that was not)

- Cross-tab SharedWorker inside opaque-origin (sandboxed) proxied documents, where a native SharedWorker cannot be constructed at all.
- Statement-level `import(x)`↵`{` is routed through the proxy instead of falling back to the root import map.

## D. Negative shapes (≥ 15) and the modal-shortcut test

**Tested to fail, or to stay unaffected:**
1. connect from a non-opaque sender, which is ignored;
2. an unknown (sid, doc), which gets an error and its port closed;
3. an evicted document id;
4. another site's script URL;
5. a bad id;
6. a bad type;
7. a missing port;
8. a bye from another window;
9. a bye that overtakes its own connect, which cancels it;
10. an `alive` with a forged nonce;
11. an `alive` with the right nonce from another window;
12. a host message from an unknown host key;
13. a page fetch of `__shared-who`, which is a network error, and the server returns 403 for `Origin: null` or a cross-site Fetch Metadata request;
14. a page fetch of `__shared-host`, likewise;
15. a cross-site framed document joining a first-party worker;
16. a module type and a classic type of one name sharing a worker;
17. a method named `import` in an object, a class declaration, a class expression, `export default {`, or a class with heritage;
18. getters and setters named `import`;
19. `{ class: 1 }` followed by a class;
20. a `class()` method whose body contains the ASI shape.

**Modal-shortcut failure test.** The shortcut is to "trust what the page says". If the broker had believed the page's own claim of its site (mutant *trust-page-claim*) or skipped the site check (mutant *no-site-check*), forged connects would have succeeded. Both mutants were killed.

The second shortcut is "release on pagehide". It failed for real: Chromium did not deliver the message, the host was never removed, and e2e lifecycle went red. That forced the acknowledgement design (see I).

## E. Mechanism-distinct approaches considered

1. **Native SharedWorker from the opaque page.** Impossible: an opaque origin throws SecurityError. Rejected.
2. **A Fusion-origin SharedWorker running the site's code.** That would give site code Fusion's origin and storage. A security break, rejected.
3. **A server-side worker (run the script in Node).** That would mean a different engine and no DOM-less parity (fetch, cookies, timing). Too heavy, rejected.
4. **BroadcastChannel between per-page workers.** That gives many globals, not one, so counts diverge. Not SharedWorker semantics, rejected.
5. **A hidden host document per (session, site), brokered by the Fusion window, with ports transferred end to end.** **Chosen.**
6. **A Service Worker as the broker.** It can't reach opaque clients' ports reliably, and that would mean adding an SW lifecycle. Rejected.

**Lexer approaches:**
- (a) Full parse (acorn): adds weight and was rejected again for the lightweight constraint.
- (b) Newline heuristic only: wraps methods spanning lines, so it's unsafe.
- (c) **Member-context stack: chosen.**

## F. Artifacts

| Kind | Files |
|---|---|
| New source | `src/lib/wp-shared-broker.ts`, `src/db/seed-data/features-tt43.ts` |
| Changed source | `public/wp-shim.js`, the proxy route (`__shared-who` and `__shared-host`), `src/components/modules/ProxyFrame.tsx` (broker start and session-minting de-duplication), `src/lib/js-imports.ts` |
| Tests | `scripts/tt43-unit.mts` (7), `scripts/e2e-tt43.mts` (3); tt42-unit updated (its pinned "not wrapped" assertion became "wrapped at statement level, method untouched") |

## G. Adversary findings (this turn)

- **Concurrent session minting (a real bug, pre-existing since TT36).** Two tabs of one profile mounting together each POSTed `/api/wp-session`, so one profile got two cookie jars. TT36's test opened tabs one after another and missed it. Fixed with in-flight de-duplication per profile key. A mutant that removed the de-duplication was killed; it reproduced the exact signature, cookies "a" vs "b" and 3 hosts instead of 2.
- **Unload messages are unreliable.** Measured: after P3 navigated, its three page connections stayed registered, so its `bye` was not processed. Only its nested frame's connection went, through the closed-window sweep. The root cause inside Chromium was not isolated. The design no longer depends on it.
- **Endpoint probing from a page.** A fetch to the broker's endpoints is a network error (no ACAO), and the server independently returns 403 for opaque or cross-site callers. Both were checked.

## H. External verification

- **Chromium's own SharedWorker** gave every observable value; the proxied path matched it exactly, in e2e-tt43's oracle test.
- **acorn** checked 21 adversarial shapes exactly. Over 12,443 real files: dynwrap-diff 0 missing, 0 extra, 0 reparse failures; js-imports-diff 12,443/12,443 agree.
- **Not externally verified:** Firefox and WebKit SharedWorker behaviour (unobtainable).

## I. Repair, then a new attack against the repair

**Repair 1, liveness:** release by acknowledgement replaced reliance on pagehide.

The new attacks on it, each a unit test:
- a navigated window's new document answers without the old ids, so they are released immediately;
- a busy page misses one ping and keeps its worker;
- a silent window is dropped after exactly 3 missed pings;
- a forged nonce, or the right nonce from another window, changes nothing;
- the dropped window's host is removed after the grace, while the other host is kept.

**Mutants killed:** *alive-release-off* (unit) and *no-partition* (unit).

**Repair 2, lexer:** the member-context stack.

The attacks on it:
- `class` as a property name and as a method name;
- `export default {`;
- heritage containing braces;
- template substitutions;
- getters and setters.

**Mutants killed** (all in tt43-unit): *always-call*, *no-export-default*, *no-class-decl*, *no-class-propname*.

**Build-level mutants killed** (e2e-tt43):
- *broker never started*: the pages fall back to per-page workers (conns 1, still functional, but not shared);
- *session de-duplication off*.

**Residual:** `class A extends {} {}` would be misread (heritage object literal). Natively it throws a TypeError at class evaluation anyway.

## J. Stopping

I stopped because the two targeted blockers are closed and verified against external oracles, each new mechanism has killed mutants (10 in total), and the full suite was run.

**Not reached** (listed in the PR body):
- inline modules in a script-set srcdoc;
- eval/new Function rewriting;
- srcdoc parent access (fundamental);
- QUIC (Node 22 has no QUIC API);
- Windows/macOS DHCP;
- a second browser engine.

## Results (this turn)

**Full run** (80 suites; clean production build 9LsgJSH8Z3S-RnKSwqWnV on :3999): **718/718 on the first pass**, and the server's uncaught-error log stayed empty.

**Ledger:** 718/718, 368 rows, built 285/62/21, tested 167/80/121. Tails (39 rows): 9 full, 10 partial, 20 none (unchanged).

| Suite | Result |
|---|---|
| tt43-unit | 7/7 |
| e2e-tt43 | 3/3 (oracle identical; lifecycle hosts 2 → 1 → 2, session 1 kept n=2, session 2 fresh n=1; attacks refused) |
| tt42-unit (updated) | 6/6 |
| e2e-tt42 / e2e-tt41 / e2e-tt36 | 3/3, 4/4, 3/3 |

**Oracles:** dynwrap-diff 12,443 parsed, 0 disagreements; js-imports-diff 12,443 agree.

**Visual:** no visible UI surface changed (the host iframe is hidden). e2e-beauty ran in the full run.
