/**
 * Fusion Voice — a formant speech synthesiser (TT32). Original code: no speech library, no recorded voice, no model.
 *
 * Pipeline: phones (ARPAbet symbols with stress digits, word / phrase marks) → segments with durations → per-frame
 * acoustic parameters (F0, voicing / aspiration / frication amplitudes, formant frequencies + bandwidths, parallel
 * fricative amplitudes) smoothed into continuous tracks → a sample-by-sample source-filter model:
 *   - voicing: a glottal flow DERIVATIVE pulse (derivative of x² − x³ over the open phase, abrupt closure) at F0;
 *   - aspiration and frication: deterministic white noise (seeded PRNG, so output is reproducible);
 *   - cascade branch: nasal pole/zero pair, then five second-order resonators F5 → F1 (vowels, sonorants, /h/);
 *   - parallel branch: frication noise through resonators F2..F6 with their own amplitudes + a flat bypass.
 * Resonator: y[n] = A·x[n] + B·y[n−1] + C·y[n−2], C = −e^(−2πBT), B = 2e^(−πBT)·cos(2πFT), A = 1 − B − C.
 * Vowel formant targets are average adult measurements (Peterson & Barney 1952 style data — facts, not code).
 */

export type PhoneClass = "vowel" | "diph" | "glide" | "liquid" | "nasal" | "stop" | "fric" | "affric" | "aspirate" | "pause";

interface PhoneSpec {
  c: PhoneClass;
  /** inherent and minimum duration, ms */
  d: number; dmin: number;
  voiced: boolean;
  /** formant targets F1..F3 (Hz); for diphthongs `to` is the end target */
  f: [number, number, number]; to?: [number, number, number];
  /** for consonants: place locus for F2/F3 transitions (stops / fricatives / nasals) */
  locus?: [number, number, number];
  /** parallel fricative amplitudes in dB for F2..F6 resonators + bypass (frication / burst spectrum) */
  par?: [number, number, number, number, number, number];
  /** frication amplitude dB */
  af?: number;
  nasal?: boolean;
}

const V = (f1: number, f2: number, f3: number, d: number, dmin: number, to?: [number, number, number]): PhoneSpec =>
  ({ c: to ? "diph" : "vowel", d, dmin, voiced: true, f: [f1, f2, f3], to });

