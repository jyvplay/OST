"use client";
/**
 * TT76 — Slides "Motion" side panel (transition + entrance animations of the current slide) and the slide-show stage
 * that plays them. Model / file format: src/lib/office/pmlanim.ts; CSS playback: src/lib/office/pmlplay.ts.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { fz } from "@/lib/uiscale";
import { Btn } from "../../ui";
import type * as M from "@/lib/office/pml";
import type { VSlide } from "@/lib/office/pmlview";
import { EFFECTS, FROM_LABEL, SIDE_LABEL, TRANS_KINDS, readAnimations, readTransition, setAnimations, setTransition, shapeIds, type Effect, type EffKind, type From, type Side, type SlideTransition, type TransKind, type Trigger } from "@/lib/office/pmlanim";
import { MOTION_CSS, describeTransition, stepFx, transitionFx } from "@/lib/office/pmlplay";
import { SlideCanvas, type ShapeFx } from "./render";

const TRIGGERS: [Trigger, string][] = [["click", "On click"], ["with", "With previous"], ["after", "After previous"]];
const FOREIGN_CLS: Record<string, string> = { entr: "Entrance", exit: "Exit", emph: "Emphasis", path: "Motion path", verb: "Action", mediacall: "Media" };
const SPLIT: [string, string][] = [["horz-out", "Horizontal out"], ["horz-in", "Horizontal in"], ["vert-out", "Vertical out"], ["vert-in", "Vertical in"]];
const secs = (ms: number) => String(Math.round(ms / 10) / 100);
const parseSecs = (s: string, lo: number, hi: number): number | null => { const n = Number(s.trim().replace(",", ".")); return Number.isFinite(n) && s.trim() !== "" ? Math.round(Math.min(hi, Math.max(lo, n)) * 1000) : null; };
/** inline SVG glyphs: the UI fonts lack ↑ ↓ ✕ ▶ on some systems (they rendered as empty boxes) */
const GLYPH = { up: "M12 19 V5 M6 11 L12 5 L18 11", down: "M12 5 V19 M6 13 L12 19 L18 13", x: "M6 6 L18 18 M18 6 L6 18", play: "M8 5 L19 12 L8 19 Z", sub: "M7 5 V13 H17 M13 9 L17 13 L13 17" } as const;
function G({ k }: { k: keyof typeof GLYPH }) { return <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden style={{ verticalAlign: "-2px" }}><path d={GLYPH[k]} fill={k === "play" ? "currentColor" : "none"} stroke="currentColor" strokeWidth={k === "play" ? 0 : 2.2} strokeLinecap="round" strokeLinejoin="round" /></svg>; }
const row: CSSProperties = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };
const lab: CSSProperties = { fontSize: fz(12), display: "flex", gap: 4, alignItems: "center" };

/** seconds field that commits on blur / Enter (one undo step per edit, not per keystroke) */
function SecsInput({ ms, label, lo, hi, onCommit, testid, disabled }: { ms: number; label: string; lo: number; hi: number; onCommit: (ms: number) => void; testid: string; disabled?: boolean }) {
  const commit = (el: HTMLInputElement) => { const v = parseSecs(el.value, lo, hi); if (v === null) { el.value = secs(ms); return; } if (v !== ms) onCommit(v); else el.value = secs(ms); };
  return <input key={ms} type="number" className="fs-input" aria-label={label} data-testid={testid} disabled={disabled} defaultValue={secs(ms)} min={lo} max={hi} step={0.25}
    onBlur={(e) => commit(e.currentTarget)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(e.currentTarget); } }} style={{ width: fz(64), minWidth: 56 }} />;
}

