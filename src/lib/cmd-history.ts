/** TM-06: terminal command history (session ring). Consecutive repeats
 *  collapse (the usual shell behaviour); the cap drops the oldest, and
 *  `history` output is numbered from 1 like the shells it mirrors. */
export const CMD_HISTORY_MAX = 100;
export function pushCommand(hist: string[], cmd: string): string[] {
  const c = cmd.trim();
  if (!c) return hist;
  if (hist[hist.length - 1] === c) return hist;
  return [...hist, c].slice(-CMD_HISTORY_MAX);
}
export function historyText(hist: string[]): string {
  return hist.map((c, i) => `${String(i + 1).padStart(3)}  ${c}`).join("\n");
}