export const PHONES: Record<string, PhoneSpec> = {
  // vowels (adult male averages)
  IY: V(280, 2250, 2950, 155, 55), IH: V(400, 1920, 2560, 135, 40), EH: V(550, 1770, 2490, 150, 70),
  AE: V(690, 1660, 2490, 230, 80), AA: V(730, 1100, 2440, 240, 100), AO: V(590, 880, 2540, 240, 100),
  UH: V(450, 1030, 2380, 160, 60), UW: V(310, 900, 2250, 210, 70), AH: V(620, 1220, 2550, 140, 60),
  ER: V(470, 1350, 1690, 180, 80), AX: V(500, 1450, 2500, 110, 50),
  EY: V(480, 1850, 2550, 190, 100, [330, 2200, 2800]), AY: V(720, 1250, 2500, 250, 150, [400, 1950, 2600]),
  OW: V(540, 1000, 2400, 220, 80, [440, 850, 2350]), AW: V(720, 1300, 2500, 260, 100, [450, 950, 2300]),
  OY: V(560, 880, 2450, 280, 150, [400, 1900, 2600]),
  // glides / liquids
  W: { c: "glide", d: 80, dmin: 60, voiced: true, f: [290, 650, 2200] },
  Y: { c: "glide", d: 80, dmin: 60, voiced: true, f: [260, 2100, 3000] },
  R: { c: "liquid", d: 80, dmin: 30, voiced: true, f: [330, 1100, 1450] },
  L: { c: "liquid", d: 80, dmin: 40, voiced: true, f: [330, 1050, 2800] },
  // nasals (murmur formants + a nasal zero), locus for the transition into / out of the vowel
  M: { c: "nasal", d: 70, dmin: 50, voiced: true, f: [270, 1100, 2150], locus: [270, 900, 2150], nasal: true },
  N: { c: "nasal", d: 60, dmin: 35, voiced: true, f: [270, 1500, 2550], locus: [270, 1700, 2600], nasal: true },
  NG: { c: "nasal", d: 95, dmin: 60, voiced: true, f: [270, 2050, 2700], locus: [270, 2000, 2700], nasal: true },
  // stops: locus (F1 at closure is low) + burst spectrum (dB for F2..F6 resonators, bypass)
  P: { c: "stop", d: 90, dmin: 50, voiced: false, f: [200, 900, 2300], locus: [200, 850, 2300], par: [0, 0, 0, 0, 0, 58], af: 126 },
  B: { c: "stop", d: 85, dmin: 60, voiced: true, f: [200, 900, 2300], locus: [200, 850, 2300], par: [0, 0, 0, 0, 0, 56], af: 118 },
  T: { c: "stop", d: 75, dmin: 50, voiced: false, f: [200, 1750, 2700], locus: [200, 1800, 2750], par: [0, 0, 30, 52, 60, 0], af: 86 },
  D: { c: "stop", d: 75, dmin: 50, voiced: true, f: [200, 1750, 2700], locus: [200, 1800, 2750], par: [0, 0, 28, 48, 56, 0], af: 82 },
  K: { c: "stop", d: 80, dmin: 60, voiced: false, f: [200, 1900, 2400], locus: [200, 1950, 2350], par: [58, 44, 30, 0, 0, 0], af: 99 },
  G: { c: "stop", d: 80, dmin: 60, voiced: true, f: [200, 1900, 2400], locus: [200, 1950, 2350], par: [56, 40, 26, 0, 0, 0], af: 91 },
  // fricatives
  F: { c: "fric", d: 100, dmin: 80, voiced: false, f: [340, 1100, 2100], locus: [340, 900, 2200], par: [0, 0, 0, 0, 0, 54], af: 86 },
  V: { c: "fric", d: 60, dmin: 40, voiced: true, f: [220, 1100, 2100], locus: [220, 900, 2200], par: [0, 0, 0, 0, 0, 50], af: 52 },
  TH: { c: "fric", d: 80, dmin: 60, voiced: false, f: [320, 1400, 2200], locus: [320, 1450, 2550], par: [0, 0, 0, 30, 38, 48], af: 73 },
  DH: { c: "fric", d: 50, dmin: 30, voiced: true, f: [270, 1300, 2500], locus: [270, 1450, 2550], par: [0, 0, 0, 28, 36, 44], af: 46 },
  S: { c: "fric", d: 105, dmin: 60, voiced: false, f: [320, 1400, 2700], locus: [320, 1700, 2700], par: [0, 0, 0, 34, 62, 0], af: 67 },
  Z: { c: "fric", d: 75, dmin: 40, voiced: true, f: [240, 1400, 2700], locus: [240, 1700, 2700], par: [0, 0, 0, 30, 56, 0], af: 65 },
  SH: { c: "fric", d: 105, dmin: 80, voiced: false, f: [300, 1840, 2750], locus: [300, 1900, 2400], par: [0, 56, 60, 52, 40, 0], af: 76 },
  ZH: { c: "fric", d: 70, dmin: 40, voiced: true, f: [300, 1840, 2750], locus: [300, 1900, 2400], par: [0, 50, 54, 46, 34, 0], af: 68 },
  HH: { c: "aspirate", d: 80, dmin: 20, voiced: false, f: [500, 1500, 2500] },
  CH: { c: "affric", d: 70, dmin: 50, voiced: false, f: [300, 1840, 2750], locus: [300, 1900, 2400], par: [0, 56, 60, 52, 40, 0], af: 76 },
  JH: { c: "affric", d: 70, dmin: 50, voiced: true, f: [300, 1840, 2750], locus: [300, 1900, 2400], par: [0, 50, 54, 46, 34, 0], af: 71 },
  _: { c: "pause", d: 200, dmin: 200, voiced: false, f: [500, 1500, 2500] },
};

