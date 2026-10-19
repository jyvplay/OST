/**
 * TT44 (TD-03): a VT100/VT220/xterm-compatible terminal emulator core — original code, no DOM, no dependencies, so the
 * same file renders in the SSH window and runs in Node tests (differentially checked against @xterm/headless, which
 * is test-only). Parser after the DEC ANSI state machine (ground / escape / CSI / OSC / DCS / SOS-PM-APC strings).
 *
 * Implemented: printing with autowrap (pending-wrap at the last column), wide (2-cell) and combining characters, DEC
 * special graphics (G0/G1, SI/SO), C0 controls, IND/NEL/RI/HTS/DECSC/DECRC/RIS/DECALN, CSI cursor motion (CUU…VPA,
 * HPA/HPR/VPR, CHT/CBT), ED/EL/ECH/ICH/DCH/IL/DL/SU/SD/REP, DECSTBM, SGR (16/256/truecolor, ':' and ';' forms,
 * underline styles collapse to underline), DSR/CPR, DA1/DA2, DECSTR, DECSCUSR, modes IRM/LNM and DECCKM, DECOM, DECAWM,
 * DECTCEM, DECSCNM, 47/1047/1048/1049 alternate screen, mouse 9/1000/1002/1003 + 1006 SGR, 1004 focus, 2004
 * bracketed paste, DECKPAM/DECKPNM; OSC 0/2 window title. Scrollback (primary screen only).
 * Width changes re-wrap the primary screen + scrollback (reflow, like xterm.js; the alternate screen is cut/padded like
 * xterm, as xterm.js also does) so long output survives a narrower window and comes back when it widens again.
 * Not implemented (disclosed): DECCOLM 132-column switching, sixel/ReGIS, DECLRMM left/right margins, OSC 52 clipboard (refused on purpose), OSC 4
 * palette changes, double-width/height lines (DECDWL).
 */

export const A = { BOLD: 1, DIM: 2, ITALIC: 4, UNDERLINE: 8, BLINK: 16, INVERSE: 32, HIDDEN: 64, STRIKE: 128, WIDE: 256, WIDE_CONT: 512, OVERLINE: 1024 } as const;
export const DEFAULT = -1;
/** truecolor values are stored as 0x1000000 | rgb */
export const RGB = 0x1000000;

export class Row {
  ch: string[]; fg: Int32Array; bg: Int32Array; at: Uint16Array; wrapped = false;
  constructor(cols: number, bg = DEFAULT) {
    this.ch = new Array<string>(cols).fill(" ");
    this.fg = new Int32Array(cols).fill(DEFAULT); this.bg = new Int32Array(cols).fill(bg); this.at = new Uint16Array(cols);
  }
  get cols(): number { return this.ch.length; }
  resize(cols: number): void {
    const n = this.ch.length;
    if (cols === n) return;
    if (cols < n) { this.ch.length = cols; this.fg = this.fg.slice(0, cols); this.bg = this.bg.slice(0, cols); this.at = this.at.slice(0, cols); if (cols && this.at[cols - 1] & A.WIDE) { this.ch[cols - 1] = " "; this.at[cols - 1] = 0; } return; }
    const fg = new Int32Array(cols).fill(DEFAULT), bg = new Int32Array(cols).fill(DEFAULT), at = new Uint16Array(cols);
    fg.set(this.fg); bg.set(this.bg); at.set(this.at);
    for (let i = n; i < cols; i++) this.ch.push(" ");
    this.fg = fg; this.bg = bg; this.at = at;
  }
  text(trimRight = true): string {
    let s = "";
    for (let i = 0; i < this.ch.length; i++) if (!(this.at[i] & A.WIDE_CONT)) s += this.ch[i] || " ";
    return trimRight ? s.replace(/\s+$/, "") : s;
  }
}

/** East-Asian wide / emoji = 2 cells; combining marks, ZWJ, variation selectors = 0; else 1 (Unicode 15 ranges, compact) */
const ZERO: [number, number][] = [[0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf], [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0610, 0x061a], [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4], [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a], [0x07a6, 0x07b0], [0x0816, 0x082d], [0x0900, 0x0902], [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d], [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0981], [0x09bc, 0x09bc], [0x09c1, 0x09c4], [0x09cd, 0x09cd], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x0eb1, 0x0eb1], [0x0eb4, 0x0ebc], [0x0ec8, 0x0ecd], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0x302a, 0x302d], [0x3099, 0x309a], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff], [0x1f3fb, 0x1f3ff], [0xe0100, 0xe01ef]];
const WIDE: [number, number][] = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4], [0x17000, 0x18cff], [0x1b000, 0x1b2ff], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567], [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d7], [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb], [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff], [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa88], [0x1fa90, 0x1fabd], [0x1fabf, 0x1fac5], [0x1face, 0x1fadb], [0x1fae0, 0x1fae8], [0x1faf0, 0x1faf8], [0x20000, 0x2fffd], [0x30000, 0x3fffd]];
function inRanges(cp: number, r: [number, number][]): boolean {
  let lo = 0, hi = r.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cp < r[m][0]) hi = m - 1; else if (cp > r[m][1]) lo = m + 1; else return true; }
  return false;
}
export function wcwidth(cp: number): number {
  if (cp < 0x300) return cp < 32 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  if (cp === 0x200d) return 0;
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}
const DEC_GRAPHICS: Record<string, string> = { "`": "◆", a: "▒", b: "␉", c: "␌", d: "␍", e: "␊", f: "°", g: "±", h: "␤", i: "␋", j: "┘", k: "┐", l: "┌", m: "└", n: "┼", o: "⎺", p: "⎻", q: "─", r: "⎼", s: "⎽", t: "├", u: "┤", v: "┴", w: "┬", x: "│", y: "≤", z: "≥", "{": "π", "|": "≠", "}": "£", "~": "·" };

interface Pen { fg: number; bg: number; at: number }
interface Saved { x: number; y: number; pen: Pen; origin: boolean; active: string; wrapnext: boolean }
interface Screen { rows: Row[]; x: number; y: number; wrapnext: boolean; top: number; bottom: number; saved: Saved | null; tabs: boolean[] }

