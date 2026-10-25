/**
 * TT76 — slide TRANSITIONS and entrance ANIMATIONS for the lossless PresentationML engine (original code written
 * against ECMA-376 Part 1 §19.3.1.50 p:transition, §19.5 animation / timing; PowerPoint 2010's p14 extensions are
 * read through Markup Compatibility, ECMA-376 Part 3).
 *
 * Transitions: read p:transition directly or inside mc:AlternateContent (Choice Requires="p14" carries the exact
 * duration p14:dur in ms; Fallback the legacy spd bucket). Written the way PowerPoint 2010+ writes them — an
 * AlternateContent whose Choice has p14:dur and whose Fallback has spd — so PowerPoint 2007 and every MCE-unaware
 * reader still see a schema-valid p:transition. Kinds Fusion edits: cut, fade (± through black), push, wipe, cover,
 * pull (direction), split (orientation + in/out), zoom, random. Any other transition (p14 vortex, ripple, …) is kept
 * byte-for-byte; only its timing attributes are editable; it plays as its Fallback kind (else a fade).
 *
 * Animations: the main sequence's ENTRANCE effects Appear (presetID 1), Fade (10), Fly In (2), Wipe (22), Zoom (53),
 * each On click / With previous / After previous, with duration and delay, are a typed list Fusion edits and plays.
 * Every other effect — emphasis, exit, motion paths, by-paragraph builds, other entrance presets — is kept as its
 * original XML at its position in the sequence (its cTn ids renumbered so they stay unique) and plays approximately:
 * an entrance appears at its time, an exit hides at its time, emphasis / paths change nothing. Interactive (trigger)
 * sequences are kept verbatim and not played. A timing tree Fusion cannot read is kept verbatim and is read-only.
 * Deleting a shape prunes the effects and build entries that target it (a dangling spTgt makes PowerPoint repair).
 */
import { attr, clone, el, findAll, kid, kids, parseXml, serializeEl, setAttr, type XDoc, type XEl } from "./xmltree";
import { cNvPrOf, mutSlide, shapeKids, spTreeOf, txBodyOf, type PptxDoc } from "./pml";

const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";
const PNS = "http://schemas.openxmlformats.org/presentationml/2006/main";

/* ================================================================ transitions */
export type TransKind = "none" | "cut" | "fade" | "push" | "wipe" | "cover" | "pull" | "split" | "zoom" | "random" | "other";
/** Direction of MOVEMENT as stored (ECMA ST_TransitionSideDirectionType): "l" = moves left, i.e. enters from the right. */
export type Side = "l" | "r" | "u" | "d";
export interface SlideTransition {
  kind: TransKind;
  dir?: Side; thruBlk?: boolean; orient?: "horz" | "vert"; inOut?: "in" | "out";
  /** effect duration (ms) */ durMs: number;
  /** advance on mouse click (default true) */ advClick: boolean;
  /** advance automatically after this many ms */ advAfterMs?: number;
  /** "other": the stored element's name (e.g. "p14:vortex"), and the kind it plays as */ name?: string; playsAs?: TransKind;
}
export const TRANS_KINDS: readonly [TransKind, string][] = [["none", "None"], ["cut", "Cut"], ["fade", "Fade"], ["push", "Push"], ["wipe", "Wipe"], ["cover", "Cover"], ["pull", "Uncover"], ["split", "Split"], ["zoom", "Zoom"], ["random", "Random"]];
export const SIDE_LABEL: Record<Side, string> = { l: "From right", r: "From left", u: "From bottom", d: "From top" };
export const SPD_MS = { fast: 500, med: 750, slow: 1000 } as const;
const spdOf = (ms: number) => (ms <= 600 ? "fast" : ms <= 875 ? "med" : "slow");
export const noTransition = (): SlideTransition => ({ kind: "none", durMs: 0, advClick: true });
const SIDED = new Set(["push", "wipe", "cover", "pull"]);
const MAX_MS = 59_000; // PowerPoint's UI limit for durations / timings
const clampMs = (n: number, lo = 0, hi = MAX_MS) => Math.min(hi, Math.max(lo, Math.round(n)));
const numMs = (s: string | undefined): number | undefined => { if (s === undefined || !/^\d{1,9}$/.test(s)) return undefined; return Number(s); };