export interface VoiceOpts {
  /** sample rate (Hz); 16 kHz default (speech band, small buffers) */
  sr?: number;
  /** speaking rate multiplier (1 = normal, 2 = twice as fast) */
  rate?: number;
  /** base pitch in Hz (default 112) */
  pitch?: number;
  /** formant scale (1 = adult male; ~1.15 for a higher, lighter voice) */
  formant?: number;
  /** pitch range multiplier for accents (default 1) */
  range?: number;
}

/** a phone token: symbol (ARPAbet, stress digit on vowels), plus word / phrase information */
export interface PhoneTok { p: string; stress?: 0 | 1 | 2; wordEnd?: boolean; wordStart?: boolean }
/** a phrase: phones + the boundary that ends it (statement fall, question rise, comma continuation) */
export interface Phrase { phones: PhoneTok[]; end: "." | "?" | "," | "!" | "" }

/** a timed segment produced by the duration rules */
export interface Segment {
  p: string; spec: PhoneSpec; t0: number; t1: number; stress: number;
  /** sub-phase for stops / affricates: closure | burst | aspiration | fric */
  part?: "closure" | "burst" | "asp" | "fric" | "murmur";
  prevVowel?: string; nextVowel?: string; wordEnd?: boolean; phraseFinal?: boolean;
  /** the consonant immediately before (for coarticulation such as /u/-fronting) */
  prevCons?: string;
}

const isVowel = (p: string) => { const c = PHONES[p]?.c; return c === "vowel" || c === "diph"; };
export const baseOf = (p: string) => p.replace(/[0-2]$/, "");

/** Duration rules (ms): D = Dmin + (Dinh − Dmin)·k, k from stress, position and clustering; then ÷ rate. */
export function segmentPhrase(ph: Phrase, t0: number, rate = 1): { segs: Segment[]; t: number } {
  const segs: Segment[] = [];
  let t = t0;
  const toks = ph.phones.filter((x) => PHONES[baseOf(x.p)]);
  // index of the last vowel (phrase-final lengthening applies to the last syllable)
  let lastV = -1; toks.forEach((x, i) => { if (isVowel(baseOf(x.p))) lastV = i; });
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i], p = baseOf(tk.p), spec = PHONES[p];
    let k = 1;
    const stress = tk.stress ?? (isVowel(p) ? 1 : 0);
    if (isVowel(p)) {
      if (stress === 0) k *= 0.55; else if (stress === 2) k *= 0.8;
      if (!tk.wordEnd && toks.slice(i + 1).some((x, j) => j < 3 && isVowel(baseOf(x.p)))) k *= 0.85; // non-final in word
      const nxt = toks[i + 1] ? baseOf(toks[i + 1].p) : "";
      if (nxt && PHONES[nxt] && !PHONES[nxt].voiced && (PHONES[nxt].c === "stop" || PHONES[nxt].c === "fric")) k *= 0.75; // pre-voiceless shortening
    } else {
      const prev = toks[i - 1] ? baseOf(toks[i - 1].p) : "", nxt = toks[i + 1] ? baseOf(toks[i + 1].p) : "";
      if ((prev && !isVowel(prev) && PHONES[prev].c !== "pause") || (nxt && !isVowel(nxt) && PHONES[nxt].c !== "pause")) k *= 0.75; // cluster
    }
    if (i >= lastV && lastV >= 0 && ph.end) k *= 1.35; // phrase-final lengthening
    const d = (spec.dmin + (spec.d - spec.dmin) * k) / rate;
    const prevVowel = (() => { for (let j = i - 1; j >= 0; j--) { const q = baseOf(toks[j].p); if (isVowel(q)) return q; if (PHONES[q].c === "pause") break; } return undefined; })();
    const nextVowel = (() => { for (let j = i + 1; j < toks.length; j++) { const q = baseOf(toks[j].p); if (isVowel(q)) return q; if (PHONES[q].c === "pause") break; } return undefined; })();
    const pc = i > 0 ? baseOf(toks[i - 1].p) : "";
    const common = { p, spec, stress, prevVowel, nextVowel, wordEnd: tk.wordEnd, phraseFinal: i >= lastV && !!ph.end, prevCons: pc && !isVowel(pc) ? pc : undefined };
    if (spec.c === "stop") {
      const after = toks[i + 1] ? baseOf(toks[i + 1].p) : "";
      const releasedIntoVowel = !!after && (isVowel(after) || PHONES[after].c === "glide" || PHONES[after].c === "liquid");
      const afterS = i > 0 && baseOf(toks[i - 1].p) === "S";
      // burst duration and voice-onset time grow from labial to alveolar to velar (≈ P 58 / T 70 / K 80 ms VOT)
      const place = /^[PB]$/.test(p) ? 0 : /^[TD]$/.test(p) ? 1 : 2;
      const closure = Math.max(35, d * 0.7), burst = [10, 14, 22][place] / Math.sqrt(rate);
      const vot = spec.voiced ? [6, 9, 14][place] : afterS ? 12 : releasedIntoVowel ? [55, 65, 75][place] / Math.sqrt(rate) : 30;
      segs.push({ ...common, t0: t, t1: t + closure, part: "closure" }); t += closure;
      segs.push({ ...common, t0: t, t1: t + burst, part: "burst" }); t += burst;
      segs.push({ ...common, t0: t, t1: t + vot, part: "asp" }); t += vot;
    } else if (spec.c === "affric") {
      const closure = Math.max(30, d * 0.55), fr = d * 0.75;
      segs.push({ ...common, t0: t, t1: t + closure, part: "closure" }); t += closure;
      segs.push({ ...common, t0: t, t1: t + fr, part: "fric" }); t += fr;
    } else {
      segs.push({ ...common, t0: t, t1: t + d }); t += d;
    }
  }
  return { segs, t };
}

