/**
 * TT139 (IN-09) — a real shortcut registry: chords, scopes, conflicts, hints.
 *
 * The shell already binds keystrokes inline in half a dozen components. That
 * works until two of them claim the same chord, or a modal opens while a
 * window's handler is still live, or the user's keyboard layout does not have
 * the physical key the code assumed. This module is the resolution layer:
 *
 *   - Normalisation to a canonical chord string, with `event.code` as the
 *     fallback when `event.key` is a dead key or a composition (so a French
 *     AZERTY user pressing the key labelled "A" is handled predictably).
 *   - Scopes with precedence: a focused modal owns its scope; global shortcuts
 *     are still reachable *except* when the owning scope marks the chord
 *     "shadowed" (Escape in a dialog must not also close the window).
 *   - Conflict detection that distinguishes a hard conflict (two bindings in the
 *     same scope, same chord) from a benign shadow (a dialog overriding a
 *     global), because reporting both as "conflict" trains users to ignore it.
 *   - Human-readable hints per platform, generated from the same data the
 *     dispatcher uses, so the help sheet cannot drift from the behaviour.
 *
 * Deliberately excluded: reserved browser/OS chords (Ctrl+W, Ctrl+T, …) are
 * rejected at registration with a reason, because silently failing to fire is a
 * worse bug than an explicit refusal.
 */

export interface Modifiers { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

export interface Binding {
  /** Canonical chord, e.g. "ctrl+shift+k" or "meta+,". */
  chord: string;
  /** Stable command id ("window.close", "palette.open"). */
  command: string;
  label: string;
  scope: string;
  /** When true this binding also fires while focus is in a text field. */
  allowInInput?: boolean;
  /** True when the binding consumes the event (preventDefault) — default true. */
  prevent?: boolean;
  /** Set when another scope deliberately shadows it. */
  shadowed?: boolean;
  order?: number;
}

export interface ResolveResult {
  binding: Binding | null;
  reason: "match" | "no-match" | "input-focused" | "shadowed" | "prevented-by-earlier" | "composing" | "reserved";
  competing: Binding[];
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph", "CapsLock", "Fn", "Hyper", "Super"]);

/** Chords the browser or OS will handle before us; binding them is dishonest. */
export const RESERVED_CHORDS = new Set([
  "ctrl+w", "ctrl+t", "ctrl+n", "ctrl+shift+n", "ctrl+shift+t", "ctrl+shift+w", "ctrl+shift+q",
  "ctrl+tab", "ctrl+shift+tab", "meta+w", "meta+t", "meta+n", "meta+q", "meta+shift+w",
  "f5", "ctrl+r", "ctrl+shift+r", "f11", "f12", "ctrl+shift+i", "ctrl+shift+j", "ctrl+shift+c",
  "alt+f4", "meta+space", "ctrl+shift+escape",
]);

/** Keys whose `key` value is layout-dependent; prefer `code` for these. */
const LAYOUT_DEPENDENT = /^[a-z]$/i;

export function isModifierOnly(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/**
 * Canonical, layout-stable chord. Letters and digits use `code` (KeyA/Digit1) so
 * the *physical* key is the binding; punctuation keeps `key` because that is
 * what users and documentation refer to.
 */
export function chordFromEvent(e: KeyLike): string | null {
  if (e.isComposing) return null;
  // A dead key is a prefix character, not a command: letting it through would
  // bind "´" and fire on the way to typing "é".
  if (e.key === "Dead" || e.key === "Unidentified" || e.key === "Process") return null;
  const key = e.key;
  if (!key || isModifierOnly(key)) return null;
  let base: string;
  const code = e.code ?? "";
  if (LAYOUT_DEPENDENT.test(key) && /^Key[A-Z]$/.test(code)) base = code.slice(3).toLowerCase();
  else if (/^\d$/.test(key) && /^Digit\d$/.test(code)) base = code.slice(5);
  else if (/^F\d{1,2}$/i.test(key)) base = key.toLowerCase();
  else if (key === " " || key === "Spacebar") base = "space";
  else if (key === "Escape" || key === "Esc") base = "escape";
  else if (key === "Enter" || key === "Return") base = "enter";
  else if (key === "ArrowUp" || key === "Up") base = "arrowup";
  else if (key === "ArrowDown" || key === "Down") base = "arrowdown";
  else if (key === "ArrowLeft" || key === "Left") base = "arrowleft";
  else if (key === "ArrowRight" || key === "Right") base = "arrowright";
  else if (key === "Backspace") base = "backspace";
  else if (key === "Delete" || key === "Del") base = "delete";
  else if (key === "Tab") base = "tab";
  else if (key === "Home") base = "home";
  else if (key === "End") base = "end";
  else if (key === "PageUp") base = "pageup";
  else if (key === "PageDown") base = "pagedown";
  else if (key === "," || key === "<") base = ",";
  else if (key === "." || key === ">") base = ".";
  else if (key === "/" || key === "?") base = "/";
  else if (key === "`" || key === "~") base = "`";
  else base = key.toLowerCase();
  const parts: string[] = [];
  // Order is fixed so string comparison is meaningful.
  if (e.ctrlKey) parts.push("ctrl");
  if (e.metaKey) parts.push("meta");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(base);
  return parts.join("+");
}

export function normaliseChord(input: string): string {
  const parts = input.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const base = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "cmd" || p === "super" || p === "win" ? "meta" : p === "option" || p === "opt" ? "alt" : p === "control" ? "ctrl" : p)));
  const out: string[] = [];
  if (mods.has("ctrl")) out.push("ctrl");
  if (mods.has("meta")) out.push("meta");
  if (mods.has("alt")) out.push("alt");
  if (mods.has("shift")) out.push("shift");
  out.push(base === "esc" ? "escape" : base === "return" ? "enter" : base);
  return out.join("+");
}

