/**
 * TT76 — Slides transitions + entrance animations (src/lib/office/pmlanim.ts).
 *  M1 corpus read: every slide of 95 real decks (PowerPoint / LibreOffice / Keynote exports): Fusion's transition and
 *     main-sequence effects == an independent lxml reader (scripts/oracle/pptx_motion.py)
 *  M2 corpus re-emit: every animated / transitioned slide rewritten from Fusion's model (foreign effects carried as XML)
 *     → ECMA-376 PML XSD valid (MCE-resolved like PowerPoint 2007) → python-pptx opens → lxml sees the same effects in
 *     the same click groups, unique cTn ids, no dangling targets → Fusion rereads the same model
 *  M3 authored: a new deck gets every transition kind and every effect × trigger → XSD → python-pptx → the oracle reads
 *     exactly what was authored (AlternateContent p14:dur + Fallback spd; presetID / subtype / nodeType / delay / groups)
 *  M4 playback model: click / with / after timing, auto-start, hidden-at-start, foreign exit hides
 *  M5 deleting an animated shape prunes its effects and build entries (modelled and opaque timelines) — never dangling
 *  N  negative shapes
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import * as M from "../src/lib/office/pml.ts";
import { readTransition, setTransition, readAnimations, setAnimations, timingXml, shapeIds, playSteps, stateAfter, hiddenAtStart, autoSteps, pruneTiming, type Effect, type SlideTransition, type EffKind, type Trigger, type From } from "../src/lib/office/pmlanim.ts";
import { parseXml, serializeXml } from "../src/lib/office/xmltree.ts";
import { channelPort, parseShowMsg, encodeText, decodeText, newSid, sidOk, type ShowMsg } from "../src/lib/office/showlink.ts";
import { stepFx, transitionFx, describeTransition, MOTION_CSS } from "../src/lib/office/pmlplay.ts";

const H = makeHarness("tt76-slides"); const { finish } = H;
const test = (n: string, c: Record<string, "full" | "partial">, fn: () => unknown) => H.test(n, c, async () => { const r = await fn(); if (typeof r === "string") console.log(`    → ${r}`); });
const ONLY = process.env.TT76_ONLY; const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python"; const CORPUS = "/home/user/tools/corpus/pptx";
const tmp = mkdtempSync(join(tmpdir(), "tt76p-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const J = (v: unknown) => JSON.stringify(v);
// TT76 register row FF-63: slide transitions + animations (and the Slides row it extends)
const MOTION = { "FF-23": "full", "FF-63": "full" } as const;
type OxT = { spd: string | null; dur: string | null; advClick: string | null; advTm: string | null; child: string | null; childNs: string | null; attrs: Record<string, string> } | null;
type OxE = { group: number; sub: number; presetID: string | null; presetClass: string | null; presetSubtype: string | null; nodeType: string | null; spid: string | null; delay: string | null; groupAuto: boolean };
type OxS = { transition: { choice: OxT; fallback: OxT; ac: boolean; requires?: string } | null; effects: OxE[]; idsUnique: boolean; dangling: string[]; hasTiming: boolean };
type OxF = { pptx_ok: true | string; slides: Record<string, OxS> } | { error: string };
const py = <T,>(script: string, files: string[]): Record<string, T> => { const out: Record<string, T> = {}; for (let k = 0; k < files.length; k += 15) Object.assign(out, JSON.parse(execFileSync(PY, [script, ...files.slice(k, k + 15)], { encoding: "utf8", maxBuffer: 512 << 20 }))); return out; };
const ox = (f: string[]) => py<OxF>("scripts/oracle/pptx_motion.py", f);
const xsd = (f: string[]) => py<{ parts: Record<string, string[]> }>("scripts/oracle/ooxml_xsd.py", f);
const xsdErr = (r: { parts: Record<string, string[]> } | undefined) => (r ? Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e[0]}`) : ["no XSD result"]);
/** XSD errors in `out` that the source deck did not already have (several corpus decks are themselves invalid) */
const noLine = (e: string) => e.replace(/line \d+: /, "");
const baseXsd = new Map<string, Set<string>>();
function newXsdErrors(out: string, src: string, v: Record<string, { parts: Record<string, string[]> }>): string[] {
  if (!baseXsd.has(src)) { const r = xsd([src])[src]; baseXsd.set(src, new Set(r ? Object.entries(r.parts).flatMap(([p, e]) => e.map((x) => `${p}: ${noLine(x)}`)) : [])); }
  const base = baseXsd.get(src)!; const r = v[out]; if (!r) return ["no XSD result"];
  return Object.entries(r.parts).flatMap(([p, e]) => e.map((x) => `${p}: ${noLine(x)}`)).filter((x) => /slides\/slide\d+\.xml/.test(x) && !base.has(x));
}
const NODE: Record<Trigger, string> = { click: "clickEffect", with: "withEffect", after: "afterEffect" };
/** Fusion's effects → the oracle's view (group index / after-chain index / nodeType / spid / delay) */
function expectOx(effects: Effect[]) {
  let g = -1, s = 0; return effects.map((e, n) => {
    if (n === 0 || e.trigger === "click") { g++; s = 0; } else if (e.trigger === "after") s++;
    return { group: g, sub: s, nodeType: NODE[e.trigger], spid: e.spid, delay: String(e.delayMs) };
  });
}
const effKey = (e: Effect) => J([e.spid, e.kind, e.trigger, e.from ?? null, e.delayMs, e.durMs, e.cls ?? null, e.presetId ?? null]);
const corpus = readdirSync(CORPUS).filter((f) => f.endsWith(".pptx")).sort().map((f) => join(CORPUS, f));
const docs = new Map<string, M.PptxDoc>();
const load = async (f: string) => { if (!docs.has(f)) docs.set(f, await M.readPptxDoc(new Uint8Array(readFileSync(f)), f)); return docs.get(f)!; };

