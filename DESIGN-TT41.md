# TT41: modules, fetch fidelity, frames, and the 8-bit deflate window

TT40 left a list of browser-proxy blockers. TT41 closed four groups of them:
- **WP-17:** ES modules and import maps;
- **WP-18:** fetch fidelity (redirect taint, Response.url and related);
- **WP-19:** SameSite through the frame tree, and nested frames that render at all;
- **WP-13 follow-up:** compressed messages for a server asking for an 8-bit client window.

The worker blockers (self.location, root-relative imports in module workers, data: workers) are closed as part of WP-17 and WP-18.

Everything shipped is original code. es-module-lexer (MIT) was read only for its list of known edge cases, and zlib's deflate.c only to prove a bound. Nothing was copied.

## Runtime honesty

**What ran:** everything here ran in the Arena Linux sandbox:
- Node 22 and Next 16.2.6: a production build on :3999, plus a private `next start` on :3992 for e2e-tt41;
- Playwright 1.64.1 driving headless Chromium;
- Python 3: its zlib binding, used as the strict 8-bit inflater, and websockets 13.1 from the existing tt39 fixtures;
- acorn 8, from the repo's node_modules, as the parser oracle;
- es-module-lexer 3.0.4, installed at /home/user/tools/oracle-npm, outside the repository. It was not used as an oracle in the end; acorn is the stronger one.

**Network:** no outside host was needed. Every "site" is a local HTTP or TLS server on 127.0.0.1 or 127.0.0.2, with a CA generated per run.

