"use client";
/**
 * TT25 "Art" layout — a Mac-style menu bar across the top.
 *  Left: the Fusion menu (About, System Settings, Launchpad, Force Quit…, Lock, Blackout), the focused app's name in
 *  bold, then File / Window / Help menus that act on the focused window (Window lists every open window, as on macOS).
 *  Right: status items, Spaces, Spotlight search (command palette), Mission Control (Overview), Control Centre
 *  (Quick panel) and the day-date-time clock.
 */
import { fz } from "@/lib/uiscale";
import { menuItemsForWindow, useBannerMenus } from "./AppBanner";
import { moduleById } from "@/lib/registry";
import { privacy } from "@/lib/privacy/session";
import { useShell } from "./shell-context";
import { FusionLogo, UiGlyph } from "./AppIcon";
import { MenuButton, StatusItems, useClock, type MenuItem } from "./chrome-bits";

/** TT80: every window publishes its banner menu names; the shell shows them beside Frame / Guide */
function WindowMenus({ win }: { win: string | null | undefined }) {
  const names = useBannerMenus(win);
  if (!win || !names.length) return null;
  const pill = { minHeight: fz(24), padding: `0 ${fz(8)}`, borderRadius: 999, fontWeight: 600 } as const;
  return <>{names.map((n) => <MenuButton key={n} label={n} testid={`shell-menu-${n.toLowerCase()}`} items={() => menuItemsForWindow(win, n)} buttonStyle={pill}>{n}</MenuButton>)}</>;
}

