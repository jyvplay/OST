/** TT125 ED-09: change the case of a selection without touching anything else. */
export type CaseMode = "upper" | "lower" | "title";
export const CASE_MODES: CaseMode[] = ["upper", "lower", "title"];
export function caseTransform(text: string, mode: CaseMode): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  // title: capitalise the first letter of every all-lower run of letters that
  // follows a non-letter (or the start). Runs the user typed with any capital
  // (iPad, camelCase, USB-c) are deliberate and are left exactly as typed.
  return text.replace(/[A-Za-z](?:[A-Za-z'’-]*)/g, (word, off: number) => {
    if (word !== word.toLowerCase()) return word; // deliberate casing kept
    const prev = off > 0 ? text[off - 1] : "";
    if (prev && /[A-Za-z]/.test(prev)) return word; // inside a run: keep
    return word[0].toUpperCase() + word.slice(1);
  });
}
export function caseLabel(mode: CaseMode): string {
  return mode === "upper" ? "UPPER CASE" : mode === "lower" ? "lower case" : "Title Case";
}
