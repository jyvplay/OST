/**
 * CK-04 — custom world-clock zones. Validation uses the platform's own zone
 * database (an Intl constructor throws RangeError on an unknown zone), so
 * the persisted list can never contain a zone the clock cannot render.
 * Stored browser-local; re-validated on every load. UTC is always present
 * and cannot be removed — a clock with no reference zone is a bug, not a
 * preference.
 */
export const WORLD_ZONES_KEY = "fusion.worldzones.v1";
export const MAX_ZONES = 12;
export const DEFAULT_ZONES = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo", "Australia/Sydney"];

export function isValidZone(zone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

export function validateZones(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ZONES];
  const out: string[] = ["UTC"];
  for (const z of raw) {
    if (typeof z !== "string" || !isValidZone(z) || out.includes(z)) continue;
    out.push(z);
    if (out.length >= MAX_ZONES) break;
  }
  return out;
}

export function addZone(list: string[], zone: string): string[] {
  if (!isValidZone(zone)) throw new Error(`Unknown time zone: ${zone}`);
  if (list.includes(zone)) return list;
  if (list.length >= MAX_ZONES) throw new Error(`At most ${MAX_ZONES} zones on the world clock`);
  return [...list, zone];
}

export function removeZone(list: string[], zone: string): string[] {
  if (zone === "UTC") throw new Error("UTC stays as the reference zone");
  return list.filter((z) => z !== zone);
}

export function allZoneNames(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return f ? f("timeZone") : [...DEFAULT_ZONES];
}
