/** URLSearchParams replaces unpaired surrogates; reject instead of silently
 * searching for a different string. This also protects portable profiles. */
export const validSearchText = (value: string): boolean => !value.includes("\0") && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
export function searchScope(value: string): string {
  if (!validSearchText(value)) throw new Error("Scope must contain valid Unicode without NUL");
  if (value.trim().includes("//")) throw new Error("Scope must not contain repeated slashes");
  const scope = value.trim().replace(/\/+$/, "") || (value.trim() ? "/" : "");
  if (scope.length > 4096 || /[\x00-\x1f\x7f\\]/.test(scope) || (scope && !scope.startsWith("/")) || scope.split("/").some(p => p === "." || p === "..") || scope.includes("//")) throw new Error("Scope must be an absolute folder path without dot segments");
  return scope;
}
