export type Preset = "hybrid" | "windows" | "mac";

export interface Binding {
  id: string;
  label: string;
  /** combos per preset, in the "Mod+Key" notation used by matchChord */
  hybrid: string;
  windows: string;
  mac: string;
  /** chords the browser keeps for itself unless Keyboard Lock is active */
  reservedBy?: string;
}

export const BINDINGS: Binding[] = [
  { id: "palette", label: "Command palette", hybrid: "Ctrl+Space", windows: "Ctrl+Space", mac: "Meta+Space" },
  { id: "launcher", label: "Launcher", hybrid: "Meta+A", windows: "Meta+A", mac: "Meta+Shift+A" },
  { id: "overview", label: "Overview", hybrid: "Meta+Q", windows: "Meta+Q", mac: "Ctrl+ArrowUp" },
  { id: "switcher", label: "Window switcher", hybrid: "Ctrl+Backquote", windows: "Alt+Tab", mac: "Meta+Backquote", reservedBy: "OS window switcher (Alt+Tab) — needs Keyboard Lock in fullscreen" },
  { id: "closeWindow", label: "Close window", hybrid: "Alt+F4", windows: "Alt+F4", mac: "Meta+W", reservedBy: "Ctrl/Cmd+W closes the browser tab" },
  { id: "tileLeft", label: "Tile left", hybrid: "Meta+ArrowLeft", windows: "Meta+ArrowLeft", mac: "Ctrl+Alt+ArrowLeft" },
  { id: "tileRight", label: "Tile right", hybrid: "Meta+ArrowRight", windows: "Meta+ArrowRight", mac: "Ctrl+Alt+ArrowRight" },
  { id: "maximize", label: "Maximise / restore", hybrid: "Meta+ArrowUp", windows: "Meta+ArrowUp", mac: "Ctrl+Alt+Enter" },
  { id: "minimize", label: "Minimise", hybrid: "Meta+ArrowDown", windows: "Meta+ArrowDown", mac: "Meta+M" },
  { id: "moveWindow", label: "Move window (16 px)", hybrid: "Meta+Shift+Arrows", windows: "Meta+Shift+Arrows", mac: "Ctrl+Shift+Arrows" },
  { id: "resizeWindow", label: "Resize window", hybrid: "Meta+Alt+Arrows", windows: "Meta+Alt+Arrows", mac: "Ctrl+Alt+Shift+Arrows" },
  { id: "workspaceNext", label: "Next workspace", hybrid: "Ctrl+Alt+ArrowRight", windows: "Ctrl+Alt+ArrowRight", mac: "Ctrl+ArrowRight" },
  { id: "files", label: "Open Files", hybrid: "Meta+E", windows: "Meta+E", mac: "Meta+Alt+E" },
  { id: "terminal", label: "Open Terminal", hybrid: "Ctrl+Alt+T", windows: "Ctrl+Alt+T", mac: "Ctrl+Alt+T" },
  { id: "alerts", label: "Alerts", hybrid: "Meta+N", windows: "Meta+N", mac: "Meta+Shift+N", reservedBy: "Ctrl/Cmd+N opens a browser window" },
  { id: "quickPanel", label: "Quick panel", hybrid: "Meta+I", windows: "Meta+I", mac: "Meta+Alt+I" },
  { id: "focusMode", label: "Focus mode", hybrid: "Meta+Shift+F", windows: "Meta+Shift+F", mac: "Meta+Ctrl+F" },
  { id: "cheatsheet", label: "Shortcut sheet", hybrid: "Shift+Slash", windows: "Shift+Slash", mac: "Shift+Slash" },
];

export const comboFor = (b: Binding, preset: Preset) => (preset === "windows" ? b.windows : preset === "mac" ? b.mac : b.hybrid);

/** Chords that the browser itself intercepts; the editor marks them explicitly. */
export const BROWSER_RESERVED = ["Ctrl+T", "Ctrl+N", "Ctrl+W", "Ctrl+Shift+T", "Ctrl+L", "Meta+T", "Meta+N", "Meta+W", "Alt+Tab", "F11"];

export function describeKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  const code = e.code || e.key;
  const key = code.startsWith("Key") ? code.slice(3)
    : code.startsWith("Digit") ? code.slice(5)
    : code;
  parts.push(key);
  return parts.join("+");
}

export function matchChord(e: KeyboardEvent, chord: string): boolean {
  const want = chord.split("+");
  const key = want[want.length - 1];
  const need = (m: string) => want.includes(m);
  if (e.ctrlKey !== need("Ctrl")) return false;
  if (e.altKey !== need("Alt")) return false;
  if (e.shiftKey !== need("Shift")) return false;
  if (e.metaKey !== need("Meta")) return false;
  if (key === "Arrows") return e.code.startsWith("Arrow");
  const code = e.code || e.key;
  if (key.length === 1) return code === `Key${key.toUpperCase()}` || code === `Digit${key}` || e.key.toUpperCase() === key.toUpperCase();
  return code === key;
}

export function conflicts(preset: Preset): { a: string; b: string; chord: string }[] {
  const seen = new Map<string, string>();
  const out: { a: string; b: string; chord: string }[] = [];
  for (const b of BINDINGS) {
    const chord = comboFor(b, preset);
    const prev = seen.get(chord);
    if (prev) out.push({ a: prev, b: b.id, chord });
    else seen.set(chord, b.id);
  }
  return out;
}
