/**
 * TT145 (ST-03) — default-apps, as a state machine over what the platform
 * actually tells you.
 *
 * The trap in this row is believing the API. `navigator.registerProtocolHandler`
 * resolves whether or not the user agreed; `navigator.launchQueue` reports that
 * the app was launched, not that it is the default; and there is no call anywhere
 * that answers "am I the default handler for mailto:?". So the honest model has
 * four *distinct* states and a rule that only one of them may be displayed as
 * "default":
 *
 *   unsupported → the API is absent; a guide is the only honest output
 *   offered     → the page called the API and it resolved; the user's answer is unknown
 *   pending     → a launch was observed through launchQueue, which proves the app was
 *                 chosen *at least once*, not that it is the current default
 *   unknown     → everything else, which is the truthful default state
 *
 * The engine also keeps the per-handler list tight: a protocol must be
 * syntactically valid and in the `web+` namespace unless it is one of the schemes
 * the browser itself allows (mailto, tel, webcal…), because registering a scheme
 * the browser refuses is a silent failure.
 */

export const MAX_HANDLERS = 20;
/** Schemes a page may register without the `web+` prefix. */
export const KNOWN_SCHEMES = ["mailto", "tel", "sms", "webcal", "matrix", "irc", "ircs", "bitcoin", "geo", "magnet"] as const;

export type State = "unsupported" | "offered" | "pending" | "unknown";

export interface Claim {
  scheme: string;
  /** Absolute URL template the app registered, e.g. `/compose?to=%s`. */
  urlTemplate: string;
  state: State;
  /** Epoch ms of the last evidence (API resolution or a launch). */
  at: number;
  /** The exact fact behind `state`, never a guess. */
  evidence: string;
}

export interface Probe {
  registerApi: boolean;
  launchQueueApi: boolean;
  /** Schemes the browser reports having seen the app launched for. */
  launchedSchemes?: string[];
  now: number;
}

export type TemplateCheck = { ok: true; normalized: string } | { ok: false; why: string };

/**
 * A URL template must be same-origin and must contain exactly one `%s`.
 * Zero `%s` means the launch target cannot carry the address; two means the
 * browser substitutes only the first and the second survives literally, which is
 * how "mailto:a@b?cc=%s" ends up mailing the wrong person.
 */
export function checkTemplate(template: string, appOrigin: string): TemplateCheck {
  const count = (template.match(/%s/g) ?? []).length;
  if (count !== 1) return { ok: false, why: `template has ${count} %s placeholders; exactly one is required` };
  let u: URL;
  try { u = new URL(template, appOrigin); } catch { return { ok: false, why: "template is not a URL" }; }
  if (u.origin !== new URL(appOrigin).origin) return { ok: false, why: `template points at ${u.origin}; a handler must stay on ${new URL(appOrigin).origin}` };
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, why: `template scheme ${u.protocol} cannot be registered` };
  return { ok: true, normalized: u.href };
}

export function checkScheme(scheme: string): TemplateCheck {
  const s = scheme.trim().toLowerCase().replace(/:$/, "");
  if (!/^[a-z][a-z0-9+.-]{1,30}$/.test(s)) return { ok: false, why: `“${scheme}” is not a valid scheme` };
  // `web+` alone parses as a scheme but names nothing; the browser would reject the
  // registration with an error the page cannot read, so it is refused here instead.
  if (s === "web+") return { ok: false, why: "“web+” is a namespace prefix with no name after it" };
  const known = (KNOWN_SCHEMES as readonly string[]).includes(s);
  if (!known && !s.startsWith("web+")) return { ok: false, why: `“${s}” is neither a browser-known scheme nor in the web+ namespace the platform requires` };
  return { ok: true, normalized: s };
}

/**
 * One registration attempt. `apiResolved` is what the promise did — nothing more.
 */
export function offer(scheme: string, template: string, appOrigin: string, probe: Probe, apiResolved: boolean): Claim {
  const sc = checkScheme(scheme);
  if (!sc.ok) throw new Error(sc.why);
  const tc = checkTemplate(template, appOrigin);
  if (!tc.ok) throw new Error(tc.why);
  if (!probe.registerApi) return { scheme: sc.normalized, urlTemplate: tc.normalized, state: "unsupported", at: probe.now, evidence: "navigator.registerProtocolHandler is absent in this browser" };
  return {
    scheme: sc.normalized, urlTemplate: tc.normalized, at: probe.now,
    state: apiResolved ? "offered" : "unknown",
    evidence: apiResolved
      ? "the registration call resolved; the browser does not report whether the user accepted"
      : "the registration call rejected; nothing is registered",
  };
}

/**
 * A launch observed through launchQueue. This is the ONLY path that may move a
 * claim past "offered", and it still may not say "default" — the user can change
 * the default afterwards, and the page is not told.
 */
export function observeLaunch(claim: Claim, probe: Probe): Claim {
  if (!probe.launchQueueApi) return claim;
  if (!(probe.launchedSchemes ?? []).includes(claim.scheme)) return claim;
  return { ...claim, state: "pending", at: probe.now, evidence: `the app was launched for ${claim.scheme}: that proves it was chosen at least once, not that it is the current default` };
}

/**
 * The display string. There is exactly one branch that may contain the word
 * "default" and it is not reachable from the API — because the browser does not
 * expose the setting. Keeping that unreachable is the point.
 */
export function displayState(c: Claim): string {
  switch (c.state) {
    case "unsupported": return "not offered — this browser has no protocol registration";
    case "offered": return "offered; the browser does not report your answer";
    case "pending": return "launched at least once; this page cannot read the default setting";
    case "unknown": return "not registered";
  }
}

/** The guide, per platform, with the step a person actually needs. Keys are `navigator.userAgentData.platform`-ish. */
export const GUIDES: Record<string, readonly string[]> = {
  Windows: ["Settings → Apps → Default apps → choose this app", "Set defaults by file type or link type, then pick it for mailto/tel", "Chromium only offers web-linked apps that are installed"],
  macOS: ["Open the link once and choose “Always allow” in the system prompt", "Safari: Settings → Websites → Protocol handlers", "System Settings → Desktop & Dock → Default web browser for the http scheme"],
  Linux: ["xdg-settings set default-url-scheme-handler mailto <desktop-file>", "Or edit ~/.config/mimeapps.list under [Default Applications]", "xdg-open mailto:a@b is the check"],
  Android: ["Settings → Apps → Default apps → Opening links → pick the app", "Only installed PWAs appear", "The page cannot read which app is the default"],
};

export function guideFor(platform: string): readonly string[] {
  return GUIDES[platform] ?? ["this platform has no recorded steps; the OS settings app is the only place to change a handler"];
}

/** Probe summary, stated as capabilities rather than as a conclusion. */
export function probeSummary(p: Probe): string {
  const parts = [p.registerApi ? "registerProtocolHandler present" : "no registerProtocolHandler", p.launchQueueApi ? "launchQueue present" : "no launchQueue"];
  if (!p.registerApi) parts.push("a guide is the only honest output");
  return parts.join(" · ");
}