function transNode(root: XEl): { node: XEl; choice?: XEl; fallback?: XEl } | null {
  for (const k of kids(root)) {
    if (k.name === "p:transition") return { node: k, fallback: k };
    if (k.name === "mc:AlternateContent") {
      const ch = kids(k, "mc:Choice").find((c) => kid(c, "p:transition")); const fb = kid(kid(k, "mc:Fallback"), "p:transition");
      if (ch || fb) return { node: k, choice: ch ? kid(ch, "p:transition") : undefined, fallback: fb };
    }
  }
  return null;
}
function kindOf(t: XEl | undefined): Omit<SlideTransition, "durMs" | "advClick" | "advAfterMs"> | null {
  const c = kids(t)[0]; if (!c) return t ? { kind: "fade" } : null; // an empty p:transition = PowerPoint's default (fade-like) — rare
  const ln = c.name.replace(/^p:/, "");
  if (c.name.startsWith("p:")) {
    if (ln === "fade" || ln === "cut") return { kind: ln, ...(attr(c, "thruBlk") === "1" || attr(c, "thruBlk") === "true" ? { thruBlk: true } : {}) };
    // push / wipe take l r u d; cover / pull also take diagonals (lu, ru, ld, rd) — those are kept as "other", playing straight
    if (SIDED.has(ln)) { const d = attr(c, "dir") ?? "l"; return /^[lrud]$/.test(d) ? { kind: ln as TransKind, dir: d as Side } : { kind: "other", name: c.name, playsAs: ln as TransKind }; }
    if (ln === "split") return { kind: "split", orient: attr(c, "orient") === "vert" ? "vert" : "horz", inOut: attr(c, "dir") === "in" ? "in" : "out" };
    if (ln === "zoom") return { kind: "zoom", inOut: attr(c, "dir") === "out" ? "out" : "in" };
    if (ln === "random") return { kind: "random" };
  }
  return { kind: "other", name: c.name };
}
export function readTransition(x: XDoc): SlideTransition {
  const t = transNode(x.root); if (!t) return noTransition();
  const main = t.choice ?? t.fallback!;
  let k = kindOf(t.choice); const fb = kindOf(t.fallback);
  if (k?.kind === "other" && fb && fb.kind !== "other") k = { ...k, playsAs: fb.kind };
  if (!k) k = fb ?? { kind: "fade" };
  if (k.kind === "other" && !k.playsAs) k = { ...k, playsAs: "fade" };
  const p14dur = t.choice ? numMs(attr(t.choice, "p14:dur")) : undefined;
  const spd = (attr(t.fallback ?? main, "spd") ?? "fast") as keyof typeof SPD_MS;
  const durMs = k.kind === "cut" ? 0 : clampMs(p14dur ?? SPD_MS[spd] ?? 500);
  const ac = attr(main, "advClick"); const tm = numMs(attr(main, "advTm"));
  return { ...k, durMs, advClick: !(ac === "0" || ac === "false"), ...(tm !== undefined ? { advAfterMs: clampMs(tm, 0, 86_400_000) } : {}) };
}
function childOf(t: SlideTransition): XEl {
  switch (t.kind) {
    case "fade": return el("p:fade", t.thruBlk ? { thruBlk: "1" } : {});
    case "cut": return el("p:cut", t.thruBlk ? { thruBlk: "1" } : {});
    case "push": case "wipe": case "cover": case "pull": return el(`p:${t.kind}`, { dir: t.dir ?? "l" });
    case "split": return el("p:split", { orient: t.orient ?? "horz", dir: t.inOut ?? "out" });
    case "zoom": return el("p:zoom", t.inOut === "out" ? { dir: "out" } : {});
    case "random": return el("p:random");
    default: throw new Error(`transition ${t.kind} is not written by Fusion`);
  }
}
/** Set (or remove with kind "none") slide i's transition. An "other" transition keeps its element; only timing changes. */
export function setTransition(d: PptxDoc, i: number, t: SlideTransition) {
  const s = mutSlide(d, i); const root = s.xml.root; const cur = transNode(root);
  const advAttrs = (n: XEl) => { setAttr(n, "advClick", t.advClick ? undefined : "0"); setAttr(n, "advTm", t.advAfterMs !== undefined ? String(clampMs(t.advAfterMs, 0, 86_400_000)) : undefined); };
  if (t.kind === "other") {
    if (!cur) throw new Error("no transition to keep");
    for (const n of findAll(cur.node, (e) => e.name === "p:transition")) {
      advAttrs(n); if (n === cur.choice) setAttr(n, "p14:dur", String(clampMs(t.durMs, 10))); else setAttr(n, "spd", spdOf(t.durMs));
    }
    return;
  }
  root.kids = root.kids.filter((k) => !(cur && k === cur.node));
  if (t.kind === "none") { root.selfClose = root.kids.length === 0; return; }
  const ms = t.kind === "cut" ? 0 : clampMs(t.durMs, 10);
  const mk = (p14: boolean) => { const n = el("p:transition", { spd: spdOf(ms), ...(p14 ? { "p14:dur": String(ms) } : {}) }, [childOf(t)]); advAttrs(n); return n; };
  const node = t.kind === "cut" ? mk(false)
    : el("mc:AlternateContent", { "xmlns:mc": MC }, [el("mc:Choice", { "xmlns:p14": P14, Requires: "p14" }, [mk(true)]), el("mc:Fallback", {}, [mk(false)])]);
  const at = root.kids.findIndex((k) => k.k === "el" && (k.name === "p:timing" || k.name === "p:extLst" || (k.name === "mc:AlternateContent" && !!findAll(k, (e) => e.name === "p:timing").length)));
  if (at < 0) root.kids.push(node); else root.kids.splice(at, 0, node);
  root.selfClose = false;
}

