"use client";
/**
 * TT56 (NC-06) — the shell's on-screen display. Sources: showOsd() calls (text size, layout, focus mode, workspace, the
 * Streams volume slider) and every <audio>/<video> volume change in the shell document (volumechange is caught in the
 * capture phase, so native media controls count too). The pill is aria-hidden and updates every frame; the polite live
 * region gets the settled text once per burst.
 */
import { useEffect, useRef, useState } from "react";
import { OSD_SETTLE_MS, OSD_VISIBLE_MS, onOsd, showOsd, volumeLabel, type OsdEvent } from "@/lib/osd";
import { fz } from "@/lib/uiscale";

export default function OsdLayer() {
  const [ev, setEv] = useState<OsdEvent | null>(null);
  const [live, setLive] = useState("");
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = onOsd((e) => {
      setEv(e);
      if (settle.current) clearTimeout(settle.current);
      settle.current = setTimeout(() => setLive(e.label), OSD_SETTLE_MS);
      if (hide.current) clearTimeout(hide.current);
      hide.current = setTimeout(() => setEv(null), OSD_VISIBLE_MS);
    });
    const vol = (e: Event) => {
      const m = e.target;
      if (!(m instanceof HTMLMediaElement) || m.dataset.osd === "off") return;
      showOsd("volume", volumeLabel(m.volume, m.muted), m.muted ? 0 : Math.round(m.volume * 100));
    };
    document.addEventListener("volumechange", vol, true);
    return () => { off(); document.removeEventListener("volumechange", vol, true); if (settle.current) clearTimeout(settle.current); if (hide.current) clearTimeout(hide.current); };
  }, []);
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" data-testid="osd-live"
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>{live}</div>
      {ev ? (
        <div aria-hidden="true" className="fs-panel fs-osd" data-testid="osd" data-kind={ev.kind}
          style={{ position: "absolute", left: "50%", bottom: "14%", transform: "translateX(-50%)", zIndex: 9700, pointerEvents: "none", padding: "10px 18px", minWidth: 220, display: "grid", gap: 6, justifyItems: "center", borderRadius: 16 }}>
          <div style={{ fontSize: fz(14), fontWeight: 700 }}>{ev.label}</div>
          {ev.value !== undefined ? (
            <div style={{ width: 180, height: 6, borderRadius: 3, background: "rgba(127,127,127,.3)", overflow: "hidden" }}>
              <div data-testid="osd-bar" style={{ width: `${ev.value}%`, height: "100%", background: "var(--fs-accent, #2b6cff)" }} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
