"use client";
/** Original reusable modal owner. Uses the existing shell-wide modal hold,
 * traps native keyboard traversal, and never lets an old instance steal focus. */
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { currentAsk, holdModal } from "@/lib/ask";
import { Btn } from "./ui";
import { fz } from "@/lib/uiscale";

export default function WorkflowDialog({ title, children, onClose, returnFocus }: { title: string; children: ReactNode; onClose: () => void; returnFocus?: HTMLElement | null }) {
  const box = useRef<HTMLElement>(null), id = useId();
  useLayoutEffect(() => {
    const release = holdModal(), previous = returnFocus ?? document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[data-initial-focus],button,textarea,input")?.focus();
    return () => { release(); if (previous?.isConnected) previous.focus(); };
  }, [returnFocus]);
  useLayoutEffect(() => {
    const close = () => onClose();
    // Disabling a focused async control can move native focus to <body>.
    // Recover only for the top workflow owner, without pre-empting AskHost or
    // the emergency privacy chord (whose window capture listener runs first).
    const recover = (event: KeyboardEvent) => {
      const current = box.current, owners = document.querySelectorAll("[data-workflow-dialog]");
      if (!current || currentAsk() || owners[owners.length - 1] !== current || current.contains(event.target as Node)) return;
      event.stopPropagation(); event.preventDefault();
      if (event.key === "Escape") onClose();
      else {
        const controls = [...current.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]')].filter(el => el.getClientRects().length);
        (event.key === "Tab" && event.shiftKey ? controls[controls.length - 1] : controls[0])?.focus();
      }
    };
    window.addEventListener("fusion:privacy-locked", close); document.addEventListener("keydown", recover, true);
    return () => { window.removeEventListener("fusion:privacy-locked", close); document.removeEventListener("keydown", recover, true); };
  }, [onClose]);
  if (typeof document === "undefined") return null;
  return createPortal(<div style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,.4)", display: "grid", placeItems: "center", padding: 16 }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") {
      event.preventDefault(); const controls = [...(box.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]') ?? [])].filter(el => el.getClientRects().length);
      const current = controls.indexOf(document.activeElement as HTMLElement), next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
    }
  }}><section ref={box} data-workflow-dialog role="dialog" aria-modal="true" aria-labelledby={id} className="fs-panel" style={{ width: "min(760px, 95vw)", maxHeight: "88vh", overflow: "auto", padding: 16, display: "grid", gap: 10 }}>
    <div className="fs-row" style={{ gap: 12, justifyContent: "space-between" }}><h2 id={id} style={{ margin: 0, fontSize: fz(18) }}>{title}</h2><Btn data-initial-focus onClick={onClose}>Close</Btn></div>
    {children}
  </section></div>, document.body);
}
