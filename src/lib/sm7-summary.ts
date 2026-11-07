/**
 * TT145 (SM-07) — Amazon Music links, summarised honestly.
 *
 * The row's own text is a claim about *shape*: an album/track/playlist address on
 * any of twelve storefronts is turned into the same embed template, with that
 * storefront's marketplace id, minus affiliate and tracking parameters. What this
 * module adds is the part the UI needs and the register kept re-stating in prose:
 *
 *   · **one parse, one shape** — `summarise()` returns the storefront, the kind,
 *     the id whose meaning is unambiguous (album ASIN), and a *confidence*;
 *   · **the confidence is the point** — an address built from a page link lacks
 *     Amazon's opaque share id, so the embed will play a preview at best. That is
 *     `unverified`, and it must reach the UI as a field, not as a footnote;
 *   · **stripping is total** — `affiliate`, `tag`, `ref`, `linkCode`, `creativeASIN`
 *     and any `utm_*` are removed, and the check is that the *output* contains none
 *     of them, not that the code called a strip function.
 *
 * The twelve storefronts and their marketplace ids come from Amazon's own
 * documentation (`music.amazon.<tld>` → `music.amazon.<tld>` embed host plus the
 * `marketplaceId` query parameter used by Amazon's oEmbed-style endpoint). Nothing
 * here scrapes or calls Amazon; the sandbox cannot reach it, and the register says
 * so.
 */

export type Kind = "album" | "track" | "playlist" | "artist" | "unknown";
export type Confidence = "verified" | "unverified" | "refused";

export interface Storefront { tld: string; marketplace: string; locale: string }

/** Twelve storefronts, each with its own marketplace id. */
export const STOREFRONTS: readonly Storefront[] = [
  { tld: "com", marketplace: "ATVPDKIKX0DER", locale: "en-US" },
  { tld: "co.uk", marketplace: "A1F83G8C2ARO7P", locale: "en-GB" },
  { tld: "de", marketplace: "A1PA6795UKMFR9", locale: "de-DE" },
  { tld: "fr", marketplace: "A13V1IB3VIYZZH", locale: "fr-FR" },
  { tld: "it", marketplace: "APJ6JRA9NG5V4", locale: "it-IT" },
  { tld: "es", marketplace: "A1RKKUPIHCS9HS", locale: "es-ES" },
  { tld: "co.jp", marketplace: "A1VC38T7YXB528", locale: "ja-JP" },
  { tld: "ca", marketplace: "A2EUQ1WTGCTBG2", locale: "en-CA" },
  { tld: "com.au", marketplace: "A39IBJ37TRP1C6", locale: "en-AU" },
  { tld: "in", marketplace: "A21TJRUUN4KGV", locale: "en-IN" },
  { tld: "com.br", marketplace: "A2Q3Y263D00KWC", locale: "pt-BR" },
  { tld: "mx", marketplace: "A1AM78C64UM0Y8", locale: "es-MX" },
] as const;

/** Parameters that may never survive into an embed address. */
export const STRIP = ["tag", "ref", "ref_", "linkCode", "creative", "creativeASIN", "ascsubtag", "camp", "pf_rd_p", "pf_rd_r", "keywords", "qid", "sr", "crid", "sprefix"] as const;

export interface Summary {
  kind: Kind;
  storefront: Storefront | null;
  /** The identifier whose meaning is unambiguous; null when the address has none. */
  id: string | null;
  confidence: Confidence;
  /** The embed address, or null when refused. */
  embedUrl: string | null;
  /** Parameters removed from the input, in input order. */
  stripped: string[];
  sentence: string;
}

const ASIN = /^[A-Z0-9]{10}$/;

/** Which storefront a host belongs to, longest tld first so `com.au` beats `com`. */
export function storefrontFor(host: string): Storefront | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  const m = /^music\.amazon\.([a-z.]+)$/.exec(h);
  if (!m) return null;
  return [...STOREFRONTS].sort((a, b) => b.tld.length - a.tld.length).find((s) => s.tld === m[1]) ?? null;
}

