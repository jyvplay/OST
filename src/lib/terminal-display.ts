/** Original VT display store. The parser owns mutable cells; React receives
 * copied text/style runs and scalar viewport/mode values, never Row buffers or
 * a Vt alias. Multiple incoming chunks coalesce into a native animation frame. */
import type { CSSProperties } from "react";
import { Vt, A, DEFAULT, RGB, type Row, type VtModes } from "./vt";

const BASE16 = ["#1b1e28", "#e0566c", "#4fc08d", "#e5b567", "#5aa6f0", "#c678dd", "#43c6d6", "#c8ccd4", "#5c6370", "#ff7a90", "#74e0a8", "#ffd48a", "#82c0ff", "#e19cf2", "#7fe3ee", "#ffffff"];
export const TERM_FG = "#e6edf7", TERM_BG = "#05080f";
const FG = TERM_FG, BG = TERM_BG;
function palette(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) { const i = n - 16, l = [0, 95, 135, 175, 215, 255]; return `rgb(${l[Math.floor(i / 36)]},${l[Math.floor(i / 6) % 6]},${l[i % 6]})`; }
  const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`;
}
const colour = (c: number, dflt: string) => (c === DEFAULT ? dflt : c & RGB ? `#${(c & 0xffffff).toString(16).padStart(6, "0")}` : palette(c));

function runs(row: Row, cursorX: number): { text: string; style: CSSProperties }[] {
  const out: { text: string; style: CSSProperties; key: string }[] = [];
  for (let x = 0; x < row.cols; x++) {
    const at = row.at[x];
    if (at & A.WIDE_CONT) continue;
    let fg = row.fg[x], bg = row.bg[x];
    const bold = (at & A.BOLD) !== 0;
    if (bold && fg >= 0 && fg < 8) fg += 8; // bold-as-bright for the 8 base colours (xterm default)
    let f = colour(fg, FG), b = colour(bg, "transparent");
    if (at & A.INVERSE) { const t = f; f = bg === DEFAULT ? BG : b; b = t; }
    if (x === cursorX) { const t = f; f = b === "transparent" ? BG : b; b = t; }
    const deco = [at & A.UNDERLINE ? "underline" : "", at & A.STRIKE ? "line-through" : "", at & A.OVERLINE ? "overline" : ""].filter(Boolean).join(" ");
    const key = `${f}|${b}|${bold}|${at & (A.ITALIC | A.DIM | A.HIDDEN)}|${deco}|${at & A.WIDE}|${x === cursorX}`;
    const ch = at & A.HIDDEN ? " " : row.ch[x] || " ";
    const last = out[out.length - 1];
    if (last && last.key === key && !(at & A.WIDE)) { last.text += ch; continue; }
    const style: CSSProperties = { color: f };
    if (b !== "transparent") style.background = b;
    if (bold) style.fontWeight = 700;
    if (at & A.ITALIC) style.fontStyle = "italic";
    if (at & A.DIM) style.opacity = 0.6;
    if (deco) style.textDecoration = deco;
    if (at & A.WIDE) { style.display = "inline-block"; style.width = "2ch"; }
    out.push({ text: ch, style, key });
  }
  return out;
}


export interface TerminalSnapshot {
  cols: number; rows: number; scroll: number; scrollback: number;
  cursor: { x: number; y: number }; showCursor: boolean; modes: VtModes;
  lines: { text: string; style: CSSProperties }[][];
}
/** The engine is private and is never returned by any API. Input handlers can
 * request fresh scalar values even before the next display frame is published. */
export class TerminalDisplay {
  private readonly engine: Vt;
  private listeners = new Set<() => void>();
  private bells = new Set<() => void>();
  private offset = 0;
  private frame: number | null = null;
  private snapshot: TerminalSnapshot;
  private readonly initial: TerminalSnapshot;
  constructor(cols = 80, rows = 24, history = 5000) {
    this.engine = new Vt(cols, rows, history);
    this.engine.onBell = () => { for (const listener of this.bells) listener(); };
    this.snapshot = this.project(); this.initial = this.snapshot;
  }
  getSnapshot = (): TerminalSnapshot => this.snapshot;
  getServerSnapshot = (): TerminalSnapshot => this.initial;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeBell = (listener: () => void): (() => void) => { this.bells.add(listener); return () => { this.bells.delete(listener); }; };
  connect(send: (text: string) => void, title: (text: string) => void): void {
    this.engine.onReply = send; this.engine.onTitle = title;
  }
  input() {
    const e = this.engine;
    return { cols: e.cols, rows: e.rows, modes: { ...e.modes }, isAlt: e.isAlt, scrollback: e.scrollback.length, scroll: this.offset };
  }
  write(data: string | Uint8Array): void { this.engine.write(data); this.queue(); }
  reset(): void { this.engine.reset(); this.offset = 0; this.publish(); }
  resize(cols: number, rows: number): boolean {
    if (cols === this.engine.cols && rows === this.engine.rows) return false;
    this.engine.resize(cols, rows); this.publish(); return true;
  }
  scrollTo(offset: number): void {
    const next = Math.max(0, Math.min(this.engine.scrollback.length, offset));
    if (next === this.offset) return;
    this.offset = next; this.publish();
  }
  scrollBy(delta: number): void { this.scrollTo(this.offset + delta); }
  private project(): TerminalSnapshot {
    const e = this.engine;
    // A remote clear/reset can shrink history while the reader is scrolled up.
    this.offset = Math.max(0, Math.min(e.scrollback.length, this.offset));
    const cursor = { ...e.cursor }, showCursor = this.offset === 0 && e.modes.cursorVisible;
    const lines: TerminalSnapshot["lines"] = [], top = e.scrollback.length - this.offset;
    for (let y = 0; y < e.rows; y++) {
      const index = top + y, row = index < e.scrollback.length ? e.scrollback[index] : e.screen[index - e.scrollback.length];
      lines.push(runs(row, showCursor && y === cursor.y ? Math.min(cursor.x, e.cols - 1) : -1));
    }
    return { cols: e.cols, rows: e.rows, scroll: this.offset, scrollback: e.scrollback.length, cursor, showCursor, modes: { ...e.modes }, lines };
  }
  private queue(): void {
    if (typeof requestAnimationFrame !== "function") { this.publish(); return; }
    if (this.frame === null) this.frame = requestAnimationFrame(() => { this.frame = null; this.publish(); });
  }
  publish(): void { if (this.frame !== null) { cancelAnimationFrame(this.frame); this.frame = null; } this.snapshot = this.project(); for (const listener of this.listeners) listener(); }
  dispose(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null; this.bells.clear(); this.listeners.clear();
    this.engine.onReply = () => undefined; this.engine.onTitle = () => undefined;
  }
}
