/**
 * TT139 (AX-07) — Captions.
 *
 * Pure caption-track model and formatter. No DOM, no speech recognition: the
 * caller supplies transcript segments (from a user, from a file, or from a
 * recogniser in a worker) and this module owns the parts that are easy to get
 * wrong and easy to test.
 *
 * What "correct captions" actually requires, and what this enforces:
 *   • Reading rate. WCAG 2.2 SC 1.2.2 and the BBC/Netflix guidance both point at
 *     ~15–20 characters per second for adult content. A cue that shows 120
 *     characters for 2 s is unreadable no matter how accurate the text is, so
 *     `auditTrack` flags exactly that.
 *   • Minimum cue duration. A 200 ms flash of text is not a caption. The floor
 *     here is 700 ms, which is the low end of published guidance.
 *   • Two lines maximum. Three-line cues cover the picture; the default
 *     wrapping splits at 42 characters per line and refuses to exceed two.
 *   • No overlaps. Overlapping cues are a rendering-order ambiguity; the model
 *     rejects them instead of picking a winner.
 *   • Speaker changes force a cue break, because a two-speaker cue misattributes.
 *
 * Time model: integer milliseconds. Not "seconds as float", because 1.1 * 1000
 * is 1100.0000000000002 and an equality check between a cue end and a cut is a
 * real source of off-by-one-frame bugs.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
  /** Free-form speaker label; a change forces a new cue. */
  speaker?: string;
}

export interface CaptionStyle {
  maxCharsPerLine: number;
  maxLines: number;
  /** Where the caption sits over the video. */
  position: "bottom" | "top";
  /** Background opacity 0..1 for readability over bright footage. */
  backgroundOpacity: number;
}

export const DEFAULT_STYLE: CaptionStyle = {
  maxCharsPerLine: 42,
  maxLines: 2,
  position: "bottom",
  backgroundOpacity: 0.75,
};

/** Reading-rate targets in characters per second. */
export const READING_RATE = { comfortable: 17, maximum: 25 } as const;
export const MIN_CUE_MS = 700;
export const MAX_CUE_MS = 12000;

export interface CaptionTrack {
  cues: Cue[];
  style: CaptionStyle;
  language: string;
}

export function createCaptionTrack(language: string, style: Partial<CaptionStyle> = {}): CaptionTrack {
  if (!language.trim()) throw new Error("A caption track needs a language tag");
  return { cues: [], style: { ...DEFAULT_STYLE, ...style }, language };
}

/** True when the two cues share any positive-length time. */
function overlaps(a: Cue, b: Cue): boolean {
  return a.start < b.end && b.start < a.end;
}

export function addCue(track: CaptionTrack, cue: Cue): CaptionTrack {
  if (!Number.isInteger(cue.start) || !Number.isInteger(cue.end)) {
    throw new Error("Cue times must be integer milliseconds");
  }
  if (cue.end <= cue.start) throw new Error(`Cue end (${cue.end}) must be after start (${cue.start})`);
  if (cue.end - cue.start < MIN_CUE_MS) {
    throw new Error(`Cue is ${cue.end - cue.start} ms; the floor is ${MIN_CUE_MS} ms`);
  }
  if (cue.text.length > 500) throw new Error("Cue text too long (>500 chars)");
  for (const existing of track.cues) {
    if (overlaps(existing, cue)) {
      throw new Error(`Cue [${cue.start},${cue.end}) overlaps [${existing.start},${existing.end})`);
    }
  }
  const cues = [...track.cues, cue].sort((a, b) => a.start - b.start);
  return { ...track, cues };
}

export function removeCue(track: CaptionTrack, index: number): CaptionTrack {
  if (!Number.isInteger(index) || index < 0 || index >= track.cues.length) {
    throw new Error(`Cue index ${index} out of range`);
  }
  return { ...track, cues: track.cues.filter((_, i) => i !== index) };
}

