/** Planner's public write contract. Pure validation shared by HTTP and tests;
 * no database, browser API, parser dependency or locale-sensitive date parsing. */
export const TASK_TITLE_LIMIT = 500;
export const TASK_NOTES_LIMIT = 65_536;
export interface TaskFields {
  title: string; notes: string; done: boolean; kind: "task" | "event";
  dueAt: string | null; endAt: string | null;
}
export interface PlannerTask extends TaskFields { id: number; reminded?: boolean; uid?: string }
export class TaskInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "TaskInputError"; this.status = status; }
}
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const objectValue = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskInputError("expected must be a task snapshot");
  return value as Record<string, unknown>;
};
export function taskId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TaskInputError("id must be a positive task integer");
  return value;
}
/** Accept explicit RFC3339 offsets only. Reject Date's silent day rollover,
 * date-only/server-local strings, nonfinite values and leap seconds. */
export function taskInstant(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new TaskInputError(`${field} must be an ISO timestamp with an explicit timezone, or null`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new TaskInputError(`${field} must be an ISO timestamp with an explicit timezone, or null`);
  const [, ys, mos, ds, hs, mins, ss = "0", fraction = "", offset] = match;
  const [year, month, day, hour, minute, second] = [ys, mos, ds, hs, mins, ss].map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 ||
    (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))) throw new TaskInputError(`${field} is not a valid date`);
  const wall = new Date(0); wall.setUTCFullYear(year, month - 1, day); wall.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, "0")));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day) throw new TaskInputError(`${field} is not a valid date`);
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.getUTCFullYear() < 1 || instant.getUTCFullYear() > 9999) throw new TaskInputError(`${field} is outside the supported date range`);
  return instant.toISOString();
}

export function taskSnapshot(task: TaskFields): TaskFields {
  return { title: task.title, notes: task.notes, done: task.done, kind: task.kind, dueAt: task.dueAt, endAt: task.endAt };
}
/** A full snapshot, rather than a title or second-resolution timestamp, detects
 * edits from another Planner window. It does not claim to detect an ABA history. */
export function assertTaskExpected(raw: unknown, current: TaskFields): void {
  const expected = objectValue(raw);
  for (const key of ["title", "notes", "done", "kind", "dueAt", "endAt"] as const) {
    if (!own(expected, key)) throw new TaskInputError(`expected.${key} is required`);
    let value = expected[key];
    if (key === "dueAt" || key === "endAt") value = taskInstant(value, `expected.${key}`);
    if (value !== current[key]) throw new TaskInputError("This item changed in another window. Reload it before saving or deleting.", 409);
  }
}

export function taskWrite(input: Record<string, unknown>, previous?: TaskFields): TaskFields & { reminded?: boolean } {
  const creating = !previous;
  const result: TaskFields & { reminded?: boolean } = previous ? { ...previous } : { title: "", notes: "", done: false, kind: "task", dueAt: null, endAt: null };
  let changed = false;
  if (own(input, "title")) {
    if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > TASK_TITLE_LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.title)) throw new TaskInputError(`title must contain 1–${TASK_TITLE_LIMIT} text characters`);
    result.title = input.title.trim(); changed = true;
  } else if (creating) throw new TaskInputError("title required");
  if (own(input, "notes")) {
    if (typeof input.notes !== "string" || input.notes.length > TASK_NOTES_LIMIT || input.notes.includes("\0")) throw new TaskInputError(`notes must be text up to ${TASK_NOTES_LIMIT} characters`);
    result.notes = input.notes; changed = true;
  }
  for (const key of ["done", "reminded"] as const) if (own(input, key)) {
    if (typeof input[key] !== "boolean") throw new TaskInputError(`${key} must be boolean`);
    result[key] = input[key]; changed = true;
  }
  if (own(input, "kind")) {
    if (input.kind !== "task" && input.kind !== "event") throw new TaskInputError("kind must be task or event");
    result.kind = input.kind; changed = true;
    if (result.kind === "task" && previous?.kind === "event" && !own(input, "endAt")) result.endAt = null;
  }
  for (const key of ["dueAt", "endAt"] as const) if (own(input, key)) { result[key] = taskInstant(input[key], key); changed = true; }
  if (!changed) throw new TaskInputError("no editable fields supplied");
  if (result.kind === "event") {
    if (!result.dueAt) throw new TaskInputError("an event needs a start time");
    if (result.endAt && result.endAt <= result.dueAt) throw new TaskInputError("event end must be after its start");
  } else if (result.endAt !== null) throw new TaskInputError("only events have an end time");
  if (own(input, "dueAt") && result.dueAt !== previous?.dueAt) result.reminded = false;
  return result;
}

/** datetime-local conversion uses local components, not toISOString().slice().
 * Include seconds/milliseconds when present so opening/saving an imported item
 * does not silently round its time. */
export function taskLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
/** Preserve an unchanged ambiguous local input's original instant. Browser
 * Date chooses one fold occurrence when the user actually changes that input;
 * DST gaps are rejected by round-tripping every local component. */
export function taskInputInstant(value: string, original?: string | null): string | null {
  if (!value) return null;
  if (original && value === taskLocalInput(original)) return original;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  if (!m) throw new TaskInputError("Choose a valid local date and time.");
  const d = new Date(value), expected = [m[1], m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
  const actual = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
  if (!Number.isFinite(d.getTime()) || !expected.every((x, i) => x === actual[i])) throw new TaskInputError("That local time does not exist. Choose another time.");
  return taskInstant(d.toISOString(), "time");
}
