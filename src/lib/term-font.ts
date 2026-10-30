/** SSH-01: terminal font-size ladder. Clamped to a readable range; the
 *  step functions snap so +/- buttons never land on fractional sizes
 *  the renderer would round unpredictably. */
export const TERM_FONT_MIN = 10, TERM_FONT_MAX = 22;
export const clampTermFont = (n: number): number => Math.min(TERM_FONT_MAX, Math.max(TERM_FONT_MIN, Math.round(n) || 13));
export const stepTermFont = (n: number, dir: 1 | -1): number => clampTermFont(clampTermFont(n) + dir);