export interface VtModes {
  appCursor: boolean; appKeypad: boolean; autowrap: boolean; origin: boolean; insert: boolean; newline: boolean; cursorVisible: boolean;
  reverseVideo: boolean; bracketedPaste: boolean; mouse: 0 | 9 | 1000 | 1002 | 1003; mouseSgr: boolean; focus: boolean; altScreen: boolean;
}

const enum_ = { GROUND: 0, ESC: 1, ESC_INT: 2, CSI: 3, CSI_IGNORE: 4, OSC: 5, STR: 6, DCS: 7 };

export class Vt {
  cols: number; rows: number;
  scrollback: Row[] = [];
  maxScrollback: number;
  title = "";
  cursorStyle = 0;
  modes: VtModes = { appCursor: false, appKeypad: false, autowrap: true, origin: false, insert: false, newline: false, cursorVisible: true, reverseVideo: false, bracketedPaste: false, mouse: 0, mouseSgr: false, focus: false, altScreen: false };
  /** bytes the terminal answers with (DSR/DA replies) — the caller sends them to the remote */
  onReply: (s: string) => void = () => undefined;
  onBell: () => void = () => undefined;
  onTitle: (t: string) => void = () => undefined;
  /** bumped on every visible change, for renderers */
  version = 0;
  private main: Screen; private alt: Screen; private s: Screen;
  private pen: Pen = { fg: DEFAULT, bg: DEFAULT, at: 0 };
  private charsets = ["B", "B", "B", "B"]; private gl = 0; private active = "B";
  private state = enum_.GROUND;
  private params: number[][] = []; private cur = -1; private sub = false; private prefix = ""; private inter = "";
  private osc = ""; private strEsc = false;
  private lastPrinted = "";
  private decoder = new TextDecoder("utf-8");

  constructor(cols = 80, rows = 24, maxScrollback = 5000) {
    this.cols = cols; this.rows = rows; this.maxScrollback = maxScrollback;
    this.main = this.newScreen(); this.alt = this.newScreen(); this.s = this.main;
    this.resetTabs();
  }
  /** tab stops live per screen (the alternate screen starts with the defaults, as in xterm.js) */
  private newScreen(): Screen { return { rows: Array.from({ length: this.rows }, () => new Row(this.cols)), x: 0, y: 0, wrapnext: false, top: 0, bottom: this.rows - 1, saved: null, tabs: Array.from({ length: this.cols }, (_, i) => i > 0 && i % 8 === 0) }; }
  private resetTabs(): void { for (const sc of [this.main, this.alt]) if (sc) sc.tabs = Array.from({ length: this.cols }, (_, i) => i > 0 && i % 8 === 0); }
  private get tabs(): boolean[] { return this.s.tabs; }

  // ------------------------------------------------------------------------------------------------- public view
  get cursor(): { x: number; y: number } { return { x: this.s.x, y: this.s.y }; }
  get screen(): Row[] { return this.s.rows; }
  get isAlt(): boolean { return this.s === this.alt; }
  /** the cursor sits past the last column waiting to wrap (xterm.js reports x === cols here) */
  get pendingWrap(): boolean { return this.s.wrapnext; }
  get scrollRegion(): { top: number; bottom: number } { return { top: this.s.top, bottom: this.s.bottom }; }
  lineText(y: number): string { return this.s.rows[y]?.text() ?? ""; }
  screenText(): string { return this.s.rows.map((r) => r.text()).join("\n").replace(/\n+$/, ""); }

  // ------------------------------------------------------------------------------------------------- input
  write(data: string | Uint8Array): void {
    const str = typeof data === "string" ? data : this.decoder.decode(data, { stream: true });
    for (const chr of str) this.feed(chr);
    this.version++;
  }
  private feed(chr: string): void {
    const cp = chr.codePointAt(0)!;
    switch (this.state) {
      case enum_.GROUND:
        if (cp < 0x20 || cp === 0x7f) return this.control(cp);
        return this.print(chr, cp);
      case enum_.ESC:
        if (cp === 0x1b) return;
        if (cp < 0x20) return this.control(cp);
        return this.escDispatch(chr);
      case enum_.ESC_INT:
        if (cp < 0x20) { if (cp === 0x18 || cp === 0x1a) this.state = enum_.GROUND; return; }
        if (cp >= 0x20 && cp <= 0x2f) { this.inter += chr; return; }
        this.escIntDispatch(chr); return;
      case enum_.CSI: case enum_.CSI_IGNORE:
        if (cp === 0x1b) { this.state = enum_.ESC; this.inter = ""; return; }
        if (cp === 0x18 || cp === 0x1a) { this.state = enum_.GROUND; return; }
        if (cp < 0x20) return this.control(cp);
        if (cp >= 0x30 && cp <= 0x39) { if (this.state === enum_.CSI_IGNORE) return; if (this.inter) { this.state = enum_.CSI_IGNORE; return; } if (this.cur < 0) this.cur = 0; this.cur = Math.min(this.cur * 10 + (cp - 0x30), 99999); return; }
        if (cp === 0x3b || cp === 0x3a) { if (this.state === enum_.CSI_IGNORE) return; this.pushParam(cp === 0x3a); return; }
        if (cp >= 0x3c && cp <= 0x3f) { if (this.params.length || this.cur >= 0 || this.prefix || this.inter) this.state = enum_.CSI_IGNORE; else this.prefix = chr; return; }
        if (cp >= 0x20 && cp <= 0x2f) { this.inter += chr; return; }
        if (cp >= 0x40 && cp <= 0x7e) { const ign = this.state === enum_.CSI_IGNORE; this.state = enum_.GROUND; if (!ign) { this.pushParam(false, true); this.csiDispatch(chr); } this.lastPrinted = ""; return; }
        return;
      case enum_.OSC:
        if (cp === 0x07) { this.oscDispatch(); this.state = enum_.GROUND; return; }
        if (this.strEsc) { this.strEsc = false; if (chr === "\\") { this.oscDispatch(); this.state = enum_.GROUND; return; } this.state = enum_.ESC; this.inter = ""; this.feed(chr); return; }
        if (cp === 0x1b) { this.strEsc = true; return; }
        if (cp === 0x18 || cp === 0x1a) { this.state = enum_.GROUND; return; }
        if (cp >= 0x20 && this.osc.length < 4096) this.osc += chr;
        return;
      case enum_.STR: case enum_.DCS:
        // DCS / SOS / PM / APC: collected until ST (ESC \\); only DECRQSS (DCS $ q … ST) is answered, nothing executed
        if (this.strEsc) { this.strEsc = false; if (chr === "\\") { if (this.state === enum_.DCS) this.dcsDispatch(); this.state = enum_.GROUND; return; } this.state = enum_.ESC; this.inter = ""; this.feed(chr); return; }
        if (cp === 0x1b) { this.strEsc = true; return; }
        if (cp === 0x18 || cp === 0x1a) { this.state = enum_.GROUND; return; }
        if (this.state === enum_.DCS && this.osc.length < 256) this.osc += chr;
        return;
    }
  }
  private pushParam(colon: boolean, final = false): void {
    const v = this.cur;
    if (this.sub && this.params.length) this.params[this.params.length - 1].push(v);
    else if (!(final && v < 0 && !this.params.length && !this.sub)) this.params.push([v]);
    this.sub = colon; this.cur = -1;
  }
  private p(i: number, def: number): number { const v = this.params[i]?.[0] ?? -1; return v < 0 || (v === 0 && def > 0) ? def : v; }

