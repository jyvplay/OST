/**
 * TT145 (AU-01) — routines: a whitelist that is a type, not a vibe.
 *
 * A routine is a trigger plus a list of actions. The security property that
 * matters is that a routine can never do something the user did not spell out, and
 * the *mechanical* way to get that is to make the action space a closed type:
 * every action is `{ kind, ...args }` where `kind` is one of a fixed set, every arg
 * is validated against that kind, and there is no "run script" member. A routine
 * loaded from a shared file therefore cannot introduce a new capability; the worst
 * it can do is ask for one that exists.
 *
 * The second property is the one that makes routines usable: a **dry run** must be
 * provably side-effect-free. That is not achieved by "not calling the executor";
 * it is achieved by making the plan a *value* — `plan()` returns the exact effects
 * that would occur, and the executor is only ever called with a plan whose
 * `dryRun` flag is false. A test can assert that a dry run produced the same plan
 * and zero executor calls.
 *
 * The third property is audit symmetry: a dry run and a real run write different
 * audit entries with the same routine id, so a person can see after the fact which
 * one happened. `auditEntry()` is the only way to build those entries.
 */

export const MAX_ACTIONS = 40;
export const MAX_ROUTINES = 200;
export const MIN_INTERVAL_MS = 60_000;

export type ActionKind =
  | "open" | "notify" | "set-theme" | "set-wallpaper" | "run-backup" | "clear-trash"
  | "lock" | "sleep-display" | "close-windows" | "focus-workspace" | "play-clip" | "write-note";

export type TriggerKind = "interval" | "time-of-day" | "display-connected" | "network-changed" | "manual";

export interface Action { kind: ActionKind; module?: string; text?: string; value?: string }
export interface Trigger { kind: TriggerKind; everyMs?: number; at?: string; on?: string }

export interface Routine {
  id: string;
  name: string;
  trigger: Trigger;
  actions: Action[];
  enabled: boolean;
  /** A routine that was never rehearsed must say so; this is set by a successful dry run. */
  rehearsedAt: number | null;
}

export type Check = { ok: true } | { ok: false; why: string };

const MODULES = ["recall", "files", "editor", "find", "terminal", "notes", "browser", "media", "photos", "music", "video", "settings", "monitor", "backup", "privacy", "spreadsheet", "whiteboard", "writer", "slides", "clock", "planner", "contacts", "tables", "books", "maps", "vault", "share", "storage", "devices", "spec"];
const THEMES = ["dark", "light", "system"];
const WALLPAPERS = ["poolside", "graphite", "daylight", "vice", "neon", "art deco", "ocean drive", "mac", "windows 11"];

export function checkAction(a: Action): Check {
  switch (a.kind) {
    case "open":
      if (!a.module) return { ok: false, why: "open needs a module" };
      if (!MODULES.includes(a.module)) return { ok: false, why: `“${a.module}” is not a module id in this build` };
      return { ok: true };
    case "notify":
      if (!a.text?.trim()) return { ok: false, why: "notify needs text" };
      if (a.text.length > 200) return { ok: false, why: `notify text is ${a.text.length} characters; 200 is the limit` };
      return { ok: true };
    case "set-theme":
      if (!THEMES.includes(a.value ?? "")) return { ok: false, why: `theme “${a.value}” is not one of ${THEMES.join(", ")}` };
      return { ok: true };
    case "set-wallpaper":
      if (!WALLPAPERS.includes(a.value ?? "")) return { ok: false, why: `wallpaper “${a.value}” is not installed` };
      return { ok: true };
    case "write-note":
      if (!a.text?.trim()) return { ok: false, why: "write-note needs text" };
      if (a.text.length > 20_000) return { ok: false, why: `note body is ${a.text.length} characters; 20000 is the limit` };
      return { ok: true };
    case "focus-workspace":
      if (!a.value || !/^[1-9]$/.test(a.value)) return { ok: false, why: "focus-workspace needs a workspace number 1–9" };
      return { ok: true };
    case "play-clip":
      if (!a.value) return { ok: false, why: "play-clip needs a clip name" };
      return { ok: true };
    case "close-windows":
      if (a.module && !MODULES.includes(a.module)) return { ok: false, why: `“${a.module}” is not a module id in this build` };
      return { ok: true };
    case "run-backup": case "clear-trash": case "lock": case "sleep-display":
      return { ok: true };
    default:
      return { ok: false, why: `“${String((a as { kind: string }).kind)}” is not an action this build can perform; a routine cannot add capabilities` };
  }
}

export function checkTrigger(t: Trigger): Check {
  if (t.kind === "interval") {
    if (!Number.isInteger(t.everyMs)) return { ok: false, why: "an interval needs whole milliseconds" };
    if ((t.everyMs as number) < MIN_INTERVAL_MS) return { ok: false, why: `a ${t.everyMs} ms interval is below the ${MIN_INTERVAL_MS} ms floor; a page cannot fire more often and still be a background daemon` };
    if ((t.everyMs as number) > 24 * 3600_000) return { ok: false, why: "an interval longer than a day will not survive a sleep/wake cycle in a tab" };
    return { ok: true };
  }
  if (t.kind === "time-of-day") {
    if (!t.at || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.at)) return { ok: false, why: `“${t.at}” is not a 24-hour HH:MM time` };
    return { ok: true };
  }
  if (t.kind === "display-connected") return t.on === "connect" || t.on === "disconnect" ? { ok: true } : { ok: false, why: "a display trigger must say connect or disconnect" };
  if (t.kind === "network-changed") return { ok: true };
  if (t.kind === "manual") return { ok: true };
  return { ok: false, why: `“${String((t as { kind: string }).kind)}” is not a trigger this build supports` };
}

