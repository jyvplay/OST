"use client";
/**
 * TT69 FF-15: "Save changes?" — the one modal of the document lifecycle (close a dirty window, Quit, Close all, or
 * Writer's New over unsaved work).
 *
 * Modality is enforced by mechanism, not by focus alone (a focus-trapped dialog still lets window-level shortcut
 * listeners act behind it — Editor's Ctrl+S, the shell's Alt+F4 — and lets a script or a click re-focus the grid):
 *  1. the dialog is portaled to <body> and the shell root is made `inert` while it is open (nothing behind can be
 *     focused or clicked, and focus() on it fails);
 *  2. the dialog handles its own keys natively and stops them there, so they never bubble to document / window;
 *  3. a window CAPTURE listener swallows every key whose target is outside the dialog (the first listener on the
 *     event path), and pulls focus back to the dialog;
 *  4. a full-screen backdrop takes every pointer event.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { fz } from "@/lib/uiscale";

export interface CloseConfirmProps {
  title: string;
  /** a recovery draft is kept on "Don't save" (false for password-protected documents) */
  recoverable: boolean;
  /** "close" (closing the window) or "replace" (Writer's New over unsaved work) */
  mode: "close" | "replace";
  busy: boolean;
  error: string;
  queued: number;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

const KEY_EVENTS = ["keydown", "keyup", "keypress"] as const;

export default function CloseConfirm(p: CloseConfirmProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const saveBtn = useRef<HTMLButtonElement | null>(null);
  const cb = useRef(p);
  useEffect(() => { cb.current = p; });

  useEffect(() => {
    const el = box.current; if (!el) return;
    saveBtn.current?.focus();
    const own = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.type !== "keydown") return;
      if (e.key === "Escape") { e.preventDefault(); if (!cb.current.busy) cb.current.onCancel(); return; }
      if (e.key === "Tab") {
        const items = [...el.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
        if (!items.length) { e.preventDefault(); return; }
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i < 0 || i === items.length - 1 ? 0 : i + 1);
        e.preventDefault(); items[next].focus(); return;
      }
      // Enter / Space act on the focused button natively; every other key does nothing here
      if (e.key !== "Enter" && e.key !== " ") e.preventDefault();
    };
    const outside = (e: KeyboardEvent) => {
      if (e.target instanceof Node && el.contains(e.target)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.type === "keydown") saveBtn.current?.focus();
    };
    for (const t of KEY_EVENTS) { el.addEventListener(t, own); window.addEventListener(t, outside, true); }
    return () => { for (const t of KEY_EVENTS) { el.removeEventListener(t, own); window.removeEventListener(t, outside, true); } };
  }, []);

  const body = p.mode === "replace"
    ? "Starting a new document replaces it."
    : p.recoverable
      ? "If you don't save, a recovery draft is kept: reopen the file to restore or discard it."
      : "This file is password-protected, so no recovery draft is kept — if you don't save, the changes are gone.";

  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-testid="close-confirm-backdrop" onPointerDown={(e) => { e.preventDefault(); saveBtn.current?.focus(); }}
      style={{ position: "fixed", inset: 0, zIndex: 2147483000, background: "rgba(6, 16, 24, 0.42)", display: "grid", placeItems: "center" }}>
      <div ref={box} role="alertdialog" aria-modal="true" aria-labelledby="fs-close-confirm-title" aria-describedby="fs-close-confirm-body"
        data-testid="close-confirm" className="fs-card" onPointerDown={(e) => e.stopPropagation()}
        style={{ width: "min(30rem, calc(100vw - 32px))", padding: 20, borderRadius: 16, display: "grid", gap: 12,
          background: "var(--fs-surface, #fff)", color: "var(--fs-text, #102030)", boxShadow: "0 18px 48px rgba(0,0,0,0.35)" }}>
        <h2 id="fs-close-confirm-title" style={{ margin: 0, fontSize: fz(18) }}>
          Save changes to “{p.title}”?
        </h2>
        <p id="fs-close-confirm-body" style={{ margin: 0, fontSize: fz(14), lineHeight: 1.5 }}>
          {body}{p.queued > 1 ? ` (${p.queued - 1} more document${p.queued > 2 ? "s" : ""} with unsaved changes after this one.)` : ""}
        </p>
        {p.error ? <p role="alert" data-testid="close-confirm-error" style={{ margin: 0, fontSize: fz(13), color: "var(--fs-bad, #b3261e)" }}>{p.error}</p> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" className="fs-btn" data-variant="ghost" data-testid="close-confirm-cancel" disabled={p.busy} onClick={() => p.onCancel()}>Cancel</button>
          <button type="button" className="fs-btn" data-variant="danger" data-testid="close-confirm-discard" disabled={p.busy} onClick={() => p.onDiscard()}>Don&apos;t save</button>
          <button ref={saveBtn} type="button" className="fs-btn" data-variant="primary" data-testid="close-confirm-save" disabled={p.busy} onClick={() => p.onSave()}>
            {p.busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
