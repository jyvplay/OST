/**
 * TT142 (DP-03 / DP-04) — which desktop row a URL asks for.
 *
 * Facts that shaped this, measured rather than assumed:
 *
 *  · the shell is server-rendered, so the row must be chosen *before* the first
 *    paint; a client-side switch would flash one desktop and then jump;
 *  · the product premise is ONE desktop shown on several screens (the display
 *    and presentation hosts are projections of it), so a per-browser default row
 *    would make "open my desktop on the other device" impossible; and
 *  · a per-browser id was actually built and measured this turn — 184 e2e
 *    scripts seed the shared `default` row and then assert on a rendered page, and
 *    the shell's own suite went 8/8 → 2/8 because every fixture was writing to a
 *    row nobody read any more (see src/proxy.ts for the full note).
 *
 * So: the shared `default` row is the default, and a **named** desktop is the
 * opt-in — `?desk=work`. Names are validated (a typo must not silently put the
 * reader on another desktop), reserved names are refused, and the settings
 * surface states that a named desktop is shared by link. Concurrent writers to
 * one row are already handled by optimistic concurrency on the row revision: a
 * stale write is refused with 409 and the tab adopts the newer desktop.
 */

/** Rows the app owns the meaning of; a link may not repurpose them. */
export const RESERVED_DESKTOP_IDS = ["display-2", "present"] as const;
/** The row every browser shares when no name is given. */
export const DEFAULT_DESKTOP_ID = "default";

/**
 * 3–48 characters, lower-case letters/digits/dashes, and it must start and end
 * with a letter or digit. The trailing-dash rule is not cosmetic: a name is used
 * in a URL, a database key and a copied link, and `work-` reads as a truncated
 * `work-something`. Refusing it at the boundary is cheaper than explaining it.
 */
const ID_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;

export type DesktopSource = "default" | "named";
export interface DesktopChoice { id: string; source: DesktopSource; warning: string | null }

/** A usable desktop name: right shape, and not a name the app reserves. */
export function isValidDesktopId(id: string | null | undefined): boolean {
  return (
    typeof id === "string" &&
    ID_SHAPE.test(id) &&
    id !== DEFAULT_DESKTOP_ID &&
    !(RESERVED_DESKTOP_IDS as readonly string[]).includes(id)
  );
}

/**
 * Resolve the row for this request. `?desk=` wins when it is usable. An unusable
 * value falls back to the shared desktop **and is reported**, because a share
 * link that quietly opens something else is worse than one that says it failed.
 */
export function chooseDesktopId(input: { param?: string | null }): DesktopChoice {
  const raw = input.param ?? "";
  const param = raw.trim();
  if (!param) return { id: DEFAULT_DESKTOP_ID, source: "default", warning: null };
  if (isValidDesktopId(param)) return { id: param, source: "named", warning: null };
  const shown = param.length > 48 ? `${param.slice(0, 48)}…` : param;
  return {
    id: DEFAULT_DESKTOP_ID,
    source: "default",
    warning: `“${shown}” is not a usable desktop name (3–48 characters: a–z, 0–9, dashes; “${DEFAULT_DESKTOP_ID}” is shared and cannot be renamed). The shared desktop is shown.`,
  };
}

/** A link that opens a named desktop, for the settings surface's copy action. */
export function shareLink(base: string, id: string): string {
  if (!isValidDesktopId(id)) throw new Error(`refusing to build a link for an unusable desktop name: ${id}`);
  const u = new URL(base);
  u.searchParams.set("desk", id);
  return u.toString();
}

/** One sentence per source, so the UI can say where this desktop came from. */
export function describeSource(source: DesktopSource): string {
  return source === "named"
    ? "A named desktop, opened from a link: anyone with the link can open and change it."
    : "The shared desktop. Every window you open here is also on your other screens.";
}

/** Short form for the UI: the part of a name that tells two of them apart. */
export function shortDesktopId(id: string): string {
  return id.length <= 12 ? id : `…${id.slice(-8)}`;
}
