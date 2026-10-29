import type { SpecRow, Status } from "./row";

/**
 * TT107 corrections. Each of these rows shipped untested; writing the first real
 * tests for them exposed defects, which are fixed here and recorded honestly.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

export const UPDATES_TT107: Record<string, Patch> = {
  "WM-17": { status: "built",
    route: "/api/webproxy?mode=raw — fetched server-side and re-served from our origin, so the target's X-Frame-Options/CSP never reach the browser",
    nuance: "TT107 first tests: the document is re-served without the target's framing headers and the top!==self idiom is defused, but relative subresources are only anchored with <base href>, so images and scripts still load from the target origin. Keeping subresources on our origin is the Private proxy's job (/api/wp), not this mechanism.",
    test: "tt107-features: a real X-Frame-Options: DENY origin is re-served framed, with no refusal header forwarded" },
  "WM-18": { status: "built",
    route: "/api/webproxy?mode=reader — allowlist rebuild of the article, rendered as our own document in a sandbox=\"\" iframe",
    nuance: "TT107 FIX: the extracted <title> was entity-decoded and interpolated unescaped (markup injection), and javascript: URLs were removed by substring deletion, which 'jajavascript:vascript:' evades. The title is now escaped and every URL passes a scheme allowlist. Still a regex allowlist rebuild, not a DOM-parsing sanitiser; it is rendered sandboxed for that reason.",
    test: "tt107-features: hostile title escaped, scheme evasion and data: URLs rejected, article text preserved" },
  "CM-02": { status: "built",
    route: "/api/embed-probe + saved window definition: S1 window when framing is allowed, S3 handoff when it is refused",
    nuance: "TT107 FIX: a non-http scheme such as ftp://x.test/ was coerced into https://ftp//x.test/ and probed as a real host; schemes are now parsed before defaulting. The probe reads X-Frame-Options and CSP frame-ancestors only — it cannot predict a site that refuses framing from JavaScript.",
    test: "tt107-features: XFO and CSP refusals route to handoff, a permissive origin earns a window, bad schemes are rejected" },
  "BL-03": { status: "built",
    route: "14-day trial row; afterwards read-only, no nags",
    nuance: "TT107 first tests: expiry degrades the tier to none while keeping the record visible, and a second trial on the same client is refused. Clock-based, so a user who moves the system clock back extends the trial; this is a local-first app with no licence server to prevent that.",
    test: "tt107-features: trial length, double-claim refusal, expiry degradation with no nagging copy" },
  "CA-14": { status: "built",
    route: "cast_targets.trusted + session auto-stop on lock/hide",
    nuance: "TT107 FIX: a session could be opened against a target that was never registered, which was then recorded as 'unknown' and could carry no trust decision. Starting a session now requires a registered target, and the Media module registers before it casts. Trust is per-target and revocable.",
    test: "tt107-features: unseen targets arrive untrusted, trust persists and is revocable per target, unregistered starts are refused" },
  "SC-09": { status: "built",
    route: "session registry + visible indicator + stop-on-lock",
    nuance: "TT107 first tests cover the registry half: every started session is a row bound to a confirmed target and stopping closes it. The indicator component and stop-on-lock are still only covered by their own module tests, so this row stays short of full coverage.",
    test: "tt107-features: session rows are bound to a registered target and closed on stop" },
  "SH-03": { status: "built",
    route: "Top bar: module menus, status, quick panel, clock, Beam indicator",
    nuance: "TT107 first browser tests: clock, launcher, search, overview, quick-panel controls and the live governor/fps status are asserted in a real browser. The Beam indicator is only present while a cast session exists and is covered by the Beam tests.",
    test: "e2e-tt107-shell: clock, controls and live status in a real browser" },
  "NC-03": { status: "built",
    nuance: "TT107 first browser tests: theme and density are applied to the document, persisted server-side and survive a reload; the panel dismisses with Escape. Volume, media and battery tiles depend on hardware APIs that headless Chromium does not expose, so they remain untested here.",
    test: "e2e-tt107-shell: theme/density persistence across reload, Escape dismissal" },
};
