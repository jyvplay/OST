/** IE-01: before/after compare. While the compare control is held the
 *  ORIGINAL pixels are shown — the edit recipe is bypassed, not undone,
 *  so releasing returns to the edit exactly as it was. */
export function shownFx<T>(edited: T, original: T, holding: boolean): T {
  return holding ? original : edited;
}
