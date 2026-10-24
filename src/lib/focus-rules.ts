/**
 * TT71 NC-02 — focus rules: hold alerts by schedule, workspace and focus mode, with a visible reason.
 * Pure (no I/O): the server evaluates every incoming alert against the rules stored in the setting alerts.focusRules,
 * in the user's time zone (setting alerts.timeZone, IANA), and records WHICH rule held it and why.
 *
 * Semantics (modelled on the OS "Focus" / "Do not disturb" concept, written from scratch):
 *  - A rule is ACTIVE when it is enabled and every condition it has holds: schedule (days + from–to, local time),
 *    workspaces (the active one is listed), focus mode (on/off). A rule with no condition is always active (manual DND).
 *  - A schedule whose `to` is earlier than `from` runs past midnight; the night belongs to the day it STARTS on
 *    (Fri 22:00–07:00 holds Friday night into Saturday morning, not Thursday night).
 *  - An alert is delivered only if EVERY active rule lets it through: its app is on the rule's allow list, or its
 *    priority is one the rule lets break through. Otherwise the FIRST active rule (list order) that blocks it is
 *    recorded, with a sentence naming the rule, the condition that made it active and why the alert did not pass.
 */
export type Priority = "low" | "normal" | "high";
export const PRIORITIES: readonly Priority[] = ["low", "normal", "high"];
export interface Schedule { days: number[]; from: string; to: string }
export interface FocusRule {
  id: string; name: string; enabled: boolean;
  schedule?: Schedule; workspaces?: number[]; focusMode?: boolean;
  allowApps: string[]; allowPriorities: Priority[];
}
export interface FocusContext { now: Date; timeZone: string; activeWorkspace: number; focusMode: boolean }
export type Decision = { deliver: true; active: string[] } | { deliver: false; rule: { id: string; name: string }; reason: string; active: string[] };

export const MAX_RULES = 32;
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (s: string) => { const m = HHMM.exec(s)!; return Number(m[1]) * 60 + Number(m[2]); };

/** Validate untrusted JSON (the setting value). Never throws; returns the first problem in words. */
export function parseRules(json: string): { rules: FocusRule[] } | { error: string } {
  let raw: unknown;
  try { raw = JSON.parse(json || "[]"); } catch { return { error: "focus rules must be JSON" }; }
  if (!Array.isArray(raw)) return { error: "focus rules must be a list" };
  if (raw.length > MAX_RULES) return { error: `at most ${MAX_RULES} focus rules` };
  const out: FocusRule[] = []; const ids = new Set<string>();
  for (const [i, r0] of raw.entries()) {
    const at = `rule ${i + 1}`;
    if (!r0 || typeof r0 !== "object" || Array.isArray(r0)) return { error: `${at}: not an object` };
    const r = r0 as Record<string, unknown>;
    if (typeof r.id !== "string" || !/^[a-z0-9-]{1,32}$/.test(r.id)) return { error: `${at}: id must be 1–32 of a-z, 0-9, -` };
    if (ids.has(r.id)) return { error: `${at}: duplicate id ${r.id}` }; ids.add(r.id);
    if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 60) return { error: `${at}: name must be 1–60 characters` };
    if (r.enabled !== undefined && typeof r.enabled !== "boolean") return { error: `${at}: enabled must be true or false` };
    const rule: FocusRule = { id: r.id, name: r.name.trim(), enabled: r.enabled !== false, allowApps: [], allowPriorities: ["high"] };
    if (r.schedule !== undefined) {
      const s = r.schedule as Record<string, unknown> | null;
      if (!s || typeof s !== "object") return { error: `${at}: schedule must be an object` };
      if (!Array.isArray(s.days) || !s.days.length || s.days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) return { error: `${at}: schedule days must be 0 (Sun) … 6 (Sat)` };
      if (typeof s.from !== "string" || !HHMM.test(s.from) || typeof s.to !== "string" || !HHMM.test(s.to)) return { error: `${at}: schedule times must be HH:MM (24 h)` };
      if (s.from === s.to) return { error: `${at}: schedule from and to are equal — use no schedule for all day` };
      rule.schedule = { days: [...new Set(s.days as number[])].sort(), from: s.from, to: s.to };
    }
    if (r.workspaces !== undefined) {
      if (!Array.isArray(r.workspaces) || r.workspaces.some((w) => !Number.isInteger(w) || (w as number) < 1 || (w as number) > 99)) return { error: `${at}: workspaces must be numbers 1–99` };
      if (r.workspaces.length) rule.workspaces = [...new Set(r.workspaces as number[])];
    }
    if (r.focusMode !== undefined) { if (typeof r.focusMode !== "boolean") return { error: `${at}: focusMode must be true or false` }; rule.focusMode = r.focusMode; }
    if (r.allowApps !== undefined) {
      if (!Array.isArray(r.allowApps) || r.allowApps.length > 64 || r.allowApps.some((a) => typeof a !== "string" || !a.trim() || a.length > 40)) return { error: `${at}: allowApps must be up to 64 app names` };
      rule.allowApps = (r.allowApps as string[]).map((a) => a.trim());
    }
    if (r.allowPriorities !== undefined) {
      if (!Array.isArray(r.allowPriorities) || r.allowPriorities.some((p) => !PRIORITIES.includes(p as Priority))) return { error: `${at}: allowPriorities must be low / normal / high` };
      rule.allowPriorities = [...new Set(r.allowPriorities as Priority[])];
    }
    out.push(rule);
  }
  return { rules: out };
}

