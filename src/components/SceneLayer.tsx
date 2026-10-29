"use client";
/**
 * LN-09 — the renderer for Scenes. All geometry comes from scene-core.ts; this file owns only the
 * canvas, the frame loop and the one place a user picture is read from the VFS.
 *
 * It sits behind every desktop icon and window and must never cost attention or battery:
 *   · one canvas, sized in device pixels, redrawn at most 30 times a second;
 *   · the loop stops completely when the tab is hidden, when the shell's governor reports pressure,
 *     and when the human has asked for reduced motion — a still frame stays on screen;
 *   · pointer-events are off, so it can never intercept a click meant for the desktop;
 *   · nothing is fetched from the network; the picture scene reads a file the VFS already holds.
 */
import { useEffect, useRef } from "react";
import { useShell } from "./shell-context";
import {
  blobAt, buildScene, coverFit, DEFAULT_SCENE, isScene, ridgeAt, sceneFps, seedFrom, validSceneImage,
  type SceneId,
} from "@/lib/scene-core";

export default function SceneLayer() {
  const shell = useShell();
  const raw = shell.settings["appearance.scene"] ?? DEFAULT_SCENE;
  const scene: SceneId = isScene(raw) ? raw : DEFAULT_SCENE;
  const imagePath = shell.settings["appearance.sceneImage"] ?? "";
  const motion = (shell.settings["appearance.motion"] ?? "system") as "system" | "on" | "off";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointer = useRef({ x: 0.5, y: 0.5 });
  const picture = useRef<HTMLImageElement | null>(null);

  // The user's picture, read once per path change from the VFS and decoded into an <img>. A blob:
  // URL is used rather than a data: URL so a large photo is not held twice as base64 text.
  useEffect(() => {
    picture.current = null;
    if (scene !== "image" || !validSceneImage(imagePath)) return;
    let dead = false; let revoke = "";
    (async () => {
      try {
        const r = await fetch(`/api/fs?op=read&path=${encodeURIComponent(imagePath)}`);
        const j = await r.json() as { node?: { content: string; encoding: string; mime: string } };
        const node = j.node;
        if (!node || node.encoding !== "base64" || dead) return;
        const bin = atob(node.content);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: node.mime || "image/png" }));
        revoke = url;
        const img = new Image();
        img.onload = () => { if (!dead) picture.current = img; };
        img.src = url;
      } catch { /* a missing picture simply leaves the gradient behind it */ }
    })();
    return () => { dead = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [scene, imagePath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || scene === "off") return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const model = buildScene(scene, seedFrom(`${scene}:${imagePath}`));
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let raf = 0, timer = 0, stopped = false;
    const t0 = performance.now();

    const onPointer = (e: PointerEvent) => {
      pointer.current = { x: e.clientX / Math.max(1, window.innerWidth), y: e.clientY / Math.max(1, window.innerHeight) };
    };
    window.addEventListener("pointermove", onPointer, { passive: true });

    const size = () => {
      const parent = canvas.parentElement;
      const w = parent?.clientWidth ?? window.innerWidth, h = parent?.clientHeight ?? window.innerHeight;
      // Device pixels, capped: a 4K desktop does not need a 4K background to look right, and the
      // cap is what keeps the fill rate flat on a large display.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      return { w: cw, h: ch };
    };

    const draw = () => {
      const { w, h } = size();
      const t = (performance.now() - t0) / 1000;
      ctx.clearRect(0, 0, w, h);

      if (scene === "image" && picture.current) {
        const img = picture.current;
        const fit = coverFit({ w: img.naturalWidth, h: img.naturalHeight }, { w, h });
        // The picture itself is a layer: it is drawn slightly larger than the box and shifted, so
        // the parallax never uncovers an edge.
        const over = 1 + 2 * 0.04;
        const near = model.layers[model.layers.length - 1];
        const off = near ? blobAt({ x: 0.5, y: 0.5, r: 0, hue: 0, alpha: 0, phase: 0, speed: 0 }, near.depth, t, pointer.current) : { x: .5, y: .5 };
        ctx.drawImage(img, fit.x - (fit.w * (over - 1)) / 2 + (off.x - 0.5) * w, fit.y - (fit.h * (over - 1)) / 2 + (off.y - 0.5) * h, fit.w * over, fit.h * over);
      }

      for (const layer of model.layers) {
        for (const r of layer.ridges) {
          ctx.beginPath();
          ctx.moveTo(0, h);
          const steps = 48;
          for (let i = 0; i <= steps; i++) {
            const u = i / steps;
            ctx.lineTo(u * w, ridgeAt(r, u, t, layer.depth, pointer.current) * h);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fillStyle = `hsla(${r.hue}, 55%, ${18 + layer.depth * 22}%, ${0.5 - layer.depth * 0.18})`;
          ctx.fill();
        }
        for (const b of layer.blobs) {
          const p = blobAt(b, layer.depth, t, pointer.current);
          const cx = p.x * w, cy = p.y * h, rr = Math.max(1, p.r * Math.min(w, h));
          const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rr);
          g.addColorStop(0, `hsla(${b.hue}, 70%, 62%, ${b.alpha})`);
          g.addColorStop(1, `hsla(${b.hue}, 70%, 62%, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill();
        }
      }
      canvas.dataset.frames = String((Number(canvas.dataset.frames ?? "0") + 1) % 1000000);
    };

    const tick = () => {
      if (stopped) return;
      const fps = sceneFps({
        reducedMotion: reduced,
        hidden: document.visibilityState === "hidden",
        throttled: document.documentElement.dataset.effects === "off",
        motionSetting: motion,
      });
      draw();
      if (fps <= 0) { canvas.dataset.animating = "false"; return; }   // one still frame, then stop
      canvas.dataset.animating = "true";
      timer = window.setTimeout(() => { raf = requestAnimationFrame(tick); }, 1000 / fps);
    };
    tick();

    // Visibility and pressure changes restart the loop; it decides for itself whether to keep going.
    const wake = () => { if (!stopped) { cancelAnimationFrame(raf); clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("resize", wake);
    const effects = new MutationObserver(wake);
    effects.observe(document.documentElement, { attributes: true, attributeFilter: ["data-effects"] });

    return () => {
      stopped = true; cancelAnimationFrame(raf); clearTimeout(timer);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("resize", wake);
      effects.disconnect();
    };
  }, [scene, imagePath, motion]);

  if (scene === "off") return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="scene-layer"
      data-scene={scene}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 0 }}
    />
  );
}