/** per-frame acoustic parameters */
export interface Frame {
  f0: number; av: number; ah: number; af: number; avs: number;
  f1: number; f2: number; f3: number; b1: number; b2: number; b3: number;
  /** parallel amplitudes (dB) for F2..F6 resonators + bypass */
  par: [number, number, number, number, number, number];
  nasal: number;
}

const FRAME_MS = 5;
const NO_PAR: Frame["par"] = [0, 0, 0, 0, 0, 0];

/** the formant target a consonant takes next to vowel v: locus + k·(vowel − locus) (k: how much the vowel shows through) */
function locusBlend(spec: PhoneSpec, v: string | undefined, k: number): [number, number, number] {
  const L = spec.locus ?? spec.f;
  if (!v) return L;
  const vf = PHONES[v].f;
  return [L[0], L[1] + k * (vf[1] - L[1]), L[2] + k * (vf[2] - L[2])];
}

/** raw (unsmoothed) parameter targets for time t inside segment s */
function targetAt(s: Segment, t: number): Frame {
  const spec = s.spec, x = s.t1 > s.t0 ? (t - s.t0) / (s.t1 - s.t0) : 0;
  const fr: Frame = { f0: 0, av: 0, ah: 0, af: 0, avs: 0, f1: spec.f[0], f2: spec.f[1], f3: spec.f[2], b1: 80, b2: 100, b3: 160, par: NO_PAR, nasal: 0 };
  switch (spec.c) {
    case "vowel": case "diph": {
      fr.av = s.stress === 0 ? 57 : 60;
      if (spec.to) { const e = Math.min(1, Math.max(0, (x - 0.25) / 0.65)); for (let j = 0; j < 3; j++) (fr as unknown as Record<string, number>)[`f${j + 1}`] = spec.f[j] + e * (spec.to[j] - spec.f[j]); }
      // unstressed AH reduces toward schwa
      if (s.p === "AH" && s.stress === 0) { fr.f1 = 520; fr.f2 = 1400; fr.f3 = 2500; }
      if (s.p === "IH" && s.stress === 0) { fr.f1 = 430; fr.f2 = 1750; }
      // American English /u/ (and /ʊ/) is fronted after coronal consonants ("two", "do", "new", "soon")
      if ((s.p === "UW" || s.p === "UH") && s.prevCons && /^(T|D|S|Z|N|L|TH|DH|SH|ZH|CH|JH|Y)$/.test(s.prevCons)) fr.f2 += s.p === "UW" ? 500 : 300;
      break;
    }
    case "glide": case "liquid":
      fr.av = 55; fr.b1 = 70; fr.b2 = s.p === "L" ? 150 : 90; fr.b3 = 180;
      break;
    case "nasal":
      fr.av = 52; fr.nasal = 1; fr.b1 = 100; fr.b2 = 300; fr.b3 = 300; fr.f1 = 270;
      break;
    case "aspirate": {
      // /h/ takes the following vowel's formants
      const v = s.nextVowel ? PHONES[s.nextVowel].f : spec.f;
      fr.f1 = v[0]; fr.f2 = v[1]; fr.f3 = v[2]; fr.ah = 60; fr.b1 = 500;
      break;
    }
    case "fric": {
      const L = locusBlend(spec, s.nextVowel ?? s.prevVowel, 0.35);
      fr.f1 = L[0]; fr.f2 = L[1]; fr.f3 = L[2];
      fr.af = spec.af ?? 55; fr.par = spec.par ?? NO_PAR;
      if (spec.voiced) { fr.av = 47; fr.avs = 47; }
      break;
    }
    case "stop": case "affric": {
      const L = locusBlend(spec, s.part === "closure" ? (s.prevVowel ?? s.nextVowel) : (s.nextVowel ?? s.prevVowel), 0.3);
      fr.f1 = L[0]; fr.f2 = L[1]; fr.f3 = L[2];
      if (s.part === "closure") { if (spec.voiced) { fr.av = 42; fr.f1 = 180; fr.b1 = 60; } }
      else if (s.part === "burst") { fr.af = (spec.af ?? 58) + (s.wordEnd && !s.nextVowel ? -8 : 0); fr.par = spec.par ?? NO_PAR; if (spec.voiced) fr.av = 44; }
      else if (s.part === "asp") {
        const v = s.nextVowel ? PHONES[s.nextVowel].f : spec.f;
        fr.f1 = 300 + x * (v[0] - 300); fr.f2 = L[1] + x * (v[1] - L[1]); fr.f3 = L[2] + x * (v[2] - L[2]); fr.b1 = spec.voiced ? 200 : 500;
        if (spec.voiced) fr.av = 52; else fr.ah = 68;
      } else if (s.part === "fric") { fr.af = spec.af ?? 60; fr.par = spec.par ?? NO_PAR; if (spec.voiced) { fr.av = 47; fr.avs = 47; } }
      break;
    }
    case "pause": break;
  }
  return fr;
}

