"use client";
/**
 * TT25 — pieces shared by the three main-UI layouts (Fusion top bar, Business taskbar, Art menu bar):
 * the privacy / cast status items, a ticking clock hook, a small accessible menu button and the layout switch
 * used by both Settings and the Quick panel.
 */
import { fz } from "@/lib/uiscale";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { privacy, type PrivacyStatus } from "@/lib/privacy/session";
import { LAYOUTS, LAYOUT_IDS, layoutOf, type LayoutId } from "@/lib/layout-core";
import { useShell } from "./shell-context";

export function useClock(periodMs = 10_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), periodMs);
    return () => window.clearInterval(t);
  }, [periodMs]);
  return now;
}

export function usePrivacyStatus(): PrivacyStatus | null {
  const [priv, setPriv] = useState<PrivacyStatus | null>(null);
  useEffect(() => privacy.subscribe((s) => setPriv(s)), []);
  return priv;
}

/** Beam "casting" stop button, the AMNESIC badge and the Private-unlocked lock button (same test ids everywhere). */
export function StatusItems({ compact = false }: { compact?: boolean }) {
  const shell = useShell();
  const priv = usePrivacyStatus();
  const pad = compact ? { minHeight: fz(22), padding: `0 ${fz(6)}`, fontSize: fz(11) } : undefined;
  return <>
    {shell.beam ? (
      <button className="fs-btn" data-variant="danger" onClick={() => shell.beam?.stop()} style={pad}
        title="A cast session is live — click to stop (UX-23)">
        ⏹ Casting · {shell.beam.transport} → {shell.beam.target}
      </button>
    ) : null}
    {priv?.amnesic ? (
      <button className="fs-btn" data-variant="primary" data-testid="amnesic-badge" onClick={() => shell.open("privacy")} style={pad}
        title={`Amnesic session: ${priv.ram.files} files in RAM, ${priv.blocked} host writes blocked — nothing new is written to this device`}>AMNESIC</button>
    ) : null}
    {priv && priv.storage === "unlocked" ? (
      <button className="fs-btn" data-variant="ghost" data-testid="storage-badge" onClick={() => { privacy.lock(); shell.bumpRefresh(); }} style={pad}
        title="Persistent Storage is unlocked — click to lock now">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" style={{ width: fz(12), height: fz(12), display: "inline-block", verticalAlign: "-1px", marginRight: 4 }}>
          <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" />
        </svg>Private unlocked</button>
    ) : null}
  </>;
}

export interface MenuItem { label: string; onSelect?: () => void; disabled?: boolean; checked?: boolean; hint?: string; separator?: boolean; testid?: string }

/**
 * Menu button (WAI-ARIA APG "menu button" pattern): Enter/Space/ArrowDown open and focus the first item,
 * ArrowUp/Down/Home/End move, Escape closes and returns focus, Tab closes, a click outside closes.
 */