**Not available, so not tested:** Firefox and Safari (Playwright's Chromium only), real phones, a real cross-tab SharedWorker, and HTTP/3.

## A. Formal model

**Proxy URL:** `/api/wp/s/<seg>/<scheme>/<host[:port]><path>`.

**Segment** `seg` takes one of these forms:

| Form | Meaning |
|---|---|
| `<sid>` | navigation |
| `<sid>:<doc>:r` | no-cors subresource of document `doc` |
| `<sid>:<doc>:f` | iframe or frame of `doc` (new) |
| `<sid>:<doc>:<c>[m][t][x][y][n]` | script request with credentials `c` ∈ {i, s, o}, plus redirect-chain flags (new) |

**Document** `doc` → `{origin, url, xs}`. Here `xs` means some ancestor frame is cross-site with this document, so Chromium's site for cookies is null.

**Chain flags** describe the hops *already taken* (Fetch §4.4 HTTP-redirect fetch, §4.1 main fetch):
- `m`: mode is same-origin. A cross-origin hop is refused (network error).
- `t`: the origin is tainted. Origin and the CORS origin become "null".
- `x`: an earlier hop was cross-origin. The request is never same-origin again, so no credentials under "same-origin", the Referer is origin-only, and response tainting is sticky "cors".
- `y`: an earlier hop was cross-site. Sec-Fetch-Site is the worst over the URL list.
- `n`: no Referer.

`nextChainFlags(policy, current, next)`:
- `x` when the initiator ≠ current origin;
- `y` when the current hop was not same-site;
- `t` when next.origin ≠ current.origin and the initiator ≠ current origin.

The flags only ever restrict. A page can drop them only by writing a URL the shim would never emit, and every request without them is judged from the document's registered origin.

**Module graph:**
- Every static, dynamic and re-export specifier that is URL-like (`/`, `./`, `../`, absolute http(s)) is rewritten to `<sid>:<doc>:s`.
- Bare specifiers stay, for import maps.
- `import.meta.url` reads become the module's real URL. `import.meta.resolve` is wrapped with an inline decoder.

**Root import map** (documents with an id):
- `"/"` → the site's root through the proxy.
- Identity keys run through the whole segment: `/api/wp/s/<sid>:<doc>:s/`, `…:i/`, `/api/wp/s/<sid>/`, with `/api/wp/s/` as a last resort.
- If the page has its own map, ours is merged into its first one, and that map's keys under the site root get root-relative twins.

**Frame tree:**
- A frame navigation from document P to target T is cross-site iff P is unknown, `P.xs` is set, or T is not same-site with P.
- If cross-site, only SameSite=None cookies are sent and only those may be stored.
- The new document gets `xs` set accordingly. Its subresources and script requests are then cross-site for SameSite.
- Sec-Fetch-Site and Origin still follow its own origin.

**Deflate:**
- zlib clamps a raw window of 8 bits to 9 (512 bytes).
- Its matcher never reaches further back than `MAX_DIST = 2^w − MIN_LOOKAHEAD = 512 − 262 = 250` bytes.
- So every distance fits a 256-byte window.

## B. Hypotheses

**H+:**
1. A tokenizer can find module specifiers exactly without a full parser, given a context stack for regex vs division. It agrees with acorn on real code.
2. Chain flags in the URL segment reproduce Fetch's redirect semantics, because every redirect passes back through the proxy, which writes the next segment.
3. Nested frames can follow Chromium's frame-tree SameSite if each document records `xs`.
4. zlib at windowBits 9 is safe for an 8-bit peer.

**H−:**
1. A lexer that is wrong on any real file would break that site. Mitigation: a lexer error means the file is served unchanged, and acorn is the oracle.
2. Rewriting JS bodies could corrupt fetch() reads of JS. Only script, worker and sharedworker destinations are rewritten.
3. An import map could break pages that bring their own. Mitigation: merge instead of adding a second map.

**H∂ (refuted or changed during the turn):**
- I expected the data: worker to need an unknown document id, which would mean no cookies. Chromium sends SameSite=None cookies with `include` from a data: worker, so it uses the page's id plus the flags `txyn`.
- I expected a bare `/api/wp/s/` identity key to be enough. It is not: see G.

## C. Frontier (what is now possible that was not)

These now work through the proxy, with values identical to native Chromium:
- module sites: root-relative imports, import maps, `import.meta`, and module workers created with `new URL(…, import.meta.url)`;
- pages that read `Response.url`;
- sites relying on Origin "null" after redirect chains;
- iframes of any kind, which were all blank before;
- servers that demand an 8-bit client window, which now get compressed traffic.

## D. Negative shapes (≥ 15) and the modal-shortcut test

Lexer shapes, all compared against acorn:
1. A string containing `import(`.
2. A comment containing `import "x"`.
3. A template literal containing import text, with a `${}` holding a real import.
4. A regex containing `import(`.
5. `a.import()` and `obj?.import()`.
6. A class method named `import`.
7. An object key `import`.
8. `while (…) /re/`.
9. `export default /re/`.
10. `for (a of /re/)`.
11. `return /re/`.
12. `typeof /re/`.
13. Newline followed by `/`, which is division (no ASI); my own expectation was wrong here and acorn caught it.
14. A hashbang.
15. `\u002f` escapes.
16. A template with an expression, which must not count as a specifier.

Proxy shapes:

17. A forged `f` tag on an image gets the script rules: no cookies cross-site, never the untagged full jar.
18. A parser-split inline script (`"</script>"` inside a string) is left unchanged.
19. An untokenisable module (an unterminated template) is served unchanged and labelled.
20. 7 illegal segment strings: out of order, repeated, unknown, a flag on `r` or `f`, a short document id.
21. A redirect A→B→C whose final ACAO names A must fail.
22. A redirect A→B→A without ACAO must fail.
23. A same-origin-mode fetch that leaves the origin must fail.

**Modal-shortcut test:** "proxy everything" would make the oracle pass trivially if both runs were the same run. They are not: the native run loads straight from A, B and C. And mutants of each mechanism turn the suite red: frame SameSite off, JS rewrite off, import.meta.url off, chain flags off.

## E. Mechanism-distinct approaches considered

1. **Full JS parser:** acorn-class, in the server path. Exact, but heavy (lightweight constraint) and a licence dependency. Used only as the test oracle.
2. **Tokenizer with a context stack:** chosen. It is exact on 12,457 files, and its known limit fails safe.
3. **Service Worker interception:** impossible. Opaque-origin pages get no Service Worker in any browser.
4. **Import maps only, with no source rewriting:** cannot fix `import.meta.url`, root-relative static imports in workers (workers have no import maps), or cross-origin absolute imports. It is used as a complement for run-time-computed paths.
5. **Server-side redirect following** (hide redirects from the browser): breaks Response.url and redirected, and needs a CORS check per hop anyway. Rejected for URL-carried chain flags.
6. **Cookie partitioning per top-level site** (CHIPS-like) instead of the frame tree: different semantics from what Chromium does today with third-party cookies allowed. Rejected; the oracle decides.
7. **Deflate:** our own LZ77 encoder with a 256-byte window, versus proving zlib's bound. The proof is cheaper and keeps zlib's speed. Verified three ways.

## F. Artifacts

**Code:**
- `src/lib/js-imports.ts` (new);
- `src/lib/wp-core.ts`;
- `src/lib/wp-cors.ts`;
- `src/lib/server/wp-sessions.ts`;
- `src/lib/server/ws-deflate.ts`;
- `src/app/api/wp/s/[sid]/[...rest]/route.ts`;
- `public/wp-shim.js`.

**Tests:**
- `scripts/tt41-unit.mts` (9);
- `scripts/e2e-tt41.mts` (4; set `TT41_DEBUG=1` for request, console and page-error logs);
- `scripts/oracle/js-imports-diff.mts` (acorn differential);
- `scripts/oracle/deflate-audit.mts` (RFC 1951 auditing decoder, test-only);
- tt39-unit's 8-bit test now also runs zlib's strict inflater;
- tt40-unit's iframe expectation changed to the `f` tag.

**Register:** `src/db/seed-data/features-tt41.ts` (WP-17, WP-18 and WP-19, plus patches to WP-10, WP-11, WP-13 and WP-16). Seed 3.30.0.

## G. Adversary findings (this turn)

1. **Every iframe inside every proxied page was blank (pre-existing).** The page is an opaque-origin sandbox, and `frame-ancestors 'self' <fusion>` cannot match an opaque ancestor. Fixed: a frame navigation with a valid frame tag omits frame-ancestors.
2. **`new Request("/x")` in a document resolved against Fusion's origin (pre-existing).** So `fetch(new Request("/api/…"))` reached Fusion's own API path. Fixed.
3. **Scheme-shaped session ids broke the module graph.** With only a bare `/api/wp/s/` identity key, the remainder `<sid>:<doc>:s/…` parses as an absolute URL with scheme `<sid>` whenever the random id is scheme-shaped (about half of sessions). Chromium then refuses it as "backtracking above its prefix". The symptom was e2e-tt41 failing 2 of 3 runs. Fixed with identity keys through the whole segment; 8 of 8 runs then passed, 4 of them with scheme-shaped ids.
4. **A valueless `crossorigin` attribute was not seen as CORS mode.** Caught by tt41-unit and fixed.
5. **Frame navigations fell into the CORS-policy branch** and were refused (403). Caught by e2e-tt41 and fixed. An `f` tag on a non-frame request now gets the script rules.

## H. External verification

- **acorn 8** (full ECMAScript parser): 12,457 node_modules files, 8,248 specifiers, 0 disagreements; 28 adversarial cases, all equal.
- **Chromium itself:** e2e-tt41 compares the page's view and what each site saw, native against proxied, for modules, fetch fidelity and frames. 4/4 tests, 8 of 8 consecutive runs after the last fix.
- **zlib's own strict inflater** (Python binding, windowBits 8, 1 byte per call) inflates our 8-bit messages. A control with distance 604 is refused ("invalid distance too far back"), so the check is live.
- **zlib source:** deflate.c's MAX_DIST bound, giving 250. Empirically, 108 configurations reach a maximum distance of 240.

## I. Repair, then a new attack against the repair

- **Repair:** the root import map.
  - **Attack:** random session ids. This found G3.
  - **Repair:** full-segment identity keys.
  - **New attack:** 8 runs with fresh ids, half scheme-shaped. All pass.
- **Repair:** frame-ancestors omitted for nested frames.
  - **Attack:** is that a framing hole? The frame tag needs this session's id and a document id the server issued, both unguessable secrets that already grant full access. A forged document id is unknown, so it is treated as cross-site with the fewest cookies, and the response still carries `frame-ancestors`, because the omission requires a known parent.

## J. Stopping

The turn stopped because:
- the targeted blockers are closed and verified against external oracles;
- mutants for each new mechanism are killed;
- the full suite has been run.

What was not reached is listed under "Remaining blockers" in the PR body.

## Results (this turn)

**Full run** (74 suites, production build on :3999): first pass **694/695**. The one failure was e2e-tabletop's wall-drag test ("timed out: moved on the wall"). It is a known flake, in code untouched this turn, and it passed 14/14 on re-run.

**Ledger: 695/695, 365 rows, built 282/62/21, tested 164/80/121; Tails 39 rows: 9 full / 10 partial / 20 none.**

| Suite | Result |
|---|---|
| tt41-unit | 9/9 |
| e2e-tt41 | 4/4, 8 of 8 consecutive runs |
| tt39-unit | 13/13 (8-bit test now with zlib strict inflate + negative control) |
| tt40-unit | 17/17 |
| e2e-tt40 | 3/3 |
| e2e-tt39 | 7/7 |

**Mutants killed:** frame SameSite off, JS rewrite off, import.meta.url off, chain flags off.
