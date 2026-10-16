/** AU-01: the routine vocabulary is a strict subset of palette commands. */
export const ROUTINE_COMMANDS = ["open", "tile", "workspace", "focusMode", "theme", "density", "alert", "preset", "closeAll", "textsize", "style"] as const;
export type RoutineCommand = (typeof ROUTINE_COMMANDS)[number];
export interface RoutineAction { cmd: string; arg?: string }

export function validateActions(actions: unknown): RoutineAction[] {
  if (!Array.isArray(actions)) throw new Error("actions must be an array");
  if (actions.length > 30) throw new Error("at most 30 actions per routine");
  return actions.map((a, i) => {
    const x = a as RoutineAction;
    if (!x || typeof x.cmd !== "string" || !(ROUTINE_COMMANDS as readonly string[]).includes(x.cmd)) {
      throw new Error(`action ${i + 1}: command "${x?.cmd}" is not in the routine whitelist`);
    }
    return { cmd: x.cmd, arg: x.arg === undefined ? undefined : String(x.arg).slice(0, 200) };
  });
}

/** "open files; tile left; theme dark" → actions. Used by the editor and dry-run. */
export function parseScript(src: string): RoutineAction[] {
  return validateActions(
    src.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const [cmd, ...rest] = s.split(/\s+/);
      return { cmd, arg: rest.length ? rest.join(" ") : undefined };
    }),
  );
}
