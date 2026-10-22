/**
 * TT44 TEST-ONLY differential oracle for src/lib/vt.ts: the same bytes (split into the same random chunks — mid-UTF-8,
 * mid-escape) go into our emulator and into @xterm/headless (MIT, devDependency only); every visible cell's character,
 * width, colours and attributes, the cursor, the screen (normal/alternate) and the terminal's replies are compared.
 */
import { createRequire } from "node:module";
import { Vt, A, DEFAULT, RGB } from "../../src/lib/vt.ts";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as { Terminal: new (o: Record<string, unknown>) => XTerm };
const { Unicode11Addon } = require("@xterm/addon-unicode11") as { Unicode11Addon: new () => unknown };
interface XCell { getChars(): string; getWidth(): number; isFgDefault(): boolean; isFgPalette(): boolean; isFgRGB(): boolean; getFgColor(): number; isBgDefault(): boolean; isBgPalette(): boolean; isBgRGB(): boolean; getBgColor(): number; isBold(): number; isItalic(): number; isDim(): number; isUnderline(): number; isBlink(): number; isInverse(): number; isInvisible(): number; isStrikethrough(): number; isOverline(): number }
interface XTerm {
  write(d: string | Uint8Array, cb?: () => void): void; loadAddon(a: unknown): void; onData(f: (s: string) => void): void; dispose(): void;
  buffer: { active: { type: string; baseY: number; cursorX: number; cursorY: number; getLine(y: number): { getCell(x: number): XCell | undefined; translateToString(trim?: boolean): string } | undefined } };
  modes: { applicationCursorKeysMode: boolean; bracketedPasteMode: boolean; mouseTrackingMode: string; insertMode: boolean; originMode: boolean; wraparoundMode: boolean };
}

export interface DiffResult { mismatches: string[]; cells: number; oracleCrash?: string; notes?: string[] }
function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

const colorOf = (mode: "default" | "palette" | "rgb", v: number) => (mode === "default" ? DEFAULT : mode === "palette" ? v : RGB | v);

/** End index of the last complete UTF-8 sequence (an incomplete trailing lead + continuations is excluded). */
export function utf8Boundary(b: Uint8Array): number {
  for (let k = 1; k <= 3 && k <= b.length; k++) {
    const x = b[b.length - k];
    if ((x & 0xc0) === 0x80) continue;
    const need = x >= 0xf0 && x < 0xf8 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 1;
    return need > k ? b.length - k : b.length;
  }
  return b.length;
}