  private control(cp: number): void {
    const s = this.s;
    if (cp !== 0x1b) this.lastPrinted = ""; // ESC is judged by the sequence it starts (CSI b must still see the char)
    switch (cp) {
      case 0x07: this.onBell(); return;
      case 0x08: if (s.wrapnext) { s.wrapnext = false; } if (s.x > 0) s.x--; return;
      case 0x09: { if (s.wrapnext) return; let x = s.x + 1; while (x < this.cols - 1 && !this.tabs[x]) x++; s.x = Math.min(x, this.cols - 1); return; }
      case 0x0a: case 0x0b: case 0x0c: s.wrapnext = false; this.index(); if (this.modes.newline) s.x = 0; return;
      case 0x0d: s.x = 0; s.wrapnext = false; return;
      case 0x0e: this.setGl(1); return;
      case 0x0f: this.setGl(0); return;
      case 0x18: case 0x1a: this.state = enum_.GROUND; return;
      case 0x1b: this.state = enum_.ESC; this.inter = ""; return;
    }
  }

  // ------------------------------------------------------------------------------------------------- printing
  private print(chr: string, cp: number): void {
    const s = this.s;
    if (this.active === "0" && cp >= 0x60 && cp <= 0x7e) chr = DEC_GRAPHICS[chr] ?? chr;
    const w = wcwidth(cp);
    if (w === 0) {
      // combining: attach to the character just written
      let x = s.wrapnext ? s.x : s.x - 1, y = s.y;
      if (x < 0) return;
      const row = s.rows[y];
      if (row.at[x] & A.WIDE_CONT && x > 0) x--;
      row.ch[x] += chr;
      if (this.lastPrinted) this.lastPrinted += chr; // REP repeats the whole grapheme
      return;
    }
    if (s.wrapnext && this.modes.autowrap) { s.rows[s.y].wrapped = true; s.x = 0; this.index(); }
    s.wrapnext = false;
    if (w === 2 && s.x === this.cols - 1) {
      if (!this.modes.autowrap) return; // xterm drops a wide character that cannot fit when DECAWM is off
      else { const pr = s.rows[s.y]; this.penBlank(pr, s.x); pr.ch[s.x] = ""; /* "" = padding, not a typed space (reflow drops it) */ pr.wrapped = true; s.x = 0; this.index(); }
    }
    if (w === 2 && this.cols < 2) return;
    const row = s.rows[s.y];
    if (this.modes.insert) this.insertCells(row, s.x, w, true);
    // an orphaned half of a wide character becomes a blank in the CURRENT pen (xterm behaviour)
    if (row.at[s.x] & A.WIDE_CONT && s.x > 0) this.penBlank(row, s.x - 1);
    const end = s.x + w;
    if (end < this.cols && row.at[end] & A.WIDE_CONT) this.penBlank(row, end);
    row.ch[s.x] = chr; row.fg[s.x] = this.pen.fg; row.bg[s.x] = this.pen.bg; row.at[s.x] = (this.pen.at & ~(A.WIDE | A.WIDE_CONT)) | (w === 2 ? A.WIDE : 0);
    if (w === 2) { row.ch[s.x + 1] = ""; row.fg[s.x + 1] = this.pen.fg; row.bg[s.x + 1] = this.pen.bg; row.at[s.x + 1] = (this.pen.at & ~A.WIDE) | A.WIDE_CONT; }
    this.lastPrinted = chr;
    s.x += w;
    if (s.x >= this.cols) { s.x = this.cols - 1; s.wrapnext = true; }
  }
  /** writing over half of a wide character blanks the other half */
  private clearWideAt(row: Row, x: number): void {
    if (x < 0 || x >= row.cols) return;
    if (row.at[x] & A.WIDE && x + 1 < row.cols) this.putBlank(row, x + 1);
    else if (row.at[x] & A.WIDE_CONT && x > 0) this.putBlank(row, x - 1);
  }
  private penBlank(row: Row, x: number): void { row.ch[x] = " "; row.fg[x] = this.pen.fg; row.bg[x] = this.pen.bg; row.at[x] = this.pen.at & ~(A.WIDE | A.WIDE_CONT); }
  private putBlank(row: Row, x: number): void { row.ch[x] = " "; row.fg[x] = DEFAULT; row.bg[x] = this.pen.bg; row.at[x] = 0; }
  private blankRow(): Row { return new Row(this.cols, this.pen.bg); }

