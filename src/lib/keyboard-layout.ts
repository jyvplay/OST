"use client";

import { useSyncExternalStore } from "react";
import { BINDING_CODES, chordLabel, learnLayoutPair, mergeLayoutPair } from "./shortcuts";

/**
 * TT67 IN-03: the user's keyboard layout, for labelling physical-key chords.
 *
 * Two sources, merged:
 *  1. navigator.keyboard.getLayoutMap() (Keyboard Map API: Chromium-based browsers, top-level secure contexts). It is
 *     re-read whenever the page regains focus, because the user may have switched layouts in another app.
 *  2. Pairs observed from real unmodified keydowns (learnLayoutPair): the only source in Firefox / Safari, and the
 *     freshest one everywhere, so an observed pair overrides the API's value for its key.
 *
 * Privacy: only the keys some shortcut uses are ever recorded (BINDING_CODES, a dozen letters and punctuation keys),
 * never from password fields, only as code → character (no order, no timing, no text), in memory only — nothing is
 * persisted or sent anywhere.
 */
type KbApi = { getLayoutMap?: () => Promise<Map<string, string>> };
let apiMap: Map<string, string> | null = null;
const seen = new Map<string, string>();
let version = 0;
const subs = new Set<() => void>();
const emit = () => { version++; for (const f of [...subs]) f(); };

export function layoutLookup(code: string): string | undefined {
  return seen.get(code) ?? apiMap?.get(code);
}
export const layoutSource = (): "observed" | "api" | "api+observed" | "none" =>
  apiMap && seen.size ? "api+observed" : apiMap ? "api" : seen.size ? "observed" : "none";

async function readApi(): Promise<void> {
  const kb = (navigator as Navigator & { keyboard?: KbApi }).keyboard;
  if (!kb?.getLayoutMap) return;
  try {
    const m = await kb.getLayoutMap();
    const next = new Map<string, string>();
    m.forEach((v, k) => { next.set(k, v); });
    const before = apiMap ? JSON.stringify([...apiMap]) : "";
    apiMap = next;
    // an API answer newer than an observation of the same key replaces it (layout switched while we were away)
    for (const [c, v] of [...seen]) if (next.has(c) && next.get(c) !== v) seen.delete(c);
    if (JSON.stringify([...next]) !== before) emit();
  } catch { /* not allowed here (iframe / insecure context): rely on observations */ }
}

let started = 0;
let stopFn: (() => void) | null = null;
/** Start watching (ref-counted; the Shell calls it once). */
export function startLayoutWatch(): () => void {
  started++;
  if (started === 1) {
    void readApi();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLInputElement | null;
      const secret = !!t && t.tagName === "INPUT" && (t.type === "password" || t.autocomplete === "one-time-code");
      const pair = learnLayoutPair(e, secret, BINDING_CODES);
      if (pair && mergeLayoutPair(seen, pair)) emit();
    };
    const onFocus = () => { void readApi(); };
    window.addEventListener("keydown", onKey, { capture: true, passive: true });
    window.addEventListener("focus", onFocus);
    stopFn = () => { window.removeEventListener("keydown", onKey, { capture: true }); window.removeEventListener("focus", onFocus); };
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    started--;
    if (started === 0) { stopFn?.(); stopFn = null; }
  };
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Re-renders when the layout table changes; returns a labeller for chords. */
export function useChordLabel(): (chord: string) => string {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return (chord: string) => chordLabel(chord, layoutLookup);
}