/** F0 contour: declining baseline, a rise-fall accent on stressed vowels, phrase-final fall / question rise */
function pitchTrack(segs: Segment[], n: number, opts: Required<VoiceOpts>, end: Phrase["end"], tStart: number, tEnd: number): Float32Array {
  const f0 = new Float32Array(n), base = opts.pitch, R = opts.range;
  const dur = Math.max(1, tEnd - tStart);
  let firstAccent = true;
  const accents: { t: number; h: number; w: number }[] = [];
  for (const s of segs) if ((s.spec.c === "vowel" || s.spec.c === "diph") && s.stress === 1) {
    accents.push({ t: (s.t0 + s.t1) / 2, h: (firstAccent ? 0.24 : 0.14) * base * R, w: Math.max(60, (s.t1 - s.t0) * 0.9) }); firstAccent = false;
  }
  for (let i = 0; i < n; i++) {
    const t = tStart + i * FRAME_MS, x = (t - tStart) / dur;
    let f = base * (1.08 - 0.18 * x);
    for (const a of accents) { const d = (t - a.t) / a.w; f += a.h * Math.exp(-d * d); }
    if (end === "?" && x > 0.75) f += base * 0.45 * R * ((x - 0.75) / 0.25);
    else if ((end === "." || end === "!") && x > 0.8) f -= base * 0.18 * ((x - 0.8) / 0.2);
    else if (end === "," && x > 0.85) f += base * 0.06 * R * ((x - 0.85) / 0.15);
    f0[i] = f;
  }
  return f0;
}