/* ================================================================ animations */
export type EffKind = "appear" | "fade" | "fly" | "wipe" | "zoom";
export type Trigger = "click" | "with" | "after";
/** Fly In / Wipe: the side the shape comes FROM. */
export type From = "l" | "r" | "t" | "b";
export const EFFECTS: readonly [EffKind, string, number][] = [["appear", "Appear", 1], ["fade", "Fade", 10], ["fly", "Fly In", 2], ["wipe", "Wipe", 22], ["zoom", "Zoom", 53]];
export const FROM_LABEL: Record<From, string> = { b: "From bottom", l: "From left", r: "From right", t: "From top" };
const SUB: Record<From, number> = { t: 1, r: 2, b: 4, l: 8 };
const FROM_SUB: Record<number, From> = { 1: "t", 2: "r", 4: "b", 8: "l" };
export interface Effect {
  spid: string; trigger: Trigger; delayMs: number; durMs: number;
  /** native = Fusion edits it; foreign = kept XML */ kind: EffKind | "foreign";
  from?: From;
  /** foreign: preset class (entr / exit / emph / path / …), id, and the original effect <p:par> */ cls?: string; presetId?: number; raw?: XEl;
}
export interface SlideAnim {
  effects: Effect[];
  /** the timing tree could not be read: kept verbatim, editing refused */ readOnly: boolean;
  /** other children of the root time node (interactive sequences) — kept, not played */ extra: XEl[];
  /** p:bldLst entries Fusion did not create (kept for spids that still exist) */ bld: XEl[];
}
const EMPTY: SlideAnim = { effects: [], readOnly: false, extra: [], bld: [] };

const cTnOf = (par: XEl | undefined) => kid(par, "p:cTn");
const childPars = (par: XEl | undefined) => kids(kid(cTnOf(par), "p:childTnLst"), "p:par");
const condDelay = (cTn: XEl | undefined): number | "indefinite" | undefined => {
  const c = kids(kid(cTn, "p:stCondLst"), "p:cond")[0]; const v = attr(c, "delay"); if (v === "indefinite") return "indefinite";
  const n = numMs(v); return n;
};
/** the root time node and its main sequence (absent when the slide has no main-sequence effects yet — still editable) */
function mainSeq(timing: XEl | undefined): { root: XEl; seq?: XEl } | null {
  const rootCTn = cTnOf(kid(kid(timing, "p:tnLst"), "p:par")); if (!rootCTn || attr(rootCTn, "nodeType") !== "tmRoot") return null;
  const seq = kids(kid(rootCTn, "p:childTnLst"), "p:seq").find((q) => attr(cTnOf(q), "nodeType") === "mainSeq");
  return { root: rootCTn, seq };
}
function nativeOf(par: XEl, cTn: XEl): Pick<Effect, "kind" | "from"> | null {
  if (attr(cTn, "presetClass") !== "entr") return null;
  const id = Number(attr(cTn, "presetID")); const sub = Number(attr(cTn, "presetSubtype") ?? "0");
  const tg = findAll(par, (e) => e.name === "p:spTgt");
  if (!tg.length || tg.some((t) => kids(t).length) || new Set(tg.map((t) => attr(t, "spid"))).size !== 1) return null; // by-paragraph / sub-targets → foreign
  const beh = kids(kid(cTn, "p:childTnLst")).map((b) => b.name);
  const set = beh[0] === "p:set";
  if (id === 1 && set && beh.length === 1) return { kind: "appear" };
  if (id === 10 && set && beh.length === 2 && beh[1] === "p:animEffect") return { kind: "fade" };
  if (id === 22 && set && beh.length === 2 && beh[1] === "p:animEffect" && FROM_SUB[sub]) return { kind: "wipe", from: FROM_SUB[sub] };
  if (id === 2 && set && beh.length === 3 && FROM_SUB[sub]) return { kind: "fly", from: FROM_SUB[sub] };
  if (id === 53 && set && beh.length >= 3) return { kind: "zoom" };
  return null;
}
const behaviourDur = (cTn: XEl) => Math.max(0, ...findAll(kid(cTn, "p:childTnLst") ?? cTn, (e) => e.name === "p:cTn").map((c) => numMs(attr(c, "dur")) ?? 0).filter((n) => n > 1));

