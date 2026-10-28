"use client";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
export function intersects(a: { left: number; top: number; right: number; bottom: number }, b: { left: number; top: number; right: number; bottom: number }) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
/** Blank-space primary drags only; row drags and native touch scrolling remain owned by their existing handlers. */
export function useMarquee(paths: string[], change: (paths: string[]) => void, selector: string) {
  const gesture = useRef<{ id: number; x: number; y: number; base: string[]; additive: boolean; moved: boolean } | null>(null);
  const suppress = useRef(false);
  const [box, setBox] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { const g = gesture.current; if (e.key === 'Escape' && g) { change(g.base); gesture.current = null; setBox(null); suppress.current = true; } };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, [change]);
  const finish = () => { gesture.current = null; setBox(null); };
  const handlers = {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (gesture.current || e.button !== 0 || e.pointerType === 'touch' || (e.target as Element).closest(`${selector},button,input,textarea,select,a,[contenteditable=true]`)) return;
      gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, base: [...paths], additive: e.ctrlKey || e.metaKey || e.shiftKey, moved: false };
      // preventDefault suppresses compatibility mousedown, so explicitly focus the owning surface.
      // Files uses focus capture to activate the correct side of a dual-pane window.
      suppress.current = false; e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault();
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const g = gesture.current; if (!g || g.id !== e.pointerId) return;
      if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 4) return;
      g.moved = true; suppress.current = true;
      const r = { left: Math.min(g.x, e.clientX), top: Math.min(g.y, e.clientY), right: Math.max(g.x, e.clientX), bottom: Math.max(g.y, e.clientY) };
      const bounds = e.currentTarget.getBoundingClientRect();
      const visible = { left: Math.max(r.left, bounds.left), top: Math.max(r.top, bounds.top), right: Math.min(r.right, bounds.right), bottom: Math.min(r.bottom, bounds.bottom) };
      const hits = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter(el => visible.left < visible.right && visible.top < visible.bottom && intersects(visible, el.getBoundingClientRect())).map(el => el.dataset.path!).filter(Boolean);
      change([...new Set([...(g.additive ? g.base : []), ...hits])]); setBox(r);
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) { if (gesture.current?.id === e.pointerId) finish(); },
    onPointerCancel(e: ReactPointerEvent<HTMLElement>) { const g = gesture.current; if (g?.id !== e.pointerId) return; change(g.base); finish(); },
    onLostPointerCapture(e: ReactPointerEvent<HTMLElement>) { if (gesture.current?.id === e.pointerId) finish(); },
    onClickCapture(e: React.MouseEvent<HTMLElement>) { if (suppress.current) { e.preventDefault(); e.stopPropagation(); suppress.current = false; } },
  };
  const overlay = box && createPortal(<div data-testid="orbit-marquee" aria-hidden="true" style={{ position: 'fixed', pointerEvents: 'none', zIndex: 19000, left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top, border: '1px solid var(--fs-accent)', background: 'color-mix(in srgb, var(--fs-accent) 18%, transparent)' }} />, document.body);
  return { handlers, overlay };
}