/** one-pole smoothing applied forward and backward (zero phase) with time constant tau ms */
function smooth(a: Float32Array, tau: number) {
  if (tau <= 0) return;
  const k = Math.exp(-FRAME_MS / tau);
  for (let i = 1; i < a.length; i++) a[i] = k * a[i - 1] + (1 - k) * a[i];
  for (let i = a.length - 2; i >= 0; i--) a[i] = k * a[i + 1] + (1 - k) * a[i];
}

/** parameter tracks for a phrase (frames every 5 ms) */
export function phraseFrames(ph: Phrase, opts: Required<VoiceOpts>): { frames: Frame[]; segs: Segment[] } {
  const lead = 30, { segs, t } = segmentPhrase(ph, lead, opts.rate);
  const total = t + (ph.end === "," ? 90 : ph.end ? 160 : 60) / Math.sqrt(opts.rate);
  const n = Math.ceil(total / FRAME_MS);
  const tracks: Record<string, Float32Array> = {};
  const keys = ["av", "ah", "af", "avs", "f1", "f2", "f3", "b1", "b2", "b3", "nasal", "p0", "p1", "p2", "p3", "p4", "p5"] as const;
  for (const k of keys) tracks[k] = new Float32Array(n);
  let si = 0;
  for (let i = 0; i < n; i++) {
    const tm = i * FRAME_MS;
    while (si < segs.length - 1 && segs[si].t1 <= tm) si++;
    const s = segs[si];
    const fr: Frame = s && tm >= s.t0 && tm < s.t1 ? targetAt(s, tm)
      : { f0: 0, av: 0, ah: 0, af: 0, avs: 0, f1: 500, f2: 1500, f3: 2500, b1: 80, b2: 100, b3: 160, par: NO_PAR, nasal: 0 };
    // silence keeps the neighbouring formants (so smoothing does not sweep through a neutral vowel)
    if (!(s && tm >= s.t0 && tm < s.t1) && s) { const near = targetAt(s, Math.min(Math.max(tm, s.t0), s.t1 - 0.01)); fr.f1 = near.f1; fr.f2 = near.f2; fr.f3 = near.f3; }
    tracks.av[i] = fr.av; tracks.ah[i] = fr.ah; tracks.af[i] = fr.af; tracks.avs[i] = fr.avs;
    tracks.f1[i] = fr.f1; tracks.f2[i] = fr.f2; tracks.f3[i] = fr.f3; tracks.b1[i] = fr.b1; tracks.b2[i] = fr.b2; tracks.b3[i] = fr.b3;
    tracks.nasal[i] = fr.nasal; for (let j = 0; j < 6; j++) tracks[`p${j}`][i] = fr.par[j];
  }
  // formants glide (≈ 18 ms), amplitudes switch fast (≈ 4 ms) so bursts and onsets stay crisp
  for (const k of ["f1", "f2", "f3"]) smooth(tracks[k], 16 / Math.sqrt(opts.rate));
  for (const k of ["b1", "b2", "b3", "nasal"]) smooth(tracks[k], 10);
  for (const k of ["av", "ah", "af", "avs"]) smooth(tracks[k], 4);
  // natural phrase envelopes: voicing that starts from silence rises over ~35 ms (an abrupt full-amplitude start is
  // heard as a plosive), and the last voiced stretch decays over ~70 ms instead of stopping dead
  {
    const av = tracks.av, rampOn = Math.round(35 / FRAME_MS), rampOff = Math.round(70 / FRAME_MS);
    const first = av.findIndex((v) => v > 30);
    const sonorantStart = !!segs[0] && /^(vowel|diph|glide|liquid|nasal)$/.test(segs[0].spec.c);
    if (sonorantStart && first >= 0 && (first === 0 || av[first - 1] < 5)) for (let i = 0; i < rampOn && first + i < n; i++) av[first + i] += 20 * Math.log10(Math.max(0.05, (i + 1) / rampOn));
    let last = -1; for (let i = n - 1; i >= 0; i--) if (av[i] > 30) { last = i; break; }
    if (last > 0) for (let i = 0; i < rampOff && last - i >= 0; i++) av[last - i] += 20 * Math.log10(Math.max(0.05, (i + 1) / rampOff));
  }
  const f0 = pitchTrack(segs, n, opts, ph.end, 0, total);
  smooth(f0, 20);
  const frames: Frame[] = [];
  for (let i = 0; i < n; i++) frames.push({
    f0: f0[i], av: tracks.av[i], ah: tracks.ah[i], af: tracks.af[i], avs: tracks.avs[i],
    f1: tracks.f1[i] * opts.formant, f2: tracks.f2[i] * opts.formant, f3: tracks.f3[i] * opts.formant,
    b1: tracks.b1[i], b2: tracks.b2[i], b3: tracks.b3[i], nasal: tracks.nasal[i],
    par: [tracks.p0[i], tracks.p1[i], tracks.p2[i], tracks.p3[i], tracks.p4[i], tracks.p5[i]],
  });
  return { frames, segs };
}