/* ================================================================== M1 */
if (want("M1")) await test("M1 corpus: Fusion's transitions + main-sequence effects == lxml oracle on every slide", MOTION, async () => {
  const o = ox(corpus); const bad: string[] = []; let slides = 0, trans = 0, ac = 0, animated = 0, effects = 0, native = 0, readOnly = 0, refused = 0;
  const kinds: Record<string, number> = {};
  for (const f of corpus) {
    const of = o[f]; let d: M.PptxDoc; try { d = await load(f); } catch { refused++; continue; }
    if (!of || "error" in of) { bad.push(`${f}: oracle ${J(of)}`); continue; }
    for (const s of d.slides) {
      slides++; const os = of.slides[s.path]; if (!os) { bad.push(`${f} ${s.path}: oracle has no slide`); continue; }
      const t = readTransition(s.xml);
      if (!!os.transition !== (t.kind !== "none")) bad.push(`${f} ${s.path}: transition presence ${t.kind} vs ${J(os.transition)}`);
      if (os.transition) {
        trans++; if (os.transition.ac) ac++;
        const fb = os.transition.fallback, ch = os.transition.choice; const main = ch ?? fb!;
        const wantDur = ch?.dur && /^\d+$/.test(ch.dur) ? Number(ch.dur) : ({ fast: 500, med: 750, slow: 1000 } as Record<string, number>)[fb?.spd ?? "fast"] ?? 500;
        if (t.kind !== "cut" && t.durMs !== wantDur) bad.push(`${f} ${s.path}: dur ${t.durMs} vs ${wantDur}`);
        if (t.advClick !== !(main.advClick === "0" || main.advClick === "false")) bad.push(`${f} ${s.path}: advClick`);
        if ((t.advAfterMs ?? null) !== (main.advTm ? Number(main.advTm) : null)) bad.push(`${f} ${s.path}: advTm ${t.advAfterMs} vs ${main.advTm}`);
        const child = main.child; const nameKind = t.kind === "other" ? t.name!.replace(/^p14:|^p:/, "") : t.kind;
        if (child && nameKind !== child && !(t.kind === "other" && t.name?.endsWith(child))) bad.push(`${f} ${s.path}: kind ${t.kind}/${t.name} vs ${child}`);
        kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
      }
      const a = readAnimations(s.xml);
      if (a.readOnly) { readOnly++; continue; }
      if (os.effects.length) animated++;
      effects += a.effects.length; native += a.effects.filter((e) => e.kind !== "foreign").length;
      if (a.effects.length !== os.effects.length) { bad.push(`${f} ${s.path}: ${a.effects.length} effects vs oracle ${os.effects.length}`); continue; }
      const exp = expectOx(a.effects);
      os.effects.forEach((e, k) => {
        const m = exp[k]; const got = { group: e.group, sub: e.sub, nodeType: e.nodeType, spid: e.spid, delay: e.delay ?? "0" };
        // an effect's nodeType can disagree with its structural position in hand-edited files; Fusion follows nodeType for the trigger and must agree on structure
        if (got.group !== m.group || got.sub !== m.sub || got.spid !== m.spid || (got.delay !== m.delay && got.delay !== "indefinite")) bad.push(`${f} ${s.path} effect ${k}: oracle ${J(got)} vs Fusion ${J(m)}`);
        const fe = a.effects[k]; if (fe.kind === "foreign" ? fe.presetId !== (Number(e.presetID) || undefined) : !["1", "10", "2", "22", "53"].includes(e.presetID ?? "")) bad.push(`${f} ${s.path} effect ${k}: preset ${e.presetID} kind ${fe.kind}`);
      });
    }
  }
  ok(!bad.length, bad.slice(0, 12).join("\n") + (bad.length > 12 ? `\n… ${bad.length} total` : ""));
  ok(effects >= 200 && native >= 100 && trans >= 100, `coverage: effects ${effects}, native ${native}, transitions ${trans}`);
  return `${slides} slides (${refused} decks refused by the reader): ${trans} transitions (${ac} p14 AlternateContent; ${J(kinds)}), ${animated} animated slides, ${effects} effects (${native} native), ${readOnly} read-only timelines — all agree with lxml`;
});

/* ================================================================== M2 */
if (want("M2")) await test("M2 corpus re-emit from Fusion's model: XSD-valid, python-pptx opens, lxml sees the same effects/groups, unique ids, nothing dangling, reread identical", MOTION, async () => {
  const outs: string[] = []; const srcOf = new Map<string, string>(); const exp = new Map<string, Map<string, { eff: Effect[]; t: SlideTransition }>>(); let slidesTouched = 0;
  for (const f of corpus) {
    let d: M.PptxDoc; try { d = await M.readPptxDoc(new Uint8Array(readFileSync(f)), f); } catch { continue; }
    const per = new Map<string, { eff: Effect[]; t: SlideTransition }>(); let touched = false;
    for (let i = 0; i < d.slides.length; i++) {
      const s = d.slides[i]; const a = readAnimations(s.xml); const t = readTransition(s.xml);
      if (!a.readOnly && (a.effects.length || a.extra.length)) { setAnimations(d, i, a.effects); touched = true; }
      if (t.kind !== "none") { setTransition(d, i, t); touched = true; }
      if (touched) per.set(d.slides[i].path, { eff: a.readOnly ? [] : a.effects, t });
    }
    if (!touched) continue;
    slidesTouched += per.size;
    const out = join(tmp, `m2-${outs.length}.pptx`); writeFileSync(out, await M.writePptxDoc(d)); outs.push(out); exp.set(out, per); srcOf.set(out, f);
  }
  const v = xsd(outs); const o = ox(outs); const bad: string[] = []; let effs = 0;
  for (const out of outs) {
    const e = newXsdErrors(out, srcOf.get(out)!, v); if (e.length) bad.push(`${out} XSD (new): ${e.slice(0, 2).join("; ")}`);
    const of = o[out]; if (!of || "error" in of) { bad.push(`${out}: ${J(of)}`); continue; }
    if (of.pptx_ok !== true) bad.push(`${out}: python-pptx ${of.pptx_ok}`);
    const back = await M.readPptxDoc(new Uint8Array(readFileSync(out)), out);
    for (const [path, x] of exp.get(out)!) {
      const os = of.slides[path]; if (!os) { bad.push(`${out} ${path} missing`); continue; }
      if (!os.idsUnique) bad.push(`${out} ${path}: duplicate cTn ids`);
      if (os.dangling.length) bad.push(`${out} ${path}: dangling ${J(os.dangling)}`);
      const want0 = expectOx(x.eff); effs += x.eff.length;
      const got = os.effects.map((q) => ({ group: q.group, sub: q.sub, nodeType: q.nodeType, spid: q.spid, delay: q.delay }));
      if (J(got) !== J(want0)) bad.push(`${out} ${path}: effects ${J(got).slice(0, 300)} vs ${J(want0).slice(0, 300)}`);
      const bs = back.slides.find((s) => s.path === path)!; const ba = readAnimations(bs.xml);
      if (J(ba.effects.map(effKey)) !== J(x.eff.map(effKey))) bad.push(`${out} ${path}: reread model differs`);
      const bt = readTransition(bs.xml); if (J({ ...bt }) !== J({ ...x.t })) bad.push(`${out} ${path}: transition ${J(bt)} vs ${J(x.t)}`);
    }
  }
  ok(!bad.length, bad.slice(0, 10).join("\n") + (bad.length > 10 ? `\n… ${bad.length}` : ""));
  return `${outs.length} decks, ${slidesTouched} slides re-emitted (${effs} effects): XSD-valid, python-pptx opens all, lxml agrees, reread identical`;
});