  // ------------------------------------------------------------------------------------------------- scrolling
  private index(): void {
    const s = this.s;
    if (s.y === s.bottom) this.scrollUp(1);
    else if (s.y < this.rows - 1) s.y++;
  }
  private reverseIndex(): void {
    const s = this.s;
    if (s.y === s.top) this.scrollDown(1);
    else if (s.y > 0) s.y--;
  }
  scrollUp(n: number): void {
    const s = this.s;
    n = Math.min(n, s.bottom - s.top + 1);
    for (let i = 0; i < n; i++) {
      const gone = s.rows.splice(s.top, 1)[0];
      s.rows.splice(s.bottom, 0, this.blankRow());
      if (s === this.main && s.top === 0) { this.scrollback.push(gone); if (this.scrollback.length > this.maxScrollback) this.scrollback.shift(); }
    }
  }
  private scrollDown(n: number, bce = true): void {
    const s = this.s;
    n = Math.min(n, s.bottom - s.top + 1);
    for (let i = 0; i < n; i++) { s.rows.splice(s.bottom, 1); s.rows.splice(s.top, 0, bce ? this.blankRow() : new Row(this.cols)); }
  }

  // ------------------------------------------------------------------------------------------------- ESC
  private escDispatch(chr: string): void {
    const s = this.s;
    this.state = enum_.GROUND;
    if (chr !== "[") this.lastPrinted = "";
    switch (chr) {
      case "[": this.state = enum_.CSI; this.params = []; this.cur = -1; this.sub = false; this.prefix = ""; this.inter = ""; return;
      case "]": this.state = enum_.OSC; this.osc = ""; this.strEsc = false; return;
      case "P": this.state = enum_.DCS; this.strEsc = false; this.osc = ""; return;
      case "X": case "^": case "_": this.state = enum_.STR; this.strEsc = false; return;
      case "7": this.saveCursor(); return;
      case "8": this.restoreCursor(); return;
      case "D": this.index(); s.wrapnext = false; return;
      case "E": this.index(); s.x = 0; s.wrapnext = false; return;
      case "H": this.tabs[s.x] = true; return;
      case "M": this.reverseIndex(); s.wrapnext = false; return;
      case "c": this.reset(); return;
      case "=": this.modes.appKeypad = true; return;
      case ">": this.modes.appKeypad = false; return;
      case "\\": return; // ST with nothing open
      case "n": this.setGl(2); return;
      case "o": this.setGl(3); return;
    }
    const cp = chr.codePointAt(0)!;
    if (cp >= 0x20 && cp <= 0x2f) { this.inter = chr; this.state = enum_.ESC_INT; }
  }
  private escIntDispatch(chr: string): void {
    this.state = enum_.GROUND;
    const i = this.inter;
    const slot = "()*+".indexOf(i[0] ?? "");
    if (slot >= 0) { this.charsets[slot] = chr === "0" ? "0" : "B"; if (slot === this.gl) this.active = this.charsets[slot]; return; }
    if (i === "#" && chr === "8") { // DECALN
      for (const r of this.s.rows) { r.wrapped = false; for (let x = 0; x < this.cols; x++) { r.ch[x] = "E"; r.fg[x] = this.pen.fg; r.bg[x] = this.pen.bg; r.at[x] = this.pen.at & ~(A.WIDE | A.WIDE_CONT); } }
      this.s.top = 0; this.s.bottom = this.rows - 1; this.s.x = 0; this.s.y = 0; this.s.wrapnext = false;
    }
  }
  private saveCursor(): void { const s = this.s; s.saved = { x: s.x, y: s.y, pen: { ...this.pen }, origin: this.modes.origin, active: this.active, wrapnext: s.wrapnext }; }
  /** GL invocation; `active` is the mapping in effect. DECSC/DECRC save / restore that mapping only (xterm model),
   *  not the G0–G3 designations or the GL level */
  private setGl(n: number): void { this.gl = n; this.active = this.charsets[n]; }
  private restoreCursor(): void {
    const s = this.s, v = s.saved;
    if (!v) { s.x = 0; s.y = 0; this.pen = { fg: DEFAULT, bg: DEFAULT, at: 0 }; this.modes.origin = false; s.wrapnext = false; this.active = "B"; return; }
    s.x = Math.min(v.x, this.cols - 1); s.y = Math.min(v.y, this.rows - 1); this.pen = { ...v.pen }; this.modes.origin = v.origin; this.active = v.active; s.wrapnext = v.wrapnext;
  }
  reset(): void {
    this.main = this.newScreen(); this.alt = this.newScreen(); this.s = this.main; this.scrollback = [];
    this.pen = { fg: DEFAULT, bg: DEFAULT, at: 0 }; this.charsets = ["B", "B", "B", "B"]; this.gl = 0; this.active = "B"; this.resetTabs();
    this.modes = { appCursor: false, appKeypad: false, autowrap: true, origin: false, insert: false, newline: false, cursorVisible: true, reverseVideo: false, bracketedPaste: false, mouse: 0, mouseSgr: false, focus: false, altScreen: false };
    this.title = ""; this.cursorStyle = 0;
  }
  private softReset(): void {
    const s = this.s;
    this.modes.cursorVisible = true; this.modes.insert = false; this.modes.origin = false; this.modes.autowrap = true; this.modes.appCursor = false; this.modes.appKeypad = false;
    this.modes.bracketedPaste = false; this.modes.focus = false;
    s.top = 0; s.bottom = this.rows - 1; this.pen = { fg: DEFAULT, bg: DEFAULT, at: 0 }; this.charsets = ["B", "B", "B", "B"]; this.gl = 0; this.active = "B"; s.saved = null;
  }