export function MenuButton({ label, items, children, testid, buttonStyle, align = "left", above = false, title }: {
  label: string; items: MenuItem[]; children: ReactNode; testid?: string; buttonStyle?: React.CSSProperties;
  align?: "left" | "right"; above?: boolean; title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const focusItem = (i: number) => {
    const els = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled]),[role=menuitemcheckbox]:not([disabled])") ?? [])];
    if (!els.length) return;
    els[(i + els.length) % els.length].focus();
  };
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => focusItem(0), 0);
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!menu.current?.contains(n) && !btn.current?.contains(n)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => { window.clearTimeout(t); window.removeEventListener("pointerdown", onDown, true); };
  }, [open]);
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button ref={btn} type="button" className="fs-btn" data-variant="ghost" aria-haspopup="menu" aria-expanded={open}
        data-testid={testid} title={title} aria-label={title ? label : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" || (above && e.key === "ArrowUp")) { e.preventDefault(); setOpen(true); } }}
        style={buttonStyle}>{children}</button>
      {open ? (
        <div ref={menu} role="menu" aria-label={label} className="fs-panel"
          onKeyDown={(e) => {
            const els = [...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled]),[role=menuitemcheckbox]:not([disabled])") ?? [])];
            const i = els.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown") { e.preventDefault(); focusItem(i + 1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(i - 1); }
            else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
            else if (e.key === "End") { e.preventDefault(); focusItem(els.length - 1); }
            else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
            else if (e.key === "Tab") setOpen(false);
          }}
          style={{
            position: "absolute", [align]: 0, ...(above ? { bottom: "calc(100% + 6px)" } : { top: "calc(100% + 4px)" }),
            minWidth: fz(220), padding: 5, zIndex: 9800, display: "grid", gap: 1, boxShadow: "0 12px 32px rgba(0,0,0,.35)",
          } as React.CSSProperties}>
          {items.map((it, i) => it.separator ? <div key={`s${i}`} role="separator" className="fs-sep" style={{ margin: "4px 2px" }} /> : (
            <button key={it.label + i} type="button" role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={it.checked === undefined ? undefined : it.checked} disabled={it.disabled} data-testid={it.testid}
              className="fs-menuitem" tabIndex={-1}
              onClick={() => { close(false); it.onSelect?.(); }}>
              <span aria-hidden="true" style={{ width: fz(12), display: "inline-block" }}>{it.checked ? "✓" : ""}</span>
              <span style={{ flex: 1, textAlign: "left" }}>{it.label}</span>
              {it.hint ? <span className="fs-dim" style={{ fontSize: fz(11) }}>{it.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

/** Context / jump-list menu: focuses its first item once on mount, arrows move, Esc/Tab/blur close. */
export function AutoMenu({ label, items, onClose }: { label: string; items: MenuItem[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => { box.current?.querySelector<HTMLButtonElement>("[role^=menuitem]")?.focus(); }, []);
  return (
    <div role="menu" aria-label={label} className="fs-panel" data-testid="jump-list" ref={box}
      onKeyDown={(e) => {
        const els = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[role^=menuitem]")];
        const i = els.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
        else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); e.stopPropagation(); onClose(); }
      }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onClose(); }}
      style={{ minWidth: fz(220), padding: 5, display: "grid", gap: 1, boxShadow: "0 12px 32px rgba(0,0,0,.35)" }}>
      {items.map((it, i) => it.separator ? <div key={`s${i}`} role="separator" className="fs-sep" style={{ margin: "4px 2px" }} /> : (
        <button key={it.label + i} type="button" role={it.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={it.checked}
          className="fs-menuitem" tabIndex={-1} data-testid={it.testid} onClick={() => { onClose(); it.onSelect?.(); }}>
          <span aria-hidden="true" style={{ width: fz(12), display: "inline-block" }}>{it.checked ? "✓" : ""}</span>
          <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: fz(260) }}>{it.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Small schematic of each layout (decorative; the radio label carries the meaning). */
function LayoutPreview({ id }: { id: LayoutId }) {
  const frame = <rect x="1" y="1" width="58" height="38" rx="4" fill="var(--fs-bg-2)" stroke="currentColor" strokeOpacity=".5" />;
  return (
    <svg viewBox="0 0 60 40" width="60" height="40" aria-hidden="true" focusable="false" style={{ width: fz(60), height: fz(40), display: "block" }}>
      {frame}
      {id === "fusion" ? <><rect x="1" y="1" width="58" height="6" rx="3" fill="currentColor" opacity=".55" /><rect x="1" y="33" width="58" height="6" rx="3" fill="currentColor" opacity=".35" /></> : null}
      {id === "business" ? <><rect x="1" y="32" width="58" height="7" fill="currentColor" opacity=".55" /><rect x="22" y="34" width="3" height="3" fill="var(--fs-accent)" />{[27, 31, 35].map((x) => <rect key={x} x={x} y="34" width="3" height="3" fill="currentColor" />)}</> : null}
      {id === "art" ? <><rect x="1" y="1" width="58" height="4" fill="currentColor" opacity=".45" /><rect x="14" y="31" width="32" height="6" rx="3" fill="currentColor" opacity=".55" />{[17, 22, 27, 32, 37, 42].map((x, i) => <circle key={x} cx={x + 1} cy="34" r={i === 2 ? 2.4 : 1.6} fill={i === 2 ? "var(--fs-accent)" : "var(--fs-bg-2)"} />)}</> : null}
    </svg>
  );
}

/** Radio group (native radios: arrow keys and screen-reader semantics for free). Used by Settings and the Quick panel. */
export function LayoutSwitch({ prefix, compact = false }: { prefix: string; compact?: boolean }) {
  const shell = useShell();
  const layout = layoutOf(shell.settings["appearance.layout"]);
  return (
    <div role="radiogroup" aria-label="Layout" className="fs-row" style={{ gap: 6, flexWrap: "wrap" }} data-testid={`${prefix}-layout`}>
      {LAYOUT_IDS.map((id) => (
        <label key={id} className="fs-layout-opt" data-checked={layout === id} title={LAYOUTS[id].blurb}
          style={{ display: "grid", justifyItems: "center", gap: 3, padding: compact ? fz(4) : fz(6), minWidth: compact ? fz(80) : fz(96) }}>
          <input type="radio" name={`${prefix}-layout`} value={id} checked={layout === id} data-testid={`${prefix}-layout-${id}`}
            onChange={() => void shell.setSetting("appearance.layout", id)} className="fs-visually-hidden-radio" />
          <LayoutPreview id={id} />
          <span style={{ fontWeight: 700, fontSize: fz(compact ? 11.5 : 12.5) }}>{LAYOUTS[id].label}</span>
        </label>
      ))}
    </div>
  );
}
