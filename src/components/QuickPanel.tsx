"use client";
import { fz, stepTextScale, clampTextScale, DEFAULT_TEXT_SCALE, LARGE_TEXT_SCALE, isLargeText, TEXT_SCALE_MAX, TEXT_SCALE_MIN } from "@/lib/uiscale";
import { STYLES, STYLE_IDS, DEFAULT_STYLE, isStyle } from "@/lib/style";

import { useEffect, useState } from "react";
import { capAvailable } from "@/lib/capabilities";
import { useShell } from "./shell-context";
import { Badge, Btn, KV, Toggle } from "./ui";
import { AppIcon, FusionLogo, UiGlyph } from "./AppIcon";

/**
 * NC-03. Tiles that the platform cannot provide (radios, brightness, system
 * volume) are ABSENT with a one-line reason rather than present and fake.
 */
export default function QuickPanel({ onClose, onBlackout }: { onClose: () => void; onBlackout: () => void }) {
  const shell = useShell();
  const [notif, setNotif] = useState<string>("default");
  const [wake, setWake] = useState<WakeLockSentinel | null>(null);
  const [screens, setScreens] = useState<string>("");

  useEffect(() => {
    if (typeof Notification !== "undefined") setNotif(Notification.permission);
  }, []);

  const theme = shell.settings["appearance.theme"] ?? "dark";
  const density = shell.settings["appearance.density"] ?? "balanced";
  const textScale = clampTextScale(shell.settings["appearance.textScale"] ?? DEFAULT_TEXT_SCALE);
  const rawStyle = shell.settings["appearance.style"];
  const style = isStyle(rawStyle) ? rawStyle : DEFAULT_STYLE;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 9500 }} onClick={onClose}>
      <div className="fs-panel" role="dialog" aria-label="Quick panel"
        style={{ position: "absolute", right: 10, top: 8, width: `min(${fz(330)}, calc(100vw - 20px))`, maxHeight: "calc(100% - 16px)", overflow: "auto", padding: 12, display: "grid", gap: 10 }}
        onClick={(e) => e.stopPropagation()}>

        <div className="fs-row" style={{ justifyContent: "space-between" }}>
          <strong style={{ fontSize: fz(12) }}>Quick panel</strong>
          <Badge tone={shell.gov.state === "COOL" ? "ok" : "warn"} title={shell.gov.reason}>{shell.gov.state}</Badge>
        </div>

        <div className="fs-row" role="group" aria-label="Text size" style={{ gap: 6 }}>
          <span style={{ fontWeight: 700, flex: 1 }}>Text size</span>
          <Btn aria-label="A− smaller text" title="Smaller text" disabled={textScale <= TEXT_SCALE_MIN}
            onClick={() => void shell.setSetting("appearance.textScale", String(stepTextScale(textScale, -1)))}>A−</Btn>
          <output data-testid="quick-textscale" aria-live="polite" style={{ minWidth: fz(42), textAlign: "center", fontWeight: 800 }}>{textScale}%</output>
          <Btn aria-label="A+ larger text" title="Larger text" disabled={textScale >= TEXT_SCALE_MAX}
            onClick={() => void shell.setSetting("appearance.textScale", String(stepTextScale(textScale, 1)))}>A+</Btn>
        </div>

        <Toggle label="Large text mode" on={isLargeText(textScale)}
          onChange={(v) => void shell.setSetting("appearance.textScale", String(v ? LARGE_TEXT_SCALE : DEFAULT_TEXT_SCALE))} />

        <div className="fs-row" role="group" aria-label="Style" style={{ gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 700, flex: 1 }}>Style</span>
          {STYLE_IDS.map((id) => (
            <button key={id} type="button" className="fs-btn" data-variant="ghost" aria-pressed={style === id} title={STYLES[id].blurb}
              aria-label={`Style: ${STYLES[id].label}`} data-testid={`quick-style-${id}`}
              onClick={() => void shell.setSetting("appearance.style", id)}
              style={{ padding: 3, outline: style === id ? "3px solid var(--fs-accent)" : undefined }}>
              <FusionLogo size={22} label="" styleId={id} />
            </button>
          ))}
        </div>

        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn onClick={() => void shell.setSetting("appearance.theme", theme === "dark" ? "light" : "dark")}>
            <UiGlyph name="contrast" /> {theme === "dark" ? "Dark" : "Light"}
          </Btn>
          <Btn onClick={() => {
            const order = ["compact", "balanced", "touch"];
            void shell.setSetting("appearance.density", order[(order.indexOf(density) + 1) % order.length]);
          }}><UiGlyph name="sliders" /> {density}</Btn>
          <Btn onClick={onBlackout}>Blackout</Btn>
          <Btn onClick={() => shell.open("beam")}><AppIcon id="beam" size={16} /> Beam</Btn>
        </div>

        <Toggle label="Focus mode" on={shell.state.focusMode} onChange={(v) => shell.dispatch({ t: "focusMode", on: v })} />
        <Toggle label="Window effects" on={(shell.settings["perf.effects"] ?? "auto") !== "off"}
          onChange={(v) => void shell.setSetting("perf.effects", v ? "auto" : "off")} />

        <div style={{ display: "grid", gap: 4 }}>
          <KV k="Screen wake lock" v={
            capAvailable(shell.caps, "wakeLock") ? (
              <Btn variant="ghost" onClick={async () => {
                if (wake) { await wake.release(); setWake(null); return; }
                try {
                  const s = await navigator.wakeLock.request("screen");
                  setWake(s);
                  s.addEventListener("release", () => setWake(null));
                } catch (e) { shell.toast(String((e as Error).message), "bad"); }
              }}>{wake ? "held — release" : "request"}</Btn>
            ) : <span className="fs-dim">unavailable</span>
          } />
          <KV k="Notifications" v={
            typeof Notification === "undefined" ? <span className="fs-dim">unavailable</span> : notif === "granted" ? <Badge tone="ok">granted</Badge> : (
              <Btn variant="ghost" onClick={async () => setNotif(await Notification.requestPermission())}>{notif} — request</Btn>
            )
          } />
          <KV k="Displays" v={
            capAvailable(shell.caps, "multiScreen") ? (
              <Btn variant="ghost" onClick={async () => {
                try {
                  const det = await (window as unknown as { getScreenDetails: () => Promise<{ screens: { label: string; availLeft: number; availTop: number; availWidth: number; availHeight: number }[] }> }).getScreenDetails();
                  setScreens(det.screens.map((s) => s.label || "screen").join(", "));
                  const other = det.screens[1];
                  if (other) {
                    window.open("/display", "fusion-display-2",
                      `popup=1,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`);
                    shell.toast("Opened the second-screen desktop. It keeps its own layout (WM-07).", "ok");
                  } else {
                    shell.toast("Only one screen reported.", "warn");
                  }
                } catch (e) { shell.toast(String((e as Error).message), "bad"); }
              }}>{screens || "extend"}</Btn>
            ) : <span className="fs-dim">no multi-screen API</span>
          } />
          <KV k="Battery" v={shell.gov.batteryLevel === null ? <span className="fs-dim">no API</span> : `${Math.round(shell.gov.batteryLevel * 100)}%${shell.gov.charging ? " ⚡" : ""}`} />
        </div>

        <div className="fs-sep" />
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>
          Not shown because the web platform does not expose them: Wi‑Fi, Bluetooth and airplane toggles,
          system brightness, global volume, and other apps&apos; media sessions. A tile that cannot work is
          not displayed (DP-10).
        </div>
      </div>
    </div>
  );
}