/** Slide i's animation model (main-sequence effects in play order). */
/** p:timing wrapped in mc:AlternateContent (PowerPoint does this for p14 timing features): every branch's p:timing */
const altTimings = (root: XEl) => kids(root, "mc:AlternateContent").flatMap((ac) => findAll(ac, (e) => e.name === "p:timing"));
export function readAnimations(x: XDoc): SlideAnim {
  // a timeline inside AlternateContent is kept verbatim (read-only): rewriting one branch would desynchronise the other
  if (altTimings(x.root).length) return { effects: [], readOnly: true, extra: [], bld: [] };
  const timing = kid(x.root, "p:timing"); if (!timing) return { ...EMPTY, effects: [] };
  const ms = mainSeq(timing);
  if (!ms) return { effects: [], readOnly: true, extra: [], bld: [] };
  const rootKids = kids(kid(ms.root, "p:childTnLst"));
  const extra = rootKids.filter((k) => k !== ms.seq);
  const effects: Effect[] = [];
  try {
    for (const click of ms.seq ? childPars(ms.seq) : []) {
      for (const sub of childPars(click)) {
        for (const ef of childPars(sub)) {
          const c = cTnOf(ef); if (!c) throw new Error("effect without cTn");
          const nt = attr(c, "nodeType"); const trigger: Trigger = nt === "clickEffect" ? "click" : nt === "afterEffect" ? "after" : "with";
          const spid = attr(findAll(ef, (e) => e.name === "p:spTgt")[0], "spid") ?? "";
          const delay = condDelay(c); const delayMs = typeof delay === "number" ? clampMs(delay) : 0;
          const nat = nativeOf(ef, c);
          if (nat) effects.push({ spid, trigger, delayMs, durMs: nat.kind === "appear" ? 0 : clampMs(behaviourDur(c) || 500), ...nat });
          else effects.push({ spid, trigger, delayMs, durMs: behaviourDur(c), kind: "foreign", cls: attr(c, "presetClass") ?? "other", presetId: Number(attr(c, "presetID") ?? "0") || undefined, raw: clone(ef) });
        }
      }
    }
  } catch { return { effects: [], readOnly: true, extra: [], bld: [] }; }
  const bld = kids(kid(timing, "p:bldLst")).filter((b) => !(b.name === "p:bldP" && effects.some((e) => e.kind !== "foreign" && e.spid === attr(b, "spid")) && attr(b, "grpId") === "0" && !attr(b, "build")));
  return { effects, readOnly: false, extra, bld };
}

