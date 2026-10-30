/** MD-12: A–B loop segment. Clicking cycles A → B → off; B cannot land
 *  before A (it re-sets A instead). While a segment is armed, playback
 *  that reaches B jumps back to A — the seek is returned, never applied
 *  silently, so the player's time stays the single source of truth. */
export interface AbState { a: number | null; b: number | null }
export function nextAbState(ab: AbState, t: number): AbState {
  if (ab.a !== null && ab.b !== null) return { a: null, b: null };
  if (ab.a === null) return { a: t, b: null };
  if (t <= ab.a) return { a: t, b: null };
  return { a: ab.a, b: t };
}
export function abLoopSeek(ab: AbState, t: number): number | null {
  if (ab.a === null || ab.b === null) return null;
  return t >= ab.b - 0.05 ? ab.a : null;
}
export const abLabel = (ab: AbState): string => ab.a === null ? "A–B loop" : ab.b === null ? `A ${fmt(ab.a)} set — press for B` : `A–B ${fmt(ab.a)}–${fmt(ab.b)}`;
const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