export default function MenuBar({ onLaunchpad, onPalette, onOverview, onQuick, onBlackout, onShortcuts }: {
  onLaunchpad: () => void; onPalette: () => void; onOverview: () => void; onQuick: () => void; onBlackout: () => void; onShortcuts: () => void;
}) {
  const shell = useShell();
  const now = useClock();
  const { state } = shell;
  const wins = state.windows.filter((w) => w.workspace === state.activeWorkspace);
  const focused = wins.find((w) => w.id === state.focus && !w.minimized) ?? null;
  const app = focused ? moduleById(focused.module) : null;
  const appName = app?.title ?? "Fusion";
  const on = (fn: (id: string) => void) => (focused ? () => fn(focused.id) : undefined);
  const mb = { minHeight: fz(24), padding: `0 ${fz(8)}`, borderRadius: 5 } as const;

  const fusionItems: MenuItem[] = [
    { label: "About Fusion Shell", onSelect: () => shell.open("spec") },
    { label: "", separator: true },
    { label: "System Settings…", onSelect: () => shell.open("settings") },
    { label: "Launchpad", onSelect: onLaunchpad, hint: "⌘A" },
    { label: "", separator: true },
    { label: "Force Quit…", onSelect: () => shell.open("monitor") },
    { label: "", separator: true },
    { label: "Lock Private storage", onSelect: () => { privacy.lock(); shell.bumpRefresh(); shell.toast("Private storage locked.", "ok"); } },
    { label: "Blackout screen", onSelect: onBlackout },
  ];
  /** TT80: Frame — everything about the focused window itself (the document commands live in the app's own menus) */
  const frameItems: MenuItem[] = [
    { label: `New ${appName} window`, onSelect: focused ? () => shell.open(focused.module) : undefined, disabled: !focused },
    { label: "Close window", onSelect: on((id) => shell.dispatch({ t: "close", id })), disabled: !focused, hint: "⌘W" },
    { label: `Quit ${appName}`, disabled: !focused, onSelect: focused ? () => wins.filter((w) => w.module === focused.module).forEach((w) => shell.dispatch({ t: "close", id: w.id })) : undefined },
    { label: "", separator: true },
    { label: "Minimise", onSelect: on((id) => shell.dispatch({ t: "minimize", id })), disabled: !focused, hint: "⌘M", testid: "menu-minimise" },
    { label: "Zoom", onSelect: on((id) => shell.dispatch({ t: "toggleMax", id })), disabled: !focused, testid: "menu-zoom" },
    { label: "Move Window to Left Side of Screen", onSelect: on((id) => shell.dispatch({ t: "tile", id, slot: "left" })), disabled: !focused, testid: "menu-tile-left" },
    { label: "Move Window to Right Side of Screen", onSelect: on((id) => shell.dispatch({ t: "tile", id, slot: "right" })), disabled: !focused, testid: "menu-tile-right" },
    { label: "Centre", onSelect: on((id) => shell.dispatch({ t: "tile", id, slot: "center" })), disabled: !focused },
    { label: "", separator: true },
    { label: "Bring All to Front", onSelect: () => [...wins].sort((a, b) => a.z - b.z).forEach((w) => shell.dispatch({ t: "focus", id: w.id })), disabled: !wins.length },
    ...(wins.length ? [{ label: "", separator: true }] : []),
    ...wins.map((w) => ({ label: w.title, checked: w.id === state.focus && !w.minimized, onSelect: () => shell.dispatch({ t: w.minimized ? "restore" : "focus", id: w.id }) })),
  ];
  const guideItems: MenuItem[] = [
    { label: "Keyboard shortcuts", onSelect: onShortcuts },
    { label: "Search commands…", onSelect: onPalette, hint: "Ctrl+Space" },
    { label: "Feature register (Spec)", onSelect: () => shell.open("spec") },
  ];
  return (
    <header role="banner" data-testid="menubar" className="fs-row"
      style={{ height: fz(30), padding: `0 ${fz(8)}`, gap: 2, background: "var(--fs-panel)", backdropFilter: "blur(24px) saturate(1.4)", borderBottom: "1px solid var(--fs-border)", position: "relative", zIndex: 70 }}>
      <nav aria-label="Menu bar" className="fs-row" style={{ gap: 1, minWidth: 0 }}>
        <MenuButton label="Fusion menu" title="Fusion menu" items={fusionItems} testid="fusion-menu" buttonStyle={{ ...mb, padding: `0 ${fz(6)}` }}>
          <FusionLogo size={18} label="" />
        </MenuButton>
        <strong data-testid="menubar-app" style={{ padding: `0 ${fz(8)}`, fontSize: fz(13), whiteSpace: "nowrap", maxWidth: "28vw", overflow: "hidden", textOverflow: "ellipsis" }}>{appName}</strong>
        {/* TT80: the focused window's own menus, then the shell's Frame / Guide */}
        {focused && <WindowMenus win={focused.id} />}
        <MenuButton label="Frame" items={frameItems} testid="menu-window" buttonStyle={mb}>Frame</MenuButton>
        <span className="fs-narrow-hide" style={{ display: "contents" }}><MenuButton label="Guide" items={guideItems} buttonStyle={mb}>Guide</MenuButton></span>
      </nav>
      <div style={{ flex: 1 }} />
      <div className="fs-row" style={{ gap: 2, minWidth: 0 }}>
        <span className="fs-narrow-hide" style={{ display: "contents" }}><StatusItems compact /></span>
        {state.focusMode ? <span className="fs-dim" style={{ fontSize: fz(11) }}>focus</span> : null}
        <div className="fs-row fs-narrow-hide" role="group" aria-label="Spaces" style={{ gap: 1 }}>
          {state.workspaces.map((ws, i) => (
            <button key={ws.id} type="button" className="fs-btn" data-variant="ghost" aria-pressed={ws.id === state.activeWorkspace}
              title={`Space: ${ws.name}`} aria-label={`Space ${i + 1}: ${ws.name}`} onClick={() => shell.dispatch({ t: "switchWorkspace", workspace: ws.id })}
              style={{ ...mb, padding: `0 ${fz(5)}`, fontWeight: ws.id === state.activeWorkspace ? 800 : 500, textDecoration: ws.id === state.activeWorkspace ? "underline" : "none" }}>{i + 1}</button>
          ))}
        </div>
        <button type="button" className="fs-btn fs-narrow-hide" data-variant="ghost" onClick={onOverview} aria-label="Mission Control" title="Mission Control (Meta+Q)" style={mb}><UiGlyph name="overview" /></button>
        <button type="button" className="fs-btn" data-variant="ghost" onClick={onPalette} aria-label="Spotlight search" title="Spotlight search (Ctrl+Space)" data-testid="menubar-search" style={mb}><UiGlyph name="search" /></button>
        <button type="button" className="fs-btn" data-variant="ghost" onClick={onQuick} aria-label="Control Centre" title="Control Centre (Meta+I)" data-testid="menubar-quick" style={mb}><UiGlyph name="sliders" /></button>
        <span data-testid="menubar-clock" style={{ fontSize: fz(12.5), padding: `0 ${fz(6)}`, whiteSpace: "nowrap", fontWeight: 600 }} suppressHydrationWarning>
          <span className="fs-narrow-hide" suppressHydrationWarning>{now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}&nbsp;&nbsp;</span>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </header>
  );
}
