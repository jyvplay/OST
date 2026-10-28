"use client";
import { useCallback, useState, type ReactNode } from 'react';
import OrbitMenu, { type OrbitAction } from './OrbitMenu';
/** An object-specific action surface. Editing descendants keep their browser menu. */
export default function OrbitTarget({ children, actions, label }: { children: ReactNode; actions: OrbitAction[]; label: string }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setPoint(null), []);
  return <div data-orbit-target={label} onContextMenu={e => {
    if (e.defaultPrevented || (e.target as Element).closest('input,textarea,select,[contenteditable],a,video,audio,canvas')) return;
    e.preventDefault(); e.stopPropagation();
    const target = (e.target as Element).closest<HTMLElement>('button,[tabindex]'); target?.focus({ preventScroll: true });
    setPoint({ x: e.clientX, y: e.clientY });
  }} onKeyDown={e => {
    if (e.defaultPrevented || (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) || (e.target as Element).closest('input,textarea,select,[contenteditable],a,video,audio,canvas')) return;
    e.preventDefault(); e.stopPropagation(); const r = (e.target as HTMLElement).getBoundingClientRect(); setPoint({ x: r.left, y: r.bottom });
  }}>
    {children}
    {point && <OrbitMenu x={point.x} y={point.y} actions={actions} close={close} />}
  </div>;
}
