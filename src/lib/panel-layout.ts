/**
 * TT143 (SH-13 / WM-07) — real virtualised panels, sized from a measurement.
 *
 * A panel with 40 000 rows must scroll at 60 fps on two cores, which means neither
 * "render everything" nor "guess a row height". The engine therefore takes the
 * measured height of one real row and derives the rest:
 *
 *   · rows are variable-height, kept in a **prefix-sum index** so `offsetOf(i)` and
 *     `indexAt(y)` are O(log n) instead of O(n); the index is rebuilt only when a
 *     row's height actually changes, and an unchanged rebuild is a no-op;
 *   · the window is computed with one screen of overscan on each side, so a fast
 *     flick does not show blank rows;
 *   · heights are clamped to a sane range and a measured height of 0 (a row that
 *     has not laid out) keeps its previous estimate instead of collapsing the
 *     index — the classic "everything jumps on mount" bug;
 *   · the sticky row (a header) is reported separately, because it must not be
 *     virtualised away.
 *
 * Everything is a value: the caller measured, the engine computes. That is what
 * lets the whole layout be tested with synthetic measurements at 100 000 rows in
 * milliseconds, instead of with a browser and a stopwatch.
 */

export interface Layout { heights: number[]; offsets: number[]; total: number }
export const MIN_ROW = 18;
export const MAX_ROW = 320;

/** Build a prefix-sum index. `estimate` fills rows that have never been measured. */
export function buildLayout(count: number, estimate: number, measured: ReadonlyMap<number, number> = new Map()): Layout {
  const h = new Array<number>(count);
  const offsets = new Array<number>(count + 1);
  let y = 0;
  for (let i = 0; i < count; i++) {
    const m = measured.get(i);
    h[i] = m != null && m > 0 ? clamp(m) : clamp(estimate);
    offsets[i] = y;
    y += h[i];
  }
  offsets[count] = y;
  return { heights: h, offsets, total: y };
}

/** Update one measured height; returns the same object when nothing changed. */
export function setHeight(layout: Layout, index: number, height: number): Layout {
  if (index < 0 || index >= layout.heights.length) return layout;
  const next = clamp(height);
  if (next === layout.heights[index]) return layout;
  const heights = [...layout.heights];
  heights[index] = next;
  const offsets = [...layout.offsets];
  for (let i = index; i < heights.length; i++) {
    offsets[i + 1] = offsets[i] + heights[i];
  }
  return { heights, offsets, total: offsets[heights.length] };
}

/** The visible window plus overscan. `first`/`last` are inclusive. */
export function windowFor(layout: Layout, scrollTop: number, viewportHeight: number, overscan = 1): { first: number; last: number; padTop: number; padBottom: number } {
  if (layout.heights.length === 0) return { first: 0, last: -1, padTop: 0, padBottom: 0 };
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  let first = indexAt(layout, top);
  let last = indexAt(layout, bottom);
  first = Math.max(0, first - Math.max(1, overscan));
  last = Math.min(layout.heights.length - 1, last + Math.max(1, overscan));
  return { first, last, padTop: layout.offsets[first], padBottom: layout.total - layout.offsets[last + 1] };
}

/** Binary search: the index whose row contains `y`. O(log n). */
export function indexAt(layout: Layout, y: number): number {
  const { offsets } = layout;
  let lo = 0, hi = layout.heights.length - 1;
  if (hi < 0) return 0;
  if (y <= 0) return 0;
  if (y >= layout.total) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * The sticky header's offset for the given scroll position: it pins until the
 * section it belongs to has scrolled past, then is pushed out by the next one.
 */
export function stickyOffset(layout: Layout, sectionStarts: readonly number[], scrollTop: number, headerHeight: number): { index: number; translateY: number } {
  if (!sectionStarts.length) return { index: 0, translateY: 0 };
  let current = 0;
  for (let i = 0; i < sectionStarts.length; i++) {
    const y = layout.offsets[sectionStarts[i]] ?? 0;
    if (y <= scrollTop + 0.5) current = i; else break;
  }
  const nextY = sectionStarts[current + 1] != null ? layout.offsets[sectionStarts[current + 1]] : Infinity;
  const push = Math.min(0, nextY - scrollTop - headerHeight);
  return { index: current, translateY: push };
}

const clamp = (n: number) => Math.max(MIN_ROW, Math.min(MAX_ROW, Math.round(n)));

/** A one-line report for the perf panel: how much of the list is actually mounted. */
export function mountRatio(layout: Layout, view: { first: number; last: number }): string {
  const mounted = Math.max(0, view.last - view.first + 1);
  const pct = layout.heights.length ? (mounted / layout.heights.length) * 100 : 0;
  return `${mounted} of ${layout.heights.length} rows mounted (${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%), ${Math.round(layout.total)} px of content`;
}
