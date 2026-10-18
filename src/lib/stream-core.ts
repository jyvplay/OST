/**
 * TT27 streaming core — pure, hook-free (unit-tested by scripts/stream-unit.mts).
 *
 * Turns a pasted link into the provider's *official* embed player URL. Nothing is scraped or proxied and no
 * provider SDK is bundled: the provider's own player runs inside a sandboxed iframe, so playback, ads, sign-in
 * and DRM stay under the provider's terms. Only the URL grammar below is ours (original code).
 *
 *   YouTube     youtube.com/watch?v=, youtu.be/, /shorts/, /live/, /embed/, music.youtube.com, playlists (list=),
 *               start time (t= / start= as 90, 1m30s, 1h2m3s) → https://www.youtube-nocookie.com/embed/…
 *               (YouTube requires a Referer from embeds since 2025 — "Error 153" — so the iframe uses
 *               referrerpolicy="strict-origin-when-cross-origin", which sends only this site's origin.)
 *   Vimeo       vimeo.com/123, vimeo.com/123/abcdef (unlisted hash), player.vimeo.com/video/123?h= → player.vimeo.com
 *   Dailymotion dailymotion.com/video/x…, dai.ly/x… → dailymotion.com/embed/video/x…
 *   Twitch      twitch.tv/videos/123, twitch.tv/<channel>, clips → player.twitch.tv (needs parent=<this host>)
 *   PeerTube    https://<instance>/w/<id> or /videos/watch/<uuid> → https://<instance>/videos/embed/<id> (open source)
 *   Spotify     open.spotify.com/(intl-xx/)?{track|album|playlist|artist|show|episode}/<22 base62>, spotify:track:… URIs
 *               → https://open.spotify.com/embed/<type>/<id>
 *   SoundCloud  soundcloud.com/<user>/<track | sets/<set>> → https://w.soundcloud.com/player/?url=…
 *   TIDAL       (TT33) tidal.com / listen.tidal.com (/browse)?/{track|album|playlist|video|mix}/<id>, album/<a>/track/<t>,
 *               embed.tidal.com/{tracks|albums|playlists|videos|mix}/<id> → https://embed.tidal.com/<types>/<id> — TIDAL's
 *               official embed player (its source is public, Apache-2.0: github.com/tidal-music/embed-player; the path
 *               grammar and default sizes below were read from it). Artist pages have no embed.
 *   Qobuz       (TT33) widget.qobuz.com/{album|track}/<id>?zone=, open.qobuz.com / play.qobuz.com/{album|track}/<id>,
 *               www.qobuz.com/<zone>/album/<slug>/<id> → https://widget.qobuz.com/album/<id>?zone=<CC-ll> (track:
 *               …/track/<id>?zone=…&display=compact). Playlists and artists have no widget → link out.
 *   Amazon      (TT33) music.amazon.<tld>/{albums|tracks|playlists}/<ASIN> (+ ?trackAsin=<ASIN>) and the official
 *   Music       Share → Embed code / URL music.amazon.<tld>/embed/<ASIN>/?id=…&marketplaceId=…&musicTerritory=…
 *               A pasted Embed URL is kept as Amazon issued it (minus tracking params); a page link is turned into
 *               the same shape WITHOUT Amazon's opaque share id, which is flagged `unverified` in the UI.
 *   Embed code  (TT33) a pasted <iframe … src="…"> snippet from any provider's Share → Embed is reduced to its src.
 *   Direct      https://….mp4 / .webm / .ogv / .mov / .mp3 / .ogg / .oga / .opus / .wav / .flac / .m4a / .aac → native element
 */

export type StreamKind = "video" | "audio";
export type Provider = "youtube" | "vimeo" | "dailymotion" | "twitch" | "peertube" | "spotify" | "soundcloud" | "tidal" | "qobuz" | "amazonmusic" | "file";