export async function diffRun(data: Uint8Array | string, cols: number, rows: number, seed = 1, opts: { checkModes?: boolean } = {}): Promise<DiffResult> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const vt = new Vt(cols, rows, 1000);
  const ours: string[] = [], theirs: string[] = [];
  vt.onReply = (s) => ours.push(s);
  const xt = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true, convertEol: false });
  // Unicode 11 widths (emoji = 2 cells, like glibc wcwidth / modern terminals); xterm.js defaults to Unicode 6
  xt.loadAddon(new Unicode11Addon()); (xt as unknown as { unicode: { activeVersion: string } }).unicode.activeVersion = "11";
  xt.onData((s) => theirs.push(s));
  const r = rng(seed);
  // Oracle defect (measured, TT63): xterm.js writeSync drops a 3-byte UTF-8 character when a chunk boundary falls
  // after its 2nd byte ("e2 80 | 94" loses the em dash). Ours still gets the raw random split; xterm gets the same
  // bytes with an incomplete trailing sequence held over to its next chunk.
  let carry = new Uint8Array(0);
  for (let i = 0; i < bytes.length;) {
    const n = 1 + Math.floor(r() * 200);
    const chunk = bytes.subarray(i, i + n); i += n;
    vt.write(chunk);
    const joined = new Uint8Array(carry.length + chunk.length); joined.set(carry); joined.set(chunk, carry.length);
    const cut = i >= bytes.length ? joined.length : utf8Boundary(joined);
    const feed = joined.subarray(0, cut); carry = joined.slice(cut);
    // synchronous parse so an exception INSIDE xterm.js is catchable (it has crashes of its own — reported, not a pass)
    try { (xt as unknown as { _core: { writeSync(d: Uint8Array): void } })._core.writeSync(feed); }
    catch (e) { xt.dispose(); return { mismatches: [], cells: 0, oracleCrash: String((e as Error).message ?? e) }; }
  }
  const mm: string[] = [];
  const b = xt.buffer.active;
  if ((b.type === "alternate") !== vt.isAlt) mm.push(`screen: ours ${vt.isAlt ? "alt" : "normal"} xterm ${b.type}`);
  const ox = vt.pendingWrap ? cols : vt.cursor.x;
  if (b.cursorX !== ox || b.cursorY !== vt.cursor.y) mm.push(`cursor: ours ${ox},${vt.cursor.y} xterm ${b.cursorX},${b.cursorY}`);
  // documented divergence: a cursor report in the pending-wrap state — xterm/VT100 give the last column (ours),
  // xterm.js gives cols+1
  const theirsN = theirs.join("").replace(new RegExp(`;${cols + 1}R`, "g"), `;${cols}R`);
  if (ours.join("") !== theirsN) mm.push(`replies: ours ${JSON.stringify(ours.join(""))} xterm ${JSON.stringify(theirs.join(""))}`);
  if (opts.checkModes !== false) {
    if (xt.modes.applicationCursorKeysMode !== vt.modes.appCursor) mm.push(`DECCKM ours ${vt.modes.appCursor}`);
    if (xt.modes.bracketedPasteMode !== vt.modes.bracketedPaste) mm.push(`bracketed paste ours ${vt.modes.bracketedPaste}`);
    if (xt.modes.insertMode !== vt.modes.insert) mm.push(`IRM ours ${vt.modes.insert}`);
    if (xt.modes.originMode !== vt.modes.origin) mm.push(`DECOM ours ${vt.modes.origin}`);
    if (xt.modes.wraparoundMode !== vt.modes.autowrap) mm.push(`DECAWM ours ${vt.modes.autowrap}`);
    const mt = ({ none: 0, x10: 9, vt200: 1000, drag: 1002, any: 1003 } as Record<string, number>)[xt.modes.mouseTrackingMode];
    if (mt !== vt.modes.mouse) mm.push(`mouse ours ${vt.modes.mouse} xterm ${xt.modes.mouseTrackingMode}`);
  }
  let cells = 0; const notes: string[] = [];
  for (let y = 0; y < rows && mm.length < 12; y++) {
    const xl = b.getLine(b.baseY + y), row = vt.screen[y];
    if (!xl) { mm.push(`row ${y}: missing in xterm`); continue; }
    const xs = xl.translateToString(true).replace(/\s+$/, ""), os = row.text(); // xterm.js keeps explicitly printed trailing spaces
    if (xs !== os) {
      // tag differences confined to the LAST column (classified by the caller: erase in the pending-wrap state)
      const oursHead = row.ch.slice(0, cols - 1).filter((_, i) => !(row.at[i] & A.WIDE_CONT)).join("").replace(/\s+$/, "");
      const theirsHead = xl.translateToString(true, 0, cols - 1).replace(/\s+$/, "");
      const tag = oursHead === theirsHead ? "lastcol: " : "";
      mm.push(`${tag}row ${y} text:\n      ours  ${JSON.stringify(os)}\n      xterm ${JSON.stringify(xs)}`); continue;
    }
    for (let x = 0; x < cols; x++) {
      const c = xl.getCell(x)!; cells++;
      const at = row.at[x];
      const w = at & A.WIDE ? 2 : at & A.WIDE_CONT ? 0 : 1;
      const xw = c.getWidth();
      // xterm.js can leave a zero-width continuation with no wide cell before it (ICH inside a wide char): an
      // invalid buffer state of the ORACLE — noted, not scored, provided ours holds a plain blank there
      if (xw === 0 && w === 1 && (x === 0 || xl.getCell(x - 1)!.getWidth() !== 2) && row.ch[x] === " ") { notes.push(`xterm-orphan (${x},${y})`); continue; }
      if (w !== xw) { mm.push(`${x === cols - 1 ? "lastcol: " : ""}(${x},${y}) width ours ${w} xterm ${xw}`); break; }
      if (w === 0) continue;
      const ch = c.getChars() || " ";
      if (ch !== (row.ch[x] || " ")) { mm.push(`${x === cols - 1 ? "lastcol: " : ""}(${x},${y}) char ours ${JSON.stringify(row.ch[x])} xterm ${JSON.stringify(ch)}`); break; }
      const xfg = colorOf(c.isFgDefault() ? "default" : c.isFgPalette() ? "palette" : "rgb", c.getFgColor());
      const xbg = colorOf(c.isBgDefault() ? "default" : c.isBgPalette() ? "palette" : "rgb", c.getBgColor());
      const blank = ch === " " && !(at & (A.INVERSE | A.UNDERLINE | A.STRIKE | A.OVERLINE));
      if (!blank && xfg !== row.fg[x]) { mm.push(`${x === cols - 1 ? "lastcol: " : ""}(${x},${y}) ${JSON.stringify(ch)} fg ours ${row.fg[x]} xterm ${xfg}`); break; }
      if (xbg !== row.bg[x]) { mm.push(`${x === cols - 1 ? "lastcol: " : ""}(${x},${y}) ${JSON.stringify(ch)} bg ours ${row.bg[x]} xterm ${xbg}`); break; }
      const flags: [string, number, number][] = [["bold", at & A.BOLD, c.isBold()], ["italic", at & A.ITALIC, c.isItalic()], ["dim", at & A.DIM, c.isDim()], ["underline", at & A.UNDERLINE, c.isUnderline()], ["blink", at & A.BLINK, c.isBlink()], ["inverse", at & A.INVERSE, c.isInverse()], ["invisible", at & A.HIDDEN, c.isInvisible()], ["strike", at & A.STRIKE, c.isStrikethrough()], ["overline", at & A.OVERLINE, c.isOverline()]];
      const bad = flags.find(([, o, t]) => !!o !== !!t);
      if (bad && !(blank && bad[0] !== "inverse")) { mm.push(`${x === cols - 1 ? "lastcol: " : ""}(${x},${y}) ${JSON.stringify(ch)} ${bad[0]} ours ${!!bad[1]} xterm ${!!bad[2]}`); break; }
    }
  }
  xt.dispose();
  return { mismatches: mm, cells, notes };
}

