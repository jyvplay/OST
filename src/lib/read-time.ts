/** TT125 WR-02: reading time at a stated adult silent-reading rate (238 wpm,
 *  the mean of the meta-analytic range); always rounded UP to a whole minute
 *  and never below one minute for a non-empty document. */
export const READING_WPM = 238;
export function readingMinutes(words: number, wpm: number = READING_WPM): number {
  if (words <= 0) return 0;
  return Math.max(1, Math.ceil(words / wpm));
}
export function readingTimeText(words: number, wpm: number = READING_WPM): string {
  const m = readingMinutes(words, wpm);
  if (!m) return "no words yet";
  return `≈ ${m} min read at ${wpm} wpm`;
}
