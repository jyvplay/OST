/** TT118 UC-01 — clean link: strip tracking parameters from a URL.
 * The removed set is explicit and listed in the result, so "cleaned" is a
 * claim a person can audit, not a vibe. Well-known click ids (fbclid, gclid,
 * msclkid, twclid, ttclid, li_fat_id, mc_cid/mc_eid), every utm_* parameter,
 * and common referral tags are removed. Everything else — including opaque
 * query tokens that might be load-bearing — is kept, and the fragment is
 * preserved. A URL that cannot be parsed is refused, not "cleaned" by regex. */
export const TRACKING_PARAMS = ["fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "twclid", "ttclid", "li_fat_id", "mc_cid", "mc_eid", "igshid", "ref_src", "ref_url", "s_cid", "yclid", "_hsenc", "_hsmi", "vero_id", "oly_anon_id", "oly_enc_id", "__s", "rb_clickid", "partner_id", "affiliate_id", "click_id", "subid"];
export interface CleanResult { url: string; removed: string[]; changed: boolean }
export function cleanUrl(input: string): CleanResult {
  let u: URL;
  try { u = new URL(String(input).trim()); } catch { throw new Error("that is not a URL that can be cleaned"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) links can be cleaned");
  const removed: string[] = [];
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(key) || TRACKING_PARAMS.includes(key.toLowerCase())) {
      if (!removed.includes(key)) removed.push(key);
      u.searchParams.delete(key);
    }
  }
  return { url: u.toString(), removed, changed: removed.length > 0 };
}