  // ------------------------------------------------------------------------------------------------- CSI
  private moveTo(x: number, y: number): void {
    const s = this.s;
    const top = this.modes.origin ? s.top : 0, bot = this.modes.origin ? s.bottom : this.rows - 1;
    s.x = Math.max(0, Math.min(this.cols - 1, x));
    s.y = Math.max(top, Math.min(bot, y + top));
    s.wrapnext = false;
  }
  private csiDispatch(f: string): void {
    const s = this.s, P = (i: number, d = 1) => this.p(i, d), pre = this.prefix, it = this.inter;
    if (it === "" && pre === "") {
      switch (f) {
        case "@": { const row = s.rows[s.y]; this.insertCells(row, s.x, Math.min(P(0), this.cols - s.x)); s.wrapnext = false; return; }
        case "A": { const lim = s.y >= s.top ? s.top : 0; s.y = Math.max(lim, s.y - P(0)); s.wrapnext = false; return; }
        case "B": case "e": { const lim = s.y <= s.bottom ? s.bottom : this.rows - 1; s.y = Math.min(lim, s.y + P(0)); s.wrapnext = false; return; }
        case "C": case "a": s.x = Math.min(this.cols - 1, s.x + P(0)); s.wrapnext = false; return;
        case "D": s.x = Math.max(0, Math.min(s.x, this.cols - 1) - P(0)); s.wrapnext = false; return;
        case "E": { const lim = s.y <= s.bottom ? s.bottom : this.rows - 1; s.y = Math.min(lim, s.y + P(0)); s.x = 0; s.wrapnext = false; return; }
        case "F": { const lim = s.y >= s.top ? s.top : 0; s.y = Math.max(lim, s.y - P(0)); s.x = 0; s.wrapnext = false; return; }
        case "G": case "`": s.x = Math.min(this.cols - 1, P(0) - 1); s.wrapnext = false; return;
        case "H": case "f": this.moveTo(P(1) - 1, P(0) - 1); return;
        case "I": for (let n = P(0); n > 0; n--) { let x = s.x + 1; while (x < this.cols - 1 && !this.tabs[x]) x++; s.x = Math.min(x, this.cols - 1); } s.wrapnext = false; return;
        case "Z": for (let n = P(0); n > 0; n--) { let x = s.x - 1; while (x > 0 && !this.tabs[x]) x--; s.x = Math.max(0, x); } s.wrapnext = false; return;
        // xterm util.c: ClearRight (EL0 / ECH), ClearBelow (ED0) and ClearScreen (ED2) reset the pending wrap;
        // EL1 / EL2 / ED1 do not. In the pending-wrap state the cursor IS on the last column, so EL0 erases it.
        case "J": { const m = P(0, 0); this.eraseDisplay(m); if (m === 0 || m === 2) s.wrapnext = false; return; }
        case "K": { const m = P(0, 0); this.eraseLine(m); if (m === 0) s.wrapnext = false; return; }
        case "L": case "M": {
          if (s.y < s.top || s.y > s.bottom) return;
          const n = Math.min(P(0), s.bottom - s.y + 1);
          for (let i = 0; i < n; i++) {
            if (f === "L") { s.rows.splice(s.bottom, 1); s.rows.splice(s.y, 0, this.blankRow()); }
            else { s.rows.splice(s.y, 1); s.rows.splice(s.bottom, 0, this.blankRow()); }
          }
          s.x = 0; s.wrapnext = false; return;
        }
        case "P": {
          const row = s.rows[s.y], n = Math.min(P(0), this.cols - s.x);
          // a wide char split by the deleted range loses its surviving half; one starting at x+n shifts intact
          this.clearWideAt(row, s.x); if (s.x + n < this.cols && row.at[s.x + n] & A.WIDE_CONT) this.putBlank(row, s.x + n);
          for (let x = s.x; x < this.cols; x++) {
            const from = x + n;
            if (from < this.cols) { row.ch[x] = row.ch[from]; row.fg[x] = row.fg[from]; row.bg[x] = row.bg[from]; row.at[x] = row.at[from]; } else this.putBlank(row, x);
          }
          s.wrapnext = false; return;
        }
        case "S": this.scrollUp(P(0)); return;
        case "T": if (this.params.length <= 1) this.scrollDown(P(0), false); return;
        case "X": { const row = s.rows[s.y], n = Math.min(P(0), this.cols - s.x); this.clearWideAt(row, s.x); this.clearWideAt(row, s.x + n - 1); for (let x = s.x; x < s.x + n; x++) this.putBlank(row, x); s.wrapnext = false; return; }
        case "b": { if (!this.lastPrinted) return; const n = Math.min(P(0), 65535); const cp = this.lastPrinted.codePointAt(0)!; for (let i = 0; i < n; i++) this.print(this.lastPrinted, cp); return; }
        case "c": if (P(0, 0) === 0) this.onReply("\x1b[?1;2c"); return;
        case "d": this.moveTo(s.x, P(0) - 1); return;
        case "g": { const m = P(0, 0); if (m === 0) this.tabs[s.x] = false; else if (m === 3) this.tabs.fill(false); return; }
        case "h": case "l": for (const [m] of this.params) this.setAnsiMode(m, f === "h"); return;
        case "m": return this.sgr();
        case "n": {
          const m = P(0, 0);
          if (m === 5) this.onReply("\x1b[0n");
          else if (m === 6) { const y = this.modes.origin ? s.y - s.top : s.y; this.onReply(`\x1b[${y + 1};${s.x + 1}R`); }
          return;
        }
        case "r": {
          const top = P(0) - 1, bot = Math.min(P(1, this.rows), this.rows) - 1;
          if (top < bot) { s.top = top; s.bottom = bot; this.moveTo(0, 0); }
          return;
        }
        case "s": this.saveCursor(); return;
        case "u": this.restoreCursor(); return;
        case "t": return; // window manipulation: ignored (no reports about the user's screen)
      }
      return;
    }
    if (pre === "?" && it === "") {
      if (f === "h" || f === "l") { for (const [m] of this.params) this.setDecMode(m, f === "h"); return; }
      if (f === "J") return this.eraseDisplay(P(0, 0));
      if (f === "K") return this.eraseLine(P(0, 0));
      if (f === "n" && P(0, 0) === 6) { const y = this.modes.origin ? s.y - s.top : s.y; this.onReply(`\x1b[?${y + 1};${s.x + 1}R`); }
      return;
    }
    if (pre === ">" && it === "" && f === "c") { if (P(0, 0) === 0) this.onReply("\x1b[>0;276;0c"); return; }
    if (pre === "" && it === "!" && f === "p") return this.softReset();
    if (pre === "" && it === " " && f === "q") { this.cursorStyle = P(0, 0); return; }
  }
  private setAnsiMode(m: number, on: boolean): void {
    if (m === 4) this.modes.insert = on;
    else if (m === 20) this.modes.newline = on;
  }
  private setDecMode(m: number, on: boolean): void {
    const md = this.modes;
    switch (m) {
      case 1: md.appCursor = on; return;
      case 5: md.reverseVideo = on; return;
      case 6: md.origin = on; this.moveTo(0, 0); return;
      case 7: md.autowrap = on; if (!on) this.s.wrapnext = false; return;
      case 25: md.cursorVisible = on; return;
      case 66: md.appKeypad = on; return;
      case 9: case 1000: case 1002: case 1003: md.mouse = on ? (m as VtModes["mouse"]) : 0; return;
      case 1004: md.focus = on; return;
      case 1006: md.mouseSgr = on; return;
      case 2004: md.bracketedPaste = on; return;
      case 1048: if (on) this.saveCursor(); else this.restoreCursor(); return;
      case 47: case 1047: case 1049: {
        // xterm: 1049 saves / restores the cursor even when the screen is already the requested one
        if (on === (this.s === this.alt)) { if (m === 1049) { if (on) this.saveCursor(); else this.restoreCursor(); } return; }
        if (on) {
          if (m === 1049) this.saveCursor();
          const x = this.s.x, y = this.s.y, wn = this.s.wrapnext;
          // a fresh alternate screen, cleared with the current background (BCE) and with its OWN saved cursor
          const keep = this.alt?.saved ?? null; // the alternate buffer's saved cursor survives re-entry (xterm.js)
          this.alt = this.newScreen(); this.alt.x = x; this.alt.y = y; this.alt.saved = keep; this.alt.wrapnext = wn;
          if (this.pen.bg !== DEFAULT) this.alt.rows = this.alt.rows.map(() => this.blankRow());
          this.s = this.alt; md.altScreen = true;
        } else {
          const x = this.s.x, y = this.s.y, wn = this.s.wrapnext;
          this.s = this.main; md.altScreen = false;
          if (m === 1049) this.restoreCursor(); else { this.s.x = x; this.s.y = y; this.s.wrapnext = wn; }
        }
        return;
      }
    }
  }
  private eraseCells(row: Row, from: number, to: number): void {
    this.clearWideAt(row, from); this.clearWideAt(row, to - 1);
    for (let x = from; x < to; x++) this.putBlank(row, x);
  }
  private eraseLine(m: number): void {
    const s = this.s, row = s.rows[s.y];
    if (m === 0) this.eraseCells(row, s.x, this.cols);
    else if (m === 1) this.eraseCells(row, 0, Math.min(s.x + 1, this.cols));
    else if (m === 2) this.eraseCells(row, 0, this.cols);
    if (m === 0 || m === 2) row.wrapped = false;
  }
  private eraseDisplay(m: number): void {
    const s = this.s;
    if (m === 0) { this.eraseLine(0); for (let y = s.y + 1; y < this.rows; y++) { s.rows[y] = this.blankRow(); } }
    else if (m === 1) { for (let y = 0; y < s.y; y++) s.rows[y] = this.blankRow(); this.eraseLine(1); }
    else if (m === 2) { for (let y = 0; y < this.rows; y++) s.rows[y] = this.blankRow(); }
    else if (m === 3) { this.scrollback = []; }
  }
  /** ICH / insert mode; `pen` = blanks in the full current pen (insert-mode printing) rather than erase attributes */
  private insertCells(row: Row, x: number, n: number, pen = false): void {
    // inserting INSIDE a wide character splits it (both halves blank); one starting at x moves intact
    if (row.at[x] & A.WIDE_CONT && x > 0) { if (pen) this.penBlank(row, x - 1); else this.putBlank(row, x - 1); this.putBlank(row, x); }
    for (let i = this.cols - 1; i >= x + n; i--) { row.ch[i] = row.ch[i - n]; row.fg[i] = row.fg[i - n]; row.bg[i] = row.bg[i - n]; row.at[i] = row.at[i - n]; }
    for (let i = x; i < Math.min(x + n, this.cols); i++) if (pen) this.penBlank(row, i); else this.putBlank(row, i);
    if (row.at[this.cols - 1] & A.WIDE) { if (pen) this.penBlank(row, this.cols - 1); else { row.ch[this.cols - 1] = " "; row.at[this.cols - 1] &= ~A.WIDE; } }
  }
  private sgr(): void {
    const ps = this.params.length ? this.params : [[0]];
    const pen = this.pen;
    for (let i = 0; i < ps.length; i++) {
      const g = ps[i], v = g[0] < 0 ? 0 : g[0];
      const ext = (): number | null => {
        // 38/48/58: ";5;n" / ";2;r;g;b" or colon sub-parameters "5:n" / "2::r:g:b" / "2:r:g:b"
        if (g.length > 1) {
          if (g[1] === 5) return g[2] >= 0 && g[2] <= 255 ? g[2] : null;
          if (g[1] === 2) { const c = g.length >= 6 ? g.slice(3, 6) : g.slice(2, 5); return c.length === 3 ? RGB | ((Math.max(0, c[0]) & 255) << 16) | ((Math.max(0, c[1]) & 255) << 8) | (Math.max(0, c[2]) & 255) : null; }
          return null;
        }
        const mode = ps[i + 1]?.[0];
        if (mode === 5) { const n = ps[i + 2]?.[0] ?? -1; i += 2; return n >= 0 && n <= 255 ? n : null; }
        if (mode === 2) { const r = ps[i + 2]?.[0] ?? 0, gg = ps[i + 3]?.[0] ?? 0, b = ps[i + 4]?.[0] ?? 0; i += 4; return RGB | ((Math.max(0, r) & 255) << 16) | ((Math.max(0, gg) & 255) << 8) | (Math.max(0, b) & 255); }
        return null;
      };
      if (v === 0) { pen.fg = DEFAULT; pen.bg = DEFAULT; pen.at = 0; }
      else if (v === 1) pen.at |= A.BOLD;
      else if (v === 2) pen.at |= A.DIM;
      else if (v === 3) pen.at |= A.ITALIC;
      else if (v === 4) { if (g.length > 1 && g[1] === 0) pen.at &= ~A.UNDERLINE; else pen.at |= A.UNDERLINE; }
      else if (v === 5 || v === 6) pen.at |= A.BLINK;
      else if (v === 7) pen.at |= A.INVERSE;
      else if (v === 8) pen.at |= A.HIDDEN;
      else if (v === 9) pen.at |= A.STRIKE;
      else if (v === 21) pen.at |= A.UNDERLINE;
      else if (v === 22) pen.at &= ~(A.BOLD | A.DIM);
      else if (v === 23) pen.at &= ~A.ITALIC;
      else if (v === 24) pen.at &= ~A.UNDERLINE;
      else if (v === 25) pen.at &= ~A.BLINK;
      else if (v === 27) pen.at &= ~A.INVERSE;
      else if (v === 28) pen.at &= ~A.HIDDEN;
      else if (v === 29) pen.at &= ~A.STRIKE;
      else if (v >= 30 && v <= 37) pen.fg = v - 30;
      else if (v === 38) { const c = ext(); if (c !== null) pen.fg = c; }
      else if (v === 39) pen.fg = DEFAULT;
      else if (v >= 40 && v <= 47) pen.bg = v - 40;
      else if (v === 48) { const c = ext(); if (c !== null) pen.bg = c; }
      else if (v === 49) pen.bg = DEFAULT;
      else if (v === 53) pen.at |= A.OVERLINE;
      else if (v === 55) pen.at &= ~A.OVERLINE;
      else if (v === 58) ext(); // underline colour: parsed and ignored
      else if (v >= 90 && v <= 97) pen.fg = v - 90 + 8;
      else if (v >= 100 && v <= 107) pen.bg = v - 100 + 8;
    }
  }
  /** DECRQSS — report a setting (the same answers xterm gives for these) */
  private dcsDispatch(): void {
    const m = /^[0-9;]*\$q([\s\S]*)$/.exec(this.osc);
    if (!m) return;
    const q = m[1], s = this.s;
    const v = q === "m" ? "1$r0m" : q === "r" ? `1$r${s.top + 1};${s.bottom + 1}r` : q === " q" ? `1$r${this.cursorStyle || 2} q` : q === '"q' ? '1$r0"q' : q === '"p' ? '1$r61;1"p' : "0$r";
    this.onReply(`\x1bP${v}\x1b\\`);
  }
  private oscDispatch(): void {
    const i = this.osc.indexOf(";");
    const code = i < 0 ? this.osc : this.osc.slice(0, i), arg = i < 0 ? "" : this.osc.slice(i + 1);
    if (code === "0" || code === "2") { this.title = arg.slice(0, 256); this.onTitle(this.title); }
    // 52 (clipboard) deliberately ignored: a remote host must not read or write the user's clipboard
  }

