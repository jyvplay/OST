/** Foreground routine trigger validation and due calculation. No background wake is implied. */
export function validateRoutineTrigger(trigger: unknown, input: unknown): string {
  if (typeof trigger !== "string" || !["manual", "interval", "time-of-day", "display-connected"].includes(trigger)) throw new Error("Unknown routine trigger");
  if (input !== undefined && typeof input !== "string") throw new Error("Trigger value must be text");
  const value = (input ?? "").trim();
  if (trigger === "interval") {
    if (!/^(?:\d+)(?:\.\d+)?$/.test(value) || Number(value) < 1 || Number(value) > 525600) throw new Error("Interval must be between 1 and 525600 minutes");
  }
  if (trigger === "time-of-day" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("Time must be HH:MM in 24-hour format");
  return value;
}

export function routineTriggerDue(row: { trigger: string; triggerArg: string; lastRun: string | null }, now: Date, displayRose: boolean): boolean {
  let value: string;
  try { value = validateRoutineTrigger(row.trigger, row.triggerArg); } catch { return false; }
  if (!Number.isFinite(now.getTime())) return false;
  const last = row.lastRun ? new Date(row.lastRun) : null;
  // A corrupt execution timestamp is not evidence that it is safe to run.
  if (last && !Number.isFinite(last.getTime())) return false;
  if (row.trigger === "interval") return !last || now.getTime() - last.getTime() >= Number(value) * 60_000;
  if (row.trigger === "time-of-day") {
    const [h, m] = value.split(":").map(Number);
    const at = new Date(now); at.setHours(h, m, 0, 0);
    return now >= at && (!last || last < at);
  }
  return row.trigger === "display-connected" && displayRose;
}
