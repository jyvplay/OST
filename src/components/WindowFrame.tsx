"use client";
import { EDGE_HOLD_MS, EDGE_IDLE, edgeFired, edgeMove, edgeSide, neighbourWorkspace, snapSuppressed, type EdgeHold } from "@/lib/windowing/edge-hold";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WindowState } from "@/lib/windowing/state";
import { useShell } from "./shell-context";
import ModuleHost from "./ModuleHost";
import { AppIcon, UiGlyph, type UiGlyphName } from "./AppIcon";
import { layoutOf } from "@/lib/layout-core";
import { assistPlan, dragTarget, type DragTarget } from "@/lib/snap-core";
import { snapUi, startAssist } from "./SnapHost";
import { runGenie } from "./genie";
import { armFocusRaise, keyboardNavRecent } from "@/lib/focus-raise";

const ORDER_ART: UiGlyphName[] = ["close", "minimize", "maximize"];
const clearSnapPreview = () => { if (snapUi.get().preview) snapUi.set({ preview: null }); };

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

/**
 * Rendering contract (HW-01 / WM-01):
 *  - position is a transform, size is width/height; nothing animates layout
 *  - during a drag we write style directly through a ref at pointer rate and
 *    dispatch ONE reducer command on pointerup. Dispatching per pointermove is
 *    the common implementation and it collapses past ~6 windows.
 */
