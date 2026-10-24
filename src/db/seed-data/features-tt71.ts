import type { SpecRow } from "./row";

/**
 * TT71 register changes (no new rows): NC-02 focus rules were registered "built" ("rules in settings + reducer flag")
 * but no rule engine or suppression record existed — now built and tested.
 */
const UP: Record<string, { note: string; test: string; route?: string; status?: SpecRow["status"] }> = {
  "NC-02": {
    note: "TT71: was registered as built but absent (alerts had read / pin / snooze only). Now built: focus rules in the setting alerts.focusRules (validated by one pure parser on client and server), each active by schedule (days + from–to in the IANA zone alerts.timeZone; overnight windows belong to their start day), by workspace and/or by focus mode, with an allow list of apps and of priorities that break through (default: high). POST /api/alerts evaluates every alert against the LIVE desktop state; a held alert stores the rule id and a sentence saying why (\"Held by focus rule “Quiet hours” (Fri 22:00–07:00 · workspace 1): Mail is not on its allow list and only high priority breaks through (this alert is low).\"), raises no toast / OS notification, waits in Alerts under \"Held by focus rules\" with Deliver now. Alerts shows which rules are active now. Limit: a held alert is not re-delivered automatically when the rule ends (it stays listed, unread).",
    test: "tt71-focus.mts (6: 22 malformed rule shapes, schedule vs minute-of-week oracle on all 604 800 minute×schedule points, DST / +05:30 / +12:45 zones, decision table, reason sentence, setting validation); e2e-tt71-focus.mts (4: live workspace / focus-mode / zone decisions + 422 refusals, held list + Deliver now + no OS notification, editor controls, Planner reminders held vs delivered); tt71-mutants.py",
    route: "src/lib/focus-rules.ts + api/alerts + modules/FocusRules.tsx + Alerts.tsx + ShellDaemons reminders",
  },
};

export function patchTT71(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
