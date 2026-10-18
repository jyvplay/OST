"use client";
import { FUSION_VOICES } from "@/lib/fusion-voice";
import { clampTextScale, DEFAULT_TEXT_SCALE, LARGE_TEXT_SCALE, isLargeText, fz, stepTextScale, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEPS, useUiUnit } from "@/lib/uiscale";
import { DEFAULT_WALLPAPER, WALLPAPERS } from "@/lib/appearance";
import { STYLES, STYLE_IDS, DEFAULT_STYLE, isStyle, resolveWallpaper } from "@/lib/style";
import { useShell } from "./shell-context";
import { Badge, Btn, Section } from "./ui";
import { AppIcon, FusionLogo } from "./AppIcon";
import { LayoutSwitch } from "./chrome-bits";
import { layoutOf } from "@/lib/layout-core";

const PREVIEW_ICONS = ["files", "sheet", "writer", "imageedit", "browser", "messages"];

/**
 * "Display & readability" (TT21) + "Style" (TT22): the settings people look for first, as real controls instead of
 * free-form key/value inputs. The same keys stay editable in the settings graph below (single source of truth:
 * the settings table).
 *   - Style: Poolside (default) / Vice / Ocean Drive / Bubbly — recolours icons, logo, wallpaper, accent, surfaces.
 *   - Large text mode: an opt-in switch to 200 % (the TT21 size); the default is 125 % (TT22 user decision).
 */