/* ---------------------------------------------------------------- writer */
const q = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function behaviours(e: Effect, next: () => number): string {
  const tgt = `<p:tgtEl><p:spTgt spid="${q(e.spid)}"/></p:tgtEl>`;
  const set = `<p:set><p:cBhvr><p:cTn id="${next()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tgt}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
  const dur = clampMs(e.durMs, 10);
  const anim = (a: string, from: string, to: string) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${next()}" dur="${dur}" fill="hold"/>${tgt}<p:attrNameLst><p:attrName>${a}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${from}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${to}"/></p:val></p:tav></p:tavLst></p:anim>`;
  const effect = (filter: string) => `<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${next()}" dur="${dur}"/>${tgt}</p:cBhvr></p:animEffect>`;
  switch (e.kind) {
    case "appear": return set;
    case "fade": return set + effect("fade");
    case "wipe": return set + effect(`wipe(${({ b: "up", t: "down", l: "right", r: "left" } as const)[e.from ?? "b"]})`);
    case "fly": {
      const f = e.from ?? "b";
      const x0 = f === "l" ? "0-#ppt_w/2" : f === "r" ? "1+#ppt_w/2" : "#ppt_x"; const y0 = f === "t" ? "0-#ppt_h/2" : f === "b" ? "1+#ppt_h/2" : "#ppt_y";
      return set + anim("ppt_x", x0, "#ppt_x") + anim("ppt_y", y0, "#ppt_y");
    }
    case "zoom": return set + anim("ppt_w", "0", "#ppt_w") + anim("ppt_h", "0", "#ppt_h") + effect("fade");
    default: return "";
  }
}
const NODE: Record<Trigger, string> = { click: "clickEffect", with: "withEffect", after: "afterEffect" };
/** p:timing for the model (null = no timing element needed). */
export function timingXml(a: SlideAnim, hasText: (spid: string) => boolean): string | null {
  if (!a.effects.length && !a.extra.length) return null;
  let id = 0; const next = () => ++id;
  const rootId = next(); const seqId = a.effects.length ? next() : 0;
  // click groups → "after" chains → effects
  type Sub = { offset: number; effs: Effect[] }; const groups: { auto: boolean; subs: Sub[] }[] = [];
  for (const [n, e] of a.effects.entries()) {
    if (n === 0 || e.trigger === "click") groups.push({ auto: n === 0 && e.trigger !== "click", subs: [] });
    const g = groups[groups.length - 1];
    if (!g.subs.length || e.trigger === "after") {
      const prev = g.subs[g.subs.length - 1];
      const off = prev ? prev.offset + Math.max(0, ...prev.effs.map((x) => x.delayMs + x.durMs)) : 0;
      g.subs.push({ offset: off, effs: [] });
    }
    g.subs[g.subs.length - 1].effs.push(e);
  }
  const effXml = (e: Effect): string => {
    if (e.kind === "foreign") {
      const r = clone(e.raw!); for (const c of findAll(r, (x) => x.name === "p:cTn")) setAttr(c, "id", String(next()));
      const top = cTnOf(r); if (top) { setAttr(top, "nodeType", NODE[e.trigger]); const cond = kids(kid(top, "p:stCondLst"), "p:cond")[0]; if (cond) setAttr(cond, "delay", String(e.delayMs)); }
      return serializeEl(r);
    }
    const preset = EFFECTS.find(([k]) => k === e.kind)![2]; const sub = e.kind === "fly" || e.kind === "wipe" ? SUB[e.from ?? "b"] : e.kind === "zoom" ? 16 : 0;
    const cid = next();
    return `<p:par><p:cTn id="${cid}" presetID="${preset}" presetClass="entr" presetSubtype="${sub}" fill="hold"${hasText(e.spid) ? ' grpId="0"' : ""} nodeType="${NODE[e.trigger]}"><p:stCondLst><p:cond delay="${clampMs(e.delayMs)}"/></p:stCondLst><p:childTnLst>${behaviours(e, next)}</p:childTnLst></p:cTn></p:par>`;
  };
  const seq = a.effects.length ? `<p:seq concurrent="1" nextAc="seek"><p:cTn id="${seqId}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups.map((g) => {
    const gid = next();
    return `<p:par><p:cTn id="${gid}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${g.auto ? `<p:cond evt="onBegin" delay="0"><p:tn val="${seqId}"/></p:cond>` : ""}</p:stCondLst><p:childTnLst>${g.subs.map((s) => {
      const sid = next();
      return `<p:par><p:cTn id="${sid}" fill="hold"><p:stCondLst><p:cond delay="${s.offset}"/></p:stCondLst><p:childTnLst>${s.effs.map(effXml).join("")}</p:childTnLst></p:cTn></p:par>`;
    }).join("")}</p:childTnLst></p:cTn></p:par>`;
  }).join("")}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>` : "";
  const extra = a.extra.map((x) => { const r = clone(x); for (const c of findAll(r, (y) => y.name === "p:cTn")) setAttr(c, "id", String(next())); return serializeEl(r); }).join("");
  const own = [...new Set(a.effects.filter((e) => e.kind !== "foreign" && hasText(e.spid)).map((e) => e.spid))];
  const bldItems = [...own.map((s) => `<p:bldP spid="${q(s)}" grpId="0" animBg="1"/>`), ...a.bld.filter((b) => !own.includes(attr(b, "spid") ?? "")).map((b) => serializeEl(b))];
  return `<p:timing><p:tnLst><p:par><p:cTn id="${rootId}" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${seq}${extra}</p:childTnLst></p:cTn></p:par></p:tnLst>${bldItems.length ? `<p:bldLst>${bldItems.join("")}</p:bldLst>` : ""}</p:timing>`;
}