export function makeRoutine(id: string, name: string, trigger: Trigger, actions: Action[]): Routine {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) throw new Error(`routine id “${id}” must be a lowercase id`);
  if (!name.trim() || name.length > 60) throw new Error("a routine needs a name of 1–60 characters");
  const t = checkTrigger(trigger);
  if (!t.ok) throw new Error(t.why);
  if (!actions.length) throw new Error("a routine with no actions does nothing and is refused rather than saved");
  if (actions.length > MAX_ACTIONS) throw new Error(`${actions.length} actions exceeds the ${MAX_ACTIONS} limit`);
  actions.forEach((a, i) => { const c = checkAction(a); if (!c.ok) throw new Error(`action ${i + 1}: ${c.why}`); });
  return { id, name: name.trim(), trigger, actions: [...actions], enabled: true, rehearsedAt: null };
}

/**
 * The plan. A dry run and a real run produce the *same* plan; only `dryRun`
 * differs, and the executor refuses to act on a plan whose dryRun is true.
 */
export interface Plan {
  routine: string;
  dryRun: boolean;
  effects: { action: Action; effect: string }[];
  /** Effects the plan cannot predict, stated rather than omitted. */
  unknowns: string[];
  sentence: string;
}

const EFFECT: Record<ActionKind, (a: Action) => string> = {
  open: (a) => `focus or open ${a.module}`,
  notify: (a) => `show “${a.text?.slice(0, 40)}” as a notification`,
  "set-theme": (a) => `switch the theme to ${a.value}`,
  "set-wallpaper": (a) => `switch the wallpaper to ${a.value}`,
  "run-backup": () => "start a backup of the selected set",
  "clear-trash": () => "empty the trash (items with another live copy only)",
  lock: () => "lock the vault and hide window contents",
  "sleep-display": () => "release the wake lock so the display may sleep",
  "close-windows": (a) => (a.module ? `close every ${a.module} window` : "close every window"),
  "focus-workspace": (a) => `switch to workspace ${a.value}`,
  "play-clip": (a) => `play ${a.value}`,
  "write-note": (a) => `append ${a.text?.length ?? 0} characters to today's note`,
};

export function plan(r: Routine, dryRun: boolean, now: number): Plan {
  const effects = r.actions.map((a) => ({ action: a, effect: EFFECT[a.kind](a) }));
  const unknowns: string[] = [];
  if (r.actions.some((a) => a.kind === "run-backup")) unknowns.push("a backup's duration depends on how much changed; the plan cannot bound it");
  if (r.actions.some((a) => a.kind === "play-clip")) unknowns.push("whether audio may start depends on the last gesture the user made");
  if (r.trigger.kind === "interval") unknowns.push("a tab that is asleep or closed does not fire; the next tick is late, not skipped silently");
  return {
    routine: r.id, dryRun, effects, unknowns,
    sentence: dryRun
      ? `a rehearsal: ${effects.length} effect(s) described, nothing performed`
      : `${effects.length} effect(s) will run now`,
  };
}

/** The only constructor for audit entries, so a rehearsal and a run cannot be confused. */
export interface AuditEntry { action: "routine.dryrun" | "routine.run"; routine: string; at: number; effects: number; detail: string }

export function auditEntry(p: Plan, now: number): AuditEntry {
  return {
    action: p.dryRun ? "routine.dryrun" : "routine.run",
    routine: p.routine, at: now, effects: p.effects.length,
    detail: p.dryRun ? `rehearsed ${p.routine}: ${p.sentence}` : `ran ${p.routine}: ${p.effects.map((e) => e.effect).join("; ")}`,
  };
}

/** An executor that is only allowed to act on a real plan. */
export function execute<T>(p: Plan, run: (a: Action) => T): { performed: T[]; refused: string | null } {
  if (p.dryRun) return { performed: [], refused: "a rehearsal plan is not executable; plan(false) is what runs" };
  return { performed: p.effects.map((e) => run(e.action)), refused: null };
}

/**
 * Import from a shared file. The parser accepts only the closed vocabulary and
 * reports every rejected action, so a shared routine degrades visibly.
 */
export function importRoutine(raw: unknown): { routine: Routine | null; rejected: string[] } {
  const rejected: string[] = [];
  if (typeof raw !== "object" || raw === null) return { routine: null, rejected: ["not an object"] };
  const r = raw as Record<string, unknown>;
  try {
    const actions = Array.isArray(r.actions) ? r.actions : [];
    const good: Action[] = [];
    actions.forEach((a, i) => {
      const c = checkAction(a as Action);
      if (c.ok) good.push(a as Action); else rejected.push(`action ${i + 1}: ${c.why}`);
    });
    if (!good.length) return { routine: null, rejected: [...rejected, "no action survived validation"] };
    const routine = makeRoutine(String(r.id ?? "imported"), String(r.name ?? "Imported routine"), r.trigger as Trigger, good);
    return { routine, rejected };
  } catch (e) {
    return { routine: null, rejected: [...rejected, (e as Error).message] };
  }
}

/** What a routine can never do, printed beside the editor. */
export const LIMITS = [
  "there is no “run script”, “run shell” or “call URL” action: the vocabulary is closed",
  "a trigger fires only while this app is running; a closed tab fires nothing, and the next tick is late",
  "an interval below one minute is refused: a page cannot be a real background daemon",
  "a rehearsal and a run write different audit entries, so the difference survives the fact",
] as const;
