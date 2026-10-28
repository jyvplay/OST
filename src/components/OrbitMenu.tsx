"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useShell } from "./shell-context";
import { createPortal } from "react-dom";
export interface OrbitAction { label: string; run: () => unknown; disabled?: boolean }
/** Local-only menu: no clipboard reads, network requests or synthetic keyboard commands. */
export default function OrbitMenu({ x, y, actions, close }: { x: number; y: number; actions: OrbitAction[]; close: () => void }) {
  const shell = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    origin.current = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const place = () => { const r = el.getBoundingClientRect(); el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`; el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`; };
    place(); const observer = new ResizeObserver(place); observer.observe(el); el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('resize', close); observer.disconnect(); if (origin.current?.isConnected) origin.current.focus(); };
  }, [x, y, close]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [close]);
  return createPortal(<div ref={ref} role="menu" aria-label="Orbit actions" className="fs-panel" onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }} onPointerDown={e => e.stopPropagation()}
    style={{ position: 'fixed', left: x, top: y, zIndex: 20000, padding: 4, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)', overflow: 'auto' }}
    onKeyDown={e => {
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : e.key === 'ArrowUp' ? (i - 1 + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
      if (next >= 0) { e.preventDefault(); buttons[next]?.focus(); }
      if (e.key === 'Tab') close();
    }}>
    {actions.map(a => <button key={a.label} role="menuitem" disabled={a.disabled} className="fs-btn" data-variant="ghost" style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => { close(); void Promise.resolve().then(a.run).catch((e: unknown) => shell.toast(e instanceof Error ? e.message : String(e), "bad")); }}>{a.label}</button>)}
  </div>, document.body);
}
