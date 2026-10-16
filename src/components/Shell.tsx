"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post, put } from "@/lib/api";
import type { RoutineAction } from "@/lib/routines";
import ShellDaemons from "./ShellDaemons";
import DesktopWidgets from "./DesktopWidgets";
import { probeCapabilities, refineCapabilities, type CapabilityReport } from "@/lib/capabilities";
import { governor, type GovernorSnapshot } from "@/lib/governor";
import { memoryPolicy } from "@/lib/policy";
import { MODULES, moduleById } from "@/lib/registry";
import { BINDINGS, comboFor, matchChord, type Preset } from "@/lib/shortcuts";
import {
  initialDesktop, reduce, type DesktopState, type Rect, type WindowCommand,
} from "@/lib/windowing/state";
import { ShellContext, type BeamSession, type ClipEntry, type ShellApi } from "./shell-context";
import WindowFrame from "./WindowFrame";
import TopBar from "./TopBar";
import Shelf from "./Shelf";
import DesktopSurface from "./DesktopSurface";
import Palette from "./Palette";
import Overview from "./Overview";
import QuickPanel from "./QuickPanel";
import { Badge, Btn } from "./ui";

interface Toast { id: number; message: string; tone: "info" | "ok" | "warn" | "bad"; action?: { label: string; run: () => void } }

