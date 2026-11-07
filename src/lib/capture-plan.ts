/**
 * TT143 (WM-15) — sending one window as a video source, and the three things that
 * make it fail.
 *
 * "Cast this window" sounds like a feature and is really a constraint solve. The
 * honest web mechanisms are:
 *
 *   · `getDisplayMedia({preferCurrentTab})` / a surface picker → a MediaStream;
 *   · that stream can be recorded (MediaRecorder), shown locally, or sent over a
 *     WebRTC peer connection as a track; but
 *   · it **cannot** be handed to `HTMLMediaElement.src` on a receiver, because a
 *     remote playback receiver fetches a URL, and a MediaStream has no URL.
 *
 * So the plan returns one of: `record` (a file, then cast the file), `webrtc`
 * (a live peer), `local` (a picture-in-picture view for the user only), or
 * `blocked` with the reason. Every plan names the *audio* decision separately,
 * because tab audio is the part that silently goes missing: `getDisplayMedia`
 * only includes it when the user ticks "share audio", which is a user choice the
 * page cannot make for them.
 */

export type CaptureGoal = "record" | "webrtc" | "local-view" | "cast";
export interface CaptureRequest {
  goal: CaptureGoal;
  surface: "tab" | "window" | "screen";
  audioRequested: boolean;
  /** Seconds; null when the user has not asked for a bound. */
  limitSec: number | null;
  codecOk: boolean;
}
export type CapturePlan =
  | { status: "ready"; mechanism: string; tracks: string[]; audio: string; warnings: string[]; stopWhen: string[] }
  | { status: "blocked"; reason: string; alternative: string | null };

/** Codec → container, for MediaRecorder. Sourced from MIME candidates the caller probed. */
export const RECORDER_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"] as const;

export function planCapture(req: CaptureRequest, env: { secureContext: boolean; hasDisplayMedia: boolean; hasRecorder: boolean; hasPeerConnection: boolean }): CapturePlan {
  if (!env.secureContext) return { status: "blocked", reason: "capture needs a secure context (https or localhost)", alternative: null };
  if (!env.hasDisplayMedia) return { status: "blocked", reason: "this browser has no screen-capture API, so there is nothing to send", alternative: null };
  if (req.surface === "screen" && req.goal === "cast") {
    return { status: "blocked", reason: "a whole-screen capture has no address a receiver can fetch; a cast needs a URL", alternative: "Record the screen to a file, save it to Files, then cast the saved file." };
  }
  if (req.codecOk === false && (req.goal === "record" || req.goal === "cast")) {
    return { status: "blocked", reason: "no supported recording codec was found, so the stream could not be saved", alternative: "A live WebRTC peer needs no codec probe; use that if a peer is available." };
  }
  const warnings: string[] = [];
  if (req.audioRequested && req.surface === "window") warnings.push("Window and screen picks can only include audio on some platforms, and only when the picker's “share audio” box is ticked. The page cannot tick it.");
  if (req.audioRequested && req.surface === "tab") warnings.push("Tab audio is included only if “share tab audio” was ticked in the picker; if it was not, the recording is silent and will say so.");
  if (req.limitSec != null && req.limitSec <= 0) return { status: "blocked", reason: "a limit of zero seconds would record nothing", alternative: null };

  const tracks = ["video"];
  if (req.audioRequested) tracks.push("audio");

  if (req.goal === "webrtc") {
    if (!env.hasPeerConnection) return { status: "blocked", reason: "this browser has no RTCPeerConnection, so a live peer cannot receive the track", alternative: "Record to a file instead." };
    return {
      status: "ready", mechanism: "getDisplayMedia → RTCPeerConnection.addTrack", tracks,
      audio: req.audioRequested ? "the audio track is sent only if the picker produced one; the receiver hears exactly what was captured" : "no audio track was requested",
      warnings: [...warnings, "A WebRTC stream is peer-to-peer: stopping the capture ends it, and the peer keeps no copy unless it records."],
      stopWhen: ["the user stops the share from the browser's own bar", "the captured surface closes", req.limitSec != null ? `${req.limitSec} s limit reached` : "the page releases the tracks"],
    };
  }
  if (req.goal === "local-view") {
    return {
      status: "ready", mechanism: "getDisplayMedia → a local <video> / picture-in-picture", tracks, audio: "played locally", warnings,
      stopWhen: ["the capture ends", "the element is detached"],
    };
  }
  if (req.goal === "cast") {
    return { status: "blocked", reason: "a live capture cannot be cast: the receiver fetches a URL and a MediaStream has none", alternative: "Record first, then cast the recorded file." };
  }
  if (!env.hasRecorder) return { status: "blocked", reason: "this browser has no MediaRecorder, so the stream cannot be written to a file", alternative: "Show it locally, or send it to a WebRTC peer." };
  return {
    status: "ready", mechanism: "getDisplayMedia → MediaRecorder → a file in Files", tracks,
    audio: req.audioRequested ? "audio is included only when the picker produced an audio track; otherwise the file is video-only and the UI says so" : "video only",
    warnings,
    stopWhen: ["the user stops the share", "the captured surface closes", req.limitSec != null ? `${req.limitSec} s limit reached` : "the user presses Stop"],
  };
}

/** A recording file name that says what it is, without inventing a timestamp source. */
export function captureName(surface: CaptureRequest["surface"], startedAt: number): string {
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  return `Capture ${surface} ${stamp}.webm`;
}
