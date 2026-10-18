"use client";
import { useEffect, useRef, useState } from "react";
import { initialState, step, type PadAction, type PadSnapshot, type PointerState } from "@/lib/gamepad-pointer";

/**
 * TT37 — IN-07: a gamepad drives Fusion's pointer. Mounted once by the shell; idle (no rAF loop) until a pad
 * connects, and the loop pauses while the tab is hidden. The mapping is the pure src/lib/gamepad-pointer.ts; this
 * component applies it to the page: a visible cursor, pointer / mouse / click / contextmenu events at the element
 * under it, Escape, focus moves (the cursor jumps to the newly focused control) and scrolling of the nearest
 * scrollable box. Limits (stated in Devices → Gamepad): synthetic events cannot enter cross-origin or sandboxed
 * frames (embedded players, Private proxy pages), native <select> pop-ups do not open, and window dragging is not
 * mapped.
 */
const TABBABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function under(x: number, y: number): Element | null { return document.elementFromPoint(x, y); }
function fire(el: Element | null, type: string, x: number, y: number, extra: Partial<PointerEventInit> = {}) {
  if (!el) return;
  const init: PointerEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, pointerId: 7, pointerType: "mouse", isPrimary: true, ...extra };
  const ev = type.startsWith("pointer") ? new PointerEvent(type, init) : new MouseEvent(type, init);
  el.dispatchEvent(ev);
}
function scrollableFrom(el: Element | null): Element {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if ((/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight) || (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth)) return n;
  }
  return document.scrollingElement ?? document.documentElement;
}
function visible(el: Element): boolean { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }

export default function GamepadPointer() {
  const cursor = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState(""); // aria-live announcement
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let raf = 0, last = 0, st: PointerState | null = null, downOn: Element | null = null, pads = 0;
    const draw = (s: PointerState) => {
      const c = cursor.current; if (!c) return;
      c.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
      c.dataset.x = String(Math.round(s.x)); c.dataset.y = String(Math.round(s.y));
    };
    const apply = (a: PadAction, s: PointerState) => {
      const { x, y } = s;
      switch (a.type) {
        case "move": draw(s); fire(under(x, y), "pointermove", x, y, { buttons: s.held[0] ? 1 : 0 }); fire(under(x, y), "mousemove", x, y, { buttons: s.held[0] ? 1 : 0 }); break;
        case "down": downOn = under(x, y); fire(downOn, "pointerdown", x, y, { buttons: 1 }); fire(downOn, "mousedown", x, y, { buttons: 1 }); break;
        case "up": {
          const el = under(x, y);
          fire(el, "pointerup", x, y); fire(el, "mouseup", x, y);
          if (el && downOn && (el === downOn || downOn.contains(el) || el.contains(downOn))) {
            (el.closest(TABBABLE) as HTMLElement | null)?.focus({ preventScroll: true });
            fire(el, "click", x, y, { detail: 1 } as PointerEventInit);
          }
          downOn = null; break;
        }
        case "context": fire(under(x, y), "contextmenu", x, y, { button: 2, buttons: 2 }); break;
        case "escape": { const t = document.activeElement ?? document.body; for (const type of ["keydown", "keyup"]) t.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); break; }
        case "focus": {
          const list = (Array.from(document.querySelectorAll(TABBABLE)) as HTMLElement[]).filter(visible);
          if (!list.length) break;
          const i = list.indexOf(document.activeElement as HTMLElement);
          const next = list[(i < 0 ? (a.dir > 0 ? 0 : list.length - 1) : (i + a.dir + list.length) % list.length)];
          next.focus();
          const r = next.getBoundingClientRect();
          if (st) { st = { ...st, x: r.left + r.width / 2, y: r.top + r.height / 2 }; draw(st); }
          break;
        }
        case "scroll": scrollableFrom(under(x, y)).scrollBy({ top: a.dy, left: a.dx }); break;
        case "toggle": setShown(a.enabled); setLive(a.enabled ? "Gamepad pointer on" : "Gamepad pointer off"); break;
      }
    };
    const frame = (t: number) => {
      raf = 0;
      if (document.visibilityState !== "visible") return; // resumed by visibilitychange
      const pad = (Array.from(navigator.getGamepads?.() ?? []).find(Boolean) ?? null) as PadSnapshot | null;
      if (!pad) { stop(); return; }
      if (!st) { st = initialState(innerWidth, innerHeight); draw(st); setShown(true); setLive("Gamepad pointer on — press Start to turn it off"); }
      const r = step(st, pad, last ? t - last : 16, t, innerWidth, innerHeight);
      last = t; st = r.state;
      for (const a of r.actions) apply(a, st);
      raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; st = null; setShown(false); };
    const onConnect = () => { pads++; start(); };
    const onDisconnect = () => { pads = Math.max(0, pads - 1); if (!(Array.from(navigator.getGamepads?.() ?? []).some(Boolean))) { stop(); setLive("Gamepad disconnected"); } };
    const onVis = () => { if (document.visibilityState === "visible" && (pads || Array.from(navigator.getGamepads?.() ?? []).some(Boolean))) start(); };
    const onToggle = () => { if (st) { st = { ...st, enabled: !st.enabled }; apply({ type: "toggle", enabled: st.enabled }, st); } };
    addEventListener("gamepadconnected", onConnect); addEventListener("gamepaddisconnected", onDisconnect);
    document.addEventListener("visibilitychange", onVis); addEventListener("fusion:gamepad-toggle", onToggle);
    if (Array.from(navigator.getGamepads?.() ?? []).some(Boolean)) start(); // a pad already connected before mount
    return () => { stop(); removeEventListener("gamepadconnected", onConnect); removeEventListener("gamepaddisconnected", onDisconnect); document.removeEventListener("visibilitychange", onVis); removeEventListener("fusion:gamepad-toggle", onToggle); };
  }, []);
  return (
    <>
      <div ref={cursor} data-testid="gp-cursor" data-shown={shown ? "1" : "0"} aria-hidden="true"
        style={{ position: "fixed", left: 0, top: 0, width: 22, height: 22, marginLeft: -3, marginTop: -2, zIndex: 2147483646, pointerEvents: "none", display: shown ? "block" : "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.45))" }}>
        <svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13.2 19.3 L10.3 13 L16.5 13 Z" fill="#fff" stroke="#0b1a2a" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      </div>
      <div role="status" aria-live="polite" data-testid="gp-live" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{live}</div>
    </>
  );
}