/** Day of week (0 = Sun) and minute of day in an IANA time zone; an unknown zone falls back to UTC (flagged). */
export function localTime(now: Date, timeZone: string): { day: number; minute: number; zone: string } {
  let zone = timeZone || "UTC";
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); }
  catch { zone = "UTC"; parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: DAY.indexOf(get("weekday")), minute: (Number(get("hour")) % 24) * 60 + Number(get("minute")), zone };
}

/** Is the schedule running at (day, minute)? Overnight schedules belong to the day they start on. */
export function inSchedule(s: Schedule, day: number, minute: number): boolean {
  const f = minutes(s.from), t = minutes(s.to);
  if (f < t) return s.days.includes(day) && minute >= f && minute < t;
  return (s.days.includes(day) && minute >= f) || (s.days.includes((day + 6) % 7) && minute < t);
}

function describe(r: FocusRule): string {
  const bits: string[] = [];
  if (r.schedule) bits.push(`${daysText(r.schedule.days)} ${r.schedule.from}–${r.schedule.to}`);
  if (r.workspaces) bits.push(`workspace ${r.workspaces.join(", ")}`);
  if (r.focusMode !== undefined) bits.push(`focus mode ${r.focusMode ? "on" : "off"}`);
  return bits.length ? bits.join(" · ") : "always";
}
export function daysText(days: number[]): string {
  const d = [...days].sort().join(",");
  if (d === "0,1,2,3,4,5,6") return "every day";
  if (d === "1,2,3,4,5") return "Mon–Fri";
  if (d === "0,6") return "weekends";
  return days.map((x) => DAY[x]).join(" ");
}

export function activeRules(rules: FocusRule[], ctx: FocusContext): FocusRule[] {
  const t = localTime(ctx.now, ctx.timeZone);
  return rules.filter((r) => r.enabled
    && (!r.schedule || inSchedule(r.schedule, t.day, t.minute))
    && (!r.workspaces || r.workspaces.includes(ctx.activeWorkspace))
    && (r.focusMode === undefined || r.focusMode === ctx.focusMode));
}

/** Decide one alert. `active` lists the names of every active rule (shown in the Alerts header as the visible state). */
export function decide(rules: FocusRule[], alert: { app: string; priority: string }, ctx: FocusContext): Decision {
  const act = activeRules(rules, ctx);
  const active = act.map((r) => r.name);
  const app = alert.app.trim().toLowerCase();
  const pr = (PRIORITIES as readonly string[]).includes(alert.priority) ? alert.priority as Priority : "normal";
  for (const r of act) {
    if (r.allowApps.some((a) => a.toLowerCase() === app) || r.allowPriorities.includes(pr)) continue;
    const through = r.allowPriorities.length ? `only ${r.allowPriorities.join(" / ")} priority breaks through` : "no priority breaks through";
    return {
      deliver: false, rule: { id: r.id, name: r.name }, active,
      reason: `Held by focus rule “${r.name}” (${describe(r)}): ${alert.app} is not on its allow list and ${through} (this alert is ${pr}).`,
    };
  }
  return { deliver: true, active };
}

/**
 * TT71 repair (second-order attack on the patch): the alert body is untrusted JSON. A non-string app crashed decide()
 * (500) and a non-enum priority was stored as garbage. Strings are trimmed and capped; a blank app/title falls back to
 * the defaults; priority must be low / normal / high.
 */
export interface AlertInput { app: string; title: string; body: string; priority: Priority; groupKey: string }
export function normalizeAlert(b: Record<string, unknown>): { value: AlertInput } | { error: string } {
  const str = (k: string, max: number, dflt: string): string | null => {
    const v = b[k];
    if (v === undefined || v === null) return dflt;
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t.slice(0, max) : dflt;
  };
  const app = str("app", 40, "Fusion"), title = str("title", 200, "Alert"), body = str("body", 2000, "");
  if (app === null || title === null || body === null) return { error: "app, title and body must be strings" };
  const groupKey = str("groupKey", 40, app);
  if (groupKey === null) return { error: "groupKey must be a string" };
  const p = b.priority ?? "normal";
  if (typeof p !== "string" || !(PRIORITIES as readonly string[]).includes(p)) return { error: "priority must be low, normal or high" };
  return { value: { app, title, body, priority: p as Priority, groupKey } };
}