/* ================================================================== M3 */
const TRANS: SlideTransition[] = [
  { kind: "fade", durMs: 700, advClick: true }, { kind: "fade", thruBlk: true, durMs: 1200, advClick: true }, { kind: "cut", durMs: 0, advClick: true },
  { kind: "push", dir: "u", durMs: 500, advClick: true }, { kind: "wipe", dir: "r", durMs: 1000, advClick: false, advAfterMs: 3000 }, { kind: "cover", dir: "d", durMs: 750, advClick: true },
  { kind: "pull", dir: "l", durMs: 2000, advClick: true }, { kind: "split", orient: "vert", inOut: "in", durMs: 600, advClick: true }, { kind: "zoom", inOut: "out", durMs: 900, advClick: true }, { kind: "random", durMs: 500, advClick: true, advAfterMs: 0 },
];
if (want("M3")) await test("M3 authored: every transition kind + every effect × trigger → XSD → python-pptx → lxml reads exactly what was authored", MOTION, async () => {
  const d = await M.readPptxDoc(await M.blankPptx("Motion"), "motion.pptx");
  for (let k = 1; k < TRANS.length; k++) M.addSlideFromLayout(d, k, M.layoutsOf(d)[0].path);
  TRANS.forEach((t, i) => setTransition(d, i, t));
  // slide 1: five shapes, one effect each, all triggers and directions
  const addrs = (["rect", "ellipse", "textbox", "triangle", "star5"] as M.NewShapeKind[]).map((k, n) => M.addShape(d, 0, k, { x: 600000 + n * 1500000, y: 1500000, cx: 1200000, cy: 900000 }, k === "textbox" ? "Hello" : ""));
  const ids = shapeIds(d.slides[0].xml); const spidOf = (addr: string) => [...ids].find(([, v]) => v.addr === addr)![0];
  const plan: [EffKind, Trigger, From | undefined, number, number][] = [["fade", "click", undefined, 0, 500], ["fly", "with", "l", 250, 750], ["wipe", "after", "t", 0, 1000], ["zoom", "click", undefined, 100, 400], ["appear", "after", undefined, 500, 0], ["fly", "click", "r", 0, 500], ["wipe", "with", "b", 0, 600]];
  const effects: Effect[] = plan.map(([kind, trigger, from, delayMs, durMs], n) => ({ spid: spidOf(addrs[n % addrs.length]), kind, trigger, from, delayMs, durMs }));
  setAnimations(d, 0, effects);
  // slide 2: the first effect is "after previous" → the step starts by itself
  const a2 = M.addShape(d, 1, "rect", { x: 1e6, y: 1e6, cx: 1e6, cy: 1e6 }); setAnimations(d, 1, [{ spid: [...shapeIds(d.slides[1].xml)].find(([, v]) => v.addr === a2)![0], kind: "fade", trigger: "after", delayMs: 0, durMs: 500 }]);
  const f = join(tmp, "m3.pptx"); writeFileSync(f, await M.writePptxDoc(d));
  const e = xsdErr(xsd([f])[f]); ok(!e.length, `XSD ${e.slice(0, 3).join("; ")}`);
  const of = ox([f])[f]; ok(of && !("error" in of), J(of)); ok(of.pptx_ok === true, `python-pptx ${of.pptx_ok}`);
  const bad: string[] = [];
  d.slides.forEach((s, i) => {
    const os = of.slides[s.path]; const t = TRANS[i]; const tr = os.transition!;
    if (!tr) { bad.push(`slide ${i + 1}: no transition`); return; }
    const fb = tr.fallback!; const ch = tr.choice;
    const childWant = t.kind === "pull" ? "pull" : t.kind;
    if (fb.child !== childWant) bad.push(`slide ${i + 1}: fallback child ${fb.child} want ${childWant}`);
    if (t.kind === "cut") { if (tr.ac) bad.push("cut must be a plain p:transition"); }
    else {
      if (!tr.ac || tr.requires !== "p14" || ch?.dur !== String(t.durMs)) bad.push(`slide ${i + 1}: p14 choice ${J(tr)}`);
      const spd = t.durMs <= 600 ? "fast" : t.durMs <= 875 ? "med" : "slow"; if (fb.spd !== spd || ch?.spd !== spd) bad.push(`slide ${i + 1}: spd ${fb.spd} want ${spd}`);
    }
    if ((fb.advClick === "0") !== !t.advClick) bad.push(`slide ${i + 1}: advClick ${fb.advClick}`);
    if ((fb.advTm ?? undefined) !== (t.advAfterMs !== undefined ? String(t.advAfterMs) : undefined)) bad.push(`slide ${i + 1}: advTm ${fb.advTm}`);
    const at = fb.attrs; const wantAttrs: Record<string, string> = t.kind === "fade" || t.kind === "cut" ? (t.thruBlk ? { thruBlk: "1" } : {}) : t.kind === "split" ? { orient: t.orient!, dir: t.inOut! } : t.kind === "zoom" ? (t.inOut === "out" ? { dir: "out" } : {}) : t.kind === "random" ? {} : { dir: t.dir! };
    if (J(at) !== J(wantAttrs)) bad.push(`slide ${i + 1}: attrs ${J(at)} want ${J(wantAttrs)}`);
    const back = readTransition(s.xml); if (J(back) !== J({ ...t, durMs: t.kind === "cut" ? 0 : t.durMs })) bad.push(`slide ${i + 1}: reread ${J(back)}`);
  });
  const os0 = of.slides[d.slides[0].path];
  const PRE: Record<EffKind, string> = { appear: "1", fade: "10", fly: "2", wipe: "22", zoom: "53" }; const SUBT: Record<string, string> = { t: "1", r: "2", b: "4", l: "8" };
  const got = os0.effects.map((x) => [x.presetID, x.presetClass, x.presetSubtype, x.nodeType, x.spid, x.delay, x.group, x.sub]);
  const exp = expectOx(effects).map((x, n) => { const p = plan[n]; return [PRE[p[0]], "entr", p[0] === "fly" || p[0] === "wipe" ? SUBT[p[2]!] : p[0] === "zoom" ? "16" : "0", x.nodeType, x.spid, x.delay, x.group, x.sub]; });
  if (J(got) !== J(exp)) bad.push(`effects\n got ${J(got)}\nwant ${J(exp)}`);
  if (!os0.idsUnique || os0.dangling.length) bad.push(`ids/dangling ${os0.idsUnique} ${J(os0.dangling)}`);
  const os1 = of.slides[d.slides[1].path]; if (!os1.effects[0]?.groupAuto) bad.push(`slide 2 auto start ${J(os1.effects)}`);
  // reread through Fusion
  const back = await M.readPptxDoc(new Uint8Array(readFileSync(f)), f); const ba = readAnimations(back.slides[0].xml);
  if (J(ba.effects.map(effKey)) !== J(effects.map(effKey))) bad.push(`reread ${J(ba.effects.map(effKey))}`);
  ok(!bad.length, bad.join("\n"));
  return `${TRANS.length} transitions (p14:dur + spd, advClick/advTm) and ${effects.length} effects (5 kinds × 3 triggers, directions, delays) read back exactly by lxml + Fusion; auto-start group marked onBegin`;
});

