/**
 * PL-05 — due-date presets. Presets are whole local days at end-of-day
 * (23:59 local), matching how the agenda buckets think: "tomorrow" means
 * tomorrow the day, not now+24h. The label always states the actual date
 * so a preset is never a silent guess.
 */
export type DuePreset = "today" | "tomorrow" | "next-week" | "none";

export function presetDue(preset: DuePreset, now = new Date()): Date | null {
  if (preset === "none") return null;
  const d = new Date(now);
  d.setHours(23, 59, 0, 0);
  if (preset === "tomorrow") d.setDate(d.getDate() + 1);
  if (preset === "next-week") d.setDate(d.getDate() + 7);
  return d;
}

export function presetLabel(preset: DuePreset, now = new Date()): string {
  const d = presetDue(preset, now);
  if (!d) return "No due date";
  const name = preset === "today" ? "Today" : preset === "tomorrow" ? "Tomorrow" : "In a week";
  return `${name} · ${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}`;
}
