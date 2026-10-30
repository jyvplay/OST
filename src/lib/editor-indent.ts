/** ED-08: indent / dedent the lines a selection spans. Two-space steps;
 *  dedent removes up to one step of leading spaces (or one leading tab).
 *  The selection grows to the full affected lines so repeat presses and
 *  follow-up typing stay on the block the user can see. */
export interface IndentResult { text: string; selStart: number; selEnd: number }
export const INDENT = "  ";
export function indentSelection(text: string, selStart: number, selEnd: number, dir: 1 | -1): IndentResult {
  const before = text.slice(0, selStart);
  const lineStart = before.lastIndexOf("\n") + 1;
  // a selection that ends exactly at a line start must not drag that
  // (empty) line into the block — editors indent what the user sees spanned
  const effEnd = selEnd > selStart && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  const afterEnd = text.indexOf("\n", effEnd);
  const lineEnd = afterEnd === -1 ? text.length : afterEnd;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split("\n");
  const out = lines.map((l) => (dir > 0 ? INDENT + l : l.startsWith(INDENT) ? l.slice(INDENT.length) : l.startsWith("\t") ? l.slice(1) : l.replace(/^ {1,2}/, "")));
  const nb = out.join("\n");
  return { text: text.slice(0, lineStart) + nb + text.slice(lineEnd), selStart: lineStart, selEnd: lineStart + nb.length };
}