export function MotionPanel({ doc, cur, sel, mutate, onSelect, onPreview, onClose }: {
  doc: M.PptxDoc; cur: number; sel: string | null; mutate: (what: string, fn: (d: M.PptxDoc) => void) => void;
  onSelect: (addr: string) => void; onPreview: () => void; onClose: () => void;
}) {
  const slide = doc.slides[cur];
  // the slide object is replaced (copy-on-write) by every edit, so it is the memo key
  const t = useMemo(() => readTransition(slide.xml), [slide]);
  const anim = useMemo(() => readAnimations(slide.xml), [slide]);
  const ids = useMemo(() => shapeIds(slide.xml), [slide]);
  const [addKind, setAddKind] = useState<EffKind>("fade"); const [addFrom, setAddFrom] = useState<From>("b");
  const selSpid = sel !== null ? [...ids].find(([, v]) => v.addr === sel)?.[0] : undefined;
  const setT = (what: string, next: SlideTransition) => mutate(what, (d) => setTransition(d, cur, next));
  const setE = (what: string, next: Effect[]) => mutate(what, (d) => setAnimations(d, cur, next));
  const patchE = (k: number, p: Partial<Effect>) => setE("Animation", anim.effects.map((e, n) => (n === k ? { ...e, ...p } : e)));
  const kindChange = (k: TransKind) => {
    const base = { durMs: t.kind === "none" || t.kind === "cut" ? (k === "fade" ? 700 : 750) : t.durMs, advClick: t.advClick, ...(t.advAfterMs !== undefined ? { advAfterMs: t.advAfterMs } : {}) };
    const extra: Partial<SlideTransition> = k === "push" || k === "wipe" || k === "cover" || k === "pull" ? { dir: (t.dir ?? "l") } : k === "split" ? { orient: "horz", inOut: "out" } : k === "zoom" ? { inOut: "in" } : {};
    setT("Transition", { kind: k, ...base, ...extra } as SlideTransition);
  };
  const opt = (): { value: string; options: [string, string][]; set: (v: string) => void } | null => {
    if (t.kind === "push" || t.kind === "wipe" || t.kind === "cover" || t.kind === "pull") return { value: t.dir ?? "l", options: (Object.keys(SIDE_LABEL) as Side[]).map((s) => [s, SIDE_LABEL[s]]), set: (v) => setT("Transition direction", { ...t, dir: v as Side }) };
    if (t.kind === "split") return { value: `${t.orient ?? "horz"}-${t.inOut ?? "out"}`, options: SPLIT, set: (v) => { const [o, io] = v.split("-"); setT("Transition direction", { ...t, orient: o as "horz" | "vert", inOut: io as "in" | "out" }); } };
    if (t.kind === "zoom") return { value: t.inOut ?? "in", options: [["in", "In"], ["out", "Out"]], set: (v) => setT("Transition direction", { ...t, inOut: v as "in" | "out" }) };
    if (t.kind === "fade") return { value: t.thruBlk ? "blk" : "smooth", options: [["smooth", "Smoothly"], ["blk", "Through black"]], set: (v) => { const { thruBlk: _drop, ...rest } = t; void _drop; setT("Transition option", v === "blk" ? { ...rest, thruBlk: true } : rest); } };
    return null;
  };
  const o = opt();
  const move = (k: number, by: number) => { const j = k + by; if (j < 0 || j >= anim.effects.length) return; const a = anim.effects.slice(); [a[k], a[j]] = [a[j], a[k]]; setE("Reorder animation", a); };
  const add = () => {
    if (!selSpid) return;
    const e: Effect = { spid: selSpid, kind: addKind, trigger: "click", delayMs: 0, durMs: addKind === "appear" ? 0 : 500, ...(addKind === "fly" || addKind === "wipe" ? { from: addFrom } : {}) };
    setE("Add animation", [...anim.effects, e]);
  };
  let step = 0;
  return (
    <aside aria-label="Motion: transition and animations" data-testid="motion-panel" className="fs-scroll" style={{ width: fz(300), flex: "none", borderLeft: "1px solid var(--fs-border)", padding: 10, display: "grid", gap: 12, alignContent: "start", overflowY: "auto", fontSize: fz(12) }}>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <h2 style={{ margin: 0, fontSize: fz(14) }}>Motion · slide {cur + 1}</h2>
        <Btn variant="ghost" onClick={onClose} aria-label="Close the motion panel" title="Close"><G k="x" /></Btn>
      </div>
      {/* ---------------- transition */}
      <section aria-label="Transition" style={{ display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: fz(12), letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fs-muted)" }}>Transition into this slide</h3>
        <div style={row}>
          <label style={lab}>Effect
            <select className="fs-input" aria-label="Transition" data-testid="motion-trans-kind" value={t.kind} onChange={(e) => kindChange(e.target.value as TransKind)} style={{ width: fz(118), minWidth: 100 }}>
              {TRANS_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              {t.kind === "other" ? <option value="other">{(t.name ?? "other").replace(/^p\d*:/, "")} (kept)</option> : null}
            </select>
          </label>
          {o ? <label style={lab}>Option
            <select className="fs-input" aria-label="Transition option" data-testid="motion-trans-opt" value={o.value} onChange={(e) => o.set(e.target.value)} style={{ width: fz(122), minWidth: 100 }}>
              {o.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label> : null}
        </div>
        {t.kind !== "none" ? <>
          <div style={row}>
            {t.kind !== "cut" ? <label style={lab}>Duration <SecsInput ms={t.durMs} label="Transition duration in seconds" testid="motion-trans-dur" lo={0.01} hi={59} onCommit={(ms) => setT("Transition duration", { ...t, durMs: ms })} /> s</label> : null}
          </div>
          <div style={row}>
            <label style={lab}><input type="checkbox" data-testid="motion-adv-click" checked={t.advClick} onChange={(e) => setT("Advance on click", { ...t, advClick: e.target.checked })} /> On mouse click</label>
            <label style={lab}><input type="checkbox" data-testid="motion-adv-after" checked={t.advAfterMs !== undefined} onChange={(e) => { const { advAfterMs: _a, ...rest } = t; void _a; setT("Advance after", e.target.checked ? { ...rest, advAfterMs: 5000 } : rest); }} /> After</label>
            {t.advAfterMs !== undefined ? <><SecsInput ms={t.advAfterMs} label="Advance after seconds" testid="motion-adv-secs" lo={0} hi={86400} onCommit={(ms) => setT("Advance after", { ...t, advAfterMs: ms })} /> s</> : null}
          </div>
        </> : null}
        <div className="fs-dim" data-testid="motion-trans-desc">{describeTransition(t)}</div>
        <div style={row}>
          <Btn variant="ghost" data-testid="motion-apply-all" disabled={t.kind === "other"} title={t.kind === "other" ? "A kept transition cannot be copied to other slides" : "Use this transition on every slide"}
            onClick={() => mutate("Apply transition to all", (d) => { d.slides.forEach((_, k) => setTransition(d, k, t)); })}>Apply to all slides</Btn>
          <Btn variant="primary" data-testid="motion-preview" onClick={onPreview} title="Play this slide in the slide show (transition and builds)">Preview <G k="play" /></Btn>
        </div>
      </section>
      {/* ---------------- animations */}
      <section aria-label="Animations" style={{ display: "grid", gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: fz(12), letterSpacing: ".06em", textTransform: "uppercase", color: "var(--fs-muted)" }}>Animations (play order)</h3>
        {anim.readOnly ? <div role="note" className="fs-dim" data-testid="motion-readonly">This slide&apos;s animation timeline uses a structure Fusion does not edit. It is kept exactly as it is and saved unchanged.</div> : null}
        {!anim.readOnly && !anim.effects.length ? <div className="fs-dim">No animations. Select a shape on the slide, pick an effect and press Add.</div> : null}
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {anim.effects.map((e, k) => {
            if (k === 0 || e.trigger === "click") step++;
            const info = ids.get(e.spid); const native = e.kind !== "foreign";
            const label = native ? EFFECTS.find(([kk]) => kk === e.kind)![1] : `${FOREIGN_CLS[e.cls ?? ""] ?? e.cls ?? "Effect"}${e.presetId ? ` #${e.presetId}` : ""} (kept)`;
            return (
              <li key={k} data-testid={`motion-fx-${k}`} className="fs-panel" style={{ padding: 6, display: "grid", gap: 4, outline: info && info.addr === sel ? "2px solid var(--fs-accent, #2563eb)" : undefined }}>
                <div style={{ ...row, justifyContent: "space-between" }}>
                  <button type="button" className="fs-btn" data-variant="ghost" onClick={() => info && onSelect(info.addr)} title="Select the shape" style={{ padding: "2px 6px", textAlign: "left", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <b aria-label={`step ${step}`} style={{ display: "inline-block", minWidth: 18 }}>{k === 0 || e.trigger === "click" ? step : <G k="sub" />}</b> {label} · {info?.name ?? `shape ${e.spid}`}
                  </button>
                  <Btn variant="ghost" aria-label="Move earlier" disabled={k === 0} onClick={() => move(k, -1)}><G k="up" /></Btn>
                  <Btn variant="ghost" aria-label="Move later" disabled={k === anim.effects.length - 1} onClick={() => move(k, 1)}><G k="down" /></Btn>
                  <Btn variant="ghost" aria-label="Remove animation" data-testid={`motion-fx-del-${k}`} onClick={() => setE("Remove animation", anim.effects.filter((_, n) => n !== k))}><G k="x" /></Btn>
                </div>
                <div style={row}>
                  <select className="fs-input" aria-label="Start" data-testid={`motion-fx-trigger-${k}`} value={e.trigger} onChange={(ev) => patchE(k, { trigger: ev.target.value as Trigger })} style={{ width: fz(118), minWidth: 100 }}>
                    {TRIGGERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  {native && (e.kind === "fly" || e.kind === "wipe") ? <select className="fs-input" aria-label="Direction" value={e.from ?? "b"} onChange={(ev) => patchE(k, { from: ev.target.value as From })} style={{ width: fz(104), minWidth: 90 }}>
                    {(Object.keys(FROM_LABEL) as From[]).map((f) => <option key={f} value={f}>{FROM_LABEL[f]}</option>)}
                  </select> : null}
                </div>
                <div style={row}>
                  {native && e.kind !== "appear" ? <label style={lab}>Duration <SecsInput ms={e.durMs} label="Animation duration in seconds" testid={`motion-fx-dur-${k}`} lo={0.01} hi={59} onCommit={(ms) => patchE(k, { durMs: ms })} /></label> : null}
                  <label style={lab}>Delay <SecsInput ms={e.delayMs} label="Animation delay in seconds" testid={`motion-fx-delay-${k}`} lo={0} hi={59} onCommit={(ms) => patchE(k, { delayMs: ms })} /></label>
                </div>
              </li>
            );
          })}
        </ol>
        {!anim.readOnly ? <div className="fs-panel" style={{ padding: 6, display: "grid", gap: 6 }}>
          <div style={row}>
            <select className="fs-input" aria-label="Entrance effect to add" data-testid="motion-add-kind" value={addKind} onChange={(e) => setAddKind(e.target.value as EffKind)} style={{ width: fz(104), minWidth: 90 }}>
              {EFFECTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            {addKind === "fly" || addKind === "wipe" ? <select className="fs-input" aria-label="Direction of the new effect" data-testid="motion-add-from" value={addFrom} onChange={(e) => setAddFrom(e.target.value as From)} style={{ width: fz(104), minWidth: 90 }}>
              {(Object.keys(FROM_LABEL) as From[]).map((f) => <option key={f} value={f}>{FROM_LABEL[f]}</option>)}
            </select> : null}
            <Btn variant="primary" data-testid="motion-add" disabled={!selSpid} onClick={add} title={selSpid ? "Add an entrance animation to the selected shape" : "Select a shape on the slide first"}>Add</Btn>
          </div>
          <div className="fs-dim">{selSpid ? `For: ${ids.get(selSpid)?.name ?? "selected shape"}` : "Select a shape on the slide to animate it."}</div>
        </div> : null}
        {anim.extra.length ? <div className="fs-dim">{anim.extra.length} trigger sequence{anim.extra.length === 1 ? "" : "s"} (click-on-shape) kept; not played.</div> : null}
      </section>
    </aside>
  );
}

/** Editor overlay: PowerPoint-style play-order badges on animated shapes (shown while the Motion panel is open). */
export function OrderBadges({ doc, view, slide, scale }: { doc: M.PptxDoc; view: VSlide; slide: M.PSlide; scale: number }) {
  void doc;
  const a = readAnimations(slide.xml); const ids = shapeIds(slide.xml);
  const tags = new Map<string, string[]>(); let step = 0;
  a.effects.forEach((e, k) => { if (k === 0 || e.trigger === "click") step++; const ad = ids.get(e.spid)?.addr; if (ad !== undefined) tags.set(ad, [...(tags.get(ad) ?? []), String(k === 0 && e.trigger !== "click" ? 0 : step)]); });
  return <>{[...tags].map(([ad, t]) => {
    const v = view.shapes.find((x) => x.layer === "slide" && x.addr === ad); if (!v) return null;
    return <span key={ad} aria-hidden data-testid="motion-badge" style={{ position: "absolute", left: Math.max(0, v.x * scale - 4), top: Math.max(0, v.y * scale - 4), background: "#7c3aed", color: "#fff", borderRadius: 4, padding: "0 4px", fontSize: fz(10), lineHeight: 1.5, pointerEvents: "none", zIndex: 4 }}>{[...new Set(t)].join(",")}</span>;
  })}</>;
}

/** One slide of the show: build state after `done` steps (the last one animated when `animate`), entering with its transition from `from`. */
export function ShowStage({ doc, i, done, animate, animKey, from, viewOf, w }: { doc: M.PptxDoc; i: number; done: number; animate: boolean; animKey: number; from: number | null; viewOf: (s: M.PSlide) => VSlide; w: number }) {
  const s = doc.slides[i]; const view = viewOf(s); const sc = w / doc.size.cx; const h = doc.size.cy * sc;
  const tr = from !== null ? transitionFx(readTransition(s.xml), i) : null;
  const fx = useMemo(() => fxFor(doc, s, view, done, animate, sc, tr && done <= 1 ? tr.ms : 0), [doc, s, view, done, animate, sc, tr]);
  const prev = from !== null && tr ? doc.slides[from] : null;
  const prevFx = useMemo(() => (prev ? fxFor(doc, prev, viewOf(prev), 1e6, false, sc, 0) : undefined), [doc, prev, viewOf, sc]);
  const layer = (z: number, css: Record<string, string | number> | undefined): CSSProperties => ({ position: "absolute", inset: 0, zIndex: z, ...(css as CSSProperties) });
  return (
    <div className="fs-motion" data-testid="show-stage" data-step={done} style={{ position: "relative", width: w, height: h, overflow: "hidden" }}>
      <style>{MOTION_CSS}</style>
      {prev && tr?.outgoing ? <div key={`o${animKey}`} data-testid="show-outgoing" style={layer(tr.outgoingOnTop ? 2 : 0, tr.outgoing)}><SlideCanvas doc={doc} view={viewOf(prev)} width={w} uid={`po${prev.uid}`} fx={prevFx} /></div> : null}
      <div key={`i${animKey}`} data-testid="show-incoming" style={layer(1, tr?.incoming)}><SlideCanvas doc={doc} view={view} width={w} uid={`p${s.uid}`} fx={fx} /></div>
    </div>
  );
}
function fxFor(doc: M.PptxDoc, s: M.PSlide, view: VSlide, done: number, animate: boolean, sc: number, offsetMs: number): ShapeFx {
  const a = readAnimations(s.xml); if (!a.effects.length) return {};
  const ids = shapeIds(s.xml);
  const geo = (ad: string) => { const v = view.shapes.find((x) => x.layer === "slide" && x.addr === ad); return v ? { x: v.x * sc, y: v.y * sc, w: v.w * sc, h: v.h * sc } : undefined; };
  return stepFx(a.effects, done, animate, (spid) => ids.get(spid)?.addr, geo, { w: doc.size.cx * sc, h: doc.size.cy * sc }, offsetMs) as ShapeFx;
}
