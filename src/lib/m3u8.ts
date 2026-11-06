/**
 * TT136 (ST-04) — streaming playlists, transcribed locally.
 *
 * This is the parser half of a stream player: a M3U/M3U8 playlist is read and
 * parsed into segments with their own byte lengths, and live playlists are
 * walked forward by index rather than by "the last line". No network I/O, no
 * fetch, no DRM: the caller supplies bytes, this module returns segments.
 *
 * Honest limits: ffmpeg/WebCodecs are *not* bundled (privacy + size), so the
 * stream is never transcoded — the module reports what a segment contains and
 * its byte budget, and the caller decides whether to play it.
 */

export interface PlaylistEntry {
  /** Resolved relative to the playlist's own URL (the caller resolves `#` against it). */
  url: string;
  /** #EXT-X-BYTERANGE byte length; null when not declared. */
  byteLength: number | null;
  /** Elapsed media time in seconds, computed by the caller; null until then. */
  durationSeconds: number | null;
  title?: string;
}

export interface Playlist {
  version: 1 | 3 | 4 | 6 | 7 | 8;
  isLive: boolean;
  entries: PlaylistEntry[];
  /** Segment durations declared by #EXTINF, summed for a timeline in seconds. */
  totalSeconds: number;
  /** True when the playlist could not be parsed as a master/media playlist. */
  invalid: string | null;
}

export const PLAYLIST_LIMIT = 20_000;
export const PLAYLIST_TEXT_BYTES = 512 * 1024;

export function parsePlaylist(text: string, baseUrl?: string): Playlist {
  if (typeof text !== "string" || text.length === 0 || new TextEncoder().encode(text).byteLength > PLAYLIST_TEXT_BYTES) {
    throw new Error("Playlist is empty or larger than 512 KiB");
  }
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.filter((l) => l.trim() !== "");
  if (lines.length > PLAYLIST_LIMIT) throw new Error(`Playlist has more than ${PLAYLIST_LIMIT} lines`);

  const isLive = lines.some((l) => l.startsWith("#EXT-X-MEDIA-SEQUENCE:") || l.startsWith("#EXT-X-PLAYLIST-TYPE:live"));
  const version = (() => {
    for (const l of lines) {
      const m = l.match(/^#EXT-X-VERSION:(\d+)/);
      if (m) return Number(m[1]) as 1 | 3 | 4 | 6 | 7 | 8;
    }
    return 1 as 1 | 3 | 4 | 6 | 7 | 8;
  })();

  const entries: PlaylistEntry[] = [];
  const pending: { duration: number; title: string | null; byteLength: number | null } = { duration: 0, title: null, byteLength: null };
  let invalid: string | null = null;
  let total = 0;

  const resolve = (raw: string): string => {
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!baseUrl) return raw;
    try { return new URL(raw, baseUrl).toString(); } catch { return raw; }
  };

  for (const line of lines) {
    if (line.startsWith("#")) {
      const [head, ...rest] = line.split(":");
      const arg = rest.join(":").trim();
      if (head === "#EXTINF") {
        const [dur, title] = arg.split(",");
        const seconds = Number(dur);
        pending.duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
        pending.title = title ? title.trim() : null;
      } else if (head === "#EXT-X-BYTERANGE") {
        const bytes = Number(arg.split("@")[0]);
        pending.byteLength = Number.isFinite(bytes) && bytes > 0 ? bytes : null;
      } else if (head === "#EXT-X-MEDIA-SEQUENCE" || head === "#EXT-X-PLAYLIST-TYPE") {
        continue;
      }
      continue;
    }
    if (/^https?:\/\//i.test(line)) {
      // An absolute URL line is a segment without its preceding #EXTINF in a
      // sloppy playlist; it gets a zero duration and is still listed, because
      // dropping it would silently truncate the playlist.
      entries.push({ url: resolve(line), byteLength: pending.byteLength, durationSeconds: pending.duration || null, title: pending.title ?? undefined });
      total += pending.duration;
      Object.assign(pending, { duration: 0, title: null, byteLength: null });
    } else if (!line.includes("://")) {
      entries.push({ url: resolve(line), byteLength: pending.byteLength, durationSeconds: pending.duration || null, title: pending.title ?? undefined });
      total += pending.duration;
      Object.assign(pending, { duration: 0, title: null, byteLength: null });
    } else {
      invalid = `Unrecognised playlist line: ${line.slice(0, 80)}`;
    }
  }
  if (!entries.length) invalid = invalid ?? "Playlist lists no segments";
  if (version < 3 && lines.some((l) => l.startsWith("#EXT-X-BYTERANGE"))) invalid = "Byte ranges require M3U8 version 3 or later";
  return { version, isLive, entries, totalSeconds: Math.round(total * 100) / 100, invalid };
}

/**
 * Live playlists re-publish: index 0 may roll forward. The player should advance
 * by "the next segment after the one already played" rather than restarting.
 */
export function advanceIndex(playlist: Playlist, lastIndex: number, playedUpTo: number): number {
  if (!playlist.isLive) return lastIndex;
  if (lastIndex >= playlist.entries.length) return 0;
  const candidate = lastIndex + 1;
  // A live playlist whose head changed (different URL) is a new playlist.
  if (playlist.entries[0] && playlist.entries[0].url !== playlist.entries[lastIndex].url) return candidate;
  if (lastIndex < playlist.entries.length - 1) return candidate;
  if (playlist.totalSeconds > 0 && playedUpTo >= playlist.totalSeconds * 0.75) return candidate;
  return lastIndex;
}

export interface StreamStat { count: number; totalBytes: number; totalSeconds: number; longestSeconds: number }

export function streamStat(playlist: Playlist): StreamStat {
  const bytes = playlist.entries.reduce((sum, e) => sum + (e.byteLength ?? 0), 0);
  const longest = playlist.entries.reduce((max, e) => Math.max(max, e.durationSeconds ?? 0), 0);
  return { count: playlist.entries.length, totalBytes: bytes, totalSeconds: playlist.totalSeconds, longestSeconds: Math.round(longest * 100) / 100 };
}

export function describePlaylist(p: Playlist): string {
  return `${p.version} playlist · ${p.entries.length} segment(s) · ${p.totalSeconds} s${p.isLive ? " · live" : ""}${p.invalid ? ` · ${p.invalid}` : ""}`;
}

/** Minimal master-list resolver: the caller still has to fetch the media playlist. */
export function resolveVariant(master: Playlist, variantUrl: string): PlaylistEntry | null {
  const match = master.entries.find((e) => e.url === variantUrl);
  return match ?? null;
}
