"use client";
import { usePadLink } from "./usePadLink";
import { useContextProfiles } from "./useContextProfiles";
import { clipboardRead } from "@/lib/access-log";
import { padCommands, padKeyOf, type PadOp } from "@/lib/windowing/pad-link";
import { mouseConfigFrom, useMouseNavGuard } from "@/lib/input";
import { startLayoutWatch, useChordLabel } from "@/lib/keyboard-layout";
import { fz, readUiUnit, applyTextScale, DEFAULT_TEXT_SCALE, TEXT_SCALE_MIN, TEXT_SCALE_MAX } from "@/lib/uiscale";
import { DEFAULT_WALLPAPER } from "@/lib/appearance";
import { applyStyle, isStyle, resolveWallpaper, useStyleId } from "@/lib/style";

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
import { privacy } from "@/lib/privacy/session";
import {
  initialDesktop, reduce, type DesktopState, type Rect, type WindowCommand,
} from "@/lib/windowing/state";
import { ShellContext, type BeamSession, type ClipEntry, type SaveAnswer, type ShellApi } from "./shell-context";
import ToastStack from "./ToastStack";
import CloseConfirm from "./CloseConfirm";
import { anyDirtyDoc, enqueueAsk, guardFor, isDocDirty, planClose } from "@/lib/doc-lifecycle";
import { addClip, SENSITIVE_CLEAR_MS } from "@/lib/cliphistory";
import WindowFrame from "./WindowFrame";
import TopBar from "./TopBar";
import Shelf from "./Shelf";
import DesktopSurface from "./DesktopSurface";
import Tabletop from "./Tabletop";
import Palette from "./Palette";
import Switcher from "./Switcher";
import OsdLayer from "./OsdLayer";
import { showOsd } from "@/lib/osd";
import Overview from "./Overview";
import QuickPanel from "./QuickPanel";
import Taskbar from "./Taskbar";
import Dock from "./Dock";
import MenuBar from "./MenuBar";
import { StartMenu, Launchpad } from "./LayoutLaunchers";
import { isLayout, layoutOf, pairedSettings } from "@/lib/layout-core";
import { Badge, Btn } from "./ui";
import { AppIcon, FusionLogo, UiGlyph } from "./AppIcon";
import { AskHost } from "./AskHost";
import { NarratorHost } from "./NarratorHost";
import GamepadPointer from "./GamepadPointer";
import { SnapHost, snapUi } from "./SnapHost";
import { askConfirm, isAskOpen } from "@/lib/ask";
import { launchModule, protocolModule } from "@/lib/pwa-launch";
import { importLaunchFile, MAX_LAUNCH_FILES } from "@/lib/pwa-file-import";
import { captureInstallPrompt, markPwaInstalled } from "@/lib/pwa-install";
import { createPointerSampleQueue, createPointerTriggerTracker, pointerGestureAction, type PointerAction } from "@/lib/pointer-triggers";

interface Toast { id: number; message: string; tone: "info" | "ok" | "warn" | "bad"; action?: { label: string; run: () => void } }

/** TT21: default window sizes grow with the text scale (40% of the text growth), clamped to the desktop. */
/** TT56 (WM-05): stable module-title lookup for the switcher */
const appTitle = (m: string) => moduleById(m)?.title ?? m;
function scaledRect(r: Partial<Rect> | undefined, vp: { w: number; h: number } | undefined): Partial<Rect> {
  if (!r) return {};
  const f = Math.max(1, 1 + (readUiUnit() - 1) * 0.4);
  const out: Partial<Rect> = { ...r };
  if (r.w) out.w = Math.round(Math.min(r.w * f, vp ? Math.max(r.w, vp.w - 24) : r.w * f));
  if (r.h) out.h = Math.round(Math.min(r.h * f, vp ? Math.max(r.h, vp.h - 24) : r.h * f));
  return out;
}

