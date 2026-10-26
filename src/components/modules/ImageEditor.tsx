"use client";

import { useState } from "react";
import type { ModuleProps } from "../shell-context";
import ImageStudio from "./ImageStudio";
import ImageQuickEdit from "./ImageQuickEdit";

/**
 * MD-03 / FF-24 / FF-30 / FF-31 Image Editor shell. Two modes, both kept (additive, TT16):
 *  - Layers (default): the layered raster editor with PSD as its native format.
 *  - Quick edit (classic): the original non-destructive crop/rotate/adjust → PNG copy + recipe editor.
 * `?open=imageedit&path=…&mode=quick` (or win.props.mode) selects the classic mode.
 */
export default function ImageEditorModule({ win }: ModuleProps) {
  const [mode, setMode] = useState<"layers" | "quick">(win.props.mode === "quick" ? "quick" : "layers");
  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100%", minHeight: 0 }}>
      <div role="tablist" aria-label="Editor mode" className="fs-row" style={{ gap: 2, padding: "3px 6px", borderBottom: "1px solid var(--fs-border)" }}>
        <button role="tab" aria-selected={mode === "layers"} className="fs-btn" data-variant={mode === "layers" ? "primary" : "ghost"} onClick={() => setMode("layers")}>Layers</button>
        <button role="tab" aria-selected={mode === "quick"} className="fs-btn" data-variant={mode === "quick" ? "primary" : "ghost"} onClick={() => setMode("quick")}>Quick edit (classic)</button>
      </div>
      <div style={{ minHeight: 0 }}>{mode === "layers" ? <ImageStudio win={win} /> : <ImageQuickEdit win={win} />}</div>
    </div>
  );
}
