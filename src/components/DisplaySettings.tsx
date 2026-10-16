"use client";
import { clampTextScale, DEFAULT_TEXT_SCALE, LARGE_TEXT_SCALE, isLargeText, fz, stepTextScale, TEXT_SCALE_MAX, TEXT_SCALE_MIN, TEXT_SCALE_STEPS, useUiUnit } from "@/lib/uiscale";
import { DEFAULT_WALLPAPER, WALLPAPERS } from "@/lib/appearance";
import { STYLES, STYLE_IDS, DEFAULT_STYLE, isStyle, resolveWallpaper } from "@/lib/style";
import { useShell } from "./shell-context";
import { Badge, Btn, Section } from "./ui";
import { AppIcon, FusionLogo } from "./AppIcon";

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
