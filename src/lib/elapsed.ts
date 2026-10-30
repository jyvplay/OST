/** BM-01: session elapsed time. Formatted from a start instant against
 *  a supplied now (the component ticks), never from a accumulated
 *  counter, so a suspended tab cannot drift the displayed duration. */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
