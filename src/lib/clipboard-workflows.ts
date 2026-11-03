import type { ClipEntry } from "@/components/shell-context";
import { sourceTextRange } from "./text-selection";
import { validSearchText } from "./search-query";
export const CLIP_TEXT_LIMIT = 1_048_576;
export function transferableClip(entry: ClipEntry): string {
  if (entry.sensitive) throw new Error("Sensitive entries cannot be inspected, compared or transferred");
  if (entry.text.length > CLIP_TEXT_LIMIT || !validSearchText(entry.text)) throw new Error("This tool requires valid Unicode without NUL, up to 1,048,576 UTF-16 code units; the original entry is retained");
  return entry.text;
}
export function clipFilePath(value: string): string {
  const path = value.trim();
  if (!validSearchText(path) || /[\x00-\x1f\x7f\\]/.test(path) || path.length > 4096 || !path.startsWith("/") || path === "/" || path.split("/").slice(1).some(part => !part || part === "." || part === "..")) throw new Error("Use an absolute canonical public file path without dot segments or controls");
  if (path === "/Private" || path.startsWith("/Private/")) throw new Error("This create-only transfer supports public files, not Private storage");
  return path;
}
/** HTML textareas expose LF-normalized offsets. Map the selected displayed
 * range back to the untouched source so CRLF/CR copies remain byte-faithful. */
export function clipboardSelection(text: string, start: number, end: number): string {
  const range = sourceTextRange(text, start, end);
  return text.slice(range.start, range.end);
}
