/**
 * TT143 (CA-08 / CA-12) — what a cast can actually be, decided by the receiver,
 * not by the sender's optimism.
 *
 * The temptation in a "cast" feature is to build a picker that lists devices and
 * then fails at the first frame. Two mechanisms are legitimate on the open web:
 *
 *   1. **Remote Playback** (`HTMLMediaElement.remote.prompt()`): the browser
 *      exposes the platform's own picker (Chromium: Cast; Safari: AirPlay). The
 *      page supplies a URL and the receiver fetches it itself, so the media must
 *      be reachable *by the receiver* — a `blob:` or a same-origin URL behind the
 *      app's session is not.
 *   2. **Google Cast sender**: needs the Cast SDK, which is a proprietary script
 *      from `gstatic.com`. It is therefore *offered as a link to the platform
 *      picker*, never bundled, and is never claimed to work from this origin.
 *
 * Everything else — a raw RAOP/ALAC sender, FairPlay mirroring, Miracast, DLNA —
 * is not implementable from a web origin without reverse-engineered protocols or
 * a native shim, so the engine returns `blocked` **with the reason**, which is
 * what lets the UI stop pretending and offer the alternative that does work.
 *
 * The engine is pure and total: for every (target, media, environment) it returns
 * a plan or a refusal with a sentence, never a `null` that the caller must guess
 * about. The interesting cases are the refusals — a local file, a media type the
 * receiver cannot fetch, an insecure origin, and a browser that has neither
 * mechanism.
 */

export type CastTarget = "remote-playback" | "airplay" | "google-cast" | "dlna" | "miracast" | "raop";
export type MediaKind = "video" | "audio" | "image" | "window";
export interface CastMedia { kind: MediaKind; url: string; mime: string; durationSec?: number }

export type CastVerdict =
  | { status: "available"; target: CastTarget; via: "platform-picker"; note: string }
  | { status: "blocked"; target: CastTarget; reason: string; alternative: string | null };

/** Schemes a receiver can fetch. `blob:` and `data:` exist only inside this page. */
const RECEIVER_FETCHABLE = new Set(["http:", "https:"]);

export function planCast(media: CastMedia, env: { secureContext: boolean; hasRemotePlayback: boolean; hasCastSdk: boolean; target: CastTarget }): CastVerdict {
  const { target } = env;
  // The honest, mechanism-specific impossibilities come first, so the message is
  // about the mechanism the user picked rather than a generic failure.
  if (target === "raop" || target === "dlna" || target === "miracast") {
    return {
      status: "blocked", target,
      reason: `${target === "raop" ? "AirPlay audio (RAOP/ALAC)" : target === "dlna" ? "DLNA/UPnP" : "Miracast"} is a native protocol; a web origin cannot speak it without a reverse-engineered implementation or an installed helper.`,
      alternative: env.hasRemotePlayback ? "Use the platform picker: it reaches AirPlay and Cast receivers through the browser itself." : null,
    };
  }
  if (target === "google-cast" && !env.hasCastSdk) {
    return {
      status: "blocked", target,
      reason: "The Cast sender needs Google's proprietary Cast SDK, which this app does not bundle.",
      alternative: env.hasRemotePlayback ? "If the browser is Chromium-based, its own remote-playback picker lists Cast devices without any SDK." : null,
    };
  }
  if (!env.secureContext) {
    return { status: "blocked", target, reason: "Casting requires a secure context (https or localhost).", alternative: null };
  }
  if (!env.hasRemotePlayback) {
    return { status: "blocked", target, reason: "This browser exposes no remote-playback API, so there is no picker to open.", alternative: null };
  }
  if (media.kind === "window") {
    return { status: "blocked", target, reason: "A window cannot be cast: the remote playback API takes media elements only, and capture streams cannot be handed to a receiver.", alternative: "Share the window with the screen-share picker instead; it sends the picture to a call, not to a TV." };
  }
  let u: URL;
  try { u = new URL(media.url, "https://placeholder.invalid"); } catch { return { status: "blocked", target, reason: "the media address is not a URL", alternative: null }; }
  if (media.url.startsWith("blob:") || media.url.startsWith("data:")) {
    return {
      status: "blocked", target,
      reason: "The media exists only inside this page (a blob or data URL); the receiver would have to fetch it and cannot.",
      alternative: "Save it to Files first and cast the saved copy, so the receiver has an address it can fetch.",
    };
  }
  if (!RECEIVER_FETCHABLE.has(u.protocol)) {
    return { status: "blocked", target, reason: `a receiver cannot fetch a “${u.protocol}” address`, alternative: null };
  }
  if (!/^(video|audio|image)\//.test(media.mime)) {
    return { status: "blocked", target, reason: `“${media.mime}” is not a media type a receiver plays`, alternative: null };
  }
  if (media.kind === "image") {
    return { status: "blocked", target, reason: "Remote playback is defined for media with a timeline; a still image has none, so there is nothing to transfer play state for.", alternative: "Open the image in the platform's own share sheet instead." };
  }
  return {
    status: "available", target, via: "platform-picker",
    note: "The browser's own picker chooses the receiver. The receiver fetches the address directly, so it must be reachable from the receiver's network — a URL that only works inside this app's session will not play.",
  };
}

/** The set of targets to show, each with its verdict, so the UI cannot invent one. */
export function castMatrix(media: CastMedia, env: Omit<Parameters<typeof planCast>[1], "target">): CastVerdict[] {
  const targets: CastTarget[] = ["remote-playback", "airplay", "google-cast", "dlna", "raop", "miracast"];
  return targets.map((target) => planCast(media, { ...env, target }));
}

/** What can be sent, given a URL the app already serves. Never invents a duration. */
export function describeMedia(media: CastMedia): string {
  const length = media.durationSec != null ? `, ${Math.floor(media.durationSec / 60)}:${String(Math.round(media.durationSec % 60)).padStart(2, "0")}` : ", length unknown to the page";
  return `${media.mime}${length}`;
}
