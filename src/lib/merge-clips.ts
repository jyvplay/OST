/** TT125 CB-03: fold the clips currently on screen into one new clip.
 *  Order is the order shown; separators are explicit so nothing fuses. */
export function mergeClipTexts(texts: ReadonlyArray<string>, sep: string = "\n\n"): string {
  return texts.filter((t) => t.trim().length > 0).join(sep);
}
