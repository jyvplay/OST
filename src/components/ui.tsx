"use client";
import { fz } from "@/lib/uiscale";

import type { ReactNode } from "react";
import { UiGlyph } from "./AppIcon";

export function Btn({
  children, onClick, variant = "default", disabled, title, type = "button", className = "", ...rest
}: {
  children: ReactNode; onClick?: (e: React.MouseEvent) => void;
  variant?: "default" | "ghost" | "primary" | "danger"; disabled?: boolean; title?: string;
  type?: "button" | "submit"; className?: string;
} & Record<string, unknown>) {
  return (
    <button type={type} className={`fs-btn ${className}`} data-variant={variant} onClick={onClick}
      disabled={disabled} title={title} {...rest}>
      {children}
    </button>
  );
}

export function Badge({ children, tone = "default", title, ...data }: { children: ReactNode; tone?: "default" | "ok" | "warn" | "bad" | "info"; title?: string } & { [k: `data-${string}`]: string | number | undefined }) {
  return <span className="fs-badge" data-tone={tone} title={title} {...data}>{children}</span>;
}

export function Section({ title, right, children, dense }: { title: string; right?: ReactNode; children: ReactNode; dense?: boolean }) {
  return (
    <section className="fs-panel" style={{ padding: dense ? 8 : 12, display: "grid", gap: 8 }}>
      <div className="fs-row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0, fontSize: fz(12), letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fs-muted)" }}>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="fs-row" style={{ justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
      <span className="fs-dim" style={{ fontSize: fz(11.5) }}>{k}</span>
      <span className={mono ? "fs-mono" : ""} style={{ fontSize: fz(11.5), textAlign: "right", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className = "" }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={`fs-row ${className}`} role="tablist" style={{ gap: 4, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className="fs-btn"
          data-variant={value === t.id ? "primary" : "ghost"} onClick={() => onChange(t.id)}>
          {t.label}{t.badge ? <span style={{ opacity: .7 }}>{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label, disabled, reason }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; reason?: string }) {
  return (
    <label className="fs-row" style={{ justifyContent: "space-between", opacity: disabled ? .55 : 1 }} title={reason}>
      <span style={{ fontSize: fz(12) }}>{label}</span>
      <button role="switch" aria-checked={on} aria-label={label} disabled={disabled}
        onClick={() => onChange(!on)}
        style={{
          width: 40, height: 22, borderRadius: 999, position: "relative", cursor: disabled ? "not-allowed" : "pointer",
          background: on ? "var(--fs-accent)" : "rgba(255,255,255,.12)", border: "1px solid var(--fs-border)",
        }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: 999,
          background: on ? "#04102b" : "#cfd8f0", transition: "left var(--fs-motion) ease",
        }} />
      </button>
    </label>
  );
}

/** `icon` is accepted for compatibility but no longer drawn: emoji render blank without a colour-emoji font (TT21). */
export function Empty({ title, hint }: { title: string; hint?: string; icon?: string }) {
  return (
    <div style={{ display: "grid", placeItems: "center", gap: 6, padding: 28, textAlign: "center", color: "var(--fs-muted)" }}>
      <div aria-hidden style={{ color: "var(--fs-warn)", display: "grid", placeItems: "center", width: fz(40), height: fz(40), borderRadius: 999, background: "rgba(255,196,83,.12)" }}><UiGlyph name="spark" size={20} /></div>
      <div style={{ fontSize: fz(13) }}>{title}</div>
      {hint ? <div style={{ fontSize: fz(11.5), maxWidth: `min(${fz(420)}, 100%)`, lineHeight: 1.5 }}>{hint}</div> : null}
    </div>
  );
}

/**
 * Capability-honest blocker. Used wherever the platform says no: it names the
 * missing primitive instead of showing a disabled control with no explanation.
 */
export function Blocked({ what, missing, workaround }: { what: string; missing: string; workaround?: string }) {
  return (
    <div className="fs-panel" style={{ padding: 10, borderColor: "rgba(255,107,107,.35)", display: "grid", gap: 4 }}>
      <div className="fs-row" style={{ gap: 6 }}>
        <Badge tone="bad">blocked</Badge><strong style={{ fontSize: fz(12) }}>{what}</strong>
      </div>
      <div className="fs-dim" style={{ fontSize: fz(11.5) }}>Missing primitive: <span className="fs-mono">{missing}</span></div>
      {workaround ? <div style={{ fontSize: fz(11.5) }}>Available instead: {workaround}</div> : null}
    </div>
  );
}