export default function Shell({ stateId, hostKind }: { stateId: string; hostKind: "tab" | "pip" | "screen" }) {
  const [state, setState] = useState<DesktopState>(initialDesktop);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [gov, setGov] = useState<GovernorSnapshot>(() => governor.snapshot());
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [palette, setPalette] = useState(false);
  const [overview, setOverview] = useState(false);
  const [quick, setQuick] = useState(false);
  const [launcher, setLauncher] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [blackout, setBlackout] = useState(false);
  const [clips, setClips] = useState<ClipEntry[]>([]);
  const [beam, setBeam] = useState<BeamSession | null>(null);
  const [streamVersion, setStreamVersion] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const [booted, setBooted] = useState(false);

  const streams = useRef(new Map<string, MediaStream>()).current;
  const commandLog = useRef<{ cmd: WindowCommand; at: number }[]>([]).current;
  const stateRefOpen = useRef(state);
  stateRefOpen.current = state;
  const counter = useRef(0);
  const loaded = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const deskRef = useRef<HTMLDivElement | null>(null);
  const toastId = useRef(1);

  /* ------------------------------------------------------------ dispatch */
  const dispatch = useCallback((cmd: WindowCommand) => {
    commandLog.push({ cmd, at: Date.now() });
    if (commandLog.length > 400) commandLog.shift();
    setState((s) => reduce(s, cmd));
  }, [commandLog]);

  const toast = useCallback((message: string, tone: Toast["tone"] = "info", action?: Toast["action"]) => {
    const id = toastId.current++;
    setToasts((t) => [...t, { id, message, tone, action }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  const capsRef = useRef<CapabilityReport | null>(null);
  const open = useCallback((moduleId: string, props?: Record<string, unknown>, rect?: Partial<Rect>) => {
    const mod = moduleById(moduleId);
    // RG-06: low-memory window cap (only when deviceMemory is actually reported)
    const policy = memoryPolicy(capsRef.current?.deviceMemoryGb);
    if (stateRefOpen.current.windows.length >= policy.maxWindows) {
      setToasts((t) => [...t, { id: Date.now(), message: `Window limit reached (${policy.maxWindows}): ${policy.reason}. Close a window first.`, tone: "warn" }]);
      return "";
    }
    counter.current += 1;
    const id = `w${counter.current}_${moduleId}`;
    dispatch({
      t: "open", id, module: moduleId,
      title: (props?.title as string) ?? mod?.title ?? moduleId,
      props: props ?? {}, rect: { ...(mod?.rect ?? {}), ...(rect ?? {}) }, host: "tab",
    });
    return id;
  }, [dispatch]);

  const copy = useCallback(async (text: string, from: string, sensitive = false) => {
    try { await navigator.clipboard?.writeText(text); } catch { /* clipboard write needs focus; the in-app history still records it */ }
    setClips((c) => [{ text: sensitive ? "•".repeat(Math.min(text.length, 12)) : text, at: Date.now(), sensitive, from }, ...c].slice(0, 50));
    toast(sensitive ? "Copied (sensitive — not stored)" : "Copied", "ok");
  }, [toast]);

  const publishStream = useCallback((id: string, stream: MediaStream | null) => {
    if (stream) streams.set(id, stream);
    else streams.delete(id);
    setStreamVersion((v) => v + 1);
  }, [streams]);

  const setSetting = useCallback(async (key: string, value: string) => {
    const prev = settings[key];
    setSettings((s) => ({ ...s, [key]: value }));
    try {
      await put("/api/settings", { key, value });
      toast(`${key} → ${value}`, "ok", prev !== undefined ? {
        label: "Undo",
        run: () => { setSettings((s) => ({ ...s, [key]: prev })); void put("/api/settings", { key, value: prev }); },
      } : undefined);
    } catch (err) {
      setSettings((s) => ({ ...s, [key]: prev ?? "" }));
      toast(String((err as Error).message), "bad");
    }
  }, [settings, toast]);

  /* ----------------------------------------------------------- bootstrap */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const probe = probeCapabilities();
      setCaps(probe);
      capsRef.current = probe;
      refineCapabilities(probe).then((r) => { if (!cancelled) setCaps(r); }).catch(() => undefined);
      governor.start();

      try {
        await api("/api/bootstrap");
        const s = await api<{ rows: { key: string; value: string }[] }>("/api/settings");
        if (!cancelled) setSettings(Object.fromEntries(s.rows.map((r) => [r.key, r.value])));
        const st = await api<{ row: { state: DesktopState; revision: number } | null }>(`/api/state?id=${stateId}`);
        if (!cancelled && st.row?.state?.windows) {
          // Geometry is host-relative: keep the MEASURED desk size, not the viewport persisted by another screen
          // (a state saved on a larger display otherwise produced oversized maximised windows — TT15 screenshot finding).
          const desk = deskRef.current?.getBoundingClientRect();
          const measured = desk && desk.width > 0 && desk.height > 0 ? { viewport: { w: Math.round(desk.width), h: Math.round(desk.height) } } : {};
          dispatch({ t: "hydrate", state: { ...initialDesktop(), ...st.row.state, ...measured } });
        }
      } catch (err) {
        toast(`Offline or server error: ${String((err as Error).message)}. The shell runs read-only.`, "warn");
      }
      loaded.current = true;
      if (!cancelled) setBooted(true);

      // SH-13: manifest shortcuts, protocol handler (web+fusion://) and the
      // share target all arrive as query parameters on the single instance.
      try {
        const params = new URLSearchParams(window.location.search);
        const want = params.get("open") ?? params.get("cmd");
        // TT15: optional file deep link (?open=sheet&path=/Documents/x.fworkbook) — VFS paths only
        const wantPath = params.get("path");
        if (want && MODULES.some((m) => m.id === want)) open(want, wantPath && wantPath.startsWith("/") && wantPath.length < 1024 ? { path: wantPath } : undefined);
        const shared = params.get("url") ?? params.get("text");
        if (shared) {
          open("browser", { url: shared, title: "Shared link" });
          toast("Opened a shared link from the OS share sheet.", "ok");
        }
        if (want || shared) window.history.replaceState({}, "", window.location.pathname);
      } catch { /* no query parameters is the normal case */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateId]);

  useEffect(() => {
    const unsubscribe = governor.subscribe(setGov);
    return () => { unsubscribe(); };
  }, []);

  /* ------------------------------------------------- persistence (SH-08) */
  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void put("/api/state", { id: stateId, state, revision: state.revision }).catch(() => undefined);
      try { localStorage.setItem(`fusion.state.${stateId}`, JSON.stringify(state)); } catch { /* quota */ }
    }, 600);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [state, stateId]);

  useEffect(() => {
    const flush = () => {
      if (!loaded.current) return;
      // keepalive fetch, not sendBeacon: the state endpoint is PUT with
      // optimistic concurrency, and sendBeacon can only issue POST.
      void fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: stateId, state, revision: state.revision }),
        keepalive: true,
      }).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [state, stateId]);

  /* ------------------------------------------------------- viewport size */
  useEffect(() => {
    const el = deskRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      dispatch({ t: "viewport", w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [dispatch]);

  /* --------------------------------------------------------- appearance */
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings["appearance.theme"] ?? "dark";
    root.dataset.density = settings["appearance.density"] ?? "balanced";
    const motion = settings["appearance.motion"] ?? "system";
    root.dataset.motion = motion === "off" ? "off" : "";
    root.dataset.effects = gov.effects && (settings["perf.effects"] ?? "auto") !== "off" ? "on" : "off";
    if (settings["appearance.accent"]) root.style.setProperty("--fs-accent", settings["appearance.accent"]);
  }, [settings, gov.effects]);

  /* ------------------------------------------------------------ keyboard */
  const preset = (settings["shell.shortcutPreset"] ?? "hybrid") as Preset;
  useEffect(() => {
    const chord = (id: string) => {
      const b = BINDINGS.find((x) => x.id === id);
      return b ? comboFor(b, preset) : "";
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (matchChord(e, chord("palette"))) { e.preventDefault(); setPalette((v) => !v); return; }
      if (e.key === "Escape") { setPalette(false); setOverview(false); setQuick(false); setLauncher(false); setSheet(false); return; }
      // FIX (found by the real-browser suite): Meta-modified window chords are
      // never text input, so they must work even while a text field inside a
      // window has focus — as Win/Super+Arrow does on every desktop OS.
      if (typing && !e.metaKey) return;
      const focus = state.focus;
      const act = (fn: () => void) => { e.preventDefault(); fn(); };
      if (matchChord(e, chord("launcher"))) return act(() => setLauncher((v) => !v));
      if (matchChord(e, chord("overview"))) return act(() => setOverview((v) => !v));
      if (matchChord(e, chord("quickPanel"))) return act(() => setQuick((v) => !v));
      if (matchChord(e, chord("switcher"))) return act(() => dispatch({ t: "cycle", dir: e.shiftKey ? -1 : 1 }));
      if (matchChord(e, chord("files"))) return act(() => open("files"));
      if (matchChord(e, chord("terminal"))) return act(() => open("terminal"));
      if (matchChord(e, chord("alerts"))) return act(() => open("alerts"));
      if (matchChord(e, chord("focusMode"))) return act(() => dispatch({ t: "focusMode", on: !state.focusMode }));
      if (matchChord(e, chord("cheatsheet"))) return act(() => setSheet((v) => !v));
      if (!focus) return;
      if (matchChord(e, chord("closeWindow"))) return act(() => dispatch({ t: "close", id: focus }));
      if (matchChord(e, chord("tileLeft"))) return act(() => dispatch({ t: "tile", id: focus, slot: "left" }));
      if (matchChord(e, chord("tileRight"))) return act(() => dispatch({ t: "tile", id: focus, slot: "right" }));
      if (matchChord(e, chord("maximize"))) return act(() => dispatch({ t: "toggleMax", id: focus }));
      if (matchChord(e, chord("minimize"))) return act(() => dispatch({ t: "minimize", id: focus }));
      // keyboard move/resize (WM-09, AX-05): every pointer gesture has a key path
      if (e.metaKey && e.shiftKey && e.code.startsWith("Arrow")) {
        return act(() => dispatch({
          t: "nudge", id: focus,
          dx: (e.code === "ArrowRight" ? 16 : e.code === "ArrowLeft" ? -16 : 0),
          dy: (e.code === "ArrowDown" ? 16 : e.code === "ArrowUp" ? -16 : 0),
        }));
      }
      if (e.metaKey && e.altKey && e.code.startsWith("Arrow")) {
        return act(() => dispatch({
          t: "grow", id: focus,
          dw: (e.code === "ArrowRight" ? 24 : e.code === "ArrowLeft" ? -24 : 0),
          dh: (e.code === "ArrowDown" ? 24 : e.code === "ArrowUp" ? -24 : 0),
        }));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, open, preset, state.focus, state.focusMode]);

  /* ---------------------------------------------- service worker (SH-14) */
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  /* ------------------------------------------------------- beam auto-stop */
  useEffect(() => {
    if (!beam) return;
    const onHide = () => {
      if (document.visibilityState === "hidden" && (settings["beam.autoStopOnHide"] ?? "on") === "on") {
        beam.stop();
        toast("Beam session stopped because the shell was hidden (SC-09).", "warn");
      }
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [beam, settings, toast]);

  /* -------------------------------------- routine/preset executor (AU-01/02) */
  const stateRef = useRef(state);
  stateRef.current = state;
  const runActions = useCallback(async (actions: RoutineAction[]) => {
    let last: string | null = null;
    for (const a of actions) {
      const arg = a.arg ?? "";
      switch (a.cmd) {
        case "open":
          if (MODULES.some((m) => m.id === arg)) last = open(arg);
          else toast(`Routine: unknown module "${arg}"`, "warn");
          break;
        case "tile": {
          const id = last ?? stateRef.current.focus;
          const slots = ["left", "right", "top", "bottom", "tl", "tr", "bl", "br", "third-l", "third-c", "third-r", "center", "full"];
          if (id && slots.includes(arg)) dispatch({ t: "tile", id, slot: arg as "left" });
          break;
        }
        case "workspace": {
          const n = Number(arg);
          if (stateRef.current.workspaces.some((w) => w.id === n)) dispatch({ t: "switchWorkspace", workspace: n });
          break;
        }
        case "focusMode": dispatch({ t: "focusMode", on: arg !== "off" }); break;
        case "theme": if (arg === "dark" || arg === "light") await setSetting("appearance.theme", arg); break;
        case "density": if (["compact", "balanced", "touch"].includes(arg)) await setSetting("appearance.density", arg); break;
        case "alert": await post("/api/alerts", { app: "Routine", title: arg || "Routine alert" }).catch(() => undefined); break;
        case "closeAll": dispatch({ t: "closeAll" }); last = null; break;
        case "preset": {
          const r = await api<{ row: { state: DesktopState } | null }>(`/api/state?id=${encodeURIComponent(`preset:${arg}`)}`);
          if (!r.row) { toast(`Preset "${arg}" not found`, "warn"); break; }
          const cur = stateRef.current;
          dispatch({ t: "hydrate", state: { ...initialDesktop(), ...r.row.state, viewport: cur.viewport, revision: cur.revision + 1 } });
          toast(`Restored preset "${arg}"`, "ok");
          break;
        }
      }
      await new Promise((res) => setTimeout(res, 30)); // let each command commit before the next reads state
    }
  }, [dispatch, open, setSetting, toast]);

  const pulse = useCallback((ts: number) => governor.tick(ts), []);
  const bumpRefresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  const value: ShellApi = useMemo(() => ({
    state, dispatch, open, caps, gov, settings, setSetting, toast,
    streams, publishStream, streamVersion, clips, copy, beam, setBeam,
    commandLog, hostKind, pulse, refreshTick, bumpRefresh, runActions,
  }), [state, dispatch, open, caps, gov, settings, setSetting, toast, streams, publishStream,
      streamVersion, clips, copy, beam, commandLog, hostKind, pulse, refreshTick, bumpRefresh, runActions]);

  const visible = state.windows.filter((w) => w.workspace === state.activeWorkspace);
  const wallpaper = settings["appearance.wallpaper"] ?? "aurora";

  return (
    <ShellContext.Provider value={value}>
      <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <TopBar
          onLauncher={() => setLauncher((v) => !v)}
          onPalette={() => setPalette(true)}
          onOverview={() => setOverview((v) => !v)}
          onQuick={() => setQuick((v) => !v)}
          onBlackout={() => setBlackout(true)}
        />

        <div
          ref={deskRef}
          className={`fs-wallpaper-${wallpaper}`}
          // "clip", not "hidden": an overflow:hidden box can still be scrolled by focus()/scrollIntoView, which
          // shifted the whole desktop up and hid window title bars when a module focused a low element (TT15, found by screenshot)
          style={{ position: "relative", flex: 1, minHeight: 0, overflow: "clip" }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <DesktopSurface onLauncher={() => setLauncher(true)} />
          {booted ? <DesktopWidgets /> : null}
          {booted ? <ShellDaemons /> : null}
          {visible.map((w) => <WindowFrame key={w.id} win={w} />)}

          {!booted ? (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--fs-muted)" }}>
              Starting Fusion Shell…
            </div>
          ) : null}

          {overview ? <Overview onClose={() => setOverview(false)} /> : null}
          {palette ? <Palette onClose={() => setPalette(false)} /> : null}
          {quick ? <QuickPanel onClose={() => setQuick(false)} onBlackout={() => setBlackout(true)} /> : null}

          {launcher ? (
            <div className="fs-panel" role="dialog" aria-label="Launcher"
              style={{ position: "absolute", left: 12, bottom: 12, width: 520, maxHeight: "72%", overflow: "auto", padding: 12, zIndex: 9000 }}>
              <div className="fs-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <strong style={{ fontSize: 13 }}>All modules</strong>
                <Btn variant="ghost" onClick={() => setLauncher(false)}>✕</Btn>
              </div>
              {(["Core", "Create", "Connect", "System"] as const).map((group) => (
                <div key={group} style={{ marginBottom: 10 }}>
                  <div className="fs-dim" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 4 }}>{group}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
                    {MODULES.filter((m) => m.group === group).map((m) => (
                      <button key={m.id} className="fs-btn" style={{ justifyContent: "flex-start", height: 40 }}
                        onClick={() => { open(m.id); setLauncher(false); }} title={m.summary}>
                        <span style={{ fontSize: 15 }}>{m.icon}</span>{m.title}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {sheet ? (
            <div className="fs-panel" role="dialog" aria-label="Shortcuts"
              style={{ position: "absolute", inset: "10% 18%", overflow: "auto", padding: 14, zIndex: 9000 }}>
              <div className="fs-row" style={{ justifyContent: "space-between" }}>
                <strong>Shortcuts — {preset} preset</strong><Btn variant="ghost" onClick={() => setSheet(false)}>✕</Btn>
              </div>
              <div style={{ display: "grid", gap: 4, marginTop: 10 }}>
                {BINDINGS.map((b) => (
                  <div key={b.id} className="fs-row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12 }}>{b.label}</span>
                    <span className="fs-row" style={{ gap: 6 }}>
                      {b.reservedBy ? <Badge tone="warn" title={b.reservedBy}>browser-reserved</Badge> : null}
                      <span className="fs-kbd">{comboFor(b, preset)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* BlackTop source-screen blackout (SH-10/SH-11) */}
          {blackout ? (
            <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 99999, color: "#223", display: "grid", placeItems: "center" }}
              onDoubleClick={() => setBlackout(false)}>
              <div style={{ display: "grid", gap: 10, placeItems: "center" }}>
                <div style={{ fontSize: 12, color: "#2b3550" }}>Blackout — this screen is a touchpad for the presenting window.</div>
                <div
                  style={{ width: 260, height: 150, border: "1px solid #1b2440", borderRadius: 10 }}
                  onPointerMove={(e) => {
                    if (e.buttons !== 1 || !state.focus) return;
                    dispatch({ t: "nudge", id: state.focus, dx: e.movementX, dy: e.movementY });
                  }}
                />
                <Btn variant="ghost" onClick={() => setBlackout(false)}>Resume on this screen</Btn>
              </div>
            </div>
          ) : null}
        </div>

        <Shelf />
      </div>

      {/* toasts */}
      <div style={{ position: "fixed", bottom: 64, left: "50%", transform: "translateX(-50%)", display: "grid", gap: 6, zIndex: 99998 }} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="fs-panel" style={{ padding: "8px 12px", display: "flex", gap: 10, alignItems: "center", maxWidth: 560 }}>
            <Badge tone={t.tone === "info" ? "info" : t.tone}>{t.tone}</Badge>
            <span style={{ fontSize: 12 }}>{t.message}</span>
            {t.action ? <Btn variant="ghost" onClick={() => { t.action?.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</Btn> : null}
          </div>
        ))}
      </div>
    </ShellContext.Provider>
  );
}
