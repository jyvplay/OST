/**
 * PR-04: minimal RFC 5545 reader/writer (VEVENT + VTODO).
 * Nuances most hand-rolled parsers miss:
 *  - line unfolding (CRLF followed by space/tab continues the previous line)
 *  - property parameters (DTSTART;TZID=...:value, DTSTART;VALUE=DATE:20260101)
 *  - TEXT escaping (\n \, \; \\)
 * TZID values are interpreted as local time and that loss is stated in the UI;
 * we do not ship a tz database.
 */

export interface IcsItem {
  uid: string; title: string; notes: string; start: Date | null; end: Date | null;
  kind: "event" | "task"; done: boolean;
}

const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
const escapeText = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

export function parseIcsDate(value: string, params: string): Date | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  if (params.includes("VALUE=DATE") || !m[4]) return new Date(Number(y), Number(mo) - 1, Number(d));
  if (z) return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

export function parseIcs(text: string): IcsItem[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: IcsItem[] = [];
  let cur: IcsItem | null = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === "BEGIN:VEVENT" || line === "BEGIN:VTODO") {
      cur = { uid: "", title: "", notes: "", start: null, end: null, kind: line.endsWith("VTODO") ? "task" : "event", done: false };
      continue;
    }
    if ((line === "END:VEVENT" || line === "END:VTODO") && cur) { out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...paramParts] = left.split(";");
    const params = paramParts.join(";").toUpperCase();
    switch (name.toUpperCase()) {
      case "UID": cur.uid = value; break;
      case "SUMMARY": cur.title = unescapeText(value); break;
      case "DESCRIPTION": cur.notes = unescapeText(value); break;
      case "DTSTART": case "DUE": cur.start = parseIcsDate(value, params); break;
      case "DTEND": cur.end = parseIcsDate(value, params); break;
      case "STATUS": cur.done = /COMPLETED/i.test(value); break;
    }
  }
  return out;
}

const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Lines longer than 75 octets are folded, as the RFC requires. */
const fold = (line: string) => {
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 75) { parts.push(rest.slice(0, 75)); rest = ` ${rest.slice(75)}`; }
  parts.push(rest);
  return parts.join("\r\n");
};

export function toIcs(items: { uid: string; title: string; notes: string; start: Date | null; end: Date | null; kind: string; done: boolean }[]): string {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fusion Shell Web//EN"];
  for (const it of items) {
    const comp = it.kind === "event" ? "VEVENT" : "VTODO";
    out.push(`BEGIN:${comp}`, `UID:${it.uid}`, `DTSTAMP:${fmt(new Date())}`, fold(`SUMMARY:${escapeText(it.title)}`));
    if (it.notes) out.push(fold(`DESCRIPTION:${escapeText(it.notes)}`));
    if (it.start) out.push(`${comp === "VTODO" ? "DUE" : "DTSTART"}:${fmt(it.start)}`);
    if (it.end && comp === "VEVENT") out.push(`DTEND:${fmt(it.end)}`);
    if (comp === "VTODO") out.push(`STATUS:${it.done ? "COMPLETED" : "NEEDS-ACTION"}`);
    out.push(`END:${comp}`);
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n") + "\r\n";
}