  // ------------------------------------------------------------------------------------------------- resize
  resize(cols: number, rows: number): void {
    cols = Math.max(2, Math.min(1000, cols | 0)); rows = Math.max(1, Math.min(500, rows | 0));
    if (cols === this.cols && rows === this.rows) return;
    const reflow = cols !== this.cols;
    for (const scr of [this.main, this.alt]) {
      if (reflow && scr === this.main) { this.reflowMain(cols, rows); continue; }
      for (const r of scr.rows) r.resize(cols);
      if (rows < this.rows) {
        // keep the cursor on screen: rows above it go to the scrollback (primary) / are dropped (alternate)
        let drop = this.rows - rows;
        while (drop > 0 && scr.y >= rows) { const g = scr.rows.shift()!; if (scr === this.main) this.scrollback.push(g); scr.y--; drop--; }
        scr.rows.length = rows;
      } else for (let i = this.rows; i < rows; i++) scr.rows.push(new Row(cols));
      scr.top = 0; scr.bottom = rows - 1;
      scr.x = Math.min(scr.x, cols - 1); scr.y = Math.min(scr.y, rows - 1); scr.wrapnext = false;
    }
    if (!reflow) for (const r of this.scrollback) r.resize(cols);
    while (this.scrollback.length > this.maxScrollback) this.scrollback.shift();
    this.cols = cols; this.rows = rows; this.resetTabs(); this.version++;
  }