/** random but well-formed terminal traffic */
export function fuzzStream(seed: number, len = 400): string { return fuzzOps(seed, len).join(""); }
export function fuzzOps(seed: number, len = 400): string[] {
  const r = rng(seed * 7919 + 13);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const n = (max: number) => Math.floor(r() * max);
  const words = ["hello", "wörld", "日本", "😀", "e\u0301", "tab\t", "ab", "Z", "─┼─", "x".repeat(30), "한국", "αβγ"];
  const ops: (() => string)[] = [
    () => pick(words), () => pick(words) + " ", () => "\r\n", () => "\n", () => "\r", () => "\b", () => "\t",
    () => `\x1b[${n(30)};${n(90)}H`, () => `\x1b[${n(5)}${pick(["A", "B", "C", "D", "E", "F", "G", "d", "e", "a", "`", "I", "Z"])}`,
    () => `\x1b[${pick(["", "0", "1", "2"])}${pick(["J", "K"])}`, () => `\x1b[${n(4)}${pick(["@", "P", "X", "L", "M", "S", "T", "b"])}`,
    () => `\x1b[${n(10)};${10 + n(20)}r`, () => "\x1b[r", () => pick(["\x1b7", "\x1b8", "\x1b[s", "\x1b[u", "\x1bD", "\x1bE", "\x1bM", "\x1bH", "\x1b[g", "\x1b[3g"]),
    () => `\x1b[${pick(["0", "1", "2", "3", "4", "5", "7", "8", "9", "22", "23", "24", "27", "29", "53", "39", "49", String(30 + n(8)), String(40 + n(8)), String(90 + n(8)), String(100 + n(8)), `38;5;${n(256)}`, `48;5;${n(256)}`, `38;2;${n(256)};${n(256)};${n(256)}`, `48:2::${n(256)}:${n(256)}:${n(256)}`, "4:3", "4:0"])}m`,
    () => `\x1b[?${pick(["1", "7", "25", "47", "1047", "1049", "2004", "1000", "1002", "1006"])}${pick(["h", "l"])}`,
    () => `\x1b[4${pick(["h", "l"])}`, () => pick(["\x1b(0", "\x1b(B", "\x0e", "\x0f", "\x1b)0"]) + "lqqkxmj",
    () => "\x1b]0;title\x07", () => "\x1b]2;t\x1b\\", () => "\x1bP1$qm\x1b\\", () => pick(["\x1b[6n", "\x1b[5n", "\x1b[c", "\x1b[>c", "\x1b[?6n"]),
    () => "\x1b[!p",
  ];
  const out: string[] = [];
  for (let i = 0; i < len; i++) out.push(pick(ops)());
  return out;
}