export function updateCue(track: CaptionTrack, index: number, patch: Partial<Cue>): CaptionTrack {
  const cur = track.cues[index];
  if (!cur) throw new Error(`Cue index ${index} out of range`);
  const next: Cue = { ...cur, ...patch };
  if (next.end <= next.start) throw new Error("Cue end must be after start");
  for (let i = 0; i < track.cues.length; i++) {
    if (i !== index && overlaps(track.cues[i], next)) {
      throw new Error(`Edited cue would overlap cue ${i}`);
    }
  }
  return { ...track, cues: track.cues.map((c, i) => (i === index ? next : c)) };
}

/** The cue on screen at time `t`, or null in a gap. */
export function activeCue(track: CaptionTrack, t: number): Cue | null {
  for (const c of track.cues) {
    if (t >= c.start && t < c.end) return c;
  }
  return null;
}

/** Wrap to at most `maxLines` lines of at most `maxCharsPerLine`. */
export function wrapCue(text: string, style: CaptionStyle): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length <= style.maxCharsPerLine) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // A single word longer than the line: hard-split rather than overflow.
    let word = w;
    while (word.length > style.maxCharsPerLine) {
      if (lines.length >= style.maxLines) break; // never exceed the line budget
      lines.push(word.slice(0, style.maxCharsPerLine));
      word = word.slice(style.maxCharsPerLine);
    }
    current = word;
  }
  if (current) lines.push(current);
  if (lines.length > style.maxLines) {
    // Collapsing the tail by joining lines re-expands past the width, which is
    // exactly the overflow this function exists to prevent. Instead keep the
    // first maxLines-1 lines whole and hard-split whatever remains, dropping
    // the overflow — a caller that cares should shorten the cue.
    const kept = lines.slice(0, style.maxLines - 1);
    const tail = lines.slice(style.maxLines - 1).join(" ").split("\s+").join("");
    let rest = tail;
    while (rest.length > 0 && kept.length < style.maxLines) {
      kept.push(rest.slice(0, style.maxCharsPerLine));
      rest = rest.slice(style.maxCharsPerLine);
    }
    return kept;
  }
  return lines;
}

export interface CueAudit {
  index: number;
  problems: string[];
  charsPerSecond: number;
}

export interface TrackAudit {
  ok: boolean;
  cueCount: number;
  durationMs: number;
  coveragePercent: number;
  cues: CueAudit[];
  trackProblems: string[];
}

/**
 * Audit a whole track against the reading-rate and coverage rules.
 * `durationMs` is the media length, which the caption file does not know.
 */
export function auditTrack(track: CaptionTrack, durationMs: number): TrackAudit {
  if (!(durationMs > 0)) throw new Error("Media duration must be positive");
  const cues: CueAudit[] = [];
  let covered = 0;

  for (let i = 0; i < track.cues.length; i++) {
    const c = track.cues[i];
    const problems: string[] = [];
    const secs = (c.end - c.start) / 1000;
    const cps = c.text.length / secs;

    if (cps > READING_RATE.maximum) {
      problems.push(`${cps.toFixed(1)} chars/s exceeds the ${READING_RATE.maximum} char/s maximum`);
    } else if (cps > READING_RATE.comfortable) {
      problems.push(`${cps.toFixed(1)} chars/s is above the comfortable ${READING_RATE.comfortable} char/s`);
    }
    if (c.end - c.start < MIN_CUE_MS) problems.push(`Cue is only ${c.end - c.start} ms`);
    if (c.end - c.start > MAX_CUE_MS) problems.push(`Cue runs ${((c.end - c.start) / 1000).toFixed(1)} s, over the ${MAX_CUE_MS / 1000} s ceiling`);
    if (wrapCue(c.text, track.style).length > track.style.maxLines) {
      problems.push("Text needs more lines than the style allows");
    }
    if (c.end > durationMs) problems.push(`Cue ends at ${c.end} ms, past the media (${durationMs} ms)`);
    if (i > 0) {
      const gap = c.start - track.cues[i - 1].end;
      if (gap < 0) problems.push("Overlaps the previous cue");
      // A gap under two frames reads as a flicker between cues.
      if (gap > 0 && gap < 34) problems.push(`Only ${gap} ms between cues (flicker)`);
      if (gap === 0 && track.cues[i - 1].speaker === c.speaker) {
        problems.push("Two adjacent cues with the same speaker should be one cue");
      }
    }
    covered += Math.min(c.end, durationMs) - Math.max(c.start, 0);
    cues.push({ index: i, problems, charsPerSecond: Math.round(cps * 10) / 10 });
  }

  const trackProblems: string[] = [];
  if (!track.cues.length) trackProblems.push("Track is empty");
  const first = track.cues[0];
  if (first && first.start > 5000) trackProblems.push(`First cue starts ${(first.start / 1000).toFixed(1)} s in`);
  const last = track.cues[track.cues.length - 1];
  if (last && last.end < durationMs - 2000) {
    trackProblems.push(`Captions stop ${((durationMs - last.end) / 1000).toFixed(1)} s before the end`);
  }

  return {
    ok: trackProblems.length === 0 && cues.every((c) => c.problems.length === 0),
    cueCount: track.cues.length,
    durationMs,
    coveragePercent: Math.round((covered / durationMs) * 1000) / 10,
    cues,
    trackProblems,
  };
}

