/** CK-07: world-clock ordering by current UTC offset. Offsets come from
 *  Intl at the instant (DST-correct), never from a static table; ties
 *  keep the user's chosen order. */
export function offsetMinutes(zone: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  } catch { return 0; }
}
export function sortZonesByOffset(zones: string[], at: Date): string[] {
  return zones.map((z, i) => ({ z, i, off: offsetMinutes(z, at) }))
    .sort((a, b) => a.off - b.off || a.i - b.i).map((x) => x.z);
}
export function offsetLabel(mins: number): string {
  const sign = mins < 0 ? "−" : "+";
  const a = Math.abs(mins);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}
