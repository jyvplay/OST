/** PK-01: Peek's fact sheet for one VFS node. Text facts reuse wc counting
 *  (Editor/Terminal agree); binary nodes report encoding instead of
 *  pretending to have lines. The short digest is display-only. */
import { wc } from "./wc-core";
export interface NodeFacts { path: string; mime: string; size: number; encoding: string; content?: string; sha256?: string }
export interface Facts { kind: "text" | "binary"; lines: number | null; words: number | null; shortSha: string | null }
export function fileFacts(n: NodeFacts): Facts {
  const shortSha = n.sha256 ? n.sha256.slice(0, 12) : null;
  if (n.encoding === "base64" || n.content === undefined) return { kind: "binary", lines: null, words: null, shortSha };
  const c = wc(n.content);
  return { kind: "text", lines: c.lines, words: c.words, shortSha };
}