/* ================================================================== M4 */
if (want("M4")) await test("M4 playback model: click / with / after timing, auto start, hidden at start, foreign exit hides", MOTION, () => {
  const E = (spid: string, trigger: Trigger, kind: EffKind | "foreign", delayMs = 0, durMs = 500, cls?: string): Effect => ({ spid, trigger, kind, delayMs, durMs, ...(cls ? { cls } : {}) });
  const effs = [E("2", "click", "fade"), E("3", "with", "fly", 250, 750), E("4", "after", "wipe", 100, 1000), E("5", "click", "appear", 0, 0), E("2", "after", "foreign", 0, 500, "exit"), E("6", "click", "foreign", 0, 500, "emph")];
  const st = playSteps(effs); const fails: string[] = [];
  if (st.length !== 3 || st.some((s) => s.auto)) fails.push(`steps ${J(st.map((s) => [s.auto, s.items.length]))}`);
  // step 1: fade 0–500, fly 250–1000, wipe starts after the longest (1000) + 100 delay
  if (J(st[0].items.map((i) => [i.spid, i.startMs, i.durMs])) !== J([["2", 0, 500], ["3", 250, 750], ["4", 1100, 1000]])) fails.push(`step1 ${J(st[0].items)}`);
  if (J(st[1].items.map((i) => [i.spid, i.startMs])) !== J([["5", 0], ["2", 0]])) fails.push(`step2 ${J(st[1].items)}`);
  if (J([...hiddenAtStart(effs)].sort()) !== J(["2", "3", "4", "5"])) fails.push(`hidden at start ${J([...hiddenAtStart(effs)])}`);
  const s1 = stateAfter(effs, 1); if (J([...s1.hidden].sort()) !== J(["5"])) fails.push(`after 1 ${J([...s1.hidden])}`);
  const s2 = stateAfter(effs, 2); if (J([...s2.hidden].sort()) !== J(["2"])) fails.push(`after 2 (exit hides 2) ${J([...s2.hidden])}`);
  const s3 = stateAfter(effs, 3); if (s3.hidden.has("6")) fails.push("emphasis must not hide");
  if (autoSteps(effs) !== 0 || autoSteps([E("2", "with", "fade")]) !== 1 || autoSteps([]) !== 0) fails.push("autoSteps");
  ok(!fails.length, fails.join("\n"));
  return "3 click steps, after-chain offsets, auto start, entrance hides until played, exit hides after, emphasis inert";
});