export interface StreamRef {
  provider: Provider;
  kind: StreamKind;
  /** provider-local id (video id, track id, permalink, …) */
  id: string;
  /** canonical page URL (what "Open on site" opens) */
  page: string;
  /** iframe src, or the media URL itself for provider "file" */
  embed: string;
  /** start offset in seconds when the link carried one */
  start?: number;
  /** spotify/soundcloud content type (track, album, playlist, …) or "playlist" for YouTube lists */
  sub?: string;
  /** the iframe host, shown in the click-to-load notice */
  host: string;
  /** TT33: the embed URL was built from a page link in a shape the provider issues but could not be checked here */
  unverified?: boolean;
}

export type Parsed = { ok: true; ref: StreamRef } | { ok: false; error: string };

export const PROVIDER_LABEL: Record<Provider, string> = {
  youtube: "YouTube", vimeo: "Vimeo", dailymotion: "Dailymotion", twitch: "Twitch", peertube: "PeerTube",
  spotify: "Spotify", soundcloud: "SoundCloud", tidal: "TIDAL", qobuz: "Qobuz", amazonmusic: "Amazon Music", file: "Direct file",
};

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)$/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac)$/i;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_TYPES = ["track", "album", "playlist", "artist", "show", "episode"] as const;

/** "90", "90s", "1m30s", "1h2m3s", "01:02:03", "2:05" → seconds; null when unparseable. */
export function parseTime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(":").reduce((a, n) => a * 60 + Number(n), 0);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function toUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch { return null; }
}

const bare = (h: string) => h.toLowerCase().replace(/^(www\.|m\.)/, "");

