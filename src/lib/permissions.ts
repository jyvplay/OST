/**
 * TT56 (SC-03) — permission audit over the FULL permission-name list (W3C Permissions registry + the names Chromium
 * implements), not just the ones Fusion uses: anything Fusion never asks for should read "prompt" forever, which is the
 * visible proof of least privilege. `USED_BY_FUSION` is derived from the API calls present in src/ (checked by the test).
 */
export const PERMISSION_NAMES = [
  "accelerometer", "ambient-light-sensor", "background-fetch", "background-sync", "bluetooth", "camera", "captured-surface-control",
  "clipboard-read", "clipboard-write", "display-capture", "geolocation", "gyroscope", "idle-detection", "keyboard-lock", "local-fonts",
  "magnetometer", "microphone", "midi", "nfc", "notifications", "payment-handler", "periodic-background-sync", "persistent-storage",
  "pointer-lock", "push", "screen-wake-lock", "speaker-selection", "storage-access", "system-wake-lock", "top-level-storage-access",
  "window-management",
] as const;
/** Permissions some Fusion feature may request — always at the moment of first use (DP-11). */
export const USED_BY_FUSION: Record<string, string> = {
  camera: "Capture, Lens, Together (only when you start them)",
  microphone: "Capture, Together (only when you start them)",
  "display-capture": "Capture, Together, Share (screen sharing)",
  "clipboard-read": "Paste in editors / Clipboard module",
  "clipboard-write": "Copy in editors",
  notifications: "Alerts (only if you enable desktop notifications)",
  "persistent-storage": "Storage (asks the browser not to evict local data)",
  "window-management": "Multi-screen placement",
  "screen-wake-lock": "Presenting / media playback",
  geolocation: "Maps “locate me”",
  bluetooth: "Devices (pairing a device you choose)",
};
export type PermState = "granted" | "denied" | "prompt" | "not queryable";
export interface PermRow { name: string; state: PermState; used: string | null }
export async function auditPermissions(perms: Permissions | undefined = typeof navigator !== "undefined" ? navigator.permissions : undefined): Promise<PermRow[]> {
  return Promise.all(PERMISSION_NAMES.map(async (name): Promise<PermRow> => {
    const used = USED_BY_FUSION[name] ?? null;
    if (!perms) return { name, state: "not queryable", used };
    try {
      // push must be queried with userVisibleOnly in Chromium (it rejects the bare descriptor)
      const desc = (name === "push" ? { name, userVisibleOnly: true } : { name }) as PermissionDescriptor;
      const s = await perms.query(desc);
      return { name, state: s.state as PermState, used };
    } catch { return { name, state: "not queryable", used }; }
  }));
}