/* ================================================================== M6 */
if (want("M6")) await test("M6 show playback CSS: waiting shapes hidden, the played step animates from its start state, transitions layer correctly", MOTION, () => {
  const E = (spid: string, trigger: Trigger, kind: EffKind | "foreign", extra: Partial<Effect> = {}): Effect => ({ spid, trigger, kind, delayMs: 0, durMs: 500, ...extra });
  const effs = [E("2", "click", "fly", { from: "l" }), E("3", "with", "wipe", { from: "t", delayMs: 200 }), E("4", "click", "zoom"), E("2", "click", "foreign", { cls: "exit" })];
  const addr = (spid: string) => ({ "2": "0", "3": "1", "4": "2" } as Record<string, string>)[spid]; const geo = () => ({ x: 100, y: 50, w: 200, h: 100 }); const S = { w: 960, h: 540 };
  const f: string[] = [];
  const s0 = stepFx(effs, 0, false, addr, geo, S); if (J(s0) !== J({ 0: { visibility: "hidden" }, 1: { visibility: "hidden" }, 2: { visibility: "hidden" } })) f.push(`start ${J(s0)}`);
  const s1 = stepFx(effs, 1, true, addr, geo, S, 400);
  if (!String(s1[0]?.animation).startsWith("fsfx-fly 500ms") || !String(s1[0].animation).includes(" 400ms backwards") || s1[0]["--fx-x"] !== "-300px") f.push(`fly ${J(s1[0])}`);
  if (!String(s1[1]?.animation).includes("fsfx-wipe") || !String(s1[1].animation).includes(" 600ms ") || s1[1]["--fx-clip"] !== "inset(0 0 100% 0)") f.push(`wipe ${J(s1[1])}`);
  if (J(s1[2]) !== J({ visibility: "hidden" })) f.push(`zoom target must still wait ${J(s1[2])}`);
  const s1b = stepFx(effs, 1, false, addr, geo, S); if (s1b[0] || s1b[1]) f.push(`stepping back shows final state ${J(s1b)}`);
  const s3 = stepFx(effs, 3, true, addr, geo, S); if (!String(s3[0]?.animation).includes("fsfx-out") || !String(s3[0].animation).includes("forwards")) f.push(`exit ${J(s3[0])}`);
  const s4 = stepFx(effs, 9, false, addr, geo, S); if (J(s4[0]) !== J({ visibility: "hidden" })) f.push(`after exit hidden ${J(s4)}`);
  // transitions
  const tr = (t: SlideTransition) => transitionFx(t, 0);
  if (tr({ kind: "cut", durMs: 0, advClick: true }) !== null) f.push("cut animates");
  const push = tr({ kind: "push", dir: "l", durMs: 800, advClick: true })!; if (push.incoming["--tr-x"] !== "100%" || push.outgoing?.["--tr-x"] !== "-100%" || push.ms !== 800) f.push(`push ${J(push)}`);
  const pull = tr({ kind: "pull", dir: "u", durMs: 500, advClick: true })!; if (!pull.outgoingOnTop || pull.outgoing?.["--tr-y"] !== "-100%") f.push(`pull ${J(pull)}`);
  const wipe = tr({ kind: "wipe", dir: "r", durMs: 500, advClick: true })!; if (wipe.incoming["--tr-clip"] !== "inset(0 100% 0 0)") f.push(`wipe ${J(wipe)}`);
  const spl = tr({ kind: "split", orient: "vert", inOut: "in", durMs: 500, advClick: true })!; if (!spl.outgoingOnTop || spl.outgoing?.["--tr-clip"] !== "inset(0 50% 0 50%)") f.push(`split ${J(spl)}`);
  const oth = tr({ kind: "other", name: "p14:vortex", playsAs: "wipe", dir: undefined, durMs: 2000, advClick: true })!; if (!String(oth.incoming.animation).startsWith("fstr-clip-in 2000ms")) f.push(`other ${J(oth)}`);
  const rnd = new Set(Array.from({ length: 6 }, (_, i) => String(transitionFx({ kind: "random", durMs: 500, advClick: true }, i)!.incoming.animation ?? transitionFx({ kind: "random", durMs: 500, advClick: true }, i)!.outgoing?.animation).split(" ")[0])); if (rnd.size < 4) f.push(`random variety ${J([...rnd])}`);
  if (describeTransition({ kind: "fade", durMs: 1250, advClick: false, advAfterMs: 3000 }) !== "Fade · 1.25 s · advance after 3 s") f.push(describeTransition({ kind: "fade", durMs: 1250, advClick: false, advAfterMs: 3000 }));
  for (const k of ["fsfx-fly", "fsfx-wipe", "fstr-in", "fstr-clip-out", "prefers-reduced-motion"]) if (!MOTION_CSS.includes(k)) f.push(`css lacks ${k}`);
  // clip-path keyframes must name BOTH ends as inset(): inset() → none is not interpolable (the wipe became a 50 % cut)
  for (const rule of MOTION_CSS.split("\n").filter((l) => l.includes("clip-path"))) if ((rule.match(/clip-path:/g) ?? []).length !== 2 || !/inset\(0 0 0 0\)/.test(rule)) f.push(`clip keyframe lacks an inset() end: ${rule.trim()}`);
  ok(!f.length, f.join("\n"));
  return "hidden-until-built, per-effect start offsets (+ transition offset), wipe clips, exit fill-forwards, back-stepping static; push/pull/wipe/split/other/random layers; reduced-motion honoured";
});

