/** First-party Writer word-count primitives. Words use Writer's status-bar tokenization; character counts use grapheme
 * clusters where Intl.Segmenter exists, so emoji and combining sequences are counted as what a reader sees. */
export interface WordCounts {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  paragraphs: number;
  lines: number;
}

function graphemeCount(text: string): number {
  if (typeof Intl.Segmenter === "function") return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  return [...text].length;
}

export function countWriterText(text: string): WordCounts {
  const normalized = text.replace(/\r\n?/g, "\n");
  const visibleText = normalized.replace(/\n/g, "");
  return {
    words: (normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length,
    characters: graphemeCount(visibleText),
    charactersNoSpaces: graphemeCount(visibleText.replace(/[\s\u00a0]/gu, "")),
    paragraphs: normalized ? normalized.split("\n").filter((p) => p.trim()).length : 0,
    lines: normalized ? normalized.split("\n").length : 0,
  };
}
