/** TT118 DF-01 — text diff for Editor versions.
 * Line diff by longest common subsequence over lines (dynamic programming;
 * inputs are capped so the O(n·m) table stays bounded — a version diff in the
 * Editor is at most a few thousand lines, and beyond the cap we refuse rather
 * than freeze the window). Changed line pairs are then word-diffed so a one-word
 * edit reads as one word, not two whole lines. Output ops are in document order. */
export type DiffOp = { kind: "same" | "add" | "del"; text: string };
export const DIFF_LINE_CAP = 4000;

function lcsTable(a: string[], b: string[]): number[][] {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return t;
}
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = String(oldText).split("\n"), b = String(newText).split("\n");
  if (a.length > DIFF_LINE_CAP || b.length > DIFF_LINE_CAP) throw new Error(`diff is limited to ${DIFF_LINE_CAP} lines per side`);
  const t = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) { ops.push({ kind: "del", text: a[i] }); i++; }
    else { ops.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ kind: "del", text: a[i++] });
  while (j < b.length) ops.push({ kind: "add", text: b[j++] });
  return ops;
}
export function diffStats(ops: DiffOp[]): { added: number; removed: number; unchanged: number } {
  return { added: ops.filter((o) => o.kind === "add").length, removed: ops.filter((o) => o.kind === "del").length, unchanged: ops.filter((o) => o.kind === "same").length };
}
/** Word-level diff of one changed pair, for display inside the line diff. */
export function diffWords(oldLine: string, newLine: string): DiffOp[] {
  const a = String(oldLine).split(/(\s+)/), b = String(newLine).split(/(\s+)/);
  const t = lcsTable(a, b);
  const ops: DiffOp[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) { ops.push({ kind: "del", text: a[i] }); i++; }
    else { ops.push({ kind: "add", text: b[j] }); j++; }
  }
  while (i < a.length) ops.push({ kind: "del", text: a[i++] });
  while (j < b.length) ops.push({ kind: "add", text: b[j++] });
  return ops;
}
