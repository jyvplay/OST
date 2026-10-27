import { allParas, cellsOf, rowsOf, type Block, type Inline, type Para, type WordDoc } from "./wordml";
import { kid } from "./xmltree";
import * as E from "./wordedit";

/**
 * First-party Writer word-count engine (FF-82).
 * - Plain-text tokenization (`countWriterText`): Unicode letters/numbers with internal apostrophes, hyphens and
 *   combining marks (`\p{M}`) stay one word; CJK Unified Ideographs count as one word per ideograph (matching Word and
 *   LibreOffice Writer); character counts use Unicode grapheme clusters (`Intl.Segmenter`) so emoji ZWJ sequences and
 *   combining marks count as what a reader sees.
 * - Model-aware document counting (`countWordDoc`, `countWordRange`): walks the lossless WordprocessingML model
 *   (`WordDoc`), excluding tracked deletions (`w:del` runs, opaque deletions and deleted table rows), inline image
 *   labels/alt-text, field instructions, bookmark/comment anchors, note reference markers, and covered vertical-merge
 *   table cells (`vmerge === "continue"`), while merging paragraphs across deleted paragraph marks (`markRev.kind === "del"`)
 *   and reporting referenced footnotes/endnotes.
 */
export interface WordCounts {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  paragraphs: number;
  lines: number;
}

export interface DocWordCounts extends WordCounts {
  notes: WordCounts;
  withNotes: WordCounts;
}

const WORD_RE = /\p{Unified_Ideograph}|[\p{L}\p{N}](?:(?!\p{Unified_Ideograph})[\p{L}\p{N}\p{M}'’\u2010-\u2013-])*/gu;

function graphemeCount(text: string): number {
  if (typeof Intl.Segmenter === "function") return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  return [...text].length;
}

export function countWriterText(text: string): WordCounts {
  const normalized = text.replace(/\r\n?/g, "\n");
  const visibleText = normalized.replace(/\n/g, "");
  return {
    words: (normalized.match(WORD_RE) ?? []).length,
    characters: graphemeCount(visibleText),
    charactersNoSpaces: graphemeCount(visibleText.replace(/[\s\u00a0]/gu, "")),
    paragraphs: normalized ? normalized.split("\n").filter((p) => p.trim()).length : 0,
    lines: normalized ? normalized.split("\n").length : 0,
  };
}

export function countableInlineText(it: Inline): string {
  if (it.rev?.kind === "del") return "";
  if (it.t === "r") return it.text;
  switch (it.kind) {
    case "page":
    case "column":
      return "\n";
    case "sym":
    case "field":
    case "ins":
    case "box":
    case "math":
      return it.label;
    case "image":
    case "note":
    case "comment":
    case "commentRef":
    case "bookmark":
    case "fieldcode":
    case "del":
    case "other":
    default:
      return "";
  }
}

export function countableParaText(p: Para): string {
  return p.content.map(countableInlineText).join("");
}

function collectBlocksText(blocks: Block[], out: string[]) {
  let pending = "";
  let hasPending = false;
  const flush = () => {
    if (hasPending) {
      out.push(pending);
      pending = "";
      hasPending = false;
    }
  };
  for (const b of blocks) {
    if (b.t === "p") {
      const t = countableParaText(b);
      pending = hasPending ? pending + t : t;
      hasPending = true;
      if (b.markRev?.kind !== "del") flush();
    } else if (b.t === "tbl") {
      flush();
      for (const r of rowsOf(b)) {
        if (r.rev?.kind === "del") continue;
        for (const c of cellsOf(r)) {
          if (c.vmerge === "continue" || (c.tcPr && kid(c.tcPr, "w:cellDel"))) continue;
          collectBlocksText(c.blocks, out);
        }
      }
    } else if (b.t === "box") {
      flush();
      collectBlocksText(b.blocks, out);
    }
  }
  flush();
}

export function countableDocText(doc: WordDoc): string {
  const paras: string[] = [];
  collectBlocksText(doc.blocks, paras);
  return paras.join("\n");
}

export function countableNotesText(doc: WordDoc): string {
  const active = new Set<string>();
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.t === "p") {
        for (const it of b.content) {
          if (it.t === "k" && it.kind === "note" && it.rev?.kind !== "del" && it.note) {
            active.add(`${it.note.type}:${it.note.id}`);
          }
        }
      } else if (b.t === "tbl") {
        for (const r of rowsOf(b)) {
          if (r.rev?.kind === "del") continue;
          for (const c of cellsOf(r)) if (c.vmerge !== "continue") walk(c.blocks);
        }
      } else if (b.t === "box") {
        walk(b.blocks);
      }
    }
  };
  walk(doc.blocks);
  const paras: string[] = [];
  for (const n of doc.notes) {
    if (!active.has(`${n.type}:${n.id}`)) continue;
    collectBlocksText(n.blocks, paras);
  }
  return paras.join("\n");
}

export function countWordDoc(doc: WordDoc): DocWordCounts {
  const bodyText = countableDocText(doc);
  const notesText = countableNotesText(doc);
  const body = countWriterText(bodyText);
  const notes = countWriterText(notesText);
  const combined = notesText ? (bodyText ? `${bodyText}\n${notesText}` : notesText) : bodyText;
  return {
    ...body,
    notes,
    withNotes: countWriterText(combined),
  };
}

function deletedRowParaIds(blocks: Block[], out = new Set<string>()): Set<string> {
  for (const b of blocks) {
    if (b.t === "tbl") {
      for (const r of rowsOf(b)) {
        if (r.rev?.kind === "del") {
          for (const c of cellsOf(r)) for (const p of allParas(c.blocks)) out.add(p.id);
        } else {
          for (const c of cellsOf(r)) {
            if (c.vmerge === "continue" || (c.tcPr && kid(c.tcPr, "w:cellDel"))) for (const p of allParas(c.blocks)) out.add(p.id);
            else deletedRowParaIds(c.blocks, out);
          }
        }
      }
    } else if (b.t === "box") {
      deletedRowParaIds(b.blocks, out);
    }
  }
  return out;
}

export function countableRangeText(doc: WordDoc, r0: E.Range): string {
  const r = E.normRange(doc, r0);
  if (r.a.pid === r.b.pid && r.a.off === r.b.off) return "";
  const skipped = deletedRowParaIds(doc.blocks);
  const paras = E.parasIn(doc, r).filter((p) => !skipped.has(p.id));
  const out: string[] = [];
  let pending = "";
  let hasPending = false;
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const from = p.id === r.a.pid ? r.a.off : 0;
    const to = p.id === r.b.pid ? r.b.off : E.plen(p);
    let acc = 0;
    let s = "";
    for (const it of p.content) {
      const n = E.ilen(it);
      const lo = Math.max(from, acc);
      const hi = Math.min(to, acc + n);
      if (hi > lo && it.rev?.kind !== "del") {
        s += it.t === "r" ? it.text.slice(lo - acc, hi - acc) : countableInlineText(it);
      }
      acc += n;
    }
    pending = hasPending ? pending + s : s;
    hasPending = true;
    const joinNext = i < paras.length - 1 && p.markRev?.kind === "del" && to === E.plen(p);
    if (!joinNext) {
      out.push(pending);
      pending = "";
      hasPending = false;
    }
  }
  if (hasPending) out.push(pending);
  return out.join("\n");
}

export function countWordRange(doc: WordDoc, r0: E.Range): WordCounts {
  return countWriterText(countableRangeText(doc, r0));
}