  /** re-wrap the primary screen + scrollback to a new width; the cursor stays on the same character */
  private reflowMain(cols: number, rows: number): void {
    const m = this.main, all = [...this.scrollback, ...m.rows], curAbs = this.scrollback.length + m.y;
    const curOff = m.x + (m.wrapnext ? 1 : 0);
    const out: Row[] = []; let cy = -1, cx = 0, cWrap = false;
    const blank = (r: Row, x: number) => r.ch[x] === " " && r.at[x] === 0 && r.bg[x] === DEFAULT && r.fg[x] === DEFAULT;
    for (let i = 0; i < all.length;) {
      const start = i; while (i < all.length - 1 && all[i].wrapped) i++; const end = i++;
      // the logical line as (row, col) cell references; a blank cell a wide char was pushed past is padding, not text
      const cells: [Row, number][] = []; let cursorAt = -1;
      for (let k = start; k <= end; k++) {
        const r = all[k]; let n = r.cols;
        if (k < end && n > 0 && r.ch[n - 1] === "" && !(r.at[n - 1] & A.WIDE_CONT) && all[k + 1].at[0] & A.WIDE) n--;
        if (k === curAbs) cursorAt = cells.length + Math.min(curOff, n);
        for (let x = 0; x < n; x++) cells.push([r, x]);
      }
      let len = cells.length; while (len > 0 && blank(cells[len - 1][0], cells[len - 1][1])) len--;
      if (cursorAt >= 0) len = Math.max(len, Math.min(cursorAt, cells.length));
      let row = new Row(cols), x = 0; out.push(row);
      const place = () => { if (cursorAt >= 0 && cy < 0) { cy = out.length - 1; cx = x; } };
      for (let c = 0; c < len; c++) {
        const [r, ox] = cells[c]; const wide = (r.at[ox] & A.WIDE) !== 0;
        if (r.at[ox] & A.WIDE_CONT) { if (c === cursorAt) place(); continue; }
        if (x + (wide ? 2 : 1) > cols) { if (x < cols) row.ch[x] = ""; /* wide-char padding marker */ row.wrapped = true; row = new Row(cols); x = 0; out.push(row); }
        if (c === cursorAt) place();
        row.ch[x] = r.ch[ox]; row.fg[x] = r.fg[ox]; row.bg[x] = r.bg[ox]; row.at[x] = r.at[ox];
        if (wide && x + 1 < cols) { row.ch[x + 1] = ""; row.fg[x + 1] = r.fg[ox]; row.bg[x + 1] = r.bg[ox]; row.at[x + 1] = (r.at[ox] & ~A.WIDE) | A.WIDE_CONT; x += 2; } else x++;
      }
      if (cursorAt >= 0 && cy < 0) {
        // cursor sits after the line's last cell: a pending wrap if the row is exactly full
        if (x >= cols) { cy = out.length - 1; cx = cols - 1; cWrap = true; } else { cy = out.length - 1; cx = x; }
      }
    }
    if (cy < 0) { cy = out.length - 1; cx = 0; }
    while (out.length > cy + 1) { const r = out[out.length - 1]; if (r.text() !== "" || out[out.length - 2]?.wrapped) break; out.pop(); }
    let s0 = Math.max(0, out.length - rows); if (s0 > cy) s0 = cy;
    this.scrollback = out.slice(0, s0);
    m.rows = out.slice(s0, s0 + rows); while (m.rows.length < rows) m.rows.push(new Row(cols));
    m.y = cy - s0; m.x = Math.min(cx, cols - 1); m.wrapnext = cWrap;
    m.top = 0; m.bottom = rows - 1;
    if (m.saved) { m.saved.x = Math.min(m.saved.x, cols - 1); m.saved.y = Math.min(m.saved.y, rows - 1); }
  }
}

