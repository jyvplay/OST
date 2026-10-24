"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { holdModal } from "@/lib/ask";
import { captureNextButton, guardedButtons, learnButton, mouseConfigFrom, MOUSE_BACK_KEY, MOUSE_FORWARD_KEY, navActionFor } from "@/lib/input";
import { fz } from "@/lib/uiscale";
import { useShell } from "./shell-context";
import { Badge, Btn, KV, Section } from "./ui";

/**
 * TT67 IN-02 "Learn my mouse". Press "Learn Back", then the button on YOUR mouse that should go back; the index the
 * browser reports is stored in settings (input.mouseBack / input.mouseForward) and used by the shell guard and by
 * every surface with its own history (Files). While learning, a modal overlay holds the shell's modal contract (no
 * global shortcut acts behind it); Escape or its Cancel button leaves without changing anything.
 */
export default function MouseButtonsSettings() {
  const shell = useShell();
  const cfg = mouseConfigFrom(shell.settings);
  const [learning, setLearning] = useState<null | "back" | "forward">(null);
  const [msg, setMsg] = useState("");
  const [probe, setProbe] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const name = (w: "back" | "forward") => (w === "back" ? "Back" : "Forward");

  useEffect(() => {
    if (!learning) return;
    const release = holdModal();
    dialogRef.current?.focus();
    const base = cfg;
    const dispose = captureNextButton((button, e) => {
      if (button === 0 && (e.target as Element | null)?.closest?.("[data-learn-cancel]")) {
        setMsg("Cancelled — nothing changed."); setLearning(null); return true;
      }
      const r = learnButton(base, learning, button);
      if (!r.ok) { setMsg(r.reason); return false; }
      const other = learning === "back" ? "forward" : "back";
      void (async () => {
        await shell.setSetting(MOUSE_BACK_KEY, String(r.cfg.back));
        await shell.setSetting(MOUSE_FORWARD_KEY, String(r.cfg.forward));
      })();
      setMsg(`${name(learning)} is now button ${button}.${r.swapped ? ` ${name(other)} moved to button ${r.cfg[other]} (they were swapped).` : ""}`);
      setLearning(null);
      return true;
    }, () => { setMsg("Cancelled — nothing changed."); setLearning(null); });
    return () => { dispose(); release(); };
    // the capture is (re)armed only when learning starts; cfg / shell are read at that moment on purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learning]);

  const isDefault = cfg.back === 3 && cfg.forward === 4;
  return (
    <Section title="Mouse buttons (Learn my mouse)">
      <KV k="Back" v={<span data-testid="mouse-back">button {cfg.back}</span>} />
      <KV k="Forward" v={<span data-testid="mouse-forward">button {cfg.forward}</span>} />
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={() => { setMsg(""); setLearning("back"); }}>Learn Back</Btn>
        <Btn variant="primary" onClick={() => { setMsg(""); setLearning("forward"); }}>Learn Forward</Btn>
        <Btn variant="ghost" disabled={isDefault} onClick={() => {
          void (async () => { await shell.setSetting(MOUSE_BACK_KEY, "3"); await shell.setSetting(MOUSE_FORWARD_KEY, "4"); })();
          setMsg("Reset to the browser's convention: Back = button 3, Forward = button 4.");
        }}>Reset</Btn>
        {isDefault ? <Badge tone="ok">browser convention</Badge> : <Badge tone="warn">learned</Badge>}
      </div>
      <div role="status" aria-live="polite" data-testid="mouse-learn-msg" style={{ fontSize: fz(12), minHeight: "1.4em" }}>{msg}</div>
      <div data-testid="mouse-probe" tabIndex={0} aria-label="Mouse button test pad"
        onMouseUp={(e) => {
          const act = navActionFor(cfg, e.button);
          setProbe(`button ${e.button} → ${act ? name(act) : e.button === 0 ? "main" : e.button === 2 ? "secondary" : "no action"}`);
        }}
        onContextMenu={(e) => e.preventDefault()}
        style={{ border: "1px dashed var(--fs-border, #888)", borderRadius: 10, padding: 12, fontSize: fz(12) }}>
        Test pad — press any mouse button here: <strong data-testid="mouse-probe-out">{probe || "…"}</strong>
      </div>
      <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
        Side buttons report different numbers depending on the mouse, driver and OS. The browser itself always treats
        buttons 3 and 4 as page Back / Forward, so those (and anything learned: {guardedButtons(cfg).join(", ")}) never
        navigate away from the desktop; learning decides what Files and other panes do.
      </div>
      {/* portalled to <body>: a window frame is a transformed ancestor, which would confine position:fixed to the window */}
      {learning && typeof document !== "undefined" ? createPortal(
        <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Learn mouse ${name(learning)} button`} tabIndex={-1}
          data-testid="mouse-learn-dialog"
          style={{ position: "fixed", inset: 0, zIndex: 9500, display: "grid", placeItems: "center", background: "rgba(8,20,30,.55)" }}>
          <div className="fs-panel" style={{ padding: 24, maxWidth: 420, textAlign: "center", display: "grid", gap: 12 }}>
            <strong style={{ fontSize: fz(16) }}>Press the button you use for {name(learning)}</strong>
            <span style={{ fontSize: fz(12) }}>Anywhere on the screen. Escape cancels.</span>
            {msg ? <span role="alert" style={{ fontSize: fz(12) }}>{msg}</span> : null}
            <span><button type="button" className="fs-btn" data-learn-cancel="">Cancel</button></span>
          </div>
        </div>, document.body,
      ) : null}
    </Section>
  );
}
