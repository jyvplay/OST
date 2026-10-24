"use client";
/**
 * TT28: renders the head of the ask queue (src/lib/ask.ts) as a modal dialog. Original code.
 *   - role="dialog" + aria-modal, labelled by its title, described by its detail text
 *   - focus moves to the first field (text selected, like prompt()), Tab / Shift+Tab are trapped inside, focus returns
 *     to whatever had it before when the dialog closes
 *   - Enter submits (after validation, with the error announced via role="alert"), Escape cancels
 *   - every key event is stopped at the dialog, so the Shell's global shortcuts can't act behind a modal
 *   - secret fields are type="password" with autocomplete off and an explicit Show toggle
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { answerAsk, currentAsk, subscribeAsk, askQueueLength, type AskRequest } from "@/lib/ask";
import { Btn } from "./ui";

export function AskHost() {
  const req = useSyncExternalStore(subscribeAsk, currentAsk, () => null);
  const waiting = useSyncExternalStore(subscribeAsk, askQueueLength, () => 0);
  if (!req) return null;
  return <AskDialog key={req.id} req={req} waiting={waiting - 1} />;
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]), [href], select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function AskDialog({ req, waiting }: { req: AskRequest; waiting: number }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(req.fields.map((f) => [f.name, f.def ?? ""])));
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const uid = useId();

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLInputElement>("input");
    first?.focus(); first?.select();
    return () => { if (prev && prev.isConnected && typeof prev.focus === "function") prev.focus(); };
  }, []);

  const submit = () => { const e = answerAsk(req.id, vals); if (e) setErr(e); };
  const cancel = () => { answerAsk(req.id, null); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
    if (e.key === "Tab" && box.current) {
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null || x === document.activeElement);
      if (!items.length) return;
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
      e.preventDefault(); items[next].focus();
    }
  };

  const single = req.fields.length === 1 && req.fields[0].label === req.title;
  return (
    <div className="fs-ask-backdrop" data-testid="ask-backdrop"
      onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) box.current?.querySelector<HTMLInputElement>("input")?.focus(); }}>
      <div ref={box} className="fs-panel fs-ask" role="dialog" aria-modal="true" aria-labelledby={`${uid}-t`} aria-describedby={req.detail ? `${uid}-d` : undefined}
        data-testid="ask-dialog" data-ask-id={req.id} onKeyDown={onKeyDown} onKeyUp={(e) => e.stopPropagation()}>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <h2 id={`${uid}-t`} className="fs-ask-title">{req.title}</h2>
          {req.detail ? <p id={`${uid}-d`} className="fs-ask-detail">{req.detail}</p> : null}
          {req.fields.map((f) => (
            <div key={f.name} className="fs-ask-field">
              <label htmlFor={`${uid}-${f.name}`} className={single ? "fs-visually-hidden" : "fs-ask-label"}>{f.label}</label>
              <div className="fs-row" style={{ gap: 6 }}>
                <input id={`${uid}-${f.name}`} className="fs-input fs-ask-input" data-testid={`ask-input-${f.name}`}
                  type={f.secret && !shown[f.name] ? "password" : "text"} autoComplete={f.secret ? "off" : undefined}
                  spellCheck={f.secret ? false : undefined} placeholder={f.placeholder} value={vals[f.name] ?? ""}
                  aria-invalid={err ? true : undefined} aria-describedby={err ? `${uid}-e` : undefined}
                  onChange={(e) => { const v = e.target.value; setVals((s) => ({ ...s, [f.name]: v })); if (err) setErr(""); }} />
                {f.secret ? (
                  <label className="fs-row fs-ask-show"><input type="checkbox" checked={!!shown[f.name]} data-testid={`ask-show-${f.name}`}
                    onChange={(e) => { const on = e.target.checked; setShown((s) => ({ ...s, [f.name]: on })); }} />Show</label>
                ) : null}
              </div>
            </div>
          ))}
          {err ? <p id={`${uid}-e`} role="alert" className="fs-ask-error" data-testid="ask-error">{err}</p> : null}
          <div className="fs-row fs-ask-actions">
            {waiting > 0 ? <span className="fs-dim" data-testid="ask-waiting">{waiting} more waiting</span> : null}
            <span style={{ flex: 1 }} />
            <Btn variant="ghost" onClick={cancel} data-testid="ask-cancel">Cancel</Btn>
            <Btn variant="primary" type="submit" data-testid="ask-ok">{req.okLabel}</Btn>
          </div>
        </form>
      </div>
    </div>
  );
}
