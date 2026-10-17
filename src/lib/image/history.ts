/**
 * Snapshot undo history with a byte budget (TT16). Documents are immutable at the layer level and share
 * unchanged pixel buffers, so a snapshot costs only the buffers that differ from its neighbour. The budget counts
 * unique buffers across all retained states (Set by identity), not states × size.
 * Inspired by the competitor's 14-line generic history (limit by count); this one bounds memory as well.
 */
export interface History<T> { past: T[]; present: T; future: T[] }

export function createHistory<T>(present: T): History<T> { return { past: [], present, future: [] }; }

export function pushHistory<T>(h: History<T>, next: T, opts: { maxStates?: number; maxBytes?: number; sizeOf?: (all: T[]) => number } = {}): History<T> {
  if (next === h.present) return h;
  let past = [...h.past, h.present];
  const maxStates = opts.maxStates ?? 50;
  while (past.length > maxStates) past = past.slice(1);
  if (opts.maxBytes && opts.sizeOf) while (past.length > 1 && opts.sizeOf([...past, next]) > opts.maxBytes) past = past.slice(1);
  return { past, present: next, future: [] };
}
export function undoHistory<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}
export function redoHistory<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

/** Unique-buffer byte count over a set of image documents (shared buffers counted once). */
export function uniqueBufferBytes(docs: { layers: { data: Uint8ClampedArray; mask?: Uint8ClampedArray }[] }[]): number {
  const seen = new Set<ArrayBufferLike>();
  let n = 0;
  for (const d of docs) for (const l of d.layers) for (const b of [l.data, l.mask]) {
    if (!b || seen.has(b.buffer)) continue;
    seen.add(b.buffer); n += b.byteLength;
  }
  return n;
}
