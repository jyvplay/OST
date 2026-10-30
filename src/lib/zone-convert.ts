/** Convert a wall-clock time to an instant using the browser's Intl time-zone
 * data. Offset candidates are sampled over a 96-hour window in 6-hour steps,
 * then each candidate is round-tripped through Intl. A gap is refused; an
 * overlap is refused unless the caller explicitly selects an occurrence.
 * The sampling assumes relevant offset regimes last at least six hours; this
 * is not a full historical time-zone database implementation. */
export type ZoneDisambiguation = "reject" | "earlier" | "later";
export interface ZoneConversion { utc: string; targetDate: string; targetTime: string; dayShift: number; ambiguous: boolean }

function partsAt(fmt: Intl.DateTimeFormat, instant: number): Record<string, string> {
  return Object.fromEntries(fmt.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
}
function formatter(zone: string) {
  return new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function offsetAt(fmt: Intl.DateTimeFormat, instant: number): number {
  const p = partsAt(fmt, instant);
  const wall = new Date(0);
  wall.setUTCFullYear(+p.year, +p.month - 1, +p.day);
  wall.setUTCHours(+p.hour, +p.minute, +p.second, 0);
  return wall.getTime() - instant;
}

export function convertZoneTime(date: string, time: string, fromZone: string, toZone: string, disambiguation: ZoneDisambiguation = "reject"): ZoneConversion {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error("date must be YYYY-MM-DD and time HH:MM");
  const year = Number(date.slice(0, 4));
  // Date.UTC's 0–99 year convention and BCE/extended-year formatting require
  // a different model. Refuse instead of silently returning an incorrect year.
  if (year < 100 || year > 9998) throw new Error("year must be between 0100 and 9998");
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== `${date}T${time}`) throw new Error("invalid calendar date or time");
  if (!["reject", "earlier", "later"].includes(disambiguation)) throw new Error("invalid repeated-time choice");
  const source = formatter(fromZone), target = formatter(toZone);
  const offsets = new Set<number>();
  for (let h = -48; h <= 48; h += 6) offsets.add(offsetAt(source, naive + h * 3_600_000));
  const desired = `${date}T${time}:00`;
  const candidates = [...offsets].map((offset) => naive - offset).filter((instant) => {
    const p = partsAt(source, instant);
    return `${p.year.padStart(4, "0")}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === desired;
  }).sort((a, b) => a - b);
  if (!candidates.length) throw new Error("This local time does not exist in the selected zone (clock change).");
  if (candidates.length > 1 && disambiguation === "reject") throw new Error("This local time occurs more than once; choose the first or second occurrence.");
  const instant = disambiguation === "later" ? candidates[candidates.length - 1] : candidates[0];
  const p = partsAt(target, instant);
  const targetDate = `${p.year.padStart(4, "0")}-${p.month}-${p.day}`;
  const dayShift = Math.round((Date.parse(`${targetDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  return { utc: new Date(instant).toISOString(), targetDate, targetTime: `${p.hour}:${p.minute}`, dayShift, ambiguous: candidates.length > 1 };
}