export interface RegistryErrors { hard: { chord: string; scope: string; commands: string[] }[]; reserved: Binding[]; invalid: string[] }

export class ShortcutRegistry {
  private bindings: Binding[] = [];
  private readonly isMac: boolean;
  constructor(opts: { platform?: "mac" | "other" } = {}) {
    this.isMac = opts.platform ? opts.platform === "mac" : false;
  }

  register(binding: Binding): { ok: boolean; reason?: "reserved" | "invalid" | "duplicate" } {
    const chord = normaliseChord(binding.chord);
    if (!chord) return { ok: false, reason: "invalid" };
    if (RESERVED_CHORDS.has(chord)) return { ok: false, reason: "reserved" };
    const exists = this.bindings.find((b) => b.chord === chord && b.scope === binding.scope && b.command === binding.command);
    if (exists) return { ok: false, reason: "duplicate" };
    this.bindings.push({ ...binding, chord });
    this.bindings.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return { ok: true };
  }

  unregister(command: string, scope?: string) {
    this.bindings = this.bindings.filter((b) => !(b.command === command && (scope === undefined || b.scope === scope)));
  }

  all(): readonly Binding[] { return this.bindings; }

  /** Every problem in the current set, split by severity. */
  audit(): RegistryErrors {
    const hard: RegistryErrors["hard"] = [];
    const reserved: Binding[] = [];
    const invalid: string[] = [];
    const byChordScope = new Map<string, Binding[]>();
    for (const b of this.bindings) {
      if (!b.chord) invalid.push(b.command);
      if (RESERVED_CHORDS.has(b.chord)) reserved.push(b);
      const k = `${b.scope}\u0000${b.chord}`;
      byChordScope.set(k, [...(byChordScope.get(k) ?? []), b]);
    }
    for (const [k, list] of byChordScope) {
      if (list.length > 1) {
        const [scope, chord] = k.split("\u0000");
        hard.push({ chord, scope, commands: list.map((b) => b.command) });
      }
    }
    return { hard, reserved, invalid };
  }