export default function Shell({ stateId, hostKind }: { stateId: string; hostKind: "tab" | "pip" | "screen" }) {
  const [state, setState] = useState<DesktopState>(initialDesktop);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [gov, setGov] = useState<GovernorSnapshot>(() => governor.snapshot());
  const [settings, setSettings] = useState<Record<string, string>>({});
  const contextProfiles = useContextProfiles();
  // TT66 IN-01: mouse Back / Forward never navigate the tab away; TT67 IN-02: also the indices the user taught it
  const mouseCfg = useMemo(() => mouseConfigFrom(settings), [settings]);
  useMouseNavGuard(mouseCfg);
  // TT67 IN-03: physical-key chords are labelled with the user's layout
  useEffect(() => startLayoutWatch(), []);
  const chordLabel = useChordLabel();
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
  // A cold-start URL is handled during boot; do not handle its queued copy twice.
  const initialLaunchUrl = useRef<string | null>(null);
  const pointerTriggersOn = (settings["shell.hotCorners"] ?? "on") === "on";
  const triggerPointerPanel = useCallback((action: PointerAction) => {
    setLauncher(action === "launcher");
    setOverview(action === "overview");
    setQuick(action === "quickPanel");
    setPalette(action === "palette");
  }, []);

  const streams = useRef(new Map<string, MediaStream>()).current;
  const commandLog = useRef<{ cmd: WindowCommand; at: number }[]>([]).current;
  const stateRefOpen = useRef(state);
  stateRefOpen.current = state;
  const counter = useRef(0);
  const loaded = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const dirtySince = useRef(0);
  const deskRef = useRef<HTMLDivElement | null>(null);
  const toastId = useRef(1);
  const refreshChan = useRef<BroadcastChannel | null>(null);

  /* ------------------------------------------------------------ dispatch */
  const rawDispatch = useCallback((cmd: WindowCommand) => {
    commandLog.push({ cmd, at: Date.now() });
    if (commandLog.length > 400) commandLog.shift();
    setState((s) => reduce(s, cmd));
  }, [commandLog]);

  /* TT69 FF-15: every close path (title bar, Alt+F4 / Cmd+W, menus, Quit, dock, taskbar, Overview, shelf middle-click,
     routines' Close all) dispatches "close"/"closeAll" — so the Save-changes question is asked HERE, once, for all */
  type AskItem = { id: string; mode: "close" | "replace"; resolve?: (a: SaveAnswer) => void };
  const [askQ, setAskQ] = useState<AskItem[]>([]);
  const askRef = useRef<AskItem[]>([]);
  useEffect(() => { askRef.current = askQ; }, [askQ]);
  const [askBusy, setAskBusy] = useState(false);
  const [askErr, setAskErr] = useState("");
  const dispatch = useCallback((cmd: WindowCommand) => {
    if (cmd.t !== "close" && cmd.t !== "closeAll") { rawDispatch(cmd); return; }
    const plan = planClose(cmd, stateRefOpen.current.windows.map((w) => w.id), isDocDirty);
    const asking = new Set(askRef.current.map((a) => a.id));
    for (const id of plan.closeNow) {
      // a forced close of a window that is being asked about settles its question (nobody is left to answer it)
      if (asking.has(id)) setAskQ((q) => { q.filter((a) => a.id === id).forEach((a) => a.resolve?.("discarded")); return q.filter((a) => a.id !== id); });
      rawDispatch({ t: "close", id });
    }
    if (plan.ask.length) {
      setAskQ((q) => {
        const ids = enqueueAsk(q.map((a) => a.id), plan.ask);
        return ids.map((id) => q.find((a) => a.id === id) ?? { id, mode: "close" as const });
      });
    }
  }, [rawDispatch]);
  const askSave = useCallback((winId: string) => new Promise<SaveAnswer>((resolve) => {
    if (!isDocDirty(winId)) { resolve("saved"); return; }
    setAskQ((q) => (q.some((a) => a.id === winId) ? q : [...q, { id: winId, mode: "replace", resolve }]));
  }), []);
  // only windows that still exist are asked about (a window can also vanish without a close command)
  const liveAsk = useCallback(() => askRef.current.filter((a) => stateRefOpen.current.windows.some((w) => w.id === a.id)), []);
  const settleHead = useCallback((answer: SaveAnswer, closeIt: boolean, stopAll = false) => {
    const q = liveAsk(); const head = q[0]; if (!head) { setAskQ([]); setAskBusy(false); return; }
    if (closeIt && head.mode === "close") rawDispatch({ t: "close", id: head.id });
    head.resolve?.(answer);
    const rest = q.slice(1);
    if (stopAll) rest.forEach((a) => a.resolve?.("cancelled"));
    setAskQ(stopAll ? [] : rest); setAskErr(""); setAskBusy(false);
    if (!closeIt) rawDispatch({ t: "focus", id: head.id });
  }, [rawDispatch, liveAsk]);
  const answerSave = useCallback(async () => {
    const head = liveAsk()[0]; const g = head ? guardFor(head.id) : undefined;
    if (!head) return;
    if (!g) { settleHead("saved", true); return; }
    setAskBusy(true); setAskErr("");
    let ok = false; let err = "";
    try { ok = await g.save(); } catch (e) { err = `Not saved: ${String((e as Error).message)}`; }
    if (ok && !g.dirty()) { settleHead("saved", true); return; }
    setAskBusy(false);
    // a thrown save keeps the question open with the reason; Save As still open / refused: keep the window and stop
    // the queue so the user can finish saving
    if (err) setAskErr(err); else settleHead("cancelled", false, true);
  }, [settleHead, liveAsk]);
  const answerDiscard = useCallback(async () => {
    const head = liveAsk()[0]; if (!head) { settleHead("cancelled", false, true); return; }
    const g = guardFor(head.id);
    setAskBusy(true);
    // the last edits are drafted before the window goes (bounded: a hung store must not trap the user)
    if (g) await Promise.race([g.flushDraft().catch(() => undefined), new Promise((r) => setTimeout(r, 4000))]);
    settleHead("discarded", true);
  }, [settleHead, liveAsk]);
  const answerCancel = useCallback(() => settleHead("cancelled", false, true), [settleHead]);

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
    // TT75 fix: the counter restarts at 0 on every page load while restored windows keep their ids (w1_books …); an id
    // collision made the reducer FOCUS the restored window and drop the new props (a deep-linked / opened file never
    // loaded). Skip ids that are already taken.
    let id = "";
    do { counter.current += 1; id = `w${counter.current}_${moduleId}`; } while (stateRefOpen.current.windows.some((w) => w.id === id));
    dispatch({
      t: "open", id, module: moduleId,
      title: (props?.title as string) ?? mod?.title ?? moduleId,
      // TT55 (WM-08): registry sizes are DEFAULTS (a remembered geometry beats them); only a caller's rect is explicit
      props: props ?? {}, defaults: scaledRect(mod?.rect, stateRefOpen.current.viewport), ...(rect ? { rect } : {}), host: "tab",
    });
    return id;
  }, [dispatch]);

  const clipSeq = useRef(0);
  const copy = useCallback(async (text: string, from: string, sensitive = false) => {
    let wrote = false;
    try { await navigator.clipboard?.writeText(text); wrote = true; } catch { /* clipboard write needs focus; the in-app history still records it */ }
    // unique, increasing ids even for two copies in the same millisecond (entries are addressed by `at`)
    const at = Math.max(Date.now(), clipSeq.current + 1); clipSeq.current = at;
    setClips((c) => addClip(c, { text: sensitive ? "•".repeat(Math.min(text.length, 12)) : text, at, sensitive, from }));
    if (sensitive && wrote) {
      // TT57: like a password manager, clear the system clipboard after 30 s — but only if it still holds this secret
      // (when the page may not read the clipboard, only if Fusion has not copied anything since)
      window.setTimeout(async () => {
        try { if ((await clipboardRead("Shell · clear sensitive copy")) === text) await navigator.clipboard.writeText(""); }
        catch { if (clipSeq.current === at) { try { await navigator.clipboard.writeText(""); } catch { /* no focus: nothing more a web page can do */ } } }
      }, SENSITIVE_CLEAR_MS);
    }
    toast(sensitive ? "Copied (sensitive — not stored, clipboard clears in 30 s)" : "Copied", "ok");
  }, [toast]);
  const editClips = useCallback((fn: (c: ClipEntry[]) => ClipEntry[]) => setClips(fn), []);

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

  // A backup restores settings in one server transaction rather than through setSetting.
  // Refresh the active shell and notify other Fusion tabs without broadcasting values.
  const readSettings = useCallback(async () => {
    const s = await api<{ rows: { key: string; value: string }[] }>("/api/settings");
    setSettings(Object.fromEntries(s.rows.map((r) => [r.key, r.value])));
  }, []);
  const reloadSettings = useCallback(async () => {
    await readSettings();
    refreshChan.current?.postMessage("settings");
  }, [readSettings]);

  /* ----------------------------------------------------------- bootstrap */
  useEffect(() => {
    let cancelled = false;
    if (initialLaunchUrl.current === null) initialLaunchUrl.current = window.location.href;
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
          // TT48: the row's revision column is authoritative (a state written without an inner revision — another tool, an
          // older client — otherwise hydrated as revision 1, and every later save of this tab was refused with 409)
          const revision = Math.max(Number(st.row.revision) || 0, Number(st.row.state.revision) || 0, 1);
          dispatch({ t: "hydrate", state: { ...initialDesktop(), ...st.row.state, ...measured, revision } });
          // TT75: new window ids continue after the restored ones (the deep link below opens before the next render)
          for (const w of st.row.state.windows) { const n = Number(/^w(\d+)_/.exec(String(w.id))?.[1] ?? 0); if (n > counter.current) counter.current = n; }
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
        const command = params.get("cmd");
        const protocolWant = command ? protocolModule(command, MODULES.map((m) => m.id)) : null;
        const want = params.get("open") ?? protocolWant ?? command;
        // TT15: optional file deep link (?open=sheet&path=/Documents/x.fworkbook) — VFS paths only.
        // External protocol intents never gain a path or other command arguments.
        const wantPath = protocolWant ? null : params.get("path");
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

  // Chromium queues installed-PWA launches until a consumer is registered. Register only after hydration,
  // so an incoming window is not overwritten by the restored desktop. Other browsers may not implement this API.
  useEffect(() => {
    if (!booted || hostKind !== "tab") return;
    type Launch = { targetURL?: string; files?: readonly FileSystemHandle[] };
    const queue = (window as unknown as { launchQueue?: { setConsumer: (callback: (launch: Launch) => void) => void } }).launchQueue;
    if (!queue || typeof queue.setConsumer !== "function") return;
    let alive = true;
    let pending = 0;
    let chain: Promise<void> = Promise.resolve();
    const handle = async (launch: Launch) => {
      if (!alive) return;
      if (launch.targetURL) {
        let target = "";
        try { target = new URL(launch.targetURL, window.location.origin).href; } catch { /* reject malformed URL */ }
        if (target && target === initialLaunchUrl.current) {
          initialLaunchUrl.current = null; // already dispatched by the cold-start URL handler
        } else if (target) {
          const app = launchModule(target, window.location.origin, MODULES.map((m) => m.id));
          if (app) open(app);
        }
      }
      const files = launch.files ?? [];
      if (!files.length) return;
      if (files.length > MAX_LAUNCH_FILES) { toast(`Open at most ${MAX_LAUNCH_FILES} files per launch; none were copied.`, "warn"); return; }
      if (!privacy.status().installed || privacy.status().amnesic) { toast("Local file launch import is unavailable in an amnesic session; nothing was copied.", "warn"); return; }
      const consent = await askConfirm({ title: "Copy local files into Fusion?", okLabel: "Copy and open", detail: `${files.length} selected file(s): UTF-8 .txt, .log, .md, .csv or .json, at most 1 MiB each. Fusion sends a plaintext copy to its server in /Documents. Edits affect that copy, not the original file. Unsupported files are skipped.` });
      if (!alive || !consent) return;
      let copied = 0, failed = 0;
      let lastError = "";
      for (const handle of files) {
        if (!alive) return;
        try {
          if (handle.kind !== "file") throw new Error("Only files can be opened");
          const imported = await importLaunchFile(await (handle as FileSystemFileHandle).getFile());
          copied++;
          open("editor", { path: imported.path, title: imported.name });
          setRefreshTick((n) => n + 1);
        } catch (e) { failed++; lastError = String((e as Error).message ?? "Unable to read the file").slice(0, 160); }
      }
      if (failed) toast(`${copied} copied; ${failed} skipped. ${lastError}`, "warn");
      else if (copied) toast(`${copied} local file(s) copied to /Documents. The originals are unchanged.`, "ok");
    };
    try {
      queue.setConsumer((launch) => {
        if (!alive) return;
        if (pending >= 8) { toast("Too many pending launch requests; the extra request was ignored.", "warn"); return; }
        pending++;
        chain = chain.then(() => handle(launch)).catch(() => { if (alive) toast("Could not handle a PWA launch.", "warn"); }).finally(() => { pending--; });
      });
    } catch { toast("This browser could not enable PWA launch handling.", "warn"); }
    return () => { alive = false; };
  }, [booted, hostKind, open, toast]);

  useEffect(() => {
    const unsubscribe = governor.subscribe(setGov);
    return () => { unsubscribe(); };
  }, []);

  /* ------------------------------------------------- persistence (SH-08) */
  useEffect(() => {
    if (!loaded.current) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    // TT21: debounce 600 ms but never defer a save more than 1 s past the first unsaved change, so a stream of
    // state updates (drag, resize, reflow) cannot starve persistence.
    const now = Date.now();
    if (!dirtySince.current) dirtySince.current = now;
    const wait = Math.max(0, Math.min(600, dirtySince.current + 1000 - now));
    saveTimer.current = window.setTimeout(() => {
      dirtySince.current = 0;
      void fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: stateId, state, revision: state.revision }) })
        .then(async (r) => {
          if (r.status !== 409) return;
          // TT48 (SH-08 contract): a newer desktop was saved by another tab/window — adopt it instead of silently dropping
          // this save (and, before this fix, every later one: the stale revision never caught up)
          const j = await r.json().catch(() => null) as { row?: { state?: DesktopState; revision?: number } } | null;
          if (!j?.row?.state) return;
          const desk = deskRef.current?.getBoundingClientRect();
          const measured = desk && desk.width > 0 && desk.height > 0 ? { viewport: { w: Math.round(desk.width), h: Math.round(desk.height) } } : {};
          dispatch({ t: "reconcile", state: { ...initialDesktop(), ...j.row.state, ...measured, revision: Math.max(Number(j.row.revision) || 0, Number(j.row.state.revision) || 0) } });
          toast("This desktop was also changed in another tab or window — its changes were merged in; the windows open here stay.", "info");
        })
        .catch(() => undefined);
      // TT18: the browser-profile mirror gets the same /Private path sealing as the server copy
      void (privacy.layer ? privacy.layer.sealState(state) : Promise.resolve(state))
        .then((sealed) => { try { localStorage.setItem(`fusion.state.${stateId}`, JSON.stringify(sealed)); } catch { /* quota */ } });
    }, wait);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [state, stateId]);

  useEffect(() => {
    const flush = () => {
      if (!loaded.current) return;
      // keepalive fetch, not sendBeacon: the state endpoint is PUT with
      // optimistic concurrency, and sendBeacon can only issue POST.
      // browsers reject keepalive bodies over 64 KiB (TT27: saved Tabletop views can push the state past that) —
      // a big state still goes out as a normal request, which usually completes before the page is torn down
      const body = JSON.stringify({ id: stateId, state, revision: state.revision });
      void fetch("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
        keepalive: body.length < 60_000,
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
    // TT56 (ST-05): "system" follows the OS prefers-color-scheme (live, see the effect below); dark stays the house default
    const th = settings["appearance.theme"] ?? "dark";
    root.dataset.theme = th === "system" ? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark") : th;
    root.dataset.themeSource = th === "system" ? "system" : "user";
    root.dataset.density = contextProfiles.active?.density ?? settings["appearance.density"] ?? "balanced";
    root.dataset.contextProfile = contextProfiles.active ? contextProfiles.observation?.kind ?? "" : "off";
    const motion = settings["appearance.motion"] ?? "system";
    root.dataset.motion = motion === "off" ? "off" : "";
    root.dataset.effects = gov.effects && (settings["perf.effects"] ?? "auto") !== "off" ? "on" : "off";
    // TT22: "auto" (default) = follow the style's accent (CSS var --fs-style-accent); a picked colour wins
    const accent = settings["appearance.accent"];
    if (accent && accent !== "auto") root.style.setProperty("--fs-accent", accent); else root.style.removeProperty("--fs-accent");
    applyStyle(settings["appearance.style"]);
    // TT25: main-UI layout (CSS hooks: window chrome, toasts, dock/taskbar styles)
    root.dataset.layout = layoutOf(settings["appearance.layout"]);
    applyTextScale(contextProfiles.active?.textScale ?? Number(settings["appearance.textScale"] ?? DEFAULT_TEXT_SCALE));
  }, [settings, gov.effects, contextProfiles.active, contextProfiles.observation]);

  // An opt-in automatic profile transition is visible, not a silent appearance mutation.
  const previousContext = useRef<string | null>(null);
  useEffect(() => {
    const kind = contextProfiles.active ? contextProfiles.observation?.kind ?? null : null;
    if (kind && previousContext.current && kind !== previousContext.current) {
      const label = kind === "extended" ? "multiple screens" : kind === "single-touch" ? "single screen / touch" : "single screen / pointer";
      showOsd("layout", `Context profile: ${label}`);
    }
    previousContext.current = kind;
  }, [contextProfiles.active, contextProfiles.observation]);

  /* TT56 (ST-05): live OS colour-scheme following for the "system" theme */
  const themeSetting = settings["appearance.theme"] ?? "dark";
  useEffect(() => {
    if (themeSetting !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => { document.documentElement.dataset.theme = mq.matches ? "light" : "dark"; };
    apply(); mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [themeSetting]);
  /* TT56 (WM-10): focus mode is ONE parent CSS variable (--fs-focus-dim) that every unfocused window reads */
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--fs-focus-dim", state.focusMode ? "0.45" : "1");
    root.dataset.focusMode = state.focusMode ? "on" : "off";
  }, [state.focusMode]);

  /* ------------------------------------------------- TT56 on-screen display (NC-06) */
  // shown for user-visible system changes AFTER boot (hydration itself is silent): text size, layout, theme, focus mode,
  // workspace. Volume comes from <OsdLayer>'s own volumechange listener and the Streams slider.
  const osdPrev = useRef<Record<string, string> | null>(null);
  const osdNow: Record<string, string> = {
    text: String(settings["appearance.textScale"] ?? DEFAULT_TEXT_SCALE), layout: layoutOf(settings["appearance.layout"]),
    theme: String(settings["appearance.style"] ?? ""), focus: String(state.focusMode), ws: String(state.activeWorkspace),
  };
  const osdKey = JSON.stringify(osdNow);
  useEffect(() => {
    const now = JSON.parse(osdKey) as Record<string, string>;
    const prev = osdPrev.current;
    if (!booted) return;
    osdPrev.current = now;
    if (!prev) return;
    if (now.text !== prev.text) { const pct = Math.round(Number(now.text)); showOsd("text", `Text size ${pct}%`, Math.min(100, Math.round(pct / 2))); }
    else if (now.layout !== prev.layout) showOsd("layout", `Layout: ${now.layout === "art" ? "Art (dock)" : now.layout === "business" ? "Business (taskbar)" : now.layout}`);
    else if (now.theme !== prev.theme && now.theme) showOsd("theme", `Theme: ${now.theme.replace(/^./, (c) => c.toUpperCase())}`);
    else if (now.focus !== prev.focus) showOsd("focus", now.focus === "true" ? "Focus mode on" : "Focus mode off");
    else if (now.ws !== prev.ws) showOsd("workspace", `Workspace: ${state.workspaces.find((w) => String(w.id) === now.ws)?.name ?? now.ws}`);
  }, [osdKey, booted, state.workspaces]);

  /* ------------------------------------------------------------ keyboard */
  const preset = (settings["shell.shortcutPreset"] ?? "hybrid") as Preset;
  const switcherCombo = useMemo(() => { const b = BINDINGS.find((x) => x.id === "switcher"); return b ? comboFor(b, preset) : ""; }, [preset]);
  useEffect(() => {
    const chord = (id: string) => {
      const b = BINDINGS.find((x) => x.id === id);
      return b ? comboFor(b, preset) : "";
    };
    const onKey = (e: KeyboardEvent) => {
      // TT28: an open ask dialog is modal: no global shortcut (palette, close window, tiling…) may act behind it
      if (isAskOpen()) return;
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
      // the switcher chord (WM-05) is handled by <Switcher> in the capture phase (held-modifier overlay, MRU order)
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
      if (matchChord(e, chord("snapLayouts"))) return act(() => {
        // TT28: open the snap layouts flyout for the focused window, keyboard-first (focus moves into it)
        const w = state.windows.find((x) => x.id === focus); if (!w) return;
        snapUi.set({ flyout: { id: focus, x: Math.round(w.x + w.w - 300), y: Math.round(w.y + 40), viaKeyboard: true } });
      });
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

  /* ------------------------- SH-06 viewport pointer triggers */
  useEffect(() => {
    if (!pointerTriggersOn) return;
    let track = createPointerTriggerTracker();
    const pending = createPointerSampleQueue();
    let frame = 0;
    let activeGesture: { pointerId: number; x: number; y: number; surface: string; candidate: PointerAction | null; contextMenu: { x: number; y: number } | null } | null = null;
    let suppressContextUntil = 0;
    let contextReset = 0;
    const clearContextSuppression = () => {
      suppressContextUntil = 0;
      if (contextReset) window.clearTimeout(contextReset);
      contextReset = 0;
    };
    const allowGestureStart = (target: EventTarget | null): string | null => {
      if (!(target instanceof Element)) return null;
      const surface = target.closest("[data-pointer-gesture-surface]");
      if (!surface || !deskRef.current?.contains(surface)) return null;
      if (target.closest("button, a, input, textarea, select, [role='button'], [role='dialog'], [role='menu'], [role='menuitem'], [contenteditable='true'], .fs-window, .fs-panel, [data-pointer-gesture-ignore]")) return null;
      const kind = surface.getAttribute("data-pointer-gesture-surface");
      if (kind === "classic" && target === surface) return kind;
      if (kind === "tabletop" && (target === surface || target.closest(".fs-tt-face"))) return kind;
      return null;
    };
    const onMove = (event: Event) => {
      const e = event as PointerEvent;
      if (e.pointerType !== "mouse") return;
      pending.push({ x: e.clientX, y: e.clientY, width: window.innerWidth, height: window.innerHeight,
        at: performance.now(), movementX: e.movementX, movementY: e.movementY, buttons: e.buttons });
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const { batch, reset } = pending.drain();
        if (reset) { track = createPointerTriggerTracker(); return; }
        let action: PointerAction | null = null;
        for (const sample of batch) action = track(sample) ?? action;
        if (action && !isAskOpen()) triggerPointerPanel(action);
      });
    };
    const onPointerDown = (event: Event) => {
      const e = event as PointerEvent;
      const surface = allowGestureStart(e.target);
      if (e.pointerType !== "mouse" || e.button !== 2 || isAskOpen() || !surface) return;
      clearContextSuppression();
      activeGesture = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, surface, candidate: null, contextMenu: null };
    };
    const onPointerMove = (event: Event) => {
      const e = event as PointerEvent, gesture = activeGesture;
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      gesture.candidate = pointerGestureAction(2, e.clientX - gesture.x, e.clientY - gesture.y);
    };
    const onPointerUp = (event: Event) => {
      const e = event as PointerEvent, gesture = activeGesture;
      if (!gesture || e.pointerId !== gesture.pointerId) return;
      activeGesture = null;
      const action = pointerGestureAction(2, e.clientX - gesture.x, e.clientY - gesture.y);
      if (action) {
        // Chromium may dispatch contextmenu before pointerup. Keep it suppressed in either event order.
        suppressContextUntil = performance.now() + 700;
        contextReset = window.setTimeout(clearContextSuppression, 700);
        if (!isAskOpen()) triggerPointerPanel(action);
        return;
      }
      if (gesture.contextMenu && gesture.surface === "classic") {
        // A plain right-click's contextmenu arrived while the gesture was still ambiguous. Replay it as the existing
        // React menu after pointerup; a short drag therefore keeps its ordinary menu instead of being lost.
        window.dispatchEvent(new CustomEvent("fusion:desktop-context-menu", { detail: gesture.contextMenu }));
        suppressContextUntil = performance.now() + 250;
        contextReset = window.setTimeout(clearContextSuppression, 250);
      }
    };
    const onPointerCancel = (event: Event) => {
      const e = event as PointerEvent, gesture = activeGesture;
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      activeGesture = null;
      if (gesture.contextMenu && gesture.surface === "classic")
        window.dispatchEvent(new CustomEvent("fusion:desktop-context-menu", { detail: gesture.contextMenu }));
    };
    const onContextMenu = (event: Event) => {
      const e = event as MouseEvent;
      if (activeGesture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        activeGesture.contextMenu = { x: e.clientX, y: e.clientY };
        return;
      }
      if (suppressContextUntil < performance.now()) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      clearContextSuppression();
    };
    const moveEvent = "onpointerrawupdate" in window ? "pointerrawupdate" : "pointermove";
    window.addEventListener(moveEvent, onMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      window.removeEventListener(moveEvent, onMove);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("contextmenu", onContextMenu, true);
      if (frame) window.cancelAnimationFrame(frame);
      if (contextReset) window.clearTimeout(contextReset);
      pending.clear();
      activeGesture = null;
    };
  }, [pointerTriggersOn, triggerPointerPanel]);

  /* ------------------------- real browser install prompt (AP-01 / SH-13) */
  useEffect(() => {
    const onPrompt = (event: Event) => { captureInstallPrompt(event); };
    const onInstalled = () => markPwaInstalled();
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

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
        case "style": if (isStyle(arg)) await setSetting("appearance.style", arg); break;
        case "view": if (arg === "tabletop" || arg === "classic") await setSetting("appearance.desktopView", arg); else toast(`Routine: unknown desktop view "${arg}"`, "warn"); break;
        case "layout": if (isLayout(arg)) { await setSetting("appearance.layout", arg); for (const [k, v] of pairedSettings(arg, settings)) await setSetting(k, v); } else toast(`Routine: unknown layout "${arg}"`, "warn"); break;
        case "textsize": { const n = Number(arg); if (Number.isInteger(n) && n >= TEXT_SCALE_MIN && n <= TEXT_SCALE_MAX) await setSetting("appearance.textScale", String(n)); break; }
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
  /** SH-04: a file change made in another tab / window of this browser (same origin) refreshes this desktop too — the bump
   *  is broadcast (no payload, no paths) and a tab that was hidden re-reads when it becomes visible again. */
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("fusion.refresh"); refreshChan.current = ch;
    ch.onmessage = (event) => {
      setRefreshTick((t) => t + 1);
      if (event.data === "settings") void readSettings().catch(() => undefined);
    };
    const onVis = () => { if (document.visibilityState === "visible") setRefreshTick((t) => t + 1); };
    document.addEventListener("visibilitychange", onVis);
    return () => { ch.close(); refreshChan.current = null; document.removeEventListener("visibilitychange", onVis); };
  }, [readSettings]);
  const bumpRefresh = useCallback(() => { setRefreshTick((t) => t + 1); refreshChan.current?.postMessage(1); }, []);
  /** TT72 SH-11: the Blackout pad drives the presenting window over BroadcastChannel("fusion-shell") */
  const pad = usePadLink(stateId, hostKind, stateRefOpen, dispatch);
  const startBlackout = useCallback(() => { setBlackout(true); pad.refresh(); }, [pad]);
  const padLocal = useCallback((op: PadOp) => { for (const c of padCommands(op, stateRefOpen.current)) dispatch(c); }, [dispatch]);
  const padInput = useCallback((op: PadOp) => { if (!pad.send(op)) padLocal(op); }, [pad, padLocal]);

  const value: ShellApi = useMemo(() => ({
    state, dispatch, open, caps, gov, settings, contextProfiles, setSetting, reloadSettings, toast,
    streams, publishStream, streamVersion, clips, copy, editClips, beam, setBeam,
    commandLog, hostKind, pulse, refreshTick, bumpRefresh, runActions, askSave,
  }), [state, dispatch, open, caps, gov, settings, contextProfiles, setSetting, reloadSettings, toast, streams, publishStream,
      streamVersion, clips, copy, editClips, beam, commandLog, hostKind, pulse, refreshTick, bumpRefresh, runActions, askSave]);

  // TT69 FF-15: while "Save changes?" is open nothing behind it can be focused or clicked
  const rootRef = useRef<HTMLDivElement | null>(null);
  const asking = askQ.some((a) => state.windows.some((w) => w.id === a.id));
  useEffect(() => {
    const el = rootRef.current; if (!el) return;
    if (asking) el.setAttribute("inert", ""); else el.removeAttribute("inert");
  }, [asking]);
  // leaving the page with unsaved documents: the browser's own prompt, and the newest drafts are started
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!anyDirtyDoc()) return;
      for (const w of stateRefOpen.current.windows) { const g = guardFor(w.id); if (g && isDocDirty(w.id)) void g.flushDraft().catch(() => undefined); }
      e.preventDefault(); e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);
  const askLive = askQ.filter((a) => state.windows.some((w) => w.id === a.id));
  const askHead = askLive[0];
  const askGuard = askHead ? guardFor(askHead.id) : undefined;

  const styleId = useStyleId();
  const visible = state.windows.filter((w) => w.workspace === state.activeWorkspace);
  const wallpaper = resolveWallpaper(settings["appearance.wallpaper"] ?? DEFAULT_WALLPAPER, styleId);
  const layout = layoutOf(settings["appearance.layout"]);
  const desktopView = settings["appearance.desktopView"] === "tabletop" ? "tabletop" : "classic";


  return (
    <ShellContext.Provider value={value}>
      {/* TT25: in Business / Art the wallpaper sits behind the whole column so the translucent taskbar, menu bar and
          floating dock show it through; Fusion keeps it on the desk exactly as before */}
      <div ref={rootRef} className={layout === "fusion" ? undefined : `fs-wallpaper-${wallpaper}`} data-layout={layout}
        data-shell-ready={booted ? "true" : "false"} aria-busy={!booted}
        style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {layout === "fusion" ? (
          <TopBar
            onLauncher={() => setLauncher((v) => !v)}
            onPalette={() => setPalette(true)}
            onOverview={() => setOverview((v) => !v)}
            onQuick={() => setQuick((v) => !v)}
            onBlackout={startBlackout}
          />
        ) : null}
        {layout === "art" ? (
          <MenuBar
            onLaunchpad={() => setLauncher((v) => !v)}
            onPalette={() => setPalette(true)}
            onOverview={() => setOverview((v) => !v)}
            onQuick={() => setQuick((v) => !v)}
            onBlackout={startBlackout}
            onShortcuts={() => setSheet(true)}
          />
        ) : null}

        <div
          ref={deskRef}
          className={layout === "fusion" ? `fs-wallpaper-${wallpaper}` : undefined}
          // "clip", not "hidden": an overflow:hidden box can still be scrolled by focus()/scrollIntoView, which
          // shifted the whole desktop up and hid window title bars when a module focused a low element (TT15, found by screenshot)
          // TT25: Business/Art isolate the desk so window z-indices (which only grow) can never paint over the taskbar,
          // menu bar, dock, their menus or the magnified dock icons that overlap the desk
          style={{ position: "relative", flex: 1, minHeight: 0, overflow: "clip", ...(layout === "fusion" ? {} : { zIndex: 0, isolation: "isolate" as const }) }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {desktopView === "tabletop" && booted ? <Tabletop /> : (
            <>
              <DesktopSurface />
              {booted ? <DesktopWidgets /> : null}
            </>
          )}
          {booted ? <ShellDaemons /> : null}
          {visible.map((w) => <WindowFrame key={w.id} win={w} />)}
          {booted ? <SnapHost /> : null}

          {!booted ? (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--fs-muted)" }}>
              Starting Fusion Shell…
            </div>
          ) : null}

          {overview ? <Overview onClose={() => setOverview(false)} /> : null}
          <AskHost />
          {booted ? <NarratorHost /> : null}
          {palette ? <Palette onClose={() => setPalette(false)} /> : null}
          <OsdLayer />
          <Switcher state={state} dispatch={dispatch} combo={switcherCombo} appName={appTitle} blocked={isAskOpen} />
          {quick ? <QuickPanel onClose={() => setQuick(false)} onBlackout={startBlackout} anchor={layout === "business" ? "bottom" : "top"} /> : null}

          {launcher && layout === "business" ? <StartMenu onClose={() => setLauncher(false)} /> : null}
          {launcher && layout === "art" ? <Launchpad onClose={() => setLauncher(false)} /> : null}
          {launcher && layout === "fusion" ? (
            <div className="fs-panel" role="dialog" aria-label="Launcher"
              style={{ position: "absolute", left: 12, bottom: 12, width: `min(${fz(560)}, calc(100% - 24px))`, maxHeight: "calc(100% - 24px)", overflow: "auto", padding: 12, zIndex: 9000 }}>
              <div className="fs-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <span className="fs-row" style={{ gap: fz(6) }}><FusionLogo size={22} label="" /><strong style={{ fontSize: fz(14) }}>All modules</strong></span>
                <Btn variant="ghost" onClick={() => setLauncher(false)} aria-label="Close launcher"><UiGlyph name="close" /></Btn>
              </div>
              {(["Core", "Create", "Connect", "System"] as const).map((group) => (
                <div key={group} style={{ marginBottom: 10 }}>
                  <div className="fs-dim" style={{ fontSize: fz(10.5), textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 4 }}>{group}</div>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${fz(150)}, 1fr))`, gap: 6 }}>
                    {MODULES.filter((m) => m.group === group).map((m) => (
                      <button key={m.id} className="fs-btn" style={{ justifyContent: "flex-start", minHeight: fz(40), gap: fz(7), padding: `${fz(3)} ${fz(6)}` }}
                        onClick={() => { open(m.id); setLauncher(false); }} title={m.summary}>
                        <AppIcon id={m.id} size={26} /><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.title}</span>
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
                    <span style={{ fontSize: fz(12) }}>{b.label}</span>
                    <span className="fs-row" style={{ gap: 6 }}>
                      {b.reservedBy ? <Badge tone="warn" title={b.reservedBy}>browser-reserved</Badge> : null}
                      <span className="fs-kbd" title={`physical key: ${comboFor(b, preset)} (US-layout name)`} data-chord={comboFor(b, preset)}>{chordLabel(comboFor(b, preset))}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

        </div>

        {layout === "fusion" ? <Shelf /> : null}
        {layout === "business" ? (
          <Taskbar onStart={() => setLauncher((v) => !v)} startOpen={launcher} onPalette={() => setPalette(true)}
            onOverview={() => setOverview((v) => !v)} onQuick={() => setQuick((v) => !v)} onBlackout={startBlackout} />
        ) : null}
        {layout === "art" ? <Dock onLaunchpad={() => setLauncher((v) => !v)} launchpadOpen={launcher} /> : null}
      </div>

      {/* TT37 IN-07: outside the desk — in Business / Art the desk is an isolated stacking context (z-index 0), which
          would paint the pointer under the taskbar, menu bar and dock it has to reach */}
      {booted ? <GamepadPointer /> : null}

      {/* BlackTop source-screen blackout (SH-10/SH-11) */}
      {blackout ? (
        <div style={{ position: "fixed", inset: 0, background: "#000", zIndex: 99999, color: "#223", display: "grid", placeItems: "center" }}
          onDoubleClick={() => setBlackout(false)} data-testid="blackout"
          tabIndex={-1} ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus(); }}
          onKeyDown={(e) => {
            const key = padKeyOf(e.key); if (!key) return;
            e.preventDefault(); e.stopPropagation();
            padInput({ t: "key", key, shift: e.shiftKey });
          }}>
          <div style={{ display: "grid", gap: 10, placeItems: "center" }}>
            <div style={{ fontSize: fz(12), color: "#7f8db3" }}>Blackout — this screen is a touchpad and keyboard for the presenting window.</div>
            <div
              data-testid="blackout-pad" aria-label="Touchpad" role="application"
              style={{ width: 300, height: 180, border: "1px solid #2b3a66", borderRadius: 12, touchAction: "none" }}
              onPointerMove={(e) => {
                if (e.buttons !== 1 || (!e.movementX && !e.movementY)) return;
                padInput({ t: "move", dx: e.movementX, dy: e.movementY });
              }}
            />
            <div data-testid="pad-status" aria-live="polite" style={{ fontSize: fz(12), color: "#9aa7cc", maxWidth: 420, textAlign: "center" }}>
              {pad.target
                ? <>Driving the presenting screen ({pad.target}){pad.ack?.moved ? <> · moving “{pad.ack.moved}”</> : null}. Arrows nudge (Shift = ×5), Tab cycles windows, Enter maximises, Home shows the desktop.</>
                : <>No presenting screen is open — the pad moves this screen&apos;s focused window. Open one with Display → present.</>}
            </div>
            <Btn variant="ghost" onClick={() => setBlackout(false)}>Resume on this screen</Btn>
          </div>
        </div>
      ) : null}

      <ToastStack toasts={toasts} invoke={async(t)=>{
        try{await Promise.resolve().then(()=>t.action?.run());}
        catch(e){toast(`Action failed: ${e instanceof Error?e.message:String(e)}`,"bad");}
        finally{setToasts(x=>x.filter(y=>y.id!==t.id));}
      }}/>
      {askHead ? (
        <CloseConfirm key={askHead.id + askHead.mode} title={askGuard?.title() ?? state.windows.find((w) => w.id === askHead.id)?.title ?? "document"}
          recoverable={askGuard?.recoverable?.() ?? true} mode={askHead.mode} busy={askBusy} error={askErr} queued={askLive.length}
          onSave={() => void answerSave()} onDiscard={() => void answerDiscard()} onCancel={answerCancel} />
      ) : null}
    </ShellContext.Provider>
  );
}
