/**
 * TT139 (PR-13) — diff engine v2: Myers O((N+M)·D) shortest edit script.
 *
 * The Editor's version history and the Backup compare view both diff text. The
 * previous implementation built the full LCS table, which is O(N·M) time and
 * memory: two 4 000-line documents allocated a 16 M-cell number array (≈128 MB)
 * before producing a single op. That is not a "slow path", it is a window-killer
 * on a phone.
 *
 * This version implements Myers' greedy algorithm with a linear-space trace over
 * the edit-distance frontier, so the cost is proportional to the *distance*
 * between the documents rather than to their size. Two consequences matter:
 *
 *  - Identical or nearly-identical documents (the overwhelmingly common case in
 *    autosave/version history) finish in time proportional to the changed lines.
 *  - The worst case is bounded by an explicit `maxD` budget. When the budget is
 *    exhausted the diff does not silently degrade into "everything changed":
 *    it reports `truncated: true` and the *common prefix/suffix* it has already
 *    proven, so the caller can still show an honest "too different to align"
 *    state instead of a wrong one.
 *
 * Word-level diff reuses the same engine over token spans, with the same budget.
 */

export type EditOp = { kind: "same" | "del" | "add"; text: string; /** 0-based index in the old/new side */ oldIndex?: number; newIndex?: number };
export type DiffResult = { ops: EditOp[]; truncated: boolean; distance: number; oldLines: number; newLines: number };
export type DiffOptions = { maxD?: number; maxTokens?: number };

export const DIFF_DEFAULT_MAX_D = 2_000;
export const DIFF_DEFAULT_MAX_TOKENS = 200_000;

/** Lines, keeping the trailing-newline fact explicit so "a\n" ≠ "a". */
export function splitLines(text: string): string[] {
  const t = String(text).replace(/\r\n?/g, "\n");
  if (t === "") return [];
  const parts = t.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Myers diff over two arrays. Returns ops in document order.
 *
 * Implementation note: this is the classic "trace" variant. We record the V
 * array after each d, then walk the trace backwards to recover the edit script.
 * Memory is O(d²) in the recorded trace — bounded by maxD, and far below the
 * O(N·M) table for the documents this app actually diffs.
 */
export function diffArrays<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y, opts: DiffOptions = {}): DiffResult {
  const maxD = Math.max(0, opts.maxD ?? DIFF_DEFAULT_MAX_D);
  const N = a.length, M = b.length;
  const max = N + M;
  if (max === 0) return { ops: [], truncated: false, distance: 0, oldLines: 0, newLines: 0 };

  // Common prefix/suffix: free progress, and it keeps V small for edits that are
  // local (nearly every real edit).
  let prefix = 0;
  while (prefix < N && prefix < M && eq(a[prefix], b[prefix])) prefix++;
  let suffix = 0;
  while (suffix < N - prefix && suffix < M - prefix && eq(a[N - 1 - suffix], b[M - 1 - suffix])) suffix++;

  const aMid = a.slice(prefix, N - suffix), bMid = b.slice(prefix, M - suffix);
  const n = aMid.length, m = bMid.length;
  const offset = maxD + 1;
  const size = 2 * offset + 1;
  let v = new Int32Array(size).fill(-1);
  const trace: Int32Array[] = [];
  const limit = Math.min(maxD, n + m);
  let foundD = -1;

  for (let d = 0; d <= limit; d++) {
    const snapshot = v.slice();
    trace.push(snapshot);
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset;
      if (idx < 0 || idx >= size) continue;
      let x: number;
      if (k === -d || (k !== d && (v[idx - 1] ?? -1) < (v[idx + 1] ?? -1))) x = v[idx + 1] ?? 0;
      else x = (v[idx - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && eq(aMid[x], bMid[y])) { x++; y++; }
      v[idx] = x;
      if (x >= n && y >= m) { foundD = d; break; }
    }
    if (foundD >= 0) break;
  }

  const ops: EditOp[] = [];
  for (let i = 0; i < prefix; i++) ops.push({ kind: "same", text: String(a[i]), oldIndex: i, newIndex: i });

  if (foundD < 0) {
    // Budget exhausted: emit the proven prefix/suffix and mark the middle.
    for (let i = 0; i < n; i++) ops.push({ kind: "del", text: String(aMid[i]), oldIndex: prefix + i });
    for (let j = 0; j < m; j++) ops.push({ kind: "add", text: String(bMid[j]), newIndex: prefix + j });
    for (let k = suffix - 1; k >= 0; k--) {
      const oi = N - 1 - k, ni = M - 1 - k;
      ops.push({ kind: "same", text: String(a[oi]), oldIndex: oi, newIndex: ni });
    }
    return { ops: orderOps(ops), truncated: true, distance: n + m, oldLines: N, newLines: M };
  }

  // Walk the trace backwards.
  const rev: EditOp[] = [];
  let x = n, y = m;
  for (let d = foundD; d > 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    const idx = k + offset;
    const prevK = k === -d || (k !== d && (vPrev[idx - 1] ?? -1) < (vPrev[idx + 1] ?? -1)) ? k + 1 : k - 1;
    const prevX = vPrev[prevK + offset] ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--; y--;
      rev.push({ kind: "same", text: String(aMid[x]), oldIndex: prefix + x, newIndex: prefix + y });
    }
    if (x === prevX) { y--; rev.push({ kind: "add", text: String(bMid[y]), newIndex: prefix + y }); }
    else { x--; rev.push({ kind: "del", text: String(aMid[x]), oldIndex: prefix + x }); }
  }
  while (x > 0 && y > 0) { x--; y--; rev.push({ kind: "same", text: String(aMid[x]), oldIndex: prefix + x, newIndex: prefix + y }); }
  while (x > 0) { x--; rev.push({ kind: "del", text: String(aMid[x]), oldIndex: prefix + x }); }
  while (y > 0) { y--; rev.push({ kind: "add", text: String(bMid[y]), newIndex: prefix + y }); }
  rev.reverse();

  for (const op of rev) ops.push(op);
  for (let k = 0; k < suffix; k++) {
    const oi = N - suffix + k, ni = M - suffix + k;
    ops.push({ kind: "same", text: String(a[oi]), oldIndex: oi, newIndex: ni });
  }
  return { ops: orderOps(ops), truncated: false, distance: foundD, oldLines: N, newLines: M };
}