/** shrinks a failing op list (prefix, then delta removal) to a small reproducer */
export async function minimize(ops: string[], cols: number, rows: number): Promise<string[]> {
  const fails = async (o: string[]) => (await diffRun(o.join(""), cols, rows, 1)).mismatches.length > 0;
  let lo = 1, hi = ops.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (await fails(ops.slice(0, mid))) hi = mid; else lo = mid + 1; }
  let cur = ops.slice(0, hi);
  for (let i = cur.length - 2; i >= 0; i--) { const t = cur.slice(0, i).concat(cur.slice(i + 1)); if (await fails(t)) cur = t; }
  return cur;
}

/** Known, documented divergence: xterm.js anchors DECSC's saved row to the BUFFER line (savedY = ybase + y), so a
 *  restore after the screen scrolled lands higher; xterm / VT510 restore the SCREEN row (what vt.ts does).
 *  Recognised only when every mismatch is a cursor line with equal x and a smaller xterm y, and the case restores. */
export function isSavedCursorAnchoring(ops: string[], mismatches: string[]): boolean {
  const restores = ops.some((o) => o.includes("\x1b8") || o.includes("\x1b[u") || o.includes("\x1b[?1049l"));
  if (!restores || !mismatches.length) return false;
  return mismatches.every((m) => {
    const r = /^cursor: ours (\d+),(\d+) xterm (\d+),(\d+)$/.exec(m);
    return !!r && r[1] === r[3] && Number(r[4]) < Number(r[2]);
  });
}

/** Known, documented divergence: in the pending-wrap state xterm.js keeps the cursor at x = cols, so EL / ED / ECH skip
 *  the last cell; xterm and the VT100 have the cursor ON the last column and erase it (vt.ts). Recognised only when
 *  every mismatch is confined to the last column and the case contains an erase. */
export function isPendingWrapErase(ops: string[], mismatches: string[]): boolean {
  return mismatches.length > 0 && mismatches.every((m) => m.startsWith("lastcol: ")) && ops.some((o) => /\x1b\[[0-9;?]*[JKX]/.test(o));
}

/** splits a byte/text stream into tokens at CSI boundaries (feeding tokens one by one == feeding the whole stream) */
export function csiTokens(data: string): string[] { return data.split(/(\x1b\[[0-?]*[ -/]*[@-~])/).filter((t) => t.length > 0); }

/** Counterfactual check for the pending-wrap-erase divergence: before every EL / ED / ECH that vt.ts receives while a
 *  wrap is pending, insert CUB 1 + CUF 1 (puts BOTH emulators on the last column, wrap not pending). If the case then
 *  matches, its mismatch is fully explained by that divergence. Returns false when no such erase occurs. */
export async function explainedByPendingWrapErase(ops: string[], cols: number, rows: number): Promise<boolean> {
  const toks = csiTokens(ops.join(""));
  const v = new Vt(cols, rows, 1000); let hit = false; const out: string[] = [];
  for (const t of toks) {
    if (/^\x1b\[[0-9;]*[JKX]$/.test(t) && v.pendingWrap) { hit = true; out.push("\x1b[1D\x1b[1C"); v.write("\x1b[1D\x1b[1C"); }
    out.push(t); v.write(t);
  }
  if (!hit) return false;
  const r = await diffRun(out.join(""), cols, rows, 1);
  return !r.oracleCrash && r.mismatches.length === 0;
}
