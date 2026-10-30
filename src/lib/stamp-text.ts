/** ED-10 — one honest local timestamp for insertion into documents.
 * Zero-padded, minute precision, no timezone claims: the OS is local-first. */
export function stampText(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