/** Group consecutive del/add runs so the renderer can show them as one hunk. */
function orderOps(ops: EditOp[]): EditOp[] {
  const out: EditOp[] = [];
  let dels: EditOp[] = [], adds: EditOp[] = [];
  const flush = () => { out.push(...dels, ...adds); dels = []; adds = []; };
  for (const op of ops) {
    if (op.kind === "del") dels.push(op);
    else if (op.kind === "add") adds.push(op);
    else { flush(); out.push(op); }
  }
  flush();
  return out;
}

export function diffLinesText(oldText: string, newText: string, opts: DiffOptions = {}): DiffResult {
  const a = splitLines(oldText), b = splitLines(newText);
  if (a.length + b.length > (opts.maxTokens ?? DIFF_DEFAULT_MAX_TOKENS)) {
    return { ops: [...a.map((t, i) => ({ kind: "del" as const, text: t, oldIndex: i })), ...b.map((t, i) => ({ kind: "add" as const, text: t, newIndex: i }))], truncated: true, distance: a.length + b.length, oldLines: a.length, newLines: b.length };
  }
  return diffArrays(a, b, (p, q) => p === q, opts);
}

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; ops: EditOp[] };

/** Unified-diff hunks with `context` unchanged lines around each change. */
export function toHunks(result: DiffResult, context = 3): Hunk[] {
  const ops = result.ops;
  const changed: number[] = [];
  ops.forEach((o, i) => { if (o.kind !== "same") changed.push(i); });
  if (!changed.length) return [];
  const windows: [number, number][] = [];
  for (const i of changed) {
    const start = Math.max(0, i - context), end = Math.min(ops.length - 1, i + context);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }
  return windows.map(([s, e]) => {
    const slice = ops.slice(s, e + 1);
    const firstOld = slice.find((o) => o.oldIndex !== undefined)?.oldIndex ?? 0;
    const firstNew = slice.find((o) => o.newIndex !== undefined)?.newIndex ?? 0;
    return {
      oldStart: firstOld, oldLines: slice.filter((o) => o.kind !== "add").length,
      newStart: firstNew, newLines: slice.filter((o) => o.kind !== "del").length,
      ops: slice,
    };
  });
}

