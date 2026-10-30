/**
 * CN-06 — starred contacts. vCard has no standard star field, so stars are
 * a local view preference keyed by contact UID, stored browser-local and
 * re-validated on load (non-string entries dropped). Starring must never
 * rewrite the address book file itself — syncing the file to another tool
 * must not leak a UI preference into shared data.
 */
export const STARS_KEY = "fusion.contact-stars.v1";

export function validateStars(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((x): x is string => typeof x === "string" && x.length > 0));
}

export function toggleStar(stars: Set<string>, uid: string): Set<string> {
  const next = new Set(stars);
  if (next.has(uid)) next.delete(uid); else next.add(uid);
  return next;
}

export function loadStars(storage: Pick<Storage, "getItem">): Set<string> {
  try { return validateStars(JSON.parse(storage.getItem(STARS_KEY) ?? "[]")); } catch { return new Set(); }
}

export function storeStars(storage: Pick<Storage, "setItem">, stars: Set<string>): void {
  storage.setItem(STARS_KEY, JSON.stringify([...stars]));
}