/** spid → top-level spTree address ("3") for every shape on the slide, and whether it has text. */
export function shapeIds(x: XDoc): Map<string, { addr: string; text: boolean; name: string }> {
  const out = new Map<string, { addr: string; text: boolean; name: string }>();
  shapeKids(spTreeOf(x)).forEach((e, i) => {
    const c = cNvPrOf(e) ?? findAll(e, (y) => y.name === "p:cNvPr")[0]; const id = attr(c, "id");
    if (id) out.set(id, { addr: String(i), text: !!txBodyOf(e), name: attr(c, "name") ?? `Shape ${id}` });
    // shapes inside groups / AlternateContent: animatable by id, play with their top-level ancestor
    for (const inner of findAll(e, (y) => y.name === "p:cNvPr")) { const iid = attr(inner, "id"); if (iid && !out.has(iid)) out.set(iid, { addr: String(i), text: false, name: attr(inner, "name") ?? `Shape ${iid}` }); }
  });
  return out;
}

/** Replace slide i's main-sequence effects. Effects on shapes that do not exist are dropped (never dangling). */
export function setAnimations(d: PptxDoc, i: number, effects: Effect[]) {
  const cur = readAnimations(d.slides[i].xml);
  if (cur.readOnly) throw new Error("this slide's animation timeline is not editable in Fusion (it is kept as it is)");
  const s = mutSlide(d, i); const ids = shapeIds(s.xml);
  const clean = effects.filter((e) => ids.has(e.spid)).map((e) => ({ ...e, delayMs: clampMs(e.delayMs), durMs: e.kind === "appear" ? 0 : clampMs(e.durMs, 10) }));
  writeTiming(s.xml, { ...cur, effects: clean, bld: cur.bld.filter((b) => ids.has(attr(b, "spid") ?? "")) }, (spid) => !!ids.get(spid)?.text);
}
function writeTiming(x: XDoc, a: SlideAnim, hasText: (spid: string) => boolean) {
  const root = x.root; const xml = timingXml(a, hasText);
  const node = xml ? (parseXml(`<p:timing xmlns:p="${PNS}"${xml.slice("<p:timing".length)}`).root) : null;
  if (node) node.attrs = node.attrs.filter(([k]) => k !== "xmlns:p");
  const at = root.kids.findIndex((k) => k.k === "el" && k.name === "p:timing");
  if (at >= 0) { if (node) root.kids[at] = node; else root.kids.splice(at, 1); }
  else if (node) { const ext = root.kids.findIndex((k) => k.k === "el" && k.name === "p:extLst"); if (ext < 0) root.kids.push(node); else root.kids.splice(ext, 0, node); }
  root.selfClose = root.kids.length === 0;
}

/**
 * After shapes were removed from a slide (already copy-on-write cloned by the caller): drop effects, build entries and
 * interactive triggers that point at spids no longer on the slide. A timeline Fusion cannot model is pruned at the XML
 * level (every <p:par> whose targets are all gone). Returns true if anything changed.
 */
