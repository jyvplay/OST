import { makeHarness } from "./harness.mts";
import { countWriterText } from "../src/lib/office/wordcount.ts";

const { test, finish } = makeHarness("tt84-wordcount");
const ok = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const eq = (actual: unknown, expected: unknown, message: string) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };

await test("W1 empty text has zero counts", { "FF-82": "partial" }, () => {
  eq(countWriterText(""), { words: 0, characters: 0, charactersNoSpaces: 0, paragraphs: 0, lines: 0 }, "empty document");
});
await test("W2 spaces, blank paragraphs and CRLF do not inflate words or character totals", {}, () => {
  eq(countWriterText("one two\r\n\r\nthree\t"), { words: 3, characters: 13, charactersNoSpaces: 11, paragraphs: 2, lines: 3 }, "line normalization");
  const onlyWhitespace = countWriterText(" \t\n");
  ok(onlyWhitespace.words === 0 && onlyWhitespace.charactersNoSpaces === 0, `whitespace-only counts ${JSON.stringify(onlyWhitespace)}`);
});
await test("W3 apostrophes, hyphens, decomposed accents and emoji count as reader-visible characters", {}, () => {
  const c = countWriterText("don't re-enter e\u0301 👨‍👩‍👧‍👦");
  ok(c.words === 3, `word tokenization ${JSON.stringify(c)}`);
  ok(c.characters === 18 && c.charactersNoSpaces === 15, `grapheme counts ${JSON.stringify(c)}`);
});
await test("W4 long input stays bounded and preserves linear counts", {}, () => {
  const text = `${"alpha ".repeat(20_000)}omega`;
  const start = performance.now(), c = countWriterText(text), elapsed = performance.now() - start;
  ok(c.words === 20_001, `word count ${c.words}`);
  ok(c.characters === 120_005 && c.charactersNoSpaces === 100_005, `character counts ${JSON.stringify(c)}`);
  ok(elapsed < 3_000, `50k words took ${elapsed.toFixed(0)} ms`);
});
finish();
