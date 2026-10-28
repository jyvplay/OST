"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useShell } from "./shell-context";
import { createPortal } from "react-dom";
export interface OrbitAction { label: string; run: () => unknown; disabled?: boolean }
/** Local-only menu: no clipboard reads, network requests or synthetic keyboard commands. */
export default function OrbitMenu({ x, y, actions, close }: { x: number; y: number; actions: OrbitAction[]; close: () => void }) {
  const shell = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const returnFocus = useRef(true);
  const origin = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    returnFocus.current = true;
    origin.current = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const place = () => { const r = el.getBoundingClientRect(); el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`; el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`; };
    place(); const observer = new ResizeObserver(place); observer.observe(el); const first = el.querySelector<HTMLButtonElement>('button:not(:disabled)'); if (first) { first.tabIndex = 0; first.focus(); }
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('resize', close); observer.disconnect(); if (returnFocus.current && origin.current?.isConnected) origin.current.focus(); };
  }, [x, y, close]);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key); };
  }, [close]);
  return createPortal(<div ref={ref} role="menu" aria-label="Orbit actions" className="fs-panel" onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }} onPointerDown={e => e.stopPropagation()}
    style={{ position: 'fixed', left: x, top: y, zIndex: 20000, padding: 4, maxWidth: 'calc(100vw - 8px)', maxHeight: 'calc(100vh - 8px)', overflow: 'auto' }}
    onFocusCapture={e => { const item = (e.target as Element).closest('button[role="menuitem"]'); if (item) ref.current?.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.tabIndex = b === item ? 0 : -1; }); }}
    onKeyDown={e => {
      const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : e.key === 'ArrowUp' ? (i - 1 + buttons.length) % buttons.length : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : -1;
      const focus = (index: number) => { buttons.forEach((b, j) => { b.tabIndex = j === index ? 0 : -1; }); buttons[index]?.focus(); };
      if (next >= 0) { e.preventDefault(); focus(next); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
        e.preventDefault(); const now = performance.now();
        typed.current.text = now - typed.current.at > 700 ? e.key.toLocaleLowerCase() : typed.current.text + e.key.toLocaleLowerCase(); typed.current.at = now;
        const text = typed.current.text, prefix = [...text].every(c => c === text[0]) ? text[0] : text;
        const match = buttons.map((_, n) => (i + n + 1) % buttons.length).find(n => buttons[n].textContent?.trim().toLocaleLowerCase().startsWith(prefix));
        if (match !== undefined) focus(match);
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const originNode = origin.current;
        const outside = [...document.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]')].filter(el => !ref.current?.contains(el) && el.tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]') && el.getClientRects().length > 0);
        const i = originNode ? outside.indexOf(originNode) : -1;
        const next = i >= 0 ? outside[i + (e.shiftKey ? -1 : 1)] : e.shiftKey ? outside.filter(el => !!originNode && !!(originNode.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)).at(-1) : outside.find(el => !!originNode && !!(originNode.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        returnFocus.current = false; close(); (next ?? originNode)?.focus();
      }
    }}>
    {actions.map(a => <button key={a.label} role="menuitem" tabIndex={-1} disabled={a.disabled} className="fs-btn" data-variant="ghost" style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }} onClick={() => { close(); void Promise.resolve().then(a.run).catch((e: unknown) => shell.toast(e instanceof Error ? e.message : String(e), "bad")); }}>{a.label}</button>)}
  </div>, document.body);
}