/* ================================================================== M5 */
if (want("M5")) await test("M5 deleting an animated shape prunes its effects + build entries (modelled timelines here; opaque + AlternateContent timelines in N15 / N17): nothing dangling, XSD-valid", MOTION, async () => {
  const outs: string[] = []; const srcOf = new Map<string, string>(); let pruned = 0, opaque = 0;
  for (const f of corpus) {
    let d: M.PptxDoc; try { d = await M.readPptxDoc(new Uint8Array(readFileSync(f)), f); } catch { continue; }
    let hit = false;
    for (let i = 0; i < d.slides.length; i++) {
      const a = readAnimations(d.slides[i].xml); if (!a.effects.length && !a.readOnly) continue;
      const ids = shapeIds(d.slides[i].xml); const target = a.effects.find((e) => ids.has(e.spid))?.spid ?? [...ids.keys()][0];
      if (!target) continue; const addr = ids.get(target)!.addr;
      M.deleteShape(d, i, addr); hit = true; pruned++; if (a.readOnly) opaque++;
    }
    if (hit) { const out = join(tmp, `m5-${outs.length}.pptx`); writeFileSync(out, await M.writePptxDoc(d)); outs.push(out); srcOf.set(out, f); }
  }
  const o = ox(outs); const v = xsd(outs); const bad: string[] = [];
  for (const out of outs) {
    const of = o[out]; if (!of || "error" in of) { bad.push(J(of)); continue; }
    for (const [p, s] of Object.entries(of.slides)) if (s.dangling.length) bad.push(`${out} ${p}: dangling ${J(s.dangling)}`);
    const e = newXsdErrors(out, srcOf.get(out)!, v); if (e.length) bad.push(`${out} XSD (new) ${e[0]}`);
    if (of.pptx_ok !== true) bad.push(`${out} python-pptx ${of.pptx_ok}`);
  }
  ok(!bad.length, bad.slice(0, 8).join("\n"));
  ok(pruned >= 20, `only ${pruned} deletions`);
  return `${pruned} animated shapes deleted across ${outs.length} decks (${opaque} on opaque timelines): no dangling targets, XSD-valid, python-pptx opens`;
});

/* ================================================================== L1 (CA-02) */
const CAST = { "CA-02": "full", "FF-23": "full" } as const;
if (want("L1")) await test("L1 presenter ↔ audience link (CA-02): real BroadcastChannel round trip delivers the deck + states + nav; hostile / malformed messages are dropped", CAST, async () => {
  const sid = newSid(); ok(sidOk(sid) && sid !== newSid(), "session ids");
  const pres = channelPort(sid), aud = channelPort(sid), other = channelPort(newSid());
  const got: ShowMsg[] = [], back: ShowMsg[] = [], leak: ShowMsg[] = [];
  aud.onmsg = (m) => got.push(m); pres.onmsg = (m) => back.push(m); other.onmsg = (m) => leak.push(m);
  const bytes = new Uint8Array(readFileSync(join(CORPUS, "SampleShow.pptx")));
  aud.send({ t: "hello", rid: newSid() });
  pres.send({ t: "deck", name: "SampleShow.pptx", bytes, slides: 2 });
  pres.send({ t: "state", s: { i: 1, done: 2, animate: true, key: 7, from: 0 } });
  aud.send({ t: "nav", dir: "next" }); pres.send({ t: "end" });
  // hostile senders on the same channel: raw postMessage of junk
  const raw = new BroadcastChannel(`fusion-show-${sid}`);
  for (const junk of [null, 5, "x", { t: "state", s: { i: -1, done: 0, animate: true, key: 0, from: null } }, { t: "state", s: { i: 0, done: 0, animate: "yes", key: 0, from: null } }, { t: "deck", name: "a", bytes: new Uint8Array(30), slides: 1 }, { t: "deck", name: "a".repeat(400), bytes, slides: 1 }, { t: "nav", dir: "up" }, { t: "hello", rid: "../etc" }, { t: "eval", code: "1" }, { t: "state", s: { i: 1e9, done: 0, animate: false, key: 0, from: null } }]) raw.postMessage(junk);
  await new Promise((r) => setTimeout(r, 300));
  raw.close(); pres.close(); aud.close(); other.close();
  ok(J(got.map((m) => m.t)) === J(["deck", "state", "end"]), `audience got ${J(got.map((m) => m.t))}`);
  const deck = got[0] as Extract<ShowMsg, { t: "deck" }>; ok(deck.bytes.length === bytes.length && deck.bytes[100] === bytes[100], "deck bytes intact");
  ok(J((got[1] as Extract<ShowMsg, { t: "state" }>).s) === J({ i: 1, done: 2, animate: true, key: 7, from: 0 }), "state");
  ok(J(back.map((m) => m.t)) === J(["hello", "nav"]), `presenter got ${J(back.map((m) => m.t))}`);
  ok(!leak.length, "another session received messages");
  // the text transport (Presentation API frames): round trip + garbage
  const rt = decodeText(encodeText({ t: "deck", name: "d.pptx", bytes, slides: 2 })) as Extract<ShowMsg, { t: "deck" }>; ok(rt?.bytes.length === bytes.length, "text deck round trip");
  for (const g of ["", "{", '{"t":"deck","name":"x","bytes":"%%%","slides":1}', '{"t":"state","s":{"i":0,"done":0,"animate":false,"key":0,"from":"0"}}', '[1,2]']) ok(decodeText(g) === null, `garbage accepted: ${g}`);
  ok(parseShowMsg({ t: "state", s: { i: 0, done: 0, animate: false, key: 0, from: null, extra: "<script>" } }) !== null && !("extra" in (parseShowMsg({ t: "state", s: { i: 0, done: 0, animate: false, key: 0, from: null, extra: 1 } }) as { s: object }).s), "unknown keys are stripped");
  let threw = false; try { channelPort("not-a-sid"); } catch { threw = true; } ok(threw, "bad sid accepted");
  return "deck (bytes intact) + state + end reach the audience, hello + nav reach the presenter, other sessions isolated; 11 hostile messages and 5 garbage text frames dropped";
});

