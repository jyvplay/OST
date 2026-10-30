/** CK-06: stopwatch laps as text. Splits are computed from cumulative lap
 *  times (what the UI lists), fastest split marked; the format matches the
 *  on-screen mm:ss.mmm so pasted laps read identically. */
export function lapsText(cumulativeMs: number[]): string {
  if (!cumulativeMs.length) return "(no laps)";
  let prev = 0;
  const splits = cumulativeMs.map((t) => { const s = t - prev; prev = t; return s; });
  const fastest = Math.min(...splits);
  const fmt = (ms: number) => { const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), r = Math.floor(ms % 1000); return `${m}:${String(s).padStart(2, "0")}.${String(r).padStart(3, "0")}`; };
  return splits.map((s, i) => `lap ${i + 1}: ${fmt(s)}${s === fastest && splits.length > 1 ? " (fastest)" : ""}`).join("\n");
}
