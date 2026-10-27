/** Locally parsed, explicit palette commands; this module performs no effects. */
export type PaletteAction =
  | { kind: "note"; text: string }
  | { kind: "focus"; mode: "on" | "off" | "toggle" }
  | { kind: "setting"; query: string }
  | { kind: "routine"; query: string };

export const PALETTE_ACTION_LIMIT = 4096;
export function parsePaletteAction(input: string): PaletteAction | null {
  if (input.length > PALETTE_ACTION_LIMIT) return null;
  const s = input.trim();
  const note = /^note(?:\s+([\s\S]*))?$/i.exec(s);
  if (note) return { kind: "note", text: (note[1] ?? "").trim() };
  const focus = /^focus(?:\s+(on|off))?$/i.exec(s);
  if (focus) return { kind: "focus", mode: (focus[1]?.toLowerCase() as "on" | "off" | undefined) ?? "toggle" };
  const setting = /^setting\s+(.+)$/i.exec(s);
  if (setting && setting[1].trim().length <= 200) return { kind: "setting", query: setting[1].trim() };
  const routine = /^run(?:\s+(.+))?$/i.exec(s);
  if (routine && (routine[1] ?? "").trim().length <= 200) return { kind: "routine", query: (routine[1] ?? "").trim() };
  return null;
}