/* ================================================================== N */
if (want("N")) await test("N1–N17 negative shapes for transitions / animations", MOTION, async () => {
  const out: string[] = []; const fails: string[] = [];
  const t = async (id: string, f: () => unknown) => { try { const r = await f(); out.push(`${id} ${typeof r === "string" ? r : "ok"}`); } catch (e) { fails.push(`${id}: ${(e as Error).message}`); } };
  const SL = (body: string) => parseXml(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="A"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/></p:sp></p:spTree></p:cSld>${body}</p:sld>`);
  // N1 garbage durations / timings are ignored, never NaN
  await t("N1", () => { const x = readTransition(SL('<p:transition spd="warp" advTm="-5" advClick="maybe"><p:fade/></p:transition>')); ok(x.durMs === 500 && x.advAfterMs === undefined && x.advClick === true, J(x)); });
  // N2 p14:dur garbage falls back to the Fallback's spd
  await t("N2", () => { const x = readTransition(SL('<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition spd="slow" p14:dur="1e9x"><p:fade/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>')); ok(x.durMs === 1000, J(x)); });
  // N3 a p14-only transition plays as its Fallback kind and keeps its element name
  await t("N3", () => { const x = readTransition(SL('<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14"><p:transition p14:dur="2000"><p14:vortex dir="r"/></p:transition></mc:Choice><mc:Fallback><p:transition><p:wipe dir="r"/></p:transition></mc:Fallback></mc:AlternateContent>')); ok(x.kind === "other" && x.name === "p14:vortex" && x.playsAs === "wipe" && x.durMs === 2000, J(x)); });
  // N4 diagonal cover is kept ("other"), not misread as a straight one
  await t("N4", () => { const x = readTransition(SL('<p:transition><p:cover dir="lu"/></p:transition>')); ok(x.kind === "other" && x.playsAs === "cover", J(x)); });
  // N5 a timing tree without tmRoot / mainSeq is read-only and editing refuses (kept verbatim)
  await t("N5", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const s = M.mutSlide(d, 0); s.xml.root.kids.push(parseXml('<p:timing xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tnLst><p:par><p:cTn id="1"/></p:par></p:tnLst></p:timing>').root); ok(readAnimations(d.slides[0].xml).readOnly, "not read-only"); let threw = false; try { setAnimations(d, 0, []); } catch { threw = true; } ok(threw, "editing a read-only timeline must refuse"); });
  // N6 an effect for a shape that does not exist is dropped on write (never dangling)
  await t("N6", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const a = M.addShape(d, 0, "rect", { x: 0, y: 0, cx: 9e5, cy: 9e5 }); const id = [...shapeIds(d.slides[0].xml)].find(([, v]) => v.addr === a)![0]; setAnimations(d, 0, [{ spid: "999", kind: "fade", trigger: "click", delayMs: 0, durMs: 500 }, { spid: id, kind: "fade", trigger: "click", delayMs: 0, durMs: 500 }]); ok(J(readAnimations(d.slides[0].xml).effects.map((e) => e.spid)) === J([id]), "dangling kept"); });
  // N7 attribute injection through a spid is escaped
  await t("N7", () => { const x = timingXml({ effects: [{ spid: '2"/><p:evil x="', kind: "fade", trigger: "click", delayMs: 0, durMs: 500 }], readOnly: false, extra: [], bld: [] }, () => false)!; ok(!x.includes("<p:evil") && x.includes("&quot;"), x.slice(0, 200)); parseXml(`<r xmlns:p="p">${x}</r>`); });
  // N8 absurd durations / delays are clamped to PowerPoint's 59 s; Appear has no duration
  await t("N8", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const a = M.addShape(d, 0, "rect", { x: 0, y: 0, cx: 9e5, cy: 9e5 }); const id = [...shapeIds(d.slides[0].xml)].find(([, v]) => v.addr === a)![0]; setAnimations(d, 0, [{ spid: id, kind: "fade", trigger: "click", delayMs: 1e12, durMs: -5 }, { spid: id, kind: "appear", trigger: "click", delayMs: NaN, durMs: 9e9 }]); const e = readAnimations(d.slides[0].xml).effects; ok(e[0].delayMs === 59000 && e[0].durMs === 10 && e[1].durMs === 0 && e[1].delayMs === 0, J(e)); });
  // N9 hostile nesting depth in a timing tree → reader refuses or reads, never throws out of the API
  await t("N9", () => { const deep = "<p:par><p:cTn id=\"9\"><p:childTnLst>".repeat(400) + "</p:childTnLst></p:cTn></p:par>".repeat(400); let x: ReturnType<typeof readAnimations> | null = null; try { x = readAnimations(SL(`<p:timing><p:tnLst><p:par><p:cTn id="1" nodeType="tmRoot"><p:childTnLst><p:seq><p:cTn id="2" nodeType="mainSeq"><p:childTnLst>${deep}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`)); } catch (e) { ok(/depth/i.test((e as Error).message), (e as Error).message); return "parser depth limit"; } ok(x, "no result"); return `effects ${x.effects.length}`; });
  // N10 setTransition "other" on a slide without one refuses; "none" removes an AlternateContent transition entirely
  await t("N10", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); let threw = false; try { setTransition(d, 0, { kind: "other", durMs: 500, advClick: true }); } catch { threw = true; } ok(threw, "other without transition"); setTransition(d, 0, { kind: "fade", durMs: 800, advClick: true }); setTransition(d, 0, { kind: "none", durMs: 0, advClick: true }); ok(!serializeXml(d.slides[0].xml).includes("AlternateContent"), "AC left behind"); });
  // N11 re-emitting twice is stable (idempotent serialisation, ids renumbered from 1)
  await t("N11", async () => { const f = join(CORPUS, "2411-Performance_Up.pptx"); const d = await M.readPptxDoc(new Uint8Array(readFileSync(f)), f); const i = d.slides.findIndex((s) => readAnimations(s.xml).effects.length); ok(i >= 0, "no animated slide"); setAnimations(d, i, readAnimations(d.slides[i].xml).effects); const x1 = serializeXml(d.slides[i].xml); setAnimations(d, i, readAnimations(d.slides[i].xml).effects); ok(serializeXml(d.slides[i].xml) === x1, "not idempotent"); });
  // N12 the transition goes before p:timing / p:extLst (schema order), not after
  await t("N12", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const a = M.addShape(d, 0, "rect", { x: 0, y: 0, cx: 9e5, cy: 9e5 }); const id = [...shapeIds(d.slides[0].xml)].find(([, v]) => v.addr === a)![0]; setAnimations(d, 0, [{ spid: id, kind: "fade", trigger: "click", delayMs: 0, durMs: 500 }]); setTransition(d, 0, { kind: "push", dir: "l", durMs: 500, advClick: true }); const x = serializeXml(d.slides[0].xml); ok(x.indexOf("AlternateContent") < x.indexOf("<p:timing"), "order"); });
  // N13 interactive (trigger) sequences survive an edit of the main sequence
  await t("N13", () => { const x = SL('<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst/></p:cTn></p:seq><p:seq concurrent="1" nextAc="seek"><p:cTn id="3" restart="whenNotActive" fill="hold" evtFilter="cancelBubble" nodeType="interactiveSeq"><p:stCondLst><p:cond evt="onClick" delay="0"><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cond></p:stCondLst><p:childTnLst/></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'); const a = readAnimations(x); ok(!a.readOnly && a.extra.length === 1, J(a)); const xml = timingXml({ ...a, effects: [{ spid: "2", kind: "fade", trigger: "click", delayMs: 0, durMs: 500 }] }, () => true)!; ok(xml.includes("interactiveSeq"), "interactive sequence lost"); });
  // N14 pruneTiming on a slide whose shapes all exist changes nothing
  await t("N14", async () => { const f = join(CORPUS, "2411-Performance_Up.pptx"); const d = await M.readPptxDoc(new Uint8Array(readFileSync(f)), f); const s = d.slides.find((q) => readAnimations(q.xml).effects.length)!; const before = serializeXml(s.xml); ok(!pruneTiming(s.xml) && serializeXml(s.xml) === before, "changed"); });
  // N15 opaque timeline (no tmRoot): deleting the target prunes the enclosing p:par only, other shapes' effects remain
  await t("N15", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const a1 = M.addShape(d, 0, "rect", { x: 0, y: 0, cx: 9e5, cy: 9e5 }); const a2 = M.addShape(d, 0, "ellipse", { x: 1e6, y: 0, cx: 9e5, cy: 9e5 }); const m = [...shapeIds(d.slides[0].xml)]; const ids = [a1, a2].map((ad) => m.find(([, v]) => v.addr === ad)![0]); const s = M.mutSlide(d, 0);
    const par = (id: string, n: number) => `<p:par><p:cTn id="${n}"><p:childTnLst><p:set><p:cBhvr><p:cTn id="${n + 50}" dur="1"/><p:tgtEl><p:spTgt spid="${id}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par>`;
    s.xml.root.kids.push(parseXml(`<p:timing xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:tnLst><p:par><p:cTn id="1"><p:childTnLst>${par(ids[0], 2)}${par(ids[1], 3)}</p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="${ids[0]}" grpId="0"/></p:bldLst></p:timing>`).root);
    ok(readAnimations(d.slides[0].xml).readOnly, "should be opaque"); M.deleteShape(d, 0, a1); const x = serializeXml(d.slides[0].xml);
    ok(!x.includes(`spid="${ids[0]}"`) && x.includes(`spid="${ids[1]}"`), x.slice(x.indexOf("<p:timing"))); });
  // N16 a build entry alone (no effect) for a deleted shape is pruned too; deleting the last target removes p:timing entirely
  await t("N16", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const a = M.addShape(d, 0, "textbox", { x: 0, y: 0, cx: 9e5, cy: 9e5 }, "Hi"); const id = [...shapeIds(d.slides[0].xml)].find(([, v]) => v.addr === a)![0]; setAnimations(d, 0, [{ spid: id, kind: "fly", from: "b", trigger: "click", delayMs: 0, durMs: 500 }]); ok(serializeXml(d.slides[0].xml).includes("<p:bldP"), "text shape gets a bldP"); M.deleteShape(d, 0, a); ok(!serializeXml(d.slides[0].xml).includes("p:timing"), "timing left behind"); });
  // N17 (second-order) p:timing wrapped in mc:AlternateContent: read-only (no second timing is ever added); deleting the target prunes every branch
  await t("N17", async () => { const d = await M.readPptxDoc(await M.blankPptx("x"), "x.pptx"); const a1 = M.addShape(d, 0, "rect", { x: 0, y: 0, cx: 9e5, cy: 9e5 }); const a2 = M.addShape(d, 0, "ellipse", { x: 1e6, y: 0, cx: 9e5, cy: 9e5 }); const m = [...shapeIds(d.slides[0].xml)]; const [i1, i2] = [a1, a2].map((ad) => m.find(([, v]) => v.addr === ad)![0]);
    const tm = (ids: string[]) => `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${ids.map((id, n) => `<p:par><p:cTn id="${10 + n}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${20 + n}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${30 + n}" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="${40 + n}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${id}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`).join("")}</p:childTnLst></p:cTn></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`;
    const s = M.mutSlide(d, 0); s.xml.root.kids.push(parseXml(`<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">${tm([i1, i2])}</mc:Choice><mc:Fallback>${tm([i1, i2])}</mc:Fallback></mc:AlternateContent>`).root);
    ok(readAnimations(d.slides[0].xml).readOnly, "AC timing must be read-only"); let threw = false; try { setAnimations(d, 0, []); } catch { threw = true; } ok(threw, "edit refused");
    M.deleteShape(d, 0, a1); let x = serializeXml(d.slides[0].xml); ok(!x.includes(`spid="${i1}"`) && (x.match(new RegExp(`spid="${i2}"`, "g")) ?? []).length === 2, "both branches pruned, other target kept");
    M.deleteShape(d, 0, M.shapeKids(M.spTreeOf(d.slides[0].xml)).findIndex((e) => M.cNvPrOf(e) && (M.cNvPrOf(e)!.attrs.find((q) => q[0] === "id")?.[1] === i2)).toString()); x = serializeXml(d.slides[0].xml); ok(!x.includes("p:timing") && !x.includes("AlternateContent"), "empty AC timing removed");
    const f = join(tmp, "n17.pptx"); writeFileSync(f, await M.writePptxDoc(d)); ok(!xsdErr(xsd([f])[f]).length, "XSD"); });
  console.log("  " + out.join("\n  "));
  ok(!fails.length, fails.join("\n"));
  return `${out.length} negative shapes hold`;
});

finish();
