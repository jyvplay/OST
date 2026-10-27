import type { SpecRow } from "./row";

const UNIT = "tt85-find.mts";
const E2E = "e2e-tt85.mts";
const BROWSER = "e2e-tt35.mts";

/** TT85: bounded browser Find, honest app information, host-scoped proxy identity, and measured own-work inventory. */
export function patchTT85(row: SpecRow): SpecRow {
  if (row.code === "PR-07h") return {
    ...row,
    tier: "A",
    status: "built",
    route: "src/components/modules/ProxyFrame.tsx (host-scoped Desktop default / Desktop or Mobile override); src/lib/server/wp-sessions.ts (bounded RAM-only host map); src/app/api/wp-session/route.ts; src/app/api/wp/s/[sid]/[...rest]/route.ts; src/lib/server/wp-ws.ts; public/wp-shim.js",
    nuance: "Private proxy only: Desktop is the default per host; a Desktop or Mobile override is stored by host in the session's RAM-only map (max 64 hosts) and applies to upstream HTTP/WebSocket identity plus the page's navigator.userAgent, platform and maxTouchPoints. Unset hosts inherit Desktop; clearing an override returns to that default. User-Agent Client Hints and navigator.userAgentData are deliberately withheld to avoid a second fingerprint surface. The browser/PWA identity cannot be changed for directly embedded pages, and no connected-display/keyboard hardware detection is claimed.",
    test: "tt85-identity.mts (5 unit tests: host/session isolation, validation, 64-host bound, real HTTP route headers and API redaction); tt38-unit.mts (real WebSocket bridge handshake proves target-host override beats session default); e2e-tt85.mts E3 (live Chromium/PyPI: desktop/mobile page identity, same-site navigation, host fallback and clear); e2e-tt35.mts identity regression passed (the full suite is 6/7 because of its separate GitHub egress timeout)",
  };
  if (row.code === "PR-07n") return {
    ...row,
    tier: "A",
    status: "built",
    route: "public/wp-find.js (bounded DOM text index + MutationObserver + Range selection); /api/wp/s/[sid]/[...rest] injects it before public/wp-shim.js; src/components/modules/ProxyFrame.tsx (Find toolbar + match count)",
    nuance: "TT85 Class A within an explicit boundary: case-insensitive Unicode default lower-casing, normalized whitespace, literal overlapping matches across inline and block boundaries, visible top-document text only; 512 Ki UTF-16 units / 50,000 DOM nodes, with an explicit partial-scan indicator. Shadow DOM, nested frames, form-control values, image alt text and canvas pixels are outside scope. Query and document text remain inside the opaque proxy frame; no page content is sent to Fusion's server.",
    test: `${UNIT} (real Chromium DOM: visibility, exact Range selection, direction, overlap, mutation recount, hard caps); ${BROWSER} (live proxied site: match count, selection, next/previous, mobile identity and save)`,
  };
  if (row.code === "AP-01") return {
    ...row,
    status: "built",
    route: "src/components/modules/Apps.tsx; src/lib/registry.ts; /manifest.webmanifest; navigator.getInstalledRelatedApps() when manifest-declared and supported; navigator.storage.estimate()",
    nuance: "TT85 app hub: the live module registry is launchable; manifest file/protocol/share declarations are rendered as declarations rather than proof of OS association; display mode and the real beforeinstallprompt/appinstalled events are observed; only browser-reported, manifest-related apps can be shown. Storage is reported at the browser origin and linked to the server bucket assistant—there is no browser API for honest per-module byte attribution and arbitrary installed apps are not enumerable.",
    test: `${E2E} E1 (live manifest, registry cardinality / launch links, real storage APIs, declared handlers, no invented app inventory)`,
  };
  if (row.code === "AP-05") return {
    ...row,
    tier: "B",
    status: "partial",
    route: "src/components/modules/Apps.tsx; src/lib/background-inventory.ts; src/components/ShellDaemons.tsx; navigator.serviceWorker.getRegistrations() + registration.sync/periodicSync.getTags()",
    nuance: "TT85 reconciles the source spec (B/P4: own inventory; Shizuku for others) with the stale seed (A/P3) by aligning the seed to the source spec. The Fusion-owned portion is implemented: registration scopes and worker states plus live one-off/periodic sync tags are queried read-only. Page-daemon callback counts are measured in memory for this page only and reset on reload; they are not OS wake counts. Unsupported APIs and query failures are distinct from empty registration lists, and a browser-selected sync tag is not a promised execution time. The Shizuku other-app portion is intentionally not implemented; no arbitrary installed apps or routines are enumerated. Local callback outcomes contain no task or routine payloads.",
    test: `${E2E} E2 (actual Chromium service-worker registration and browser tag-query parity; observed callbacks + governor pause; no fabricated periodic tasks); tt85-inventory.mts (bounded counter model for the own-work portion)`,
  };
  if (row.code === "SH-13") return {
    ...row,
    status: "partial",
    nuance: `${row.nuance ? `${row.nuance} ` : ""}TT85: captures the real beforeinstallprompt event and offers it only while the browser permits; LaunchQueue.setConsumer file handoff and a genuine installed-app double-launch test remain unimplemented, so no single-instance file-open claim is made.`,
    test: `${row.test ? `${row.test}; ` : ""}${E2E} E1 (real install-event state is shown without synthesizing a prompt)`,
  };
  return row;
}