// --------------------------------------------------------------------------------------------------- keyboard
export interface KeyLike { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
/** the bytes a key press sends (xterm conventions; DECCKM / DECKPAM aware); null = not a terminal key */
export function keyToBytes(e: KeyLike, m: Pick<VtModes, "appCursor" | "appKeypad">): string | null {
  const mod = (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0);
  const csi = (final: string, num = "1") => (mod ? `\x1b[${num};${mod + 1}${final}` : num === "1" ? (m.appCursor && "ABCDHF".includes(final) ? `\x1bO${final}` : `\x1b[${final}`) : `\x1b[${num}${final}`);
  const tilde = (n: number) => (mod ? `\x1b[${n};${mod + 1}~` : `\x1b[${n}~`);
  switch (e.key) {
    case "ArrowUp": return csi("A"); case "ArrowDown": return csi("B"); case "ArrowRight": return csi("C"); case "ArrowLeft": return csi("D");
    case "Home": return csi("H"); case "End": return csi("F");
    case "Insert": return tilde(2); case "Delete": return tilde(3); case "PageUp": return tilde(5); case "PageDown": return tilde(6);
    case "F1": return mod ? `\x1b[1;${mod + 1}P` : "\x1bOP"; case "F2": return mod ? `\x1b[1;${mod + 1}Q` : "\x1bOQ";
    case "F3": return mod ? `\x1b[1;${mod + 1}R` : "\x1bOR"; case "F4": return mod ? `\x1b[1;${mod + 1}S` : "\x1bOS";
    case "F5": return tilde(15); case "F6": return tilde(17); case "F7": return tilde(18); case "F8": return tilde(19);
    case "F9": return tilde(20); case "F10": return tilde(21); case "F11": return tilde(23); case "F12": return tilde(24);
    case "Enter": return e.altKey ? "\x1b\r" : "\r";
    case "Backspace": return e.ctrlKey ? "\x08" : e.altKey ? "\x1b\x7f" : "\x7f";
    case "Tab": return e.shiftKey ? "\x1b[Z" : "\t";
    case "Escape": return "\x1b";
  }
  if (e.metaKey) return null;
  if (e.key.length === 1 || [...e.key].length === 1) {
    let ch = e.key;
    if (e.ctrlKey && !e.altKey) {
      const c = ch.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
      if (ch === " " || ch === "2" || ch === "@") return "\x00";
      if (ch === "/" || ch === "-" || ch === "_") return "\x1f";
      if (ch === "?") return "\x7f";
      if (ch >= "3" && ch <= "7") return String.fromCharCode(27 + (ch.charCodeAt(0) - 51));
      if (ch === "8") return "\x7f";
      return null;
    }
    if (e.ctrlKey && e.altKey) {
      // AltGr on many layouts arrives as Ctrl+Alt with the composed character: send it as text
      return ch;
    }
    if (e.altKey) return `\x1b${ch}`;
    return null; // plain text comes through the input event (IME / composition safe)
  }
  return null;
}

/** mouse report bytes (X10 / normal / button / any-event tracking; SGR 1006 or legacy encoding) */
export function mouseReport(m: Pick<VtModes, "mouse" | "mouseSgr">, kind: "down" | "up" | "move" | "wheel", button: number, x: number, y: number, mods: { shift: boolean; alt: boolean; ctrl: boolean }): string | null {
  if (!m.mouse) return null;
  if (kind === "move" && m.mouse !== 1002 && m.mouse !== 1003) return null;
  if (kind === "move" && m.mouse === 1002 && button < 0) return null;
  if ((kind === "up" || kind === "wheel") && m.mouse === 9) return null; // X10: button presses only
  let b = kind === "wheel" ? (button > 0 ? 65 : 64) : button < 0 ? 3 : button;
  if (kind === "move") b += 32;
  if (m.mouse !== 9) b |= (mods.shift ? 4 : 0) | (mods.alt ? 8 : 0) | (mods.ctrl ? 16 : 0);
  if (m.mouseSgr) return `\x1b[<${b};${x + 1};${y + 1}${kind === "up" ? "m" : "M"}`; // SGR release keeps the button
  if (kind === "up") b = (b & ~3) | 3; // legacy release: button 3
  if (x + 1 + 32 > 255 || y + 1 + 32 > 255) return null; // legacy bytes cannot carry it: dropped (xterm), never clamped
  const enc = (n: number) => String.fromCharCode(n + 32);
  return `\x1b[M${enc(b)}${enc(x + 1)}${enc(y + 1)}`;
}