export function pruneTiming(x: XDoc): boolean {
  const ids = shapeIds(x); const gone = (t: XEl) => !ids.has(attr(t, "spid") ?? "");
  const alts = altTimings(x.root);
  if (alts.length) {
    let changed = false;
    for (const tm of alts) if (pruneOpaque(tm, gone)) changed = true;
    // a branch whose last target went away is left with an empty timeline: drop the whole AlternateContent then
    for (const ac of kids(x.root, "mc:AlternateContent")) if (findAll(ac, (e) => e.name === "p:timing").length && !findAll(ac, (e) => e.name === "p:spTgt").length) { x.root.kids = x.root.kids.filter((k) => k !== ac); changed = true; }
    return changed;
  }
  const timing = kid(x.root, "p:timing"); if (!timing) return false;
  const tg = findAll(timing, (e) => e.name === "p:spTgt" || e.name === "p:bldP" || e.name === "p:bldGraphic" || e.name === "p:bldDgm" || e.name === "p:bldOleChart");
  if (!tg.some(gone)) return false;
  const a = readAnimations(x);
  if (!a.readOnly) {
    const keepEx = a.extra.filter((ex) => !findAll(ex, (e) => e.name === "p:spTgt").some(gone));
    writeTiming(x, { ...a, effects: a.effects.filter((e) => ids.has(e.spid) && !(e.raw && findAll(e.raw, (y) => y.name === "p:spTgt").some(gone))), extra: keepEx, bld: a.bld.filter((b) => !gone(b)) }, (spid) => !!ids.get(spid)?.text);
    return true;
  }
  pruneOpaque(timing, gone);
  if (!findAll(timing, (e) => e.name === "p:spTgt").length) x.root.kids = x.root.kids.filter((k) => k !== timing);
  return true;
}
/** opaque timeline: remove the smallest <p:par> around each dangling target, and dangling build entries */
function pruneOpaque(timing: XEl, gone: (t: XEl) => boolean): boolean {
  const dead = findAll(timing, (e) => e.name === "p:spTgt" || (e.name.startsWith("p:bld") && e.name !== "p:bldLst" && e.name !== "p:bldSub")).filter(gone);
  if (!dead.length) return false;
  const rm = (n: XEl) => { const parents = findAll(timing, (e) => e.kids.includes(n)); for (const p of parents) p.kids = p.kids.filter((k) => k !== n); };
  for (const t of dead.filter((e) => e.name === "p:spTgt")) {
    const par = findAll(timing, (e) => e.name === "p:par" && findAll(e, (y) => y === t).length > 0 && !findAll(e, (y) => y.name === "p:spTgt").some((y) => !gone(y))).pop();
    if (par) rm(par);
  }
  for (const b of dead.filter((e) => e.name !== "p:spTgt")) rm(b);
  return true;
}

/* ================================================================ playback model */
export interface PlayItem { spid: string; kind: EffKind | "foreign"; cls: string; from?: From; startMs: number; durMs: number }
export interface PlayStep { auto: boolean; items: PlayItem[] }
/** Click steps of the main sequence: step k plays when the k-th click arrives (step 0 may start on its own). */
export function playSteps(effects: Effect[]): PlayStep[] {
  const steps: PlayStep[] = []; let subStart = 0, subEnd = 0;
  effects.forEach((e, n) => {
    if (n === 0 || e.trigger === "click") { steps.push({ auto: n === 0 && e.trigger !== "click", items: [] }); subStart = 0; subEnd = 0; }
    else if (e.trigger === "after") subStart = subEnd;
    const start = subStart + e.delayMs; const cls = e.kind === "foreign" ? e.cls ?? "other" : "entr";
    steps[steps.length - 1].items.push({ spid: e.spid, kind: e.kind, cls, from: e.from, startMs: start, durMs: e.durMs });
    subEnd = Math.max(subEnd, start + e.durMs);
  });
  return steps;
}
/** Shapes hidden before any step: those whose FIRST effect is an entrance. */
export function hiddenAtStart(effects: Effect[]): Set<string> {
  const first = new Map<string, string>();
  for (const e of effects) if (!first.has(e.spid)) first.set(e.spid, e.kind === "foreign" ? e.cls ?? "other" : "entr");
  return new Set([...first].filter(([, c]) => c === "entr").map(([s]) => s));
}
/** Visibility after `done` steps have fully played, and the items animating in step `done - 1`. */
export function stateAfter(effects: Effect[], done: number): { hidden: Set<string>; playing: PlayItem[] } {
  const steps = playSteps(effects); const hidden = hiddenAtStart(effects);
  for (const st of steps.slice(0, done)) for (const it of [...st.items].sort((a, b) => a.startMs - b.startMs)) { if (it.cls === "entr") hidden.delete(it.spid); else if (it.cls === "exit") hidden.add(it.spid); }
  return { hidden, playing: done > 0 ? steps[done - 1]?.items ?? [] : [] };
}
/** How many steps play without a click when the slide appears. */
export const autoSteps = (effects: Effect[]) => (playSteps(effects)[0]?.auto ? 1 : 0);
/** Total run time (ms) of a step. */
export const stepMs = (st: PlayStep | undefined) => Math.max(0, ...(st?.items ?? []).map((i) => i.startMs + i.durMs));
