"use client";
/**
 * TT28: runs the Art "genie" minimise on a snapshot of a window that React has just removed (see genie-core.ts for
 * the geometry and its honest limits). The snapshot is a DOM clone; live media can't be cloned (iframes would
 * reload, canvases come out blank), so those become neutral placeholders of the same size.
 */
import { genieFrames, GENIE_MS, type Box } from "@/lib/genie-core";

export function runGenie(win: HTMLElement, desk: HTMLElement, src: Box, winId: string): void {
  if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (document.documentElement.dataset.motion === "off") return; // the Shell's own "reduce motion" setting
  if (typeof (HTMLElement.prototype as { animate?: unknown }).animate !== "function") return;
  const ghost = win.cloneNode(true) as HTMLElement;
  for (const m of ghost.querySelectorAll("iframe, video, audio, canvas, object, embed")) {
    const ph = document.createElement("div");
    const el = m as HTMLElement;
    ph.style.cssText = `width:${el.style.width || "100%"};height:${el.style.height || "100%"};background:color-mix(in srgb, var(--fs-text) 8%, transparent)`;
    m.replaceWith(ph);
  }
  ghost.removeAttribute("data-win-id"); ghost.removeAttribute("role"); ghost.removeAttribute("aria-label");
  ghost.setAttribute("aria-hidden", "true"); ghost.setAttribute("inert", ""); ghost.dataset.testid = "genie-ghost"; ghost.setAttribute("data-testid", "genie-ghost");
  // fixed on <body>: the desk clips its overflow and the dock sits outside it, so the ghost must live above both
  const d0 = desk.getBoundingClientRect();
  const page: Box = { x: d0.left + src.x, y: d0.top + src.y, w: src.w, h: src.h };
  Object.assign(ghost.style, { position: "fixed", transform: "none", left: `${page.x}px`, top: `${page.y}px`, width: `${page.w}px`, height: `${page.h}px`, margin: "0",
    zIndex: "2000000002", pointerEvents: "none", transformOrigin: "0 0", willChange: "transform, clip-path, opacity" });
  // wait one frame so the dock has rendered the minimised tile we fly into
  requestAnimationFrame(() => {
    const tile = document.querySelector<HTMLElement>(`[data-testid="dock-min-${CSS.escape(winId)}"]`);
    if (!tile || !desk.isConnected) return;
    const t = tile.getBoundingClientRect();
    const dst: Box = { x: t.left, y: t.top, w: t.width, h: t.height };
    (desk.closest<HTMLElement>("[data-layout]") ?? document.body).appendChild(ghost);
    const anim = ghost.animate(genieFrames(page, dst), { duration: GENIE_MS, fill: "forwards" });
    const done = () => ghost.remove();
    anim.onfinish = done; anim.oncancel = done;
    setTimeout(done, GENIE_MS + 400); // belt and braces: never leave a ghost behind
  });
}