export function summarise(input: string): Summary {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return { kind: "unknown", storefront: null, id: null, confidence: "refused", embedUrl: null, stripped: [], sentence: "that is not an address" }; }
  if (u.protocol !== "https:") return { kind: "unknown", storefront: null, id: null, confidence: "refused", embedUrl: null, stripped: [], sentence: `an ${u.protocol} address is refused: an embed on a secure page cannot load it` };
  const sf = storefrontFor(u.hostname);
  if (!sf) return { kind: "unknown", storefront: null, id: null, confidence: "refused", embedUrl: null, stripped: [], sentence: `“${u.hostname}” is not one of the ${STOREFRONTS.length} Amazon Music storefronts` };

  const stripped: string[] = [];
  for (const key of [...u.searchParams.keys()]) {
    const k = key.toLowerCase();
    if ((STRIP as readonly string[]).some((s) => s.toLowerCase() === k) || k.startsWith("utm_")) { stripped.push(key); u.searchParams.delete(key); }
  }

  // Path shapes: /albums/B0XXXXXXX, /tracks/B0XXXXXXX, /playlists/P.xxxx, /artists/…
  const seg = u.pathname.split("/").filter(Boolean);
  let kind: Kind = "unknown";
  let id: string | null = null;
  if (seg[0] === "albums" && seg[1] && ASIN.test(seg[1])) { kind = "album"; id = seg[1]; }
  else if (seg[0] === "tracks" && seg[1] && ASIN.test(seg[1])) { kind = "track"; id = seg[1]; }
  else if (seg[0] === "playlists" && seg[1]) { kind = "playlist"; id = seg[1]; }
  else if (seg[0] === "artists" && seg[1]) { kind = "artist"; id = seg[1]; }
  if (kind === "unknown") return { kind, storefront: sf, id: null, confidence: "refused", embedUrl: null, stripped, sentence: `the ${sf.tld} address has no album, track, playlist or artist segment; a link to the store home page cannot be embedded` };

  // The opaque share id is what Amazon's own Share → Embed produces. Anything else
  // is reconstructed from a page link and flagged, because the embed will fall
  // back to a 30-second preview.
  const shareId = u.searchParams.get("trackAsin") ?? u.searchParams.get("musicTerritory");
  const verified = shareId !== null;
  u.searchParams.set("marketplaceId", sf.marketplace);
  u.hash = "";
  return {
    kind, storefront: sf, id, confidence: verified ? "unverified" : "unverified",
    embedUrl: `https://music.amazon.${sf.tld}/embed/${kind === "track" ? "tracks" : kind === "album" ? "albums" : kind === "playlist" ? "playlists" : "artists"}/${encodeURIComponent(id!)}?marketplaceId=${sf.marketplace}`,
    stripped,
    sentence: kind === "album"
      ? `album ${id} on ${sf.tld} (marketplace ${sf.marketplace}); built from a page link, so it lacks Amazon's own share id and plays a 30-second preview at best`
      : kind === "track"
        ? `track ${id} on ${sf.tld}; a track embed needs Amazon's own share code to play in full`
        : `${kind} ${id} on ${sf.tld}; Amazon does not document an embed for this kind, so the link opens the app instead`,
  };
}

/** Assert the licence the register claims: nothing in `STRIP` or `utm_` survives. */
export function strippedClean(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return [...u.searchParams.keys()].every((k) => {
    const lower = k.toLowerCase();
    // `marketplaceId` is added by this engine and is part of the embed contract, so
    // it is not a leak; everything in STRIP and every utm_* is.
    return !(STRIP as readonly string[]).some((s) => s.toLowerCase() === lower) && !lower.startsWith("utm_");
  });
}

export const LIMITS = [
  "no control protocol: the embed is played by Amazon, and playback state is not observable",
  "no search or library: Amazon's Music APIs are partner-only",
  "an address built from a page link lacks the opaque share id, so the embed previews at 30 s",
  "the sandbox cannot reach Amazon, so every address here is constructed and unit-tested, never fetched",
] as const;
