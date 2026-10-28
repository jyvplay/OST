"use client";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
export interface SelectionRect { left: number; top: number; right: number; bottom: number }
export function intersects(a: SelectionRect, b: SelectionRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
interface Gesture {
  id: number; owner: HTMLElement; scroll: HTMLElement; base: string[]; additive: boolean; moved: boolean;
  rx: number; ry: number; sx: number; sy: number; ax: number; ay: number; x: number; y: number; stamp: number; signature: string;
  apply: (paths: string[]) => void;
}
/** Blank-space mouse/pen gestures. Content-space anchors keep already crossed rows selected during scrolling. */
export function useMarquee(paths: string[], change: (paths: string[]) => void, selector: string) {
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const suppress = useRef(false);
  const [box, setBox] = useState<SelectionRect | null>(null);
  const finish = (cancel = false) => {
    const g = gesture.current; gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null;
    if (g) {
      if (cancel) g.apply(g.base);
      suppress.current = g.moved;
      if (g.owner.hasPointerCapture(g.id)) g.owner.releasePointerCapture(g.id);
    }
    setBox(null);
  };
  const update = () => {
    const g = gesture.current; if (!g || !g.moved) return;
    const bounds = g.scroll.getBoundingClientRect();
    const x = g.x - bounds.left + g.scroll.scrollLeft, y = g.y - bounds.top + g.scroll.scrollTop;
    const r = { left: Math.max(0, Math.min(g.ax, x)), top: Math.max(0, Math.min(g.ay, y)), right: Math.min(g.scroll.scrollWidth, Math.max(g.ax, x)), bottom: Math.min(g.scroll.scrollHeight, Math.max(g.ay, y)) };
    const hits = [...g.owner.querySelectorAll<HTMLElement>(selector)].filter(el => {
      // A pane may contain ancestor navigation columns. Only the chosen scroll surface participates.
      if (!g.scroll.contains(el)) return false;
      const b = el.getBoundingClientRect();
      return intersects(r, { left: b.left - bounds.left + g.scroll.scrollLeft, right: b.right - bounds.left + g.scroll.scrollLeft, top: b.top - bounds.top + g.scroll.scrollTop, bottom: b.bottom - bounds.top + g.scroll.scrollTop });
    }).map(el => el.dataset.path!).filter(Boolean);
    const result = [...new Set([...(g.additive ? g.base : []), ...hits])];
    const signature = JSON.stringify(result);
    if (signature !== g.signature) { g.signature = signature; g.apply(result); }
    setBox({ left: Math.max(bounds.left, r.left + bounds.left - g.scroll.scrollLeft), top: Math.max(bounds.top, r.top + bounds.top - g.scroll.scrollTop), right: Math.min(bounds.right, r.right + bounds.left - g.scroll.scrollLeft), bottom: Math.min(bounds.bottom, r.bottom + bounds.top - g.scroll.scrollTop) });
  };
  const tick = (stamp: number) => {
    frame.current = null;
    const g = gesture.current; if (!g || !g.moved) return;
    const b = g.scroll.getBoundingClientRect(), dt = Math.min(32, Math.max(0, stamp - g.stamp)); g.stamp = stamp;
    const velocity = (p: number, low: number, high: number) => p < low + 28 ? -Math.min(1, (low + 28 - p) / 28) : p > high - 28 ? Math.min(1, (p - high + 28) / 28) : 0;
    const vx = velocity(g.x, b.left, b.right), vy = velocity(g.y, b.top, b.bottom);
    // DOM scrolling may round fractional CSS pixels. Carry the remainder rather than
    // discarding it or imposing a refresh-rate-dependent minimum elapsed time.
    g.rx = vx ? g.rx + vx * dt * .7 : 0; g.ry = vy ? g.ry + vy * dt * .7 : 0;
    const dx = Math.trunc(g.rx), dy = Math.trunc(g.ry); g.rx -= dx; g.ry -= dy;
    g.scroll.scrollLeft += dx; g.scroll.scrollTop += dy;
    update();
    const canX = vx < 0 ? g.scroll.scrollLeft > 0 : vx > 0 && g.scroll.scrollLeft < g.scroll.scrollWidth - g.scroll.clientWidth;
    const canY = vy < 0 ? g.scroll.scrollTop > 0 : vy > 0 && g.scroll.scrollTop < g.scroll.scrollHeight - g.scroll.clientHeight;
    // A zero-pixel frame can still make fractional progress. Stop at a real bound,
    // not merely when this particular frame did not move an integer CSS pixel.
    if (canX || canY) frame.current = requestAnimationFrame(tick);
  };
  useEffect(() => {
    const cancel = () => finish(true);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && gesture.current) { e.preventDefault(); e.stopPropagation(); cancel(); } };
    const hidden = () => { if (document.hidden) cancel(); };
    const scroll = () => { if (gesture.current) update(); };
    window.addEventListener('keydown', key, true); window.addEventListener('blur', cancel); window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', hidden); document.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('blur', cancel); window.removeEventListener('resize', cancel); document.removeEventListener('visibilitychange', hidden); document.removeEventListener('scroll', scroll, true); };
  });
  useEffect(() => () => { gesture.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const handlers = {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (gesture.current || e.button !== 0) return;
      suppress.current = false;
      if (e.pointerType === 'touch' || (e.target as Element).closest(`${selector},button,input,textarea,select,a,nav,[contenteditable],[data-marquee-ignore]`)) return;
      const owner = e.currentTarget;
      let scroll = (e.target as Element).closest<HTMLElement>('.fs-scroll');
      if (!scroll || !owner.contains(scroll)) scroll = owner;
      const b = scroll.getBoundingClientRect();
      gesture.current = { id: e.pointerId, owner, scroll, rx: 0, ry: 0, sx: e.clientX, sy: e.clientY, ax: e.clientX - b.left + scroll.scrollLeft, ay: e.clientY - b.top + scroll.scrollTop, x: e.clientX, y: e.clientY, base: [...paths], additive: e.ctrlKey || e.metaKey || e.shiftKey, moved: false, stamp: performance.now(), signature: '', apply: change };
      owner.focus({ preventScroll: true }); owner.setPointerCapture(e.pointerId); e.preventDefault();
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const g = gesture.current; if (!g || g.id !== e.pointerId) return;
      g.x = e.clientX; g.y = e.clientY;
      if (!g.moved && Math.hypot(g.x - g.sx, g.y - g.sy) < 4) return;
      g.moved = true; update();
      if (frame.current === null) { g.stamp = performance.now(); frame.current = requestAnimationFrame(tick); }
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) { if (gesture.current?.id === e.pointerId) finish(); },
    onPointerCancel(e: ReactPointerEvent<HTMLElement>) { if (gesture.current?.id === e.pointerId) finish(true); },
    onLostPointerCapture(e: ReactPointerEvent<HTMLElement>) { if (gesture.current?.id === e.pointerId) finish(true); },
    onClickCapture(e: React.MouseEvent<HTMLElement>) { if (suppress.current) { e.preventDefault(); e.stopPropagation(); suppress.current = false; } },
  };
  const overlay = box && createPortal(<div data-testid="orbit-marquee" aria-hidden="true" style={{ position: 'fixed', pointerEvents: 'none', zIndex: 19000, left: box.left, top: box.top, width: Math.max(0, box.right - box.left), height: Math.max(0, box.bottom - box.top), border: '1px solid var(--fs-accent)', background: 'color-mix(in srgb, var(--fs-accent) 18%, transparent)' }} />, document.body);
  return { handlers, overlay };
}
