import type { SpecRow, Status } from "./row";

type Patch = Partial<Pick<SpecRow, "name" | "tier" | "route" | "nuance" | "test">> & { status: Status };

/**
 * TT36 register changes: Reader view for any reachable page inside Private proxy tabs (original content extractor,
 * checked against Readability as an independent oracle), named browser profiles shared by tabs, and the Plus Codes
 * length rules checked against Google's reference implementation.
 */
export const UPDATES_TT36: Record<string, Patch> = {
  "PR-07k": {
    tier: "A",
    name: "Reader mode",
    route: "src/lib/reader-core.ts (parseHtml, readable, readerDocument); /api/wp/s/<session>/__reader?u= (src/app/api/wp/s/[sid]/[...rest]/route.ts); src/components/modules/ProxyFrame.tsx (wp-reader); legacy Reader mode button for non-proxy tabs (/api/webproxy?mode=reader)",
    nuance: "Any page the Fusion server can reach: fetched within the tab's private session (its cookies and identity), the article found by an original content scorer (text vs link density, content / chrome names, landmarks), then re-serialised from an allow-list — scripts, styles, forms, event handlers, styles and unsafe schemes cannot survive (re-parsed by Python's html.parser in the tests; 3 source mutants caught). Links stay in the reader, images come through the proxy, find in page and Back / Forward work, 'Original page' leaves it. Against readability-lxml (Readability's Python port) on 7 live pages: recall 1.00 everywhere and the same article boundaries; the reader keeps link-dense lists inside READMEs that Readability drops (precision 0.32–1.00). A logo-wall page (pypi.org/sponsors/) is where the two pick different sections. Reader pages carry a stricter CSP than proxied pages (no inline script, no forms).",
    status: "built", test: "tt36-unit.mts ×3; e2e-tt36.mts ×2",
  },
  "PR-07o": {
    tier: "A",
    route: "src/lib/browserSession.ts (Tab.profile, safeProfileName); src/components/modules/Browser.tsx (session per tab or per named profile); src/components/modules/ProxyFrame.tsx (wp-profile)",
    nuance: "Private proxy tabs: 'This tab only' (an isolated jar per tab) or a named profile (Personal, Work, or any name in use) shared by every tab that picks it — signed in together, isolated from other profiles. The choice is saved with the window. Profiles are amnesic by design: the jar lives in memory while at least one tab uses it and is deleted with the last one (and on server restart). Directly embedded (non-proxy) pages still share the browser's own partitioned storage.",
    status: "partial", test: "tt36-unit.mts ×1; e2e-tt35.mts ×1; e2e-tt36.mts ×1",
  },
  "MP-07": {
    status: "built", test: "tt34-unit.mts ×2 (1 mutant caught); e2e-tt34.mts ×1; tt36-unit.mts ×1 (code lengths identical to Google's openlocationcode for lengths −1…20 at 304 points)",
  },
};