/** Standard unified diff text (`-u` style), for export/copy. */
export function toUnified(result: DiffResult, opts: { oldName?: string; newName?: string; context?: number } = {}): string {
  const hunks = toHunks(result, opts.context ?? 3);
  if (!hunks.length) return "";
  const out: string[] = [`--- ${opts.oldName ?? "a"}`, `+++ ${opts.newName ?? "b"}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart + 1},${h.oldLines} +${h.newStart + 1},${h.newLines} @@`);
    for (const op of h.ops) out.push(`${op.kind === "same" ? " " : op.kind === "del" ? "-" : "+"}${op.text}`);
  }
  return `${out.join("\n")}\n`;
}

/** Tokenise for word diff: words, whitespace runs and single punctuation marks. */
export function wordTokens(line: string): string[] {
  return line.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? [];
}

export function diffWords(oldLine: string, newLine: string, opts: DiffOptions = {}): DiffResult {
  return diffArrays(wordTokens(oldLine), wordTokens(newLine), (p, q) => p === q, { maxD: 400, ...opts });
}

export function diffStats(result: DiffResult): { added: number; removed: number; unchanged: number } {
  let added = 0, removed = 0, unchanged = 0;
  for (const o of result.ops) { if (o.kind === "add") added++; else if (o.kind === "del") removed++; else unchanged++; }
  return { added, removed, unchanged };
}

/**
 * Three-way merge (diff3 shape). A change block is a maximal run of non-"same"
 * ops over the base document. Two blocks conflict when their base ranges
 * intersect, or when one is a pure insertion at a position another block
 * replaces — the same conservatism real diff3 has, stated instead of guessed.
 *
 * A merge that cannot prove disjointness reports a conflict; it never writes a
 * plausible-looking file that silently dropped one side's edit.
 */
export type MergeBlock = { start: number; end: number; lines: string[] };
export type MergeConflict = { oldStart: number; oldEnd: number; ours: string; theirs: string };

function blocksFrom(result: DiffResult): MergeBlock[] {
  const blocks: MergeBlock[] = [];
  let cursor = 0;
  let cur: MergeBlock | null = null;
  for (const op of result.ops) {
    if (op.kind === "same") { cur = null; cursor++; }
    else if (op.kind === "del") {
      if (!cur) { cur = { start: cursor, end: cursor, lines: [] }; blocks.push(cur); }
      cur.end = cursor + 1; cursor++;
    } else {
      if (!cur) { cur = { start: cursor, end: cursor, lines: [] }; blocks.push(cur); }
      cur.lines.push(op.text);
    }
  }
  return blocks;
}

function overlaps(a: MergeBlock, b: MergeBlock): boolean {
  const aPoint = a.start === a.end, bPoint = b.start === b.end;
  if (aPoint && bPoint) return a.start === b.start && a.lines.join("\n") !== b.lines.join("\n");
  if (aPoint) return a.start >= b.start && a.start <= b.end;
  if (bPoint) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

export function mergeThreeWay(base: string, ours: string, theirs: string): { text: string; conflicts: MergeConflict[] } {
  const baseLines = splitLines(base);
  const ob = blocksFrom(diffLinesText(base, ours));
  const tb = blocksFrom(diffLinesText(base, theirs));
  const conflicts: MergeConflict[] = [];
  for (const o of ob) for (const t of tb) {
    if (!overlaps(o, t)) continue;
    if (o.lines.join("\n") === t.lines.join("\n") && o.start === t.start && o.end === t.end) continue; // identical edit
    conflicts.push({ oldStart: o.start, oldEnd: o.end, ours: o.lines.join("\n"), theirs: t.lines.join("\n") });
  }
  const out: string[] = [];
  const tag = (bs: MergeBlock[], side: "ours" | "theirs") => bs.map((b) => ({ b, side }));
  const all = [...tag(ob, "ours"), ...tag(tb, "theirs")].sort((x, y) => x.b.start - y.b.start || x.b.end - y.b.end || (x.side === "ours" ? -1 : 1));
  for (let line = 0; line <= baseLines.length; line++) {
    // pure insertions at this position; identical text from both sides is emitted once
    const points = all.filter((x) => x.b.start === line && x.b.end === line);
    if (points.length) {
      const first = points[0].b.lines;
      out.push(...first);
      for (const p of points.slice(1)) if (p.b.lines.join("\n") !== first.join("\n")) out.push(...p.b.lines);
    }
    if (line === baseLines.length) break;
    const covering = all.find((x) => x.b.start <= line && line < x.b.end);
    if (covering) { if (line === covering.b.start) out.push(...covering.b.lines); }
    else out.push(baseLines[line]);
  }
  return { text: out.join("\n"), conflicts };
}
