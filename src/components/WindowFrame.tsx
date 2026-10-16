"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { moduleById } from "@/lib/registry";
import type { WindowState } from "@/lib/windowing/state";
import { useShell } from "./shell-context";
import ModuleHost from "./ModuleHost";

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
  const drag = useRef<{ mode: "move" | Handle; x0: number; y0: number; rect: { x: number; y: number; w: number; h: number } } | null>(null);
  const [pipDoc, setPipDoc] = useState<Document | null>(null);
  const mod = moduleById(win.module);
  const focused = shell.state.focus === win.id;

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

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    shell.pulse(performance.now());
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    let { x, y, w, h } = d.rect;
    if (d.mode === "move") { x += dx; y += dy; }
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
  }, [shell]);

  const onPointerUp = useCallback(() => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d || !el) return;
    const x = Number(el.dataset.pendingX ?? win.x);
    const y = Number(el.dataset.pendingY ?? win.y);
    const w = Number(el.dataset.pendingW ?? win.w);
    const h = Number(el.dataset.pendingH ?? win.h);
    if (d.mode === "move") {
      // drag-to-edge tiling (WM-02)
      const vp = shell.state.viewport;
      if (y <= 2) shell.dispatch({ t: "tile", id: win.id, slot: "full" });
      else if (x <= 2) shell.dispatch({ t: "tile", id: win.id, slot: "left" });
      else if (x + w >= vp.w - 2) shell.dispatch({ t: "tile", id: win.id, slot: "right" });
      else shell.dispatch({ t: "move", id: win.id, x, y });
    } else {
      shell.dispatch({ t: "resize", id: win.id, w, h, x, y });
    }
  }, [shell, win.id, win.x, win.y, win.w, win.h]);

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
          <div className="fs-titlebar"><span>{mod?.icon}</span><strong style={{ fontSize: 12 }}>{win.title}</strong></div>
          <div style={{ padding: 14, fontSize: 12, color: "var(--fs-muted)" }}>
            This window is running in a Document Picture-in-Picture window (always on top).
            Closing that window returns it here.
          </div>
        </div>
        {createPortal(<div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>{body}</div>, pipDoc.body)}
      </>
    );
  }

  if (win.minimized) return null;

  return (
    <div
      ref={ref}
      className="fs-window"
      role="dialog"
      aria-label={win.title}
      aria-modal={false}
      data-focused={focused}
      style={{
        zIndex: win.z,
        borderColor: focused ? "rgba(91,140,255,.55)" : "var(--fs-border)",
        opacity: shell.state.focusMode && !focused ? 0.45 : 1,
      }}
      onPointerDown={() => shell.dispatch({ t: "focus", id: win.id })}
    >
      <div
        className="fs-titlebar"
        onPointerDown={(e) => onPointerDown(e, "move")}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => shell.dispatch({ t: "toggleMax", id: win.id })}
      >
        <span aria-hidden style={{ fontSize: 13 }}>{mod?.icon ?? "▫"}</span>
        <strong style={{ fontSize: 12, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{win.title}</strong>
        {/* window actions are real buttons so assistive tech can reach them (AX-01) */}
        <button className="fs-btn" data-variant="ghost" title="Tile left (Meta+Left)" aria-label="Tile left"
          onClick={() => shell.dispatch({ t: "tile", id: win.id, slot: "left" })} style={{ minHeight: 22, padding: "0 6px" }}>◧</button>
        <button className="fs-btn" data-variant="ghost" title="Tile right (Meta+Right)" aria-label="Tile right"
          onClick={() => shell.dispatch({ t: "tile", id: win.id, slot: "right" })} style={{ minHeight: 22, padding: "0 6px" }}>◨</button>
        <button className="fs-btn" data-variant="ghost" title="Pop out (always on top)" aria-label="Pop out"
          onClick={popOut} style={{ minHeight: 22, padding: "0 6px" }}>⧉</button>
        <button className="fs-btn" data-variant="ghost" title="Minimise" aria-label="Minimise"
          onClick={() => shell.dispatch({ t: "minimize", id: win.id })} style={{ minHeight: 22, padding: "0 6px" }}>—</button>
        <button className="fs-btn" data-variant="ghost" title="Maximise / restore" aria-label="Maximise or restore"
          onClick={() => shell.dispatch({ t: "toggleMax", id: win.id })} style={{ minHeight: 22, padding: "0 6px" }}>▢</button>
        <button className="fs-btn" data-variant="ghost" title="Close" aria-label="Close window"
          onClick={() => shell.dispatch({ t: "close", id: win.id })} style={{ minHeight: 22, padding: "0 8px", color: "#ff9b9b" }}>✕</button>
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