/** Parse a link. `parentHost` is this page's hostname (Twitch refuses to play without it). */
export function parseStream(raw: string, parentHost = "localhost"): Parsed {
  let text = raw.trim();
  // TT33: a pasted embed snippet (<iframe … src="…">) → its src. Only the first iframe's src is read; nothing else
  // in the snippet (scripts, styles, attributes) is used, so pasting a hostile snippet cannot inject anything.
  if (/^<\s*iframe\b/i.test(text)) {
    const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(text);
    if (!m) return { ok: false, error: "That embed code has no src address" };
    text = (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").trim();
    if (/^\/\//.test(text)) text = `https:${text}`;
  }
  // spotify:track:ID URIs
  const su = /^spotify:(track|album|playlist|artist|show|episode):([A-Za-z0-9]{22})$/.exec(text);
  if (su) return spotify(su[1], su[2]);
  const u = toUrl(text);
  if (!u) return { ok: false, error: "Not a web link — paste an https:// address" };
  if (u.protocol !== "https:") return { ok: false, error: "Only https:// links are played (mixed content is blocked by the browser)" };
  const host = bare(u.hostname);
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com" || host === "youtu.be") {
    let id = "";
    if (host === "youtu.be") id = parts[0] ?? "";
    else if (parts[0] === "watch") id = u.searchParams.get("v") ?? "";
    else if (["shorts", "live", "embed", "v"].includes(parts[0] ?? "")) id = parts[1] ?? "";
    const list = u.searchParams.get("list") ?? "";
    const start = parseTime(u.searchParams.get("t") ?? u.searchParams.get("start"));
    if (!id && parts[0] === "playlist" && /^[A-Za-z0-9_-]{10,64}$/.test(list)) {
      return ok({ provider: "youtube", kind: "video", id: list, sub: "playlist", host: "www.youtube-nocookie.com",
        page: `https://www.youtube.com/playlist?list=${list}`, embed: `https://www.youtube-nocookie.com/embed/videoseries?list=${list}` });
    }
    if (!YT_ID.test(id)) return { ok: false, error: "That YouTube link has no video id (expected watch?v=…, youtu.be/…, /shorts/… or a playlist)" };
    const q = new URLSearchParams();
    if (start) q.set("start", String(start));
    if (/^[A-Za-z0-9_-]{10,64}$/.test(list)) q.set("list", list);
    q.set("rel", "0");
    return ok({ provider: "youtube", kind: "video", id, host: "www.youtube-nocookie.com", ...(start ? { start } : {}),
      page: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`,
      embed: `https://www.youtube-nocookie.com/embed/${id}?${q}` });
  }

  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const nums = parts.filter((p) => /^\d{5,12}$/.test(p));
    const id = nums[0];
    if (!id) return { ok: false, error: "That Vimeo link has no numeric video id" };
    const after = parts[parts.indexOf(id) + 1];
    const hash = u.searchParams.get("h") ?? (after && /^[a-f0-9]{6,20}$/i.test(after) ? after : "");
    const start = parseTime(u.hash.replace(/^#t=/, "")) ?? undefined;
    return ok({ provider: "vimeo", kind: "video", id, host: "player.vimeo.com", ...(start ? { start } : {}),
      page: `https://vimeo.com/${id}${hash ? `/${hash}` : ""}`,
      embed: `https://player.vimeo.com/video/${id}?dnt=1${hash ? `&h=${hash}` : ""}${start ? `#t=${start}s` : ""}` });
  }

  if (host === "dailymotion.com" || host === "dai.ly") {
    const id = host === "dai.ly" ? parts[0] : parts[0] === "video" || parts[0] === "embed" ? parts[parts[0] === "embed" ? 2 : 1] : "";
    const clean = (id ?? "").split("_")[0];
    if (!/^x[a-z0-9]{4,10}$/i.test(clean)) return { ok: false, error: "That Dailymotion link has no video id (x…)" };
    return ok({ provider: "dailymotion", kind: "video", id: clean, host: "www.dailymotion.com",
      page: `https://www.dailymotion.com/video/${clean}`, embed: `https://www.dailymotion.com/embed/video/${clean}` });
  }

  if (host === "twitch.tv" || host === "clips.twitch.tv") {
    const parent = encodeURIComponent(parentHost);
    if (host === "clips.twitch.tv" || parts[1] === "clip") {
      const slug = host === "clips.twitch.tv" ? parts[0] : parts[2];
      if (!slug || !/^[A-Za-z0-9_-]{4,100}$/.test(slug)) return { ok: false, error: "That Twitch clip link has no clip slug" };
      return ok({ provider: "twitch", kind: "video", id: slug, sub: "clip", host: "clips.twitch.tv",
        page: `https://clips.twitch.tv/${slug}`, embed: `https://clips.twitch.tv/embed?clip=${slug}&parent=${parent}&autoplay=false` });
    }
    if (parts[0] === "videos" && /^\d{5,14}$/.test(parts[1] ?? "")) {
      return ok({ provider: "twitch", kind: "video", id: parts[1], sub: "video", host: "player.twitch.tv",
        page: `https://www.twitch.tv/videos/${parts[1]}`, embed: `https://player.twitch.tv/?video=v${parts[1]}&parent=${parent}&autoplay=false` });
    }
    if (parts.length === 1 && /^[A-Za-z0-9_]{3,25}$/.test(parts[0])) {
      return ok({ provider: "twitch", kind: "video", id: parts[0].toLowerCase(), sub: "channel", host: "player.twitch.tv",
        page: `https://www.twitch.tv/${parts[0].toLowerCase()}`, embed: `https://player.twitch.tv/?channel=${parts[0].toLowerCase()}&parent=${parent}&autoplay=false` });
    }
    return { ok: false, error: "That Twitch link is not a channel, past broadcast (/videos/…) or clip" };
  }

  if (host === "open.spotify.com" || host === "play.spotify.com") {
    const p = parts[0]?.startsWith("intl-") ? parts.slice(1) : parts;
    const [type, id] = p[0] === "embed" ? [p[1], p[2]] : [p[0], p[1]];
    if (!(SPOTIFY_TYPES as readonly string[]).includes(type ?? "")) return { ok: false, error: "Spotify links must point at a track, album, playlist, artist, show or episode" };
    if (!SPOTIFY_ID.test(id ?? "")) return { ok: false, error: "That Spotify link has no 22-character id" };
    return spotify(type!, id!);
  }

  if (host === "soundcloud.com" || host === "on.soundcloud.com") {
    if (host === "on.soundcloud.com") return { ok: false, error: "Short on.soundcloud.com links must be opened once in a browser to get the full soundcloud.com/… address (they redirect server-side)" };
    if (parts.length < 2 || ["discover", "search", "stream", "you", "upload", "charts"].includes(parts[0])) {
      return { ok: false, error: "SoundCloud links must point at a track (soundcloud.com/artist/track) or a set (…/sets/name)" };
    }
    const ok2 = parts.every((s) => /^[A-Za-z0-9_-]{1,120}$/.test(s));
    if (!ok2) return { ok: false, error: "That SoundCloud link has unexpected characters" };
    const isSet = parts[1] === "sets";
    const permalink = `https://soundcloud.com/${parts.slice(0, isSet ? 3 : 2).join("/")}`;
    return ok({ provider: "soundcloud", kind: "audio", id: permalink, sub: isSet ? "set" : "track", host: "w.soundcloud.com",
      page: permalink, embed: soundcloudEmbed(permalink, "#0a84ff", isSet) });
  }

  if (host === "w.soundcloud.com" && parts[0] === "player") {
    // TT33: SoundCloud's own Embed code points at the widget with url=<permalink | api.soundcloud.com/{tracks|playlists}/<n>>
    const inner = toUrl(u.searchParams.get("url") ?? "");
    if (inner && bare(inner.hostname) === "soundcloud.com") return parseStream(inner.href, parentHost);
    const api = inner && inner.hostname === "api.soundcloud.com" ? /^\/(tracks|playlists)\/(\d{1,15})\/?$/.exec(inner.pathname) : null;
    if (!api) return { ok: false, error: "That SoundCloud player address has no track or playlist in its url= parameter" };
    const apiUrl = `https://api.soundcloud.com/${api[1]}/${api[2]}`, isSet = api[1] === "playlists";
    return ok({ provider: "soundcloud", kind: "audio", id: apiUrl, sub: isSet ? "set" : "track", host: "w.soundcloud.com",
      page: `https://w.soundcloud.com/player/?url=${encodeURIComponent(apiUrl)}`, embed: soundcloudEmbed(apiUrl, "#0a84ff", isSet) });
  }

  if (host === "tidal.com" || host === "listen.tidal.com" || host === "embed.tidal.com" || host === "link.tidal.com") return tidal(host, parts);
  if (host === "qobuz.com" || host === "open.qobuz.com" || host === "play.qobuz.com" || host === "widget.qobuz.com") return qobuz(host, parts, u);
  const amz = /^music\.amazon\.(com|ca|co\.uk|de|fr|it|es|co\.jp|com\.mx|com\.br|com\.au|in)$/.exec(host);
  if (amz) return amazonMusic(amz[1], parts, u);

  // PeerTube (open-source, federated): /w/<shortUUID>, /videos/watch/<uuid>, /videos/embed/<uuid>
  const pt = /^\/(?:w\/([A-Za-z0-9]{10,36})|videos\/(?:watch|embed)\/([0-9a-f-]{36}|[A-Za-z0-9]{10,36}))\/?$/.exec(u.pathname);
  if (pt) {
    const id = pt[1] ?? pt[2];
    return ok({ provider: "peertube", kind: "video", id, host: u.hostname,
      page: `https://${u.hostname}/w/${id}`, embed: `https://${u.hostname}/videos/embed/${id}` });
  }

  if (VIDEO_EXT.test(u.pathname) || AUDIO_EXT.test(u.pathname)) {
    const kind: StreamKind = VIDEO_EXT.test(u.pathname) ? "video" : "audio";
    return ok({ provider: "file", kind, id: u.href, host: u.hostname, page: u.href, embed: u.href });
  }
  return { ok: false, error: `${u.hostname} is not a supported player — YouTube, Vimeo, Dailymotion, Twitch, PeerTube, Spotify, SoundCloud, TIDAL, Qobuz, Amazon Music or a direct media file` };
}

function ok(ref: StreamRef): Parsed { return { ok: true, ref }; }

function spotify(type: string, id: string): Parsed {
  return ok({ provider: "spotify", kind: "audio", id, sub: type, host: "open.spotify.com",
    page: `https://open.spotify.com/${type}/${id}`, embed: `https://open.spotify.com/embed/${type}/${id}?utm_source=generator` });
}

/* ---------------------------------------------------------------- TT33 TIDAL / Qobuz / Amazon Music */

const TIDAL_EMBED_TYPE: Record<string, string> = { track: "tracks", album: "albums", playlist: "playlists", video: "videos", mix: "mix",
  tracks: "tracks", albums: "albums", playlists: "playlists", videos: "videos" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tidal(host: string, parts: string[]): Parsed {
  if (host === "link.tidal.com") return { ok: false, error: "Short link.tidal.com links redirect server-side — open it once in a browser and paste the full tidal.com/… address" };
  let p = parts[0] === "browse" ? parts.slice(1) : parts;
  // album/<a>/track/<t> is a track inside an album page
  if (p[0] === "album" && p[2] === "track" && p[3]) p = ["track", p[3]];
  const [word, rawId] = p;
  if (word === "artist") return { ok: false, error: "TIDAL has no embedded player for artist pages — open it on tidal.com, or paste a track, album, playlist, video or mix" };
  const type = TIDAL_EMBED_TYPE[word ?? ""];
  if (!type) return { ok: false, error: "TIDAL links must point at a track, album, playlist, video or mix" };
  const id = rawId ?? "";
  const valid = type === "playlists" ? UUID.test(id) : type === "mix" ? /^[0-9a-f]{10,64}$/i.test(id) : /^\d{1,12}$/.test(id);
  if (!valid) return { ok: false, error: type === "playlists" ? "That TIDAL playlist link has no playlist id (a UUID)" : `That TIDAL ${type === "mix" ? "mix" : "link"} has no valid id` };
  const sub = type === "mix" ? "mix" : type.replace(/s$/, "");
  return ok({ provider: "tidal", kind: type === "videos" ? "video" : "audio", id: id.toLowerCase(), sub, host: "embed.tidal.com",
    page: `https://tidal.com/${sub}/${id.toLowerCase()}`, embed: `https://embed.tidal.com/${type}/${id.toLowerCase()}` });
}

/** "us-en" / "US-en" / "NL-nl" → "US-en" (the widget's zone format); anything else → null. */
export function qobuzZone(raw: string | null | undefined): string | null {
  const m = /^([a-z]{2})-([a-z]{2})$/i.exec(raw ?? "");
  return m ? `${m[1].toUpperCase()}-${m[2].toLowerCase()}` : null;
}

function qobuz(host: string, parts: string[], u: URL): Parsed {
  let type = "", id = "", zone = "US-en";
  if (host === "qobuz.com") {
    // store pages: /<zone>/album/<slug>/<id>  (also /<zone>/interpreter/…, /<zone>/playlists/… → no widget)
    zone = qobuzZone(parts[0]) ?? zone;
    const at = parts.findIndex((x) => x === "album" || x === "track");
    if (at >= 0) { type = parts[at]; id = parts[parts.length - 1] ?? ""; if (parts.length - at < 2) id = ""; }
  } else {
    type = parts[0] ?? ""; id = parts[1] ?? "";
    if (host === "widget.qobuz.com") zone = qobuzZone(u.searchParams.get("zone")) ?? zone;
  }
  if (type !== "album" && type !== "track") {
    return { ok: false, error: "Qobuz's player widget plays albums and tracks — open playlists and artists on play.qobuz.com" };
  }
  if (!/^[A-Za-z0-9]{1,40}$/.test(id)) return { ok: false, error: `That Qobuz ${type} link has no ${type} id` };
  return ok({ provider: "qobuz", kind: "audio", id, sub: type, host: "widget.qobuz.com",
    page: `https://open.qobuz.com/${type}/${id}`,
    embed: `https://widget.qobuz.com/${type}/${id}?zone=${zone}${type === "track" ? "&display=compact" : ""}` });
}

/** Amazon Music storefronts: domain suffix → [music territory, Amazon marketplace id] (ids from Amazon's SP-API docs). */
export const AMAZON_MUSIC_STORES: Record<string, readonly [string, string]> = {
  "com": ["US", "ATVPDKIKX0DER"], "ca": ["CA", "A2EUQ1WTGCTBG2"], "co.uk": ["GB", "A1F83G8C2ARO7P"], "de": ["DE", "A1PA6795UKMFR9"],
  "fr": ["FR", "A13V1IB3VIYZZH"], "it": ["IT", "APJ6JRA9NG5V4"], "es": ["ES", "A1RKKUPIHCS9HS"], "co.jp": ["JP", "A1VC38T7YXB528"],
  "com.mx": ["MX", "A1AM78C64UM0Y8"], "com.br": ["BR", "A2Q3Y263D00KWC"], "com.au": ["AU", "A39IBJ37TRP1C6"], "in": ["IN", "A21TJRUUN4KGV"],
};
const ASIN = /^[A-Z0-9]{10}$/;

function amazonMusic(tld: string, parts: string[], u: URL): Parsed {
  const store = AMAZON_MUSIC_STORES[tld]; const base = `https://music.amazon.${tld}`;
  if (parts[0] === "embed") {
    const id = parts[1] ?? "";
    if (!ASIN.test(id) && !/^[0-9a-f]{32}[a-z]{4}$/.test(id)) return { ok: false, error: "That Amazon Music embed address has no album, track or playlist id" };
    // keep exactly what Amazon's Share → Embed issued, minus anything else (affiliate tags, refs)
    const q = new URLSearchParams();
    const share = u.searchParams.get("id"), mp = u.searchParams.get("marketplaceId"), terr = u.searchParams.get("musicTerritory");
    if (share && /^[A-Za-z0-9_-]{1,40}$/.test(share)) q.set("id", share);
    q.set("marketplaceId", mp && /^[A-Z0-9]{8,20}$/.test(mp) ? mp : store[1]);
    q.set("musicTerritory", terr && /^[A-Z]{2}$/.test(terr) ? terr : store[0]);
    return ok({ provider: "amazonmusic", kind: "audio", id, sub: ASIN.test(id) ? "embed" : "user playlist", host: `music.amazon.${tld}`,
      page: ASIN.test(id) ? `${base}/albums/${id}` : `${base}/user-playlists/${id}`, embed: `${base}/embed/${id}/?${q}`, ...(share ? {} : { unverified: true }) });
  }
  const kindWord = parts[0] ?? "";
  if (kindWord === "artists" || kindWord === "podcasts" || kindWord === "stations") {
    return { ok: false, error: `Amazon Music has no embedded player for ${kindWord} — open it on music.amazon.${tld}, or paste an album, track or playlist` };
  }
  if (kindWord === "user-playlists" || (kindWord === "my" && parts[1] === "playlists")) {
    return { ok: false, error: "Amazon Music user playlists only embed through Amazon's Share → Embed button — paste that embed code here" };
  }
  const type = kindWord === "albums" ? "album" : kindWord === "tracks" ? "track" : kindWord === "playlists" ? "playlist" : "";
  if (!type) return { ok: false, error: "Amazon Music links must point at an album, track or playlist (or paste Amazon's Share → Embed code)" };
  let id = parts[1] ?? ""; let sub = type;
  const trackAsin = u.searchParams.get("trackAsin");
  if (type === "album" && trackAsin && ASIN.test(trackAsin)) { id = trackAsin; sub = "track"; }
  if (!ASIN.test(id)) return { ok: false, error: `That Amazon Music ${type} link has no 10-character id (ASIN)` };
  const page = sub === "track" && type === "album" ? `${base}/albums/${parts[1]}?trackAsin=${id}` : `${base}/${kindWord}/${id}`;
  return ok({ provider: "amazonmusic", kind: "audio", id, sub, host: `music.amazon.${tld}`, page, unverified: true,
    embed: `${base}/embed/${id}/?marketplaceId=${store[1]}&musicTerritory=${store[0]}` });
}

/**
 * TT33: what the provider's embedded player gives without the provider's own app — shown in the click-to-load notice
 * so nobody expects more than the embed can do. Empty when there is nothing to say.
 */
export function accessNote(ref: StreamRef): string {
  switch (ref.provider) {
    case "spotify": return "Full tracks need you to be signed in to Spotify in this browser; otherwise Spotify plays 30-second previews.";
    case "tidal": return "Full tracks need a TIDAL subscription and signing in inside the player; otherwise TIDAL plays 30-second previews.";
    case "qobuz": return "Qobuz's widget may play only excerpts unless you are signed in to Qobuz in this browser; full hi-res streaming is on play.qobuz.com and in Qobuz's apps.";
    case "amazonmusic": return `Amazon's embedded player plays 30-second previews (Amazon users report this even with a subscription); full tracks play on ${ref.host} and in Amazon's apps.${ref.unverified ? " This player address was built from the page link; if it does not load, use Share → Embed on Amazon Music and paste that code." : ""}`;
    default: return "";
  }
}

/** SoundCloud HTML5 widget URL (documented params). `color` is ignored by the widget in visual mode. */
export function soundcloudEmbed(permalink: string, color: string, visual = false): string {
  const q = new URLSearchParams({
    url: permalink, color: color.replace(/^#/, ""), auto_play: "false", hide_related: "true",
    show_comments: "false", show_user: "true", show_reposts: "false", visual: visual ? "true" : "false",
  });
  return `https://w.soundcloud.com/player/?${q}`;
}

/** Height the provider's player needs (Spotify compact 152 / full 352; SoundCloud 166 track / 450 set). */
export function playerHeight(ref: StreamRef): number | null {
  if (ref.provider === "spotify") return ref.sub === "track" || ref.sub === "episode" ? 152 : 352;
  if (ref.provider === "soundcloud") return ref.sub === "set" ? 450 : 166;
  // TT33 — TIDAL's own default sizes (track 120, album / playlist / mix 275; video is 16:9), Qobuz widget album 390 /
  // compact track 100, Amazon Music's issued embed code 550.
  if (ref.provider === "tidal") return ref.sub === "video" ? null : ref.sub === "track" ? 120 : 275;
  if (ref.provider === "qobuz") return ref.sub === "track" ? 100 : 390;
  if (ref.provider === "amazonmusic") return 550;
  if (ref.provider === "file" && ref.kind === "audio") return 64;
  return null; // 16:9 video
}

/** The `allow` list for each provider's iframe — only what that player needs. */
export function iframeAllow(ref: StreamRef): string {
  if (ref.provider === "spotify") return "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
  if (ref.provider === "soundcloud") return "autoplay";
  if (ref.provider === "tidal") return "autoplay; encrypted-media; fullscreen; clipboard-write";
  if (ref.provider === "qobuz" || ref.provider === "amazonmusic") return "autoplay; encrypted-media";
  return "autoplay; encrypted-media; fullscreen; picture-in-picture";
}

/* ------------------------------------------------------------------ library */

export interface LibraryItem { id: string; url: string; title: string; provider: Provider; kind: StreamKind; added: string }
export interface Library { v: 1; items: LibraryItem[] }
export const LIBRARY_MAX = 500;
export const emptyLibrary = (): Library => ({ v: 1, items: [] });

/** Defensive parse of a stored library: drops rows whose link no longer parses, dedupes by embed, caps the size. */
export function normalizeLibrary(raw: unknown): Library {
  const items = Array.isArray((raw as Library | null)?.items) ? (raw as Library).items : [];
  const seen = new Set<string>(); const out: LibraryItem[] = [];
  for (const it of items) {
    if (!it || typeof it.url !== "string") continue;
    const p = parseStream(it.url);
    if (!p.ok || seen.has(p.ref.embed)) continue;
    seen.add(p.ref.embed);
    out.push({
      id: typeof it.id === "string" && it.id ? it.id.slice(0, 40) : `s${out.length}`,
      url: it.url.slice(0, 2048), title: typeof it.title === "string" && it.title.trim() ? it.title.trim().slice(0, 200) : defaultTitle(p.ref),
      provider: p.ref.provider, kind: p.ref.kind, added: typeof it.added === "string" ? it.added : new Date(0).toISOString(),
    });
    if (out.length >= LIBRARY_MAX) break;
  }
  return { v: 1, items: out };
}

export function defaultTitle(ref: StreamRef): string {
  if (ref.provider === "soundcloud") return ref.id.replace("https://soundcloud.com/", "").replace(/[-_]/g, " ");
  if (ref.provider === "file") return decodeURIComponent(ref.id.split("/").pop() ?? ref.id);
  if (ref.provider === "amazonmusic" && ref.sub === "embed") return `Amazon Music ${ref.id}`;
  return `${PROVIDER_LABEL[ref.provider]} ${ref.sub ? `${ref.sub} ` : ""}${ref.id}`;
}

/** Add (or move to the top when the same player is already saved). Returns the same library on a bad link. */
export function addToLibrary(lib: Library, url: string, title: string, now: string, id: string): { lib: Library; error?: string; item?: LibraryItem } {
  const p = parseStream(url);
  if (!p.ok) return { lib, error: p.error };
  const rest = lib.items.filter((i) => { const q = parseStream(i.url); return !(q.ok && q.ref.embed === p.ref.embed); });
  const item: LibraryItem = { id, url: url.trim(), title: title.trim().slice(0, 200) || defaultTitle(p.ref), provider: p.ref.provider, kind: p.ref.kind, added: now };
  return { lib: { v: 1, items: [item, ...rest].slice(0, LIBRARY_MAX) }, item };
}

export const removeFromLibrary = (lib: Library, id: string): Library => ({ v: 1, items: lib.items.filter((i) => i.id !== id) });
export const renameInLibrary = (lib: Library, id: string, title: string): Library =>
  ({ v: 1, items: lib.items.map((i) => (i.id === id && title.trim() ? { ...i, title: title.trim().slice(0, 200) } : i)) });
export function moveInLibrary(lib: Library, id: string, delta: number): Library {
  const i = lib.items.findIndex((x) => x.id === id); const j = i + delta;
  if (i < 0 || j < 0 || j >= lib.items.length) return lib;
  const items = lib.items.slice(); const [x] = items.splice(i, 1); items.splice(j, 0, x);
  return { v: 1, items };
}
/** Items of one kind, optionally filtered by a case-insensitive query over title, provider and URL. */
export function filterLibrary(lib: Library, kind: StreamKind | "all", q: string): LibraryItem[] {
  const n = q.trim().toLowerCase();
  return lib.items.filter((i) => (kind === "all" || i.kind === kind) &&
    (!n || i.title.toLowerCase().includes(n) || PROVIDER_LABEL[i.provider].toLowerCase().includes(n) || i.url.toLowerCase().includes(n)));
}
/** Next item for a queue (wraps when `loop`). */
export function nextIn(items: LibraryItem[], currentId: string | null, loop: boolean): LibraryItem | null {
  if (!items.length) return null;
  const i = items.findIndex((x) => x.id === currentId);
  if (i < 0) return items[0];
  if (i + 1 < items.length) return items[i + 1];
  return loop ? items[0] : null;
}
/** TT34 SM-11: previous item (wraps to the last when `loop`; from "nothing playing" → the last item). */
export function prevIn(items: LibraryItem[], currentId: string | null, loop: boolean): LibraryItem | null {
  if (!items.length) return null;
  const i = items.findIndex((x) => x.id === currentId);
  if (i < 0) return items[items.length - 1];
  if (i > 0) return items[i - 1];
  return loop ? items[items.length - 1] : null;
}
/**
 * TT34 SM-11: shuffle without repeats — a uniformly random item not yet played in this round and not the current one.
 * When the round is used up: a new round if `loop` (the current item is still excluded, so no back-to-back repeat),
 * else null. `played` is the ids already played this round; `rand` returns [0, 1).
 */
export function shuffleNext(items: LibraryItem[], currentId: string | null, played: readonly string[], loop: boolean, rand: () => number = Math.random): { item: LibraryItem; newRound: boolean } | null {
  const seen = new Set(played);
  let pool = items.filter((x) => x.id !== currentId && !seen.has(x.id));
  let newRound = false;
  if (!pool.length) {
    if (!loop) return null;
    pool = items.filter((x) => x.id !== currentId);
    newRound = true;
    if (!pool.length) return items.length ? { item: items[0], newRound } : null; // a one-item list loops onto itself
  }
  const k = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return { item: pool[k], newRound };
}