// ---------------------------------------------------------------------------------------------------------------
// waveform generator

class Reso {
  private y1 = 0; private y2 = 0; private a = 1; private b = 0; private c = 0;
  set(f: number, bw: number, sr: number) {
    const T = 1 / sr, r = Math.exp(-Math.PI * bw * T);
    this.c = -r * r; this.b = 2 * r * Math.cos(2 * Math.PI * f * T); this.a = 1 - this.b - this.c;
  }
  run(x: number) { const y = this.a * x + this.b * this.y1 + this.c * this.y2; this.y2 = this.y1; this.y1 = y; return y; }
}
class AntiReso {
  private x1 = 0; private x2 = 0; private a = 1; private b = 0; private c = 0;
  set(f: number, bw: number, sr: number) {
    const T = 1 / sr, r = Math.exp(-Math.PI * bw * T);
    const c = -r * r, b = 2 * r * Math.cos(2 * Math.PI * f * T), a = 1 - b - c;
    this.a = 1 / a; this.b = -b / a; this.c = -c / a;
  }
  run(x: number) { const y = this.a * x + this.b * this.x1 + this.c * this.x2; this.x2 = this.x1; this.x1 = x; return y; }
}

/** deterministic PRNG (mulberry32) so the same text always gives the same samples */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PAR_GAIN = 0.25;
const db = (x: number) => (x <= 0 ? 0 : Math.pow(10, (x - 60) / 20));

