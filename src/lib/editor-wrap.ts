/** ED-06: editor soft-wrap preference. Stored per browser (a reading
 *  preference, not document data); the style is a pure function so the
 *  textarea and the preview can never disagree about the setting. */
export const WRAP_KEY = "fusion.editor.wrap.v1";
export function wrapStyle(on: boolean): { whiteSpace: "pre-wrap" | "pre"; overflowX: "hidden" | "auto" } {
  return on ? { whiteSpace: "pre-wrap", overflowX: "hidden" } : { whiteSpace: "pre", overflowX: "auto" };
}
export const readWrap = (store: { getItem(k: string): string | null }): boolean => { try { return store.getItem(WRAP_KEY) === "1"; } catch { return false; } };
