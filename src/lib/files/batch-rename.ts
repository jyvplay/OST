/**
 * TT136 (FM-03) — batch rename as a *plan*: nothing is written until the plan is
 * collision-free. Tokens are literal (no expressions, no regex, no eval).
 *
 * Tokens: {name} {ext} {n} {nn} {nnn} {date} {time} {upper} {lower}
 * {upper}/{lower} apply to everything to their right in the pattern.
 *
 * Refusals are whole-plan refusals: a plan with one bad name renames nothing.
 */

export const RENAME_LIMIT = 500;
export const NAME_MAX = 255;

export interface RenameEntry { path: string; name: string; kind: "file" | "dir" }

export interface RenameRow {
  from: string;
  to: string;
  index: number;
  /** true when the produced name equals the current name (a no-op, still listed) */
  unchanged: boolean;
}

export interface RenamePlan {
  rows: RenameRow[];
  /** Names that collide with each other or with an untouched sibling (case-insensitive). */
  conflicts: { name: string; paths: string[] }[];
  errors: string[];
  ok: boolean;
}

const splitName = (name: string): { base: string; ext: string } => {
  if (name.startsWith(".") && name.lastIndexOf(".") === 0) return { base: name, ext: "" };
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot + 1) } : { base: name, ext: "" };
};

const dirOf = (path: string) => path.slice(0, path.length - path.split("/").pop()!.length - 1) || "/";

/** Expand one pattern for one name. Throws with a human reason on any invalid pattern. */
export function expandPattern(pattern: string, name: string, index: number, date: Date): string {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) throw new Error("Pattern must be 1…200 characters");
  if (!Number.isInteger(index) || index < 0 || index > 100_000) throw new Error("Index out of range");
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("A valid date is required for {date}/{time}");
  const { base, ext } = splitName(name);
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
  const t = `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}`;
  // {upper}/{lower} set a case mode for every token to their right; they emit no text.
  let mode: "keep" | "upper" | "lower" = "keep";
  const apply = (s: string) => mode === "upper" ? s.toUpperCase() : mode === "lower" ? s.toLowerCase() : s;
  const out = pattern.replace(/\{([a-z]+)\}/g, (whole, token: string) => {
    switch (token) {
      case "name": return apply(base);
      case "ext": return ext === "" ? "" : apply(ext);
      case "n": return String(index + 1);
      case "nn": return pad(index + 1, 2);
      case "nnn": return pad(index + 1, 3);
      case "date": return d;
      case "time": return t;
      case "upper": mode = "upper"; return "";
      case "lower": mode = "lower"; return "";
      default: throw new Error(`Unknown token ${whole}`);
    }
  });
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(out)) throw new Error(`"${out}" contains a character a file name cannot hold`);
  if (out === "" || out === "." || out === "..") throw new Error("The pattern produced an empty or reserved name");
  if (new TextEncoder().encode(out).byteLength > NAME_MAX) throw new Error(`"${out}" is longer than ${NAME_MAX} bytes`);
  return out;
}

/**
 * Plan a batch rename. `siblings` are every name in the same folder (used to
 * detect a rename that would land on an untouched neighbour); renames within
 * this batch may exchange or rotate names because each rename is applied
 * through a two-phase temporary name by the caller.
 */
export function planBatchRename(entries: readonly RenameEntry[], pattern: string, date: Date, siblings: readonly string[] = []): RenamePlan {
  if (entries.length > RENAME_LIMIT) throw new Error(`At most ${RENAME_LIMIT} entries per batch`);
  const errors: string[] = [];
  const rows: RenameRow[] = [];
  entries.forEach((entry, index) => {
    try {
      const produced = expandPattern(pattern, entry.name, index, date);
      const target = entry.kind === "dir" ? produced : produced;
      const full = `${dirOf(entry.path)}/${target}`.replace(/\/+/g, "/");
      rows.push({ from: entry.path, to: full, index, unchanged: full === entry.path });
    } catch (e) {
      errors.push(`${entry.name}: ${(e as Error).message}`);
    }
  });

  // Group by folder + lower-cased final name. Two different source paths landing
  // on one name inside one batch is always a conflict; an untouched sibling is a
  // conflict only if no member of this batch is vacating that exact name.
  const byFolder = new Map<string, RenameRow[]>();
  for (const row of rows) {
    const folder = dirOf(row.to);
    const key = `${folder}\u0000${row.to.split("/").pop()!.toLowerCase()}`;
    byFolder.set(key, [...(byFolder.get(key) ?? []), row]);
  }
  const vacated = new Set(rows.map((r) => r.from.toLowerCase()));
  const conflicts: { name: string; paths: string[] }[] = [];
  for (const [key, group] of byFolder) {
    const name = key.split("\u0000")[1];
    if (group.length > 1) conflicts.push({ name, paths: group.map((g) => g.from) });
    else {
      const folder = key.split("\u0000")[0];
      const siblingPath = `${folder}/${name}`.replace(/\/+/g, "/");
      const hit = siblings.find((s) => s.toLowerCase() === `${folder}/${name}`.toLowerCase() && !vacated.has(s.toLowerCase()));
      if (hit && !vacated.has(siblingPath.toLowerCase())) conflicts.push({ name, paths: [group[0].from, hit] });
    }
  }
  return { rows, conflicts, errors, ok: errors.length === 0 && conflicts.length === 0 && rows.length > 0 };
}

/**
 * Two-phase rename order: every source moves to a unique temporary name first,
 * then to its target. `token` comes from the caller so this stays deterministic
 * and replayable (no Date.now() inside the engine).
 */
export function applyOrder(plan: RenamePlan, token: string): { phase1: { from: string; to: string }[]; phase2: { from: string; to: string }[] } {
  if (!plan.ok) throw new Error("A batch rename with errors or conflicts must not be applied");
  if (!/^[a-z0-9]{1,16}$/.test(token)) throw new Error("Temporary-name token must be 1…16 lowercase alphanumerics");
  const temp = (r: RenameRow) => `${dirOf(r.to)}/.rename-${r.index}-${token}.part`;
  return {
    phase1: plan.rows.map((r) => ({ from: r.from, to: temp(r) })),
    phase2: plan.rows.map((r) => ({ from: temp(r), to: r.to })),
  };
}
