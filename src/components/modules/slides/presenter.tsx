"use client";
/**
 * TT76 (CA-02) — presenter console: what the presenter sees while the audience screen (/present?show=…) shows the
 * slide. Current slide (live, with its transition and builds), what the next click shows, speaker notes, elapsed time,
 * the audience link state, and big Previous / Next / End controls. Keyboard: the show keys (owned by Slides.tsx).
 */
import { useEffect, useState, type CSSProperties } from "react";
import { fz } from "@/lib/uiscale";
import type * as M from "@/lib/office/pml";
import type { VSlide } from "@/lib/office/pmlview";
import { autoSteps, playSteps, readAnimations } from "@/lib/office/pmlanim";
import type { ShowState } from "@/lib/office/showlink";
import { ShowStage } from "./motion";

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`; };
const btn: CSSProperties = { fontSize: fz(15), padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.08)", color: "#f1f5f9", cursor: "pointer", minHeight: 44 };

export function PresenterConsole({ doc, st, shown, viewOf, notes, audience, t0, onNext, onPrev, onEnd }: {
  doc: M.PptxDoc; st: ShowState; shown: number[]; viewOf: (s: M.PSlide) => VSlide; notes: string;
  audience: "waiting" | "connected"; t0: number; onNext: () => void; onPrev: () => void; onEnd: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const [vw, setVw] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1280));
  useEffect(() => { const f = () => setVw(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  const steps = playSteps(readAnimations(doc.slides[st.i].xml).effects).length;
  const k = shown.indexOf(st.i); const nextSlide = k >= 0 && k < shown.length - 1 ? shown[k + 1] : null;
  // what the next click shows: the next build step of this slide, else the next slide as it first appears
  const next = st.done < steps ? { i: st.i, done: st.done + 1, label: `Next: build ${st.done + 1} of ${steps} on this slide` }
    : nextSlide !== null ? { i: nextSlide, done: autoSteps(readAnimations(doc.slides[nextSlide].xml).effects), label: `Next: slide ${nextSlide + 1}` } : null;
  const mainW = Math.max(320, Math.min(vw * 0.58, 1100)); const sideW = Math.max(220, Math.min(vw * 0.3, 520));
  return (
    <div data-testid="presenter-console" onClick={(e) => e.stopPropagation()} style={{ position: "absolute", inset: 0, background: "#0b1220", color: "#e2e8f0", display: "grid", gridTemplateRows: "auto 1fr", cursor: "default" }}>
      <header style={{ display: "flex", gap: 14, alignItems: "center", padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,.12)", fontSize: fz(15) }}>
        <b data-testid="presenter-timer" aria-label="Elapsed time" style={{ fontVariantNumeric: "tabular-nums", fontSize: fz(22) }}>{mmss(now - t0)}</b>
        <span data-testid="presenter-pos">Slide {st.i + 1} of {doc.slides.length}{steps ? ` · build ${st.done}/${steps}` : ""}</span>
        <span data-testid="presenter-audience" data-state={audience} style={{ padding: "2px 10px", borderRadius: 999, background: audience === "connected" ? "rgba(34,197,94,.2)" : "rgba(234,179,8,.2)", color: audience === "connected" ? "#86efac" : "#fde68a" }}>
          {audience === "connected" ? "Audience screen connected" : "Waiting for the audience screen…"}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={btn} data-testid="presenter-prev" onClick={onPrev}>Previous</button>
        <button type="button" style={{ ...btn, background: "#2563eb", borderColor: "#2563eb" }} data-testid="presenter-next" onClick={onNext}>Next</button>
        <button type="button" style={btn} data-testid="presenter-end" onClick={onEnd}>End show</button>
      </header>
      <div style={{ display: "flex", gap: 18, padding: 16, minHeight: 0 }}>
        <div style={{ display: "grid", alignContent: "start", gap: 6 }}>
          <span style={{ fontSize: fz(13), opacity: 0.7 }}>Current</span>
          <div style={{ boxShadow: "0 0 0 1px rgba(255,255,255,.2)" }}>
            <ShowStage doc={doc} i={st.i} done={st.done} animate={st.animate} animKey={st.key} from={st.from} viewOf={viewOf} w={mainW} />
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateRows: "auto auto 1fr", gap: 8, minHeight: 0, width: sideW }}>
          <span data-testid="presenter-next-label" style={{ fontSize: fz(13), opacity: 0.7 }}>{next ? next.label : "End of the show"}</span>
          <div style={{ boxShadow: "0 0 0 1px rgba(255,255,255,.2)", opacity: 0.9 }}>
            {next ? <ShowStage doc={doc} i={next.i} done={next.done} animate={false} animKey={0} from={null} viewOf={viewOf} w={sideW} /> : <div style={{ width: sideW, aspectRatio: `${doc.size.cx} / ${doc.size.cy}`, display: "grid", placeItems: "center", background: "#000", fontSize: fz(14) }}>End of the show</div>}
          </div>
          <div data-testid="presenter-notes" aria-label="Speaker notes" className="fs-scroll" style={{ overflowY: "auto", whiteSpace: "pre-wrap", fontSize: fz(18), lineHeight: 1.5, padding: 10, background: "rgba(255,255,255,.05)", borderRadius: 8 }}>
            {notes.trim() ? notes : <span style={{ opacity: 0.6 }}>No speaker notes on this slide.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