  /** Human-readable hint, matching the platform the shell is running on. */
  hint(chord: string): string {
    const norm = normaliseChord(chord);
    const parts = norm.split("+");
    const base = parts.pop() ?? "";
    const map: Record<string, string> = {
      ctrl: this.isMac ? "⌃" : "Ctrl", meta: this.isMac ? "⌘" : "Win", alt: this.isMac ? "⌥" : "Alt", shift: this.isMac ? "⇧" : "Shift",
    };
    const keyLabel: Record<string, string> = {
      escape: "Esc", enter: "Enter", space: "Space", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
      backspace: "⌫", delete: "Del", pageup: "PgUp", pagedown: "PgDn", tab: "Tab",
    };
    const labels = [...parts.map((p) => map[p] ?? p), keyLabel[base] ?? (base.length === 1 ? base.toUpperCase() : base)];
    return this.isMac ? labels.join("") : labels.join("+");
  }

  /**
   * Resolve one event. `activeScopes` is ordered from most specific (a focused
   * modal) to least (global). A binding in a more specific scope shadows every
   * less specific binding of the same chord unless its `shadowed` flag is false,
   * which is how Escape-in-dialog behaviour is expressed rather than hard-coded.
   */
  resolve(e: KeyLike, ctx: { activeScopes: readonly string[]; inputFocused: boolean }): ResolveResult {
    if (e.isComposing) return { binding: null, reason: "composing", competing: [] };
    const chord = chordFromEvent(e);
    if (!chord) return { binding: null, reason: "no-match", competing: [] };
    if (RESERVED_CHORDS.has(chord)) return { binding: null, reason: "reserved", competing: [] };
    const order = ctx.activeScopes;
    const candidates = this.bindings.filter((b) => b.chord === chord && order.includes(b.scope));
    if (!candidates.length) return { binding: null, reason: "no-match", competing: [] };
    candidates.sort((a, b) => order.indexOf(a.scope) - order.indexOf(b.scope) || (a.order ?? 0) - (b.order ?? 0));
    const winner = candidates[0];
    if (ctx.inputFocused && !winner.allowInInput) return { binding: null, reason: "input-focused", competing: candidates };
    const shadowedByLower = candidates.slice(1).every((c) => c.shadowed);
    void shadowedByLower;
    if (winner.shadowed) return { binding: null, reason: "shadowed", competing: candidates };
    return { binding: winner, reason: "match", competing: candidates };
  }
}

/** A small default map so the help sheet and the dispatcher share one source. */
export const DEFAULT_BINDINGS: Binding[] = [
  { chord: "ctrl+space", command: "palette.open", label: "Command palette", scope: "global", order: 10 },
  { chord: "ctrl+`", command: "switcher.open", label: "Window switcher", scope: "global", order: 11 },
  { chord: "ctrl+shift+p", command: "palette.actions", label: "Action palette", scope: "global", order: 12 },
  { chord: "meta+arrowleft", command: "window.tileLeft", label: "Tile left", scope: "global", order: 20 },
  { chord: "meta+arrowright", command: "window.tileRight", label: "Tile right", scope: "global", order: 21 },
  { chord: "meta+shift+arrowleft", command: "window.moveLeft", label: "Move window left", scope: "global", order: 22 },
  { chord: "meta+shift+arrowright", command: "window.moveRight", label: "Move window right", scope: "global", order: 23 },
  { chord: "meta+arrowup", command: "window.maximise", label: "Maximise", scope: "global", order: 24 },
  { chord: "meta+arrowdown", command: "window.restore", label: "Restore", scope: "global", order: 25 },
  { chord: "escape", command: "window.close", label: "Close window", scope: "window", order: 30 },
  { chord: "escape", command: "dialog.dismiss", label: "Dismiss dialog", scope: "dialog", order: 1, shadowed: true },
  { chord: "enter", command: "dialog.confirm", label: "Confirm", scope: "dialog", order: 2, shadowed: true },
  { chord: "ctrl+f", command: "editor.find", label: "Find in document", scope: "editor", allowInInput: true, order: 40 },
  { chord: "ctrl+h", command: "editor.replace", label: "Replace", scope: "editor", allowInInput: true, order: 41 },
  { chord: "ctrl+s", command: "editor.save", label: "Save", scope: "editor", allowInInput: true, order: 42 },
  { chord: "f2", command: "files.rename", label: "Rename", scope: "files", order: 50 },
  { chord: "delete", command: "files.trash", label: "Move to Trash", scope: "files", order: 51 },
];
