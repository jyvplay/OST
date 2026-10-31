/**
 * PR-04: minimal RFC 5545 reader/writer (VEVENT + VTODO).
 * Nuances most hand-rolled parsers miss:
 *  - line unfolding (CRLF followed by space/tab continues the previous line)
 *  - property parameters (DTSTART;TZID=...:value, DTSTART;VALUE=DATE:20260101)
 *  - TEXT escaping (\n \, \; \\)
 * TZID and floating values are interpreted in the server's local timezone;
 * the original timezone is not preserved, and the UI states that limitation.
 */

export interface IcsItem {
  uid: string; title: string; notes: string; start: Date | null; end: Date | null;
  kind: "event" | "task"; done: boolean;
  /** TT117 PL-02: raw RRULE value (validated by src/lib/recurrence on use). */
  rrule?: string;
}

// Decode in one pass: a literal backslash followed by "n" is not a newline.
const unescapeText = (s: string) => s.replace(/\\([\\,;nN])/g, (_m, c: string) => c === "n" || c === "N" ? "\n" : c);
const escapeText = (s: string) => s.replace(/\r\n|\r/g, "\n").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

export function parseIcsDate(value: string, params: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, day, hour = "00", minute = "00", second = "00", z] = m;
  const year = Number(y), month = Number(mo), date = Number(day), h = Number(hour), mi = Number(minute), sec = Number(second);
  const dateOnly = !m[4];
  if ((/\bVALUE=DATE(?:;|$)/i.test(params) && !dateOnly) || (/\bVALUE=DATE-TIME(?:;|$)/i.test(params) && dateOnly)) return null;
  if (year < 1 || month < 1 || month > 12 || date < 1 || h > 23 || mi > 59 || sec > 59) return null;
  // Use setFullYear instead of the Date constructor's special 1900 offset for
  // years 0–99, then round-trip all components to reject rollover and gaps.
  const utc = !!z;
  const d = new Date(0);
  if (utc) { d.setUTCFullYear(year, month - 1, date); d.setUTCHours(h, mi, sec, 0); }
  else { d.setFullYear(year, month - 1, date); d.setHours(h, mi, sec, 0); }
  const actual = utc ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()] : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  return actual.every((n, i) => n === [year, month, date, h, mi, sec][i]) ? d : null;
}

export function parseIcs(text: string): IcsItem[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: IcsItem[] = [];
  let cur: IcsItem | null = null;
  let nested = 0, dueSeen = false;
  for (const line of lines) {
    const marker = line.toUpperCase();
    if (!cur && (marker === "BEGIN:VEVENT" || marker === "BEGIN:VTODO")) {
      cur = { uid: "", title: "", notes: "", start: null, end: null, kind: marker.endsWith("VTODO") ? "task" : "event", done: false };
      nested = 0; dueSeen = false;
      continue;
    }
    if (!cur) continue;
    // VALARM and other nested components have their own properties. They must
    // not replace the parent event's SUMMARY, dates, status, or UID.
    if (marker.startsWith("BEGIN:")) { nested++; continue; }
    if (marker.startsWith("END:")) {
      if (nested) { nested--; continue; }
      if (marker === (cur.kind === "task" ? "END:VTODO" : "END:VEVENT")) { out.push(cur); cur = null; }
      continue;
    }
    if (nested) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const [name, ...paramParts] = left.split(";");
    const params = paramParts.join(";").toUpperCase();
    switch (name.toUpperCase()) {
      case "UID": cur.uid = unescapeText(value); break;
      case "SUMMARY": cur.title = unescapeText(value); break;
      case "DESCRIPTION": cur.notes = unescapeText(value); break;
      case "DTSTART": if (!dueSeen) cur.start = parseIcsDate(value, params); break;
      case "DUE": cur.start = parseIcsDate(value, params); dueSeen = true; break;
      case "DTEND": cur.end = parseIcsDate(value, params); break;
      case "STATUS": cur.done = value.trim().toUpperCase() === "COMPLETED"; break;
      case "RRULE": cur.rrule = value.toUpperCase(); break;
    }
  }
  return out;
}

export type IcsImportWarningCode = "timezone" | "floating" | "allDay" | "invalidDate" | "recurrence" | "exceptions" | "duration" | "alarms" | "missingUid";
export interface IcsImportWarning { code: IcsImportWarningCode; items: number }

/** Identify known lossy cases before importing, counted once per item. This is
 * deliberately a warning scan, not a complete RFC 5545 validator or timezone
 * converter. It follows the reader's component and unfolding boundaries. */