export default function WindowFrame({ win }: { win: WindowState }) {
  const shell = useShell();
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ mode: "move" | Handle; x0: number; y0: number; rect: { x: number; y: number; w: number; h: number }; snap?: DragTarget | null; edge?: EdgeHold; timer?: number } | null>(null);
  const [pipDoc, setPipDoc] = useState<Document | null>(null);
  const focused = shell.state.focus === win.id;

  // TT28 Art genie: remember the live element while the window is shown; when it gets minimised, React has already
  // removed it, and the detached element is cloned and animated into its dock tile
  const lastEl = useRef<{ el: HTMLElement; desk: HTMLElement } | null>(null);
  const artLayout = layoutOf(shell.settings["appearance.layout"]) === "art";
  useEffect(() => { armFocusRaise(); }, []);
  useEffect(() => {
    if (!win.minimized) { const el = ref.current, desk = el?.parentElement; if (el && desk) lastEl.current = { el, desk }; return; }
    const last = lastEl.current; lastEl.current = null;
    if (last && artLayout && win.host !== "pip") runGenie(last.el, last.desk, { x: win.x, y: win.y, w: win.w, h: win.h }, win.id);
    // geometry deliberately read at the moment of minimising only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.minimized]);

  // keep the DOM in sync when the reducer changes geometry (keyboard moves, tiling)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = `translate3d(${win.x}px, ${win.y}px, 0)`;
    el.style.width = `${win.w}px`;
    el.style.height = `${win.h}px`;
  }, [win.x, win.y, win.w, win.h]);

  const onPointerDown = useCallback((e: React.PointerEvent, mode: "move" | Handle) => {
    // buttons 3/4 are browser Back/Forward: never let them start a drag
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { mode, x0: e.clientX, y0: e.clientY, rect: { x: win.x, y: win.y, w: win.w, h: win.h } };
    shell.dispatch({ t: "focus", id: win.id });
    e.preventDefault();
    e.stopPropagation();
  }, [shell, win.id, win.x, win.y, win.w, win.h]);

  /* TT70 WM-13: edge-hold → move the window to the neighbouring workspace (timer: a still pointer sends no events) */
  const disarmEdge = useCallback((d: NonNullable<typeof drag.current>) => {
    if (d.timer !== undefined) { window.clearTimeout(d.timer); d.timer = undefined; }
    delete ref.current?.dataset.edgeHold;
  }, []);
  const edgeStep = useCallback((d: NonNullable<typeof drag.current>, x: number, width: number) => {
    const side = edgeSide(x, width);
    const st = shell.state;
    const r = edgeMove(d.edge ?? EDGE_IDLE, side, neighbourWorkspace(st.workspaces, st.activeWorkspace, side) !== null);
    d.edge = r.state;
    if (r.timer === "keep") return;
    disarmEdge(d);
    if (r.timer !== "arm") return;
    if (ref.current) ref.current.dataset.edgeHold = side < 0 ? "left" : "right";
    d.timer = window.setTimeout(() => {
      d.timer = undefined; delete ref.current?.dataset.edgeHold;
      if (drag.current !== d || !d.edge || d.edge.side !== side) return; // released / moved away meanwhile
      const target = neighbourWorkspace(shell.state.workspaces, shell.state.activeWorkspace, side);
      if (target === null) return;
      shell.dispatch({ t: "toWorkspace", id: win.id, workspace: target });
      shell.dispatch({ t: "switchWorkspace", workspace: target });
      d.edge = edgeFired(d.edge); d.snap = null; clearSnapPreview();
    }, EDGE_HOLD_MS);
  }, [shell, win.id, disarmEdge]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    shell.pulse(performance.now());
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    let { x, y, w, h } = d.rect;
    if (d.mode === "move") {
      x += dx; y += dy;
      // TT28: live snap preview from the POINTER position (corners → quarters, sides → halves, top → maximise)
      const desk = el.parentElement?.getBoundingClientRect();
      if (desk) {
        edgeStep(d, e.clientX - desk.left, desk.width);
        const t = d.edge && snapSuppressed(d.edge) ? null : dragTarget(e.clientX - desk.left, e.clientY - desk.top, shell.state.viewport);
        if ((t?.key ?? null) !== (d.snap?.key ?? null)) snapUi.set({ preview: t ? { ...t.rect, key: t.key } : null });
        d.snap = t;
      }
    }
    else {
      if (d.mode.includes("e")) w = d.rect.w + dx;
      if (d.mode.includes("s")) h = d.rect.h + dy;
      if (d.mode.includes("w")) { w = d.rect.w - dx; x = d.rect.x + dx; }
      if (d.mode.includes("n")) { h = d.rect.h - dy; y = d.rect.y + dy; }
      w = Math.max(240, w); h = Math.max(180, h);
    }
    el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    el.style.width = `${Math.round(w)}px`;
    el.style.height = `${Math.round(h)}px`;
    el.dataset.pendingX = String(Math.round(x));
    el.dataset.pendingY = String(Math.round(y));
    el.dataset.pendingW = String(Math.round(w));
    el.dataset.pendingH = String(Math.round(h));
  }, [shell, edgeStep]);

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (d) disarmEdge(d);
    if (!d || !el) return;
    const x = Number(el.dataset.pendingX ?? win.x);
    const y = Number(el.dataset.pendingY ?? win.y);
    const w = Number(el.dataset.pendingW ?? win.w);
    const h = Number(el.dataset.pendingH ?? win.h);
    if (d.mode === "move") {
      // drag-to-edge tiling (WM-02)
      const vp = shell.state.viewport;
      clearSnapPreview();
      if (d.snap) {
        const t = d.snap;
        if (t.key === "full") shell.dispatch({ t: "tile", id: win.id, slot: "full" });
        else {
          shell.dispatch({ t: "place", id: win.id, rect: t.rect });
          // Business: Snap Assist offers the other open windows for the zones left empty
          if (layoutOf(shell.settings["appearance.layout"]) === "business") {
            const others = shell.state.windows.filter((o) => o.id !== win.id && (o.workspace ?? 1) === shell.state.activeWorkspace && o.host !== "pip").length;
            startAssist(assistPlan(t.layout, t.key, vp, others), win.id);
          }
        }
      }
      else if (y <= 2) shell.dispatch({ t: "tile", id: win.id, slot: "full" });
      // TT70 WM-13: released at the edge it just hopped across → the geometric half-tile is suppressed as well
      else if (d.edge && snapSuppressed(d.edge)) shell.dispatch({ t: "move", id: win.id, x, y });
      else if (x <= 2) shell.dispatch({ t: "tile", id: win.id, slot: "left" });
      else if (x + w >= vp.w - 2) shell.dispatch({ t: "tile", id: win.id, slot: "right" });
      else shell.dispatch({ t: "move", id: win.id, x, y });
    } else {
      shell.dispatch({ t: "resize", id: win.id, w, h, x, y });
    }
  }, [shell, win.id, win.x, win.y, win.w, win.h, disarmEdge]);

  /** WM-11: Document Picture-in-Picture is the web's only true always-on-top. */
  const popOut = useCallback(async () => {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow: (o: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture;
    if (!dpip) {
      const popup = window.open("", `fusion-${win.id}`, `width=${win.w},height=${win.h}`);
      if (!popup) shell.toast("The browser blocked the pop-out window.", "warn");
      else shell.toast("Document PiP is unavailable here; opened a plain popup instead (not always-on-top).", "warn");
      return;
    }
    try {
      const pip = await dpip.requestWindow({ width: Math.round(win.w), height: Math.round(win.h) });
      // Stylesheet adoption — the step most PiP demos skip, without which the
      // portalled React tree renders completely unstyled.
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const css = Array.from(sheet.cssRules).map((r) => r.cssText).join("");
          const style = pip.document.createElement("style");
          style.textContent = css;
          pip.document.head.appendChild(style);
        } catch {
          const link = sheet.href ? pip.document.createElement("link") : null;
          if (link && sheet.href) { link.rel = "stylesheet"; link.href = sheet.href; pip.document.head.appendChild(link); }
        }
      }
      pip.document.documentElement.setAttribute("data-theme", document.documentElement.dataset.theme ?? "dark");
      pip.document.body.style.margin = "0";
      pip.document.body.style.background = "var(--fs-panel-solid)";
      pip.addEventListener("pagehide", () => {
        setPipDoc(null);
        shell.dispatch({ t: "setHost", id: win.id, host: "tab" });
      });
      setPipDoc(pip.document);
      shell.dispatch({ t: "setHost", id: win.id, host: "pip" });
    } catch (err) {
      shell.toast(`Pop-out failed: ${String((err as Error).message)}`, "bad");
    }
  }, [shell, win.id, win.w, win.h]);

  const body = <ModuleHost win={win} />;

  if (win.host === "pip" && pipDoc) {
    return (
      <>
        <div className="fs-window" ref={ref} style={{ zIndex: win.z, opacity: .55 }} aria-label={`${win.title} (in a separate window)`}>
          <div className="fs-titlebar"><AppIcon id={win.module} size={16} /><strong style={{ fontSize: fz(12) }}>{win.title}</strong></div>
          <div style={{ padding: 14, fontSize: fz(12), color: "var(--fs-muted)" }}>
            This window is running in a Document Picture-in-Picture window (always on top).
            Closing that window returns it here.
          </div>
        </div>
        {createPortal(<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>{body}</div>, pipDoc.body)}
      </>
    );
  }

  if (win.minimized) return null;

  const layout = layoutOf(shell.settings["appearance.layout"]);
  const actions = ([
    ["Tile left (Meta+Left)", "Tile left", "tileLeft", () => shell.dispatch({ t: "tile", id: win.id, slot: "left" }), null],
    ["Tile right (Meta+Right)", "Tile right", "tileRight", () => shell.dispatch({ t: "tile", id: win.id, slot: "right" }), null],
    ["Pop out (always on top)", "Pop out", "popout", popOut, null],
    ["Minimise", "Minimise", "minimize", () => shell.dispatch({ t: "minimize", id: win.id }), "var(--fs-win-min, #ffd34d)"],
    ["Maximise / restore", "Maximise or restore", "maximize", () => shell.dispatch({ t: "toggleMax", id: win.id }), "var(--fs-win-max, #5ee39b)"],
    ["Close", "Close window", "close", () => shell.dispatch({ t: "close", id: win.id }), "var(--fs-win-close, #ff7a7a)"],
  ] as [string, string, UiGlyphName, () => void, string | null][]);

  return (
    <div
      ref={ref}
      className="fs-window"
      data-win-id={win.id}
      role="dialog"
      aria-label={win.title}
      aria-modal={false}
      data-focused={focused}
      style={{
        zIndex: win.z,
        borderColor: focused ? "rgba(91,140,255,.55)" : "var(--fs-border)",
        opacity: focused ? 1 : "var(--fs-focus-dim, 1)",
      }}
      onPointerDown={() => shell.dispatch({ t: "focus", id: win.id })}
      onFocusCapture={() => { if (!focused && keyboardNavRecent()) shell.dispatch({ t: "focus", id: win.id }); }}
    >
      <div
        className="fs-titlebar"
        onPointerDown={(e) => onPointerDown(e, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={() => { const d = drag.current; if (d) { disarmEdge(d); d.edge = EDGE_IDLE; } }}
        onDoubleClick={() => shell.dispatch({ t: "toggleMax", id: win.id })}
      >
        {layout === "art" ? (
          // TT25 Art: macOS traffic lights on the left in close / minimise / zoom order; grey when the window is inactive
          <span className="fs-traffic" role="group" aria-label="Window controls">
            {actions.filter((a) => a[4]).sort((a, b) => ORDER_ART.indexOf(a[2]) - ORDER_ART.indexOf(b[2])).map(([title, label, glyph, run]) => (
              <button key={label} type="button" className={`fs-tl fs-tl-${glyph}`} title={title} aria-label={label} onClick={run} onPointerDown={(e) => e.stopPropagation()}>
                <UiGlyph name={glyph} size={8} />
              </button>
            ))}
          </span>
        ) : null}
        {layout === "art" ? (
          <strong className="fs-title-centre" style={{ fontSize: fz(12.5) }}>
            <AppIcon id={win.module} size={14} /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{win.title}</span>
          </strong>
        ) : (
          <>
            <AppIcon id={win.module} size={16} />
            <strong style={{ fontSize: fz(12), flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{win.title}</strong>
          </>
        )}
        {/* window actions are real buttons so assistive tech can reach them (AX-01) */}
        {actions.filter((a) => layout === "fusion" || !a[4]).map(([title, label, glyph, run, bubble]) => (
          <button key={label} className="fs-btn fs-winbtn" data-variant="ghost" title={title} aria-label={label} onClick={run}
            data-bubble={bubble ? "1" : undefined}
            style={bubble ? { background: bubble, color: "#14213d", borderColor: "rgba(0,0,0,.25)" } : undefined}>
            <UiGlyph name={glyph} size={bubble ? 11 : 13} />
          </button>
        ))}
        {layout === "business" ? (
          // TT25 Business: Windows caption buttons — flat, full title-bar height, red on hover for Close
          <span className="fs-caption" role="group" aria-label="Window controls">
            {actions.filter((a) => a[4]).map(([title, label, glyph, run]) => (
              <button key={label} type="button" className={`fs-cap fs-cap-${glyph}`} title={title} aria-label={label} onClick={() => { snapUi.set({ flyout: null }); run(); }} onPointerDown={(e) => e.stopPropagation()}
                aria-haspopup={glyph === "maximize" ? "dialog" : undefined}
                onPointerEnter={glyph === "maximize" ? (e) => {
                  // TT28 Snap layouts: hovering Maximise opens the layout flyout under it (as on Windows 11)
                  const b = e.currentTarget.getBoundingClientRect(), desk = ref.current?.parentElement?.getBoundingClientRect();
                  if (desk) snapUi.hoverOpen(win.id, Math.round(b.right - desk.left - 300), Math.round(b.bottom - desk.top + 4));
                } : undefined}
                onPointerLeave={glyph === "maximize" ? () => snapUi.hoverLeave() : undefined}>
                <UiGlyph name={glyph} size={12} />
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {body}
      </div>

      {HANDLES.map((h) => (
        <div
          key={h}
          className="fs-resizer"
          onPointerDown={(e) => onPointerDown(e, h)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          style={{
            cursor: `${h}-resize`,
            touchAction: "none",
            ...(h === "n" ? { top: -3, left: 8, right: 8, height: 6 } : {}),
            ...(h === "s" ? { bottom: -3, left: 8, right: 8, height: 6 } : {}),
            ...(h === "e" ? { right: -3, top: 8, bottom: 8, width: 6 } : {}),
            ...(h === "w" ? { left: -3, top: 8, bottom: 8, width: 6 } : {}),
            ...(h === "ne" ? { right: -3, top: -3, width: 12, height: 12 } : {}),
            ...(h === "nw" ? { left: -3, top: -3, width: 12, height: 12 } : {}),
            ...(h === "se" ? { right: -3, bottom: -3, width: 14, height: 14 } : {}),
            ...(h === "sw" ? { left: -3, bottom: -3, width: 12, height: 12 } : {}),
          }}
        />
      ))}
    </div>
  );
}
