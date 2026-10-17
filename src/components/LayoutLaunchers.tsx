"use client";
/**
 * TT25 launchers for the two new layouts (the Fusion launcher panel in Shell.tsx is unchanged):
 *  • StartMenu (Business) — above the taskbar at the bottom-left: search field, a "Pinned" grid and an
 *    alphabetical "All apps" list, plus Settings / Lock Private storage at the bottom (Windows 11 structure).
 *  • Launchpad (Art) — full-screen, blurred, a search field and a big grid of every app; Esc or a click on the
 *    background closes it (macOS Launchpad).
 * Both filter by title and summary (accent-insensitive), and Enter launches the first match.
 */
import { fz } from "@/lib/uiscale";
import { useMemo, useState } from "react";
import { MODULES } from "@/lib/registry";
import { privacy } from "@/lib/privacy/session";
import { useShell } from "./shell-context";
import { AppIcon, FusionLogo, UiGlyph } from "./AppIcon";
import { TASKBAR_PINNED } from "./Taskbar";

const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function useFiltered(q: string) {
  return useMemo(() => {
    const t = fold(q.trim());
    const all = [...MODULES].sort((a, b) => a.title.localeCompare(b.title));
    return t ? all.filter((m) => fold(`${m.title} ${m.summary}`).includes(t)) : all;
  }, [q]);
}

export function StartMenu({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const list = useFiltered(q);
  const launch = (id: string) => { shell.open(id); onClose(); };
  const pinned = [...TASKBAR_PINNED, "contacts", "slides", "imageedit", "vector", "notes", "calculator", "clock", "privacy"]
    .filter((id, i, a) => a.indexOf(id) === i && MODULES.some((m) => m.id === id));
  return (
    <div className="fs-panel" role="dialog" aria-label="Start" data-testid="start-menu"
      style={{ position: "absolute", left: 8, bottom: 8, width: `min(${fz(600)}, calc(100% - 16px))`, maxHeight: "calc(100% - 16px)", overflow: "auto",
        padding: fz(16), zIndex: 9000, display: "grid", gap: fz(12), boxShadow: "0 18px 48px rgba(0,0,0,.4)" }}>
      <label className="fs-row" style={{ gap: 8, padding: `${fz(1)} ${fz(10)}`, borderRadius: 999, border: "1px solid var(--fs-border)", background: "var(--fs-field, var(--fs-bg-2))" }}>
        <UiGlyph name="search" /><span className="fs-visually-hidden">Search apps</span>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type to search apps" data-testid="start-search"
          onKeyDown={(e) => { if (e.key === "Enter" && list[0]) launch(list[0].id); }}
          style={{ flex: 1, minHeight: 34, border: 0, background: "transparent", color: "inherit", font: "inherit", outline: "none", minWidth: 0 }} />
      </label>
      {!q ? (
        <section aria-label="Pinned">
          <div style={{ fontWeight: 800, marginBottom: 6 }}>Pinned</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(84)}, 1fr))`, gap: 4 }}>
            {pinned.map((id) => {
              const m = MODULES.find((x) => x.id === id)!;
              return (
                <button key={id} type="button" className="fs-start-tile" onClick={() => launch(id)} title={m.summary} data-testid={`start-${id}`}>
                  <AppIcon id={id} size={30} /><span>{m.title}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}
      <section aria-label={q ? "Search results" : "All apps"}>
        <div style={{ fontWeight: 800, marginBottom: 6 }}>{q ? `Results (${list.length})` : "All apps"}</div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(170)}, 1fr))`, gap: 2 }}>
          {list.map((m) => (
            <button key={m.id} type="button" className="fs-menuitem fs-start-row" onClick={() => launch(m.id)} title={m.summary} data-testid={`start-all-${m.id}`}>
              <AppIcon id={m.id} size={20} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
            </button>
          ))}
          {!list.length ? <div className="fs-dim">No app matches “{q}”.</div> : null}
        </div>
      </section>
      <div className="fs-row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--fs-border)", paddingTop: fz(8) }}>
        <span className="fs-row" style={{ gap: 6 }}><FusionLogo size={22} label="" /><strong>Fusion Shell</strong></span>
        <span className="fs-row" style={{ gap: 4 }}>
          <button type="button" className="fs-btn" data-variant="ghost" onClick={() => launch("settings")}>Settings</button>
          <button type="button" className="fs-btn" data-variant="ghost" title="Lock Persistent Storage now"
            onClick={() => { privacy.lock(); shell.bumpRefresh(); onClose(); shell.toast("Private storage locked.", "ok"); }}>Lock</button>
        </span>
      </div>
    </div>
  );
}

export function Launchpad({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const list = useFiltered(q);
  const launch = (id: string) => { shell.open(id); onClose(); };
  return (
    <div role="dialog" aria-label="Launchpad" data-testid="launchpad" className="fs-launchpad" onClick={onClose}>
      <div style={{ width: "min(1100px, 100%)", margin: "0 auto", display: "grid", gap: fz(18), padding: fz(20) }} onClick={(e) => e.stopPropagation()}>
        <label className="fs-row" style={{ justifySelf: "center", gap: 8, padding: `${fz(1)} ${fz(12)}`, borderRadius: 10, background: "rgba(255,255,255,.18)", color: "#fff", width: `min(${fz(300)}, 100%)` }}>
          <UiGlyph name="search" /><span className="fs-visually-hidden">Search apps</span>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" data-testid="launchpad-search"
            onKeyDown={(e) => { if (e.key === "Enter" && list[0]) launch(list[0].id); }}
            style={{ flex: 1, minHeight: 34, border: 0, background: "transparent", color: "inherit", font: "inherit", outline: "none", minWidth: 0 }} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(104)}, 1fr))`, gap: fz(14) }}>
          {list.map((m) => (
            <button key={m.id} type="button" className="fs-lp-item" onClick={() => launch(m.id)} title={m.summary} data-testid={`launchpad-${m.id}`}>
              <AppIcon id={m.id} size={56} /><span>{m.title}</span>
            </button>
          ))}
        </div>
        {!list.length ? <div style={{ color: "#fff", textAlign: "center" }}>No app matches “{q}”.</div> : null}
      </div>
    </div>
  );
}