export function inspectIcsImport(text: string): IcsImportWarning[] {
  const totals = new Map<IcsImportWarningCode, number>();
  let warnings: Set<IcsImportWarningCode> | null = null, kind = "", nested = 0, hasUid = false;
  for (const line of text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
    const marker = line.toUpperCase();
    if (!warnings && (marker === "BEGIN:VEVENT" || marker === "BEGIN:VTODO")) {
      warnings = new Set(); kind = marker.slice(6); nested = 0; hasUid = false; continue;
    }
    if (!warnings) continue;
    if (marker.startsWith("BEGIN:")) {
      if (marker === "BEGIN:VALARM" && nested === 0) warnings.add("alarms");
      nested++; continue;
    }
    if (marker.startsWith("END:")) {
      if (nested) { nested--; continue; }
      if (marker === `END:${kind}`) {
        if (!hasUid) warnings.add("missingUid");
        for (const code of warnings) totals.set(code, (totals.get(code) ?? 0) + 1);
        warnings = null;
      }
      continue;
    }
    if (nested) continue;
    const colon = line.indexOf(":"); if (colon < 0) continue;
    const left = line.slice(0, colon), value = line.slice(colon + 1).trim();
    const [rawName, ...parts] = left.split(";");
    const name = rawName.toUpperCase(), params = parts.join(";");
    if (name === "UID") hasUid = !!value;
    if (name === "RRULE") warnings.add("recurrence");
    if (["EXDATE", "RDATE", "EXRULE", "RECURRENCE-ID"].includes(name)) warnings.add("exceptions");
    if (name === "DURATION") warnings.add("duration");
    if (name === "DTSTART" || name === "DTEND" || name === "DUE") {
      const hasZone = /(?:^|;)TZID\s*=/i.test(params);
      const dateOnly = /^\d{8}$/.test(value);
      if (hasZone) warnings.add("timezone");
      else if (!dateOnly && !/Z$/i.test(value)) warnings.add("floating");
      if (dateOnly) warnings.add("allDay");
      if (!parseIcsDate(value, params)) warnings.add("invalidDate");
    }
  }
  return [...totals].map(([code, items]) => ({ code, items }));
}

const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Fold physical lines at 75 UTF-8 octets, including the continuation space.
 * Iterate code points so a surrogate pair / UTF-8 sequence is never split. */
const fold = (line: string) => {
  const parts: string[] = [];
  let part = "", bytes = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    const length = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + length > 75) { parts.push(part); part = " "; bytes = 1; }
    part += ch; bytes += length;
  }
  parts.push(part);
  return parts.join("\r\n");
};

export function toIcs(items: { uid: string; title: string; notes: string; start: Date | null; end: Date | null; kind: string; done: boolean; rrule?: string }[]): string {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fusion Shell Web//EN"];
  for (const it of items) {
    const comp = it.kind === "event" ? "VEVENT" : "VTODO";
    out.push(`BEGIN:${comp}`, `UID:${escapeText(it.uid)}`, `DTSTAMP:${fmt(new Date())}`, `SUMMARY:${escapeText(it.title)}`);
    if (it.notes) out.push(`DESCRIPTION:${escapeText(it.notes)}`);
    // A rule stored in notes as "RRULE:..." (Planner) or carried as a field is emitted as a real RRULE.
    const rule = it.rrule ?? (/^RRULE:(.+)$/m.exec(it.notes)?.[1]);
    if (it.start) {
      // The task model stores one due instant, not a separate recurrence
      // start. Anchor recurring VTODOs at that same instant so readers can
      // expand them, without inventing a task duration.
      if (comp === "VTODO" && rule) out.push(`DTSTART:${fmt(it.start)}`);
      out.push(`${comp === "VTODO" ? "DUE" : "DTSTART"}:${fmt(it.start)}`);
    }
    if (rule) {
      const clean = rule.trim();
      if (/[\r\n\x00-\x1f\x7f]/.test(clean)) throw new Error("RRULE must be a single content line");
      out.push(`RRULE:${clean.toUpperCase()}`);
    }
    if (it.end && comp === "VEVENT") out.push(`DTEND:${fmt(it.end)}`);
    if (comp === "VTODO") out.push(`STATUS:${it.done ? "COMPLETED" : "NEEDS-ACTION"}`);
    out.push(`END:${comp}`);
  }
  out.push("END:VCALENDAR");
  return out.map(fold).join("\r\n") + "\r\n";
}