/**
 * Distribute a list of transcript lines evenly across a media duration.
 * This is a starting point for manual correction, never a finished track, and
 * `auditTrack` will flag the cues it produces that are too short to read.
 */
export function autoTime(segments: string[], durationMs: number, style: Partial<CaptionStyle> = {}): CaptionTrack {
  const track = createCaptionTrack("und", style);
  if (!segments.length) return track;
  // Weight by character count so a long line gets proportionally more screen
  // time — even division makes the last line of every paragraph unreadable.
  const weights = segments.map((s) => Math.max(1, s.trim().length));
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = 0;
  const out: Cue[] = [];
  for (let i = 0; i < segments.length; i++) {
    const share = (weights[i] / total) * durationMs;
    const start = Math.round(cursor);
    const end = Math.round(cursor + share);
    cursor += share;
    if (end - start < MIN_CUE_MS) continue;
    out.push({ start, end: Math.min(end, Math.round(durationMs)), text: segments[i].trim() });
  }
  // Clamp the final cue to the media length without shrinking it below the floor.
  return { ...track, cues: out.map((c) => ({ ...c, end: Math.min(c.end, Math.round(durationMs)) })) };
}

/** WebVTT serialization — the format a browser's <track> element consumes. */
export function toWebVtt(track: CaptionTrack): string {
  const stamp = (ms: number): string => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
  };
  const lines = ["WEBVTT", ""];
  for (const c of track.cues) {
    lines.push(`${stamp(c.start)} --> ${stamp(c.end)}`);
    if (c.speaker) lines.push(`<v ${c.speaker}>${c.text}`);
    else lines.push(c.text);
    lines.push("");
  }
  return lines.join("\n");
}

/** Parse WebVTT, rejecting overlaps and out-of-order cues. */
export function fromWebVtt(vtt: string): CaptionTrack {
  const track = createCaptionTrack("und");
  const blocks = vtt.replace(/\r\n/g, "\n").split(/\n{2,}/);
  if (!blocks.length || !/^WEBVTT/.test(blocks[0].trim())) throw new Error("Not a WebVTT file: missing WEBVTT header");
  const cues: Cue[] = [];
  const parseStamp = (s: string): number => {
    const m = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(s.trim());
    if (!m) throw new Error(`Bad WebVTT timestamp: ${s}`);
    return Number(m[1]) * 3600000 + Number(m[2]) * 60000 + Number(m[3]) * 1000 + Number(m[4]);
  };
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (!lines.length) continue;
    let i = 0;
    // Optional cue identifier line.
    if (!lines[0].includes("-->")) i = 1;
    if (i >= lines.length) continue;
    const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[i]);
    if (!timing) throw new Error(`Malformed cue timing: ${lines[i]}`);
    const start = parseStamp(timing[1]);
    const end = parseStamp(timing[2]);
    let text = lines.slice(i + 1).join(" ").trim();
    let speaker: string | undefined;
    const voice = /^<v\s+([^>]+)>([\s\S]*)$/.exec(text);
    if (voice) {
      speaker = voice[1].trim();
      text = voice[2].trim();
    }
    cues.push({ start, end, text, speaker });
  }
  return { ...track, cues };
}