export default function DisplaySettings({ locked }: { locked: Record<string, string> }) {
  const shell = useShell();
  const unit = useUiUnit();
  const ts = clampTextScale(shell.settings["appearance.textScale"] ?? DEFAULT_TEXT_SCALE);
  const theme = shell.settings["appearance.theme"] ?? "dark";
  const wallpaper = shell.settings["appearance.wallpaper"] ?? DEFAULT_WALLPAPER;
  const rawStyle = shell.settings["appearance.style"];
  const style = isStyle(rawStyle) ? rawStyle : DEFAULT_STYLE;
  const set = (k: string, v: string) => void shell.setSetting(k, v);
  const lockT = locked["appearance.textScale"];
  const large = isLargeText(ts);
  // smallest inline UI size in the app is 10 design px; body text is 13
  const smallest = Math.round(10 * unit * 10) / 10;
  const body = Math.round(13 * unit * 10) / 10;

  return (
    <Section title="Display & readability" right={<Badge tone={body >= 16 ? "ok" : "info"} title="Computed from the text size and your browser's default font size">body text {body}px</Badge>}>
      <div data-testid="display-settings" style={{ display: "grid", gap: fz(12) }}>
        {/* ------------------------------------------------------------ layout (TT25) */}
        <div style={{ display: "grid", gap: fz(5) }}>
          <strong style={{ fontSize: fz(13) }}>Layout</strong>
          <span className="fs-dim" style={{ fontSize: fz(11.5) }}>Business: a Windows-style taskbar with Start along the bottom. Art: a Mac-style menu bar and a centred dock of every app that magnifies under the pointer. Fusion: the original top bar and shelf.</span>
          <LayoutSwitch prefix="settings" />
          <label className="fs-row" style={{ gap: 8 }}>
            <input type="checkbox" data-testid="settings-pair-style" checked={(shell.settings["appearance.pairStyle"] ?? "on") !== "off"}
              onChange={(e) => set("appearance.pairStyle", e.target.checked ? "on" : "off")} />
            Match the look to the layout (Art → Silver, Business → Daylight, light theme)
          </label>
          {layoutOf(shell.settings["appearance.layout"]) === "art" ? (
            <label className="fs-row" style={{ gap: 8 }}>
              <input type="checkbox" data-testid="settings-dock-magnify" checked={(shell.settings["appearance.dockMagnify"] ?? "on") !== "off"}
                onChange={(e) => set("appearance.dockMagnify", e.target.checked ? "on" : "off")} />
              Magnify dock icons under the pointer
            </label>
          ) : null}
          {layoutOf(shell.settings["appearance.layout"]) === "art" ? (
            <label className="fs-row" style={{ gap: 8 }}>
              <input type="checkbox" data-testid="settings-dock-autohide" checked={shell.settings["appearance.dockAutoHide"] === "on"}
                onChange={(e) => set("appearance.dockAutoHide", e.target.checked ? "on" : "off")} />
              Automatically hide and show the dock
            </label>
          ) : null}
          {layoutOf(shell.settings["appearance.layout"]) === "art" ? (
            <label className="fs-row" style={{ gap: 8 }}>
              Dock icon size
              <select className="fs-input" data-testid="settings-dock-size" value={shell.settings["appearance.dockSize"] ?? "auto"}
                onChange={(e) => set("appearance.dockSize", e.target.value)} style={{ width: "auto" }}>
                <option value="auto">Auto — a pleasing size for this screen</option>
                <option value="small">Small (44 px)</option>
                <option value="medium">Medium (52 px)</option>
                <option value="large">Large (64 px)</option>
              </select>
            </label>
          ) : null}
        </div>

        {/* ------------------------------------------------------- narrator (TT30, AX-14) */}
        <div style={{ display: "grid", gap: fz(5) }} data-testid="settings-narrator">
          <strong style={{ fontSize: fz(13) }}>Narrator (screen reader)</strong>
          <span className="fs-dim" style={{ fontSize: fz(11.5) }}>Speaks what has focus, announces dialogs, alerts and status messages, and reads the page with the Narrator key (hold Caps Lock or Insert; F1 lists the commands). Ctrl+Win+Enter turns it on or off anywhere. If you already use a screen reader (NVDA, JAWS, VoiceOver, Orca), leave this off — Fusion works with yours.</span>
          <label className="fs-row" style={{ gap: 8 }}>
            <input type="checkbox" data-testid="settings-narrator-on" checked={shell.settings["accessibility.narrator"] === "on"}
              onChange={(e) => set("accessibility.narrator", e.target.checked ? "on" : "off")} />
            Turn on Narrator
          </label>
          <label className="fs-row" style={{ gap: 8 }}>
            Speaking speed
            <select className="fs-input" data-testid="settings-narrator-rate" value={shell.settings["accessibility.narratorRate"] ?? "1"}
              onChange={(e) => set("accessibility.narratorRate", e.target.value)} style={{ width: "auto" }}>
              {["0.75", "1", "1.25", "1.5", "2"].map((r) => <option key={r} value={r}>{r === "1" ? "Normal (1×)" : `${r}×`}</option>)}
            </select>
          </label>
          <label className="fs-row" style={{ gap: 8 }}>
            <input type="checkbox" data-testid="settings-narrator-captions" checked={(shell.settings["accessibility.narratorCaptions"] ?? "on") !== "off"}
              onChange={(e) => set("accessibility.narratorCaptions", e.target.checked ? "on" : "off")} />
            Show captions of what Narrator says
          </label>
          <label className="fs-row" style={{ gap: 8 }}>
            <input type="checkbox" data-testid="settings-narrator-speech" checked={(shell.settings["accessibility.narratorSpeech"] ?? "on") !== "off"}
              onChange={(e) => set("accessibility.narratorSpeech", e.target.checked ? "on" : "off")} />
            Speak aloud (off: captions only)
          </label>
          {/* TT32 (AX-15): which engine speaks — Fusion Voice is Fusion's own on-device synthesiser */}
          <label className="fs-row" style={{ gap: 8 }}>
            Voice
            <select className="fs-input" data-testid="settings-narrator-voice" value={shell.settings["accessibility.narratorVoice"] ?? "auto"}
              onChange={(e) => set("accessibility.narratorVoice", e.target.value)} style={{ width: "auto" }}>
              <option value="auto">Automatic (system voice if installed, else Fusion Voice)</option>
              <option value="system">System voice</option>
              <option value="fusion">Fusion Voice (built in, works offline)</option>
            </select>
          </label>
          <label className="fs-row" style={{ gap: 8 }}>
            Fusion Voice
            <select className="fs-input" data-testid="settings-fusion-voice" value={shell.settings["accessibility.fusionVoice"] ?? "standard"}
              onChange={(e) => set("accessibility.fusionVoice", e.target.value)} style={{ width: "auto" }}>
              {Object.entries(FUSION_VOICES).map(([id, v]) => <option key={id} value={id}>{v.label}</option>)}
            </select>
          </label>
        </div>

        {/* ------------------------------------------------------- desktop view (TT26) */}
        <div style={{ display: "grid", gap: fz(5) }}>
          <strong id="desktop-view-label" style={{ fontSize: fz(13) }}>Desktop view</strong>
          <span className="fs-dim" style={{ fontSize: fz(11.5) }}>Tabletop replaces the desktop with a 3D box: your files are cards on the table (pile them, peek at them) and the four walls hold windows, apps, widgets and recent files. Double-click a wall to bring it to the front.</span>
          <div role="radiogroup" aria-labelledby="desktop-view-label" className="fs-row" style={{ gap: 12 }} data-testid="settings-desktop-view">
            {(["classic", "tabletop"] as const).map((v) => (
              <label key={v} className="fs-layout-opt" data-checked={(shell.settings["appearance.desktopView"] ?? "classic") === v}
                style={{ position: "relative", display: "inline-flex", alignItems: "center", minHeight: 36, padding: `0 ${fz(12)}`, fontWeight: 700 }}>
                {/* chip radio (as the Layout picker): the whole chip is the target, ≥ 36 px, native radio semantics and arrow keys */}
                <input type="radio" name="desktop-view" value={v} data-testid={`settings-view-${v}`} checked={(shell.settings["appearance.desktopView"] ?? "classic") === v}
                  onChange={() => set("appearance.desktopView", v)} className="fs-visually-hidden-radio" />
                {v === "classic" ? "Classic" : "Tabletop (3D)"}
              </label>
            ))}
          </div>
        </div>

        {/* ------------------------------------------------------------- style */}
        <div style={{ display: "grid", gap: fz(5) }}>
          <strong id="style-label" style={{ fontSize: fz(13) }}>Style</strong>
          <div role="radiogroup" aria-labelledby="style-label" data-testid="style-picker"
            style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${fz(190)}), 1fr))`, gap: 8 }}>
            {STYLE_IDS.map((id) => {
              const s = STYLES[id];
              return (
                <button key={id} type="button" role="radio" aria-checked={style === id} disabled={Boolean(locked["appearance.style"])}
                  data-testid={`style-${id}`} onClick={() => set("appearance.style", id)}
                  className="fs-btn" data-variant="ghost"
                  style={{ flexDirection: "column", alignItems: "stretch", padding: 6, gap: 6, height: "auto", whiteSpace: "normal", textAlign: "left",
                    outline: style === id ? "3px solid var(--fs-accent)" : undefined, outlineOffset: 1 }}>
                  <span aria-hidden className={`fs-wallpaper-${s.wallpaper}`}
                    style={{ display: "flex", alignItems: "center", gap: fz(4), padding: fz(6), borderRadius: 10, minHeight: fz(44), flexWrap: "wrap" }}>
                    <FusionLogo size={24} label="" styleId={id} />
                    {PREVIEW_ICONS.map((m) => <AppIcon key={m} id={m} size={18} styleId={id} />)}
                  </span>
                  <span style={{ display: "grid", gap: 1 }}>
                    <span style={{ fontWeight: 800 }}>{s.label}{id === DEFAULT_STYLE ? " · default" : ""}</span>
                    <span className="fs-dim" style={{ fontSize: fz(11) }}>{s.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* --------------------------------------------------------- text size */}
        <div style={{ display: "grid", gap: fz(5) }}>
          <div className="fs-row" style={{ flexWrap: "wrap", gap: 6 }}>
            <strong id="ts-label" style={{ fontSize: fz(13), flex: 1 }}>Text size</strong>
            {lockT ? <Badge tone="warn" title={lockT}>locked by policy</Badge> : null}
            <Btn aria-label="A− smaller text" disabled={Boolean(lockT) || ts <= TEXT_SCALE_MIN} onClick={() => set("appearance.textScale", String(stepTextScale(ts, -1)))}>A−</Btn>
            <output data-testid="settings-textscale" style={{ minWidth: fz(44), textAlign: "center", fontWeight: 800 }}>{ts}%</output>
            <Btn aria-label="A+ larger text" disabled={Boolean(lockT) || ts >= TEXT_SCALE_MAX} onClick={() => set("appearance.textScale", String(stepTextScale(ts, 1)))}>A+</Btn>
          </div>
          <label className="fs-row" style={{ gap: 8, cursor: lockT ? "not-allowed" : "pointer", flexWrap: "wrap" }}>
            <button type="button" role="switch" aria-checked={large} data-testid="large-text-toggle" disabled={Boolean(lockT)}
              aria-label="Large text mode"
              onClick={() => set("appearance.textScale", String(large ? DEFAULT_TEXT_SCALE : LARGE_TEXT_SCALE))}
              className="fs-switch" />
            <span style={{ fontWeight: 700 }}>Large text mode</span>
            <span className="fs-dim" style={{ fontSize: fz(11) }}>Doubles text, icons and controls ({LARGE_TEXT_SCALE}%). Off returns to the {DEFAULT_TEXT_SCALE}% default.</span>
          </label>
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <div role="radiogroup" aria-labelledby="ts-label" className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
              {TEXT_SCALE_STEPS.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={ts === s} disabled={Boolean(lockT)}
                  className="fs-btn" data-variant={ts === s ? "primary" : "ghost"} data-testid={`ts-${s}`}
                  onClick={() => set("appearance.textScale", String(s))}>
                  {s}%{s === DEFAULT_TEXT_SCALE ? " · default" : s === LARGE_TEXT_SCALE ? " · large" : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="fs-panel" aria-label="Text size preview" style={{ padding: fz(8), display: "flex", gap: fz(10), alignItems: "center", background: "var(--fs-bg-2)" }}>
            <FusionLogo size={34} label="" />
            <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
              <div style={{ fontSize: fz(15), fontWeight: 800 }}>Hello! This is your text size.</div>
              <div style={{ fontSize: fz(13) }}>Body text is {body}px; the smallest labels are {smallest}px.</div>
              <div className="fs-dim" style={{ fontSize: fz(11) }}>Browser zoom (Ctrl +) and your browser&apos;s default font size multiply on top of this.</div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------- theme */}
        <div style={{ display: "grid", gap: fz(5) }}>
          <strong id="theme-label" style={{ fontSize: fz(13) }}>Theme</strong>
          <div role="radiogroup" aria-labelledby="theme-label" className="fs-row" style={{ gap: 6 }}>
            {(["dark", "light"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={theme === t} disabled={Boolean(locked["appearance.theme"])}
                className="fs-btn" data-variant={theme === t ? "primary" : "ghost"} onClick={() => set("appearance.theme", t)}>
                {t === "dark" ? "Dark" : "Light"}
              </button>
            ))}
          </div>
        </div>

        {/* --------------------------------------------------------- wallpaper */}
        <div style={{ display: "grid", gap: fz(5) }}>
          <strong id="wp-label" style={{ fontSize: fz(13) }}>Wallpaper</strong>
          <div role="radiogroup" aria-labelledby="wp-label" style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${fz(92)}), 1fr))`, gap: 8 }}>
            {WALLPAPERS.map((w) => (
              <button key={w.id} type="button" role="radio" aria-checked={wallpaper === w.id} disabled={Boolean(locked["appearance.wallpaper"])}
                data-testid={`wp-${w.id}`} onClick={() => set("appearance.wallpaper", w.id)}
                className="fs-btn" data-variant="ghost"
                style={{ flexDirection: "column", padding: 4, gap: 4, height: "auto", outline: wallpaper === w.id ? "3px solid var(--fs-accent)" : undefined, outlineOffset: 1 }}>
                <span className={`fs-wallpaper-${resolveWallpaper(w.id, style)}`} aria-hidden style={{ display: "grid", placeItems: "center", width: "100%", height: fz(46), borderRadius: 8 }}>
                  <AppIcon id="files" size={16} />
                </span>
                <span style={{ fontWeight: 700 }}>{w.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