/** render frames to samples */
export function renderFrames(frames: Frame[], sr: number, formantScale = 1, seed = 1): Float32Array {
  const spf = Math.round((sr * FRAME_MS) / 1000), out = new Float32Array(frames.length * spf);
  const c1 = new Reso(), c2 = new Reso(), c3 = new Reso(), c4 = new Reso(), c5 = new Reso();
  const np = new Reso(), nz = new AntiReso();
  const p2 = new Reso(), p3 = new Reso(), p4 = new Reso(), p5 = new Reso(), p6 = new Reso();
  const rnd = prng(seed);
  let phase = 0, f0cur = 110, lastNoise = 0, tilt = 0;
  const F4 = 3300 * formantScale, F5 = 3850 * formantScale, F6 = Math.min(4900 * formantScale, sr * 0.45);
  c4.set(F4, 250, sr); c5.set(Math.min(F5, sr * 0.45), 300, sr);
  p2.set(1500, 200, sr); p3.set(2500, 250, sr); p4.set(F4, 300, sr); p5.set(Math.min(F5, sr * 0.45), 400, sr); p6.set(F6, 600, sr);
  const OQ = 0.6;
  let i = 0;
  for (let fi = 0; fi < frames.length; fi++) {
    const a = frames[fi], b = frames[Math.min(fi + 1, frames.length - 1)];
    for (let k = 0; k < spf; k++, i++) {
      const u = k / spf, lerp = (x: number, y: number) => x + (y - x) * u;
      if (k % 8 === 0) {
        c1.set(lerp(a.f1, b.f1), lerp(a.b1, b.b1), sr); c2.set(lerp(a.f2, b.f2), lerp(a.b2, b.b2), sr); c3.set(lerp(a.f3, b.f3), lerp(a.b3, b.b3), sr);
        p2.set(lerp(a.f2, b.f2), 200, sr); p3.set(lerp(a.f3, b.f3), 300, sr);
        const nas = lerp(a.nasal, b.nasal);
        if (nas < 0.02) { np.set(270, 100, sr); nz.set(270, 100, sr); } else { nz.set(270 + 220 * nas, 100, sr); }
      }
      // glottal source (flow derivative), period latched at each cycle start
      const av = db(lerp(a.av, b.av)), ah = db(lerp(a.ah, b.ah)), af = db(lerp(a.af, b.af));
      phase += f0cur / sr;
      if (phase >= 1) { phase -= 1; const target = lerp(a.f0, b.f0) || 110; f0cur = target * (1 + 0.006 * (rnd() - 0.5)); }
      let g = 0;
      if (phase < OQ) { const x = phase / OQ; g = 2 * x - 3 * x * x; }
      // spectral tilt: gentle one-pole low-pass on the source (natural voices fall ~12 dB / octave)
      tilt = 0.25 * tilt + 0.75 * g;
      const noise = rnd() * 2 - 1;
      // aspiration / frication noise is pitch-synchronously modulated when voicing is on
      const mod = av > 0.01 && phase > 0.5 ? 0.5 : 1;
      const hn = noise - lastNoise;
      const src = tilt * av * 6 + (noise * 0.5 + hn * 0.5) * ah * mod * 0.9;
      let c = nz.run(np.run(src));
      c = c1.run(c2.run(c3.run(c4.run(c5.run(c)))));
      // parallel branch: first-differenced frication noise (fricatives are high-frequency) through F2..F6 + bypass
      const fn = hn * af * mod, flat = noise * af * mod * 1.41; // flat (labial / dental) noise, ×√2 = the power the differenced noise had lastNoise = noise;
      const pa = [db(lerp(a.par[0], b.par[0])), db(lerp(a.par[1], b.par[1])), db(lerp(a.par[2], b.par[2])), db(lerp(a.par[3], b.par[3])), db(lerp(a.par[4], b.par[4])), db(lerp(a.par[5], b.par[5]))];
      const par = (p2.run(fn) * pa[0] - p3.run(fn) * pa[1] + p4.run(fn) * pa[2] - p5.run(fn) * pa[3] + p6.run(fn) * pa[4] + flat * pa[5] * 0.15) * PAR_GAIN;
      out[i] = c + par;
    }
  }
  return out;
}

/** normalise to a peak of `peak` and add short fades so there are no clicks */
export function finish(x: Float32Array, sr: number, peak = 0.8): Float32Array {
  let m = 0; for (const v of x) m = Math.max(m, Math.abs(v));
  const g = m > 0 ? peak / m : 0, fade = Math.round(sr * 0.004);
  for (let i = 0; i < x.length; i++) {
    const e = Math.min(1, i / fade, (x.length - 1 - i) / fade);
    x[i] = x[i] * g * e;
  }
  return x;
}

export const DEFAULT_VOICE: Required<VoiceOpts> = { sr: 16000, rate: 1, pitch: 112, formant: 1, range: 1 };

/** synthesise phrases → PCM samples (Float32, −1..1) */
export function synthPhrases(phrases: Phrase[], o: VoiceOpts = {}): Float32Array {
  const opts = { ...DEFAULT_VOICE, ...o };
  const parts: Float32Array[] = [];
  let seed = 7;
  for (const ph of phrases) {
    if (!ph.phones.length) continue;
    const { frames } = phraseFrames(ph, opts);
    parts.push(renderFrames(frames, opts.sr, opts.formant, seed++));
  }
  const len = parts.reduce((s, p) => s + p.length, 0), out = new Float32Array(len);
  let o2 = 0; for (const p of parts) { out.set(p, o2); o2 += p.length; }
  return finish(out, opts.sr);
}

/** 16-bit PCM WAV bytes (mono) */
export function toWav(x: Float32Array, sr: number): Uint8Array {
  const n = x.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return new Uint8Array(buf);
}
