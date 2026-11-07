/**
 * TT143 (MD-06) — audio output routing, told truthfully.
 *
 * `HTMLMediaElement.setSinkId()` is the only web API that picks an output device,
 * and it has three limits that decide the whole design:
 *
 *   1. it needs a **secure context** and a permission prompt in Chromium
 *      (`speaker-selection`); Firefox does not implement it at all;
 *   2. it fails on an element whose source is a **cross-origin** media stream
 *      without CORS, because routing would let a page observe which device is
 *      sampled;
 *   3. it moves **one element**, not the system: a page cannot change where the
 *      OS or another app plays sound.
 *
 * So the engine resolves a request into `ready`, `unsupported` or `refused` with
 * the specific cause, and the UI lists devices from `enumerateDevices()` filtered
 * to `audiooutput` — with the honest note that device *labels* are empty until a
 * microphone or camera permission has been granted, which is a privacy feature of
 * the platform and not a bug to work around.
 */

export interface AudioDevice { deviceId: string; label: string; groupId?: string }
export type RouteVerdict =
  | { status: "ready"; deviceId: string; note: string }
  | { status: "default"; note: string }
  | { status: "unsupported"; reason: string }
  | { status: "refused"; reason: string };

export function planRoute(deviceId: string, env: { secureContext: boolean; hasSetSinkId: boolean; permission: "granted" | "denied" | "prompt"; crossOriginSource: boolean; isStream: boolean }): RouteVerdict {
  if (!env.secureContext) return { status: "unsupported", reason: "output routing needs a secure context" };
  if (!env.hasSetSinkId) return { status: "unsupported", reason: "this browser has no setSinkId, so a page cannot choose an output device (Firefox, and Safari before 17)" };
  if (!deviceId || deviceId === "default") return { status: "default", note: "the system default output; choosing it needs no permission" };
  if (env.crossOriginSource || env.isStream) return { status: "refused", reason: "a cross-origin stream or a live capture cannot be re-routed: the platform blocks it so a page cannot probe which device is listening" };
  if (env.permission === "denied") return { status: "refused", reason: "the user denied the speaker-selection permission for this site" };
  return { status: "ready", deviceId, note: "a device picker may still appear the first time; the choice is remembered per origin" };
}

/** Why the labels are empty, in the words a support page can use. */
export function labelNote(devices: readonly AudioDevice[]): string | null {
  if (!devices.length) return "No output devices are listed: the browser hides them until a media permission has been granted on this origin.";
  if (devices.every((d) => !d.label)) return "Device labels are hidden until a microphone or camera permission is granted; the ids still work, so choosing one is possible without revealing what it is.";
  return null;
}

/** Group outputs that the platform reports as one physical device (e.g. HDMI + jack). */
export function groupDevices(devices: readonly AudioDevice[]): { group: string; devices: AudioDevice[] }[] {
  const byGroup = new Map<string, AudioDevice[]>();
  for (const d of devices) {
    const g = d.groupId ?? "";
    byGroup.set(g, [...(byGroup.get(g) ?? []), d]);
  }
  return [...byGroup.entries()].map(([group, ds]) => ({ group, devices: ds }));
}
