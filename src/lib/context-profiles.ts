/**
 * Opt-in, browser-local appearance profiles. Context is deliberately derived
 * only from the browser's primary-pointer media query and one display bit;
 * viewport width, screen labels and other identifying data are not recorded.
 */
export const CONTEXT_PROFILE_KEY = "fusion.context-profiles.v1";
export const CONTEXTS = ["single-pointer", "single-touch", "extended"] as const;
export type ContextKind = typeof CONTEXTS[number];
export type Density = "compact" | "balanced" | "touch";
export interface ContextProfile { density: Density; textScale: number | null }
export interface ContextConfig {
  version: 1;
  enabled: boolean;
  profiles: Record<ContextKind, ContextProfile>;
}
export interface ContextObservation {
  kind: ContextKind;
  /** false means the browser did not expose Screen.isExtended. */
  displayDetection: boolean;
  /** Reports the primary pointer query, not every available input device. */
  primaryCoarse: boolean;
}

export function defaultContextConfig(): ContextConfig {
  return { version: 1, enabled: false, profiles: {
    "single-pointer": { density: "balanced", textScale: null },
    "single-touch": { density: "touch", textScale: null },
    extended: { density: "compact", textScale: null },
  } };
}

/** The extended bit wins; without it, use the primary pointer, never viewport width. */
export function classifyContext(extended: boolean | undefined, primaryCoarse: boolean): ContextObservation {
  return {
    kind: extended === true ? "extended" : primaryCoarse ? "single-touch" : "single-pointer",
    displayDetection: typeof extended === "boolean",
    primaryCoarse,
  };
}

const validProfile = (v: unknown): v is ContextProfile => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return ["compact", "balanced", "touch"].includes(p.density as string)
    && (p.textScale === null || (typeof p.textScale === "number" && Number.isInteger(p.textScale) && p.textScale >= 100 && p.textScale <= 300));
};

/** Malformed or oversized local data fails closed to disabled, not a partial profile. */
export function parseContextConfig(raw: string | null): ContextConfig {
  if (!raw || raw.length > 4096) return defaultContextConfig();
  try {
    const x: unknown = JSON.parse(raw);
    if (!x || typeof x !== "object" || Array.isArray(x)) return defaultContextConfig();
    const root = x as Record<string, unknown>;
    if (root.version !== 1 || typeof root.enabled !== "boolean" || !root.profiles || typeof root.profiles !== "object" || Array.isArray(root.profiles)) return defaultContextConfig();
    const p = root.profiles as Record<string, unknown>;
    const a = p["single-pointer"], b = p["single-touch"], c = p.extended;
    if (!validProfile(a) || !validProfile(b) || !validProfile(c)) return defaultContextConfig();
    // Construct from an allowlist; never spread attacker-controlled keys.
    return { version: 1, enabled: root.enabled, profiles: {
      "single-pointer": { density: a.density, textScale: a.textScale },
      "single-touch": { density: b.density, textScale: b.textScale },
      extended: { density: c.density, textScale: c.textScale },
    } };
  } catch { return defaultContextConfig(); }
}

export function changeContextProfile(config: ContextConfig, kind: ContextKind, profile: ContextProfile): ContextConfig {
  if (!CONTEXTS.includes(kind) || !validProfile(profile)) throw new Error("Invalid context profile");
  return { ...config, profiles: { ...config.profiles, [kind]: { density: profile.density, textScale: profile.textScale } } };
}
