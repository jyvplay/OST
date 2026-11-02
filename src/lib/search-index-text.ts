/** Match PostgreSQL left(text, n): Unicode code points, not half a UTF-16
 * surrogate. ASCII/BMP prefixes keep the cheap slice path. */
export const SEARCH_BODY_LIMIT = 50_000;
export function searchIndexText(text: string, limit = SEARCH_BODY_LIMIT): string {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Index prefix limit must be a nonnegative safe integer");
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit);
  if (!/[\ud800-\udbff]/.test(prefix)) return prefix;
  let at = 0;
  for (let count = 0; count < limit && at < text.length; count++) at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
  return text.slice(0, at);
}
