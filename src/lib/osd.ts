/**
 * TT56 (NC-06) — on-screen display bus. Producers call showOsd(); the single <OsdLayer> in the shell renders a transient
 * pill and announces the SETTLED value once through an aria-live=polite region (a burst of 20 volume steps is one
 * announcement, not twenty). Pure helpers are exported for the unit test.
 */
export type OsdKind = "volume" | "text" | "layout" | "focus" | "workspace" | "theme";
export interface OsdEvent { kind: OsdKind; label: string; value?: number; at: number }
type Fn = (e: OsdEvent) => void;
const subs = new Set<Fn>();
export function showOsd(kind: OsdKind, label: string, value?: number) {
  const e: OsdEvent = { kind, label, value: value === undefined ? undefined : Math.max(0, Math.min(100, value)), at: Date.now() };
  for (const f of subs) f(e);
}
export function onOsd(f: Fn): () => void { subs.add(f); return () => { subs.delete(f); }; }
/** Settle delay before the live region speaks: long enough to swallow a key-repeat / slider drag burst. */
export const OSD_SETTLE_MS = 600;
/** How long the pill stays after the last event. */
export const OSD_VISIBLE_MS = 1600;
export const volumeLabel = (v: number, muted: boolean) => (muted || v <= 0 ? "Muted" : `Volume ${Math.round(v * 100)}%`);
/**
 * Debounce model used by the layer (and its unit test): given event times, the announcement times are the instants where
 * OSD_SETTLE_MS passed without a newer event.
 */
export function announceTimes(times: number[], settle = OSD_SETTLE_MS): number[] {
  const out: number[] = [];
  const t = [...times].sort((a, b) => a - b);
  for (let i = 0; i < t.length; i++) if (i === t.length - 1 || t[i + 1] - t[i] >= settle) out.push(t[i] + settle);
  return out;
}
