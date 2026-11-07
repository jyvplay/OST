/**
 * TT143 (CT-05) — "remote desktop" without lying about it.
 *
 * A browser cannot be an RDP or VNC client: neither protocol is reachable from a
 * page (raw TCP is unavailable, and TLS-wrapped RDP needs a transport a page does
 * not have). What a page *can* do is the two honest things:
 *
 *   1. **WebRTC screen sharing from a cooperating peer** — a real remote screen,
 *      streamed by a host that chose to share it, which is what the Streams module
 *      already negotiates; and
 *   2. **a link out to the platform's own client**, named so the user is not sent
 *      to a random URL.
 *
 * So this engine classifies a request into `stream` (WebRTC, allowed), `handoff`
 * (an external client, with its scheme named and its risks stated) or `blocked`
 * (an unsupported protocol, with the reason). The interesting part is the middle
 * one: `rdp://` and `vnc://` are *not* registered schemes on most systems — a
 * `vnc://` link on a machine without a handler silently does nothing, so the
 * engine says "copy this address" instead of rendering a link that would appear
 * to work.
 */

export type RemoteKind = "webrtc" | "rdp" | "vnc" | "ssh" | "nomachine" | "unknown";
export type RemoteVerdict =
  | { status: "stream"; kind: "webrtc"; note: string }
  | { status: "handoff"; kind: RemoteKind; scheme: string; address: string; note: string }
  | { status: "copy"; kind: RemoteKind; address: string; note: string }
  | { status: "blocked"; kind: RemoteKind; reason: string; alternative: string | null };

/** Schemes that are commonly registered by a client on the three desktop OSes. */
const REGISTERED: Record<string, string> = {
  "rdp://": "Windows Remote Desktop",
  "ssh://": "the system SSH handler",
  "nx://": "NoMachine",
};
/** Schemes that a client uses but that are usually NOT registered system-wide. */
const UNREGISTERED = new Set(["vnc://", "rdp+tls://"]);

export function planRemote(input: string): RemoteVerdict {
  const raw = input.trim();
  if (!raw) return { status: "blocked", kind: "unknown", reason: "no address was given", alternative: null };
  const lower = raw.toLowerCase();
  for (const scheme of Object.keys(REGISTERED)) {
    if (lower.startsWith(scheme)) return { status: "handoff", kind: scheme.slice(0, -3) as RemoteKind, scheme, address: raw, note: `Opens ${REGISTERED[scheme]} if it is installed. A web page cannot speak ${scheme.slice(0, -3).toUpperCase()} itself: the protocol needs raw TCP, which the page does not have.` };
  }
  for (const scheme of UNREGISTERED) {
    if (lower.startsWith(scheme)) return { status: "copy", kind: scheme.slice(0, -3) as RemoteKind, address: raw, note: `“${scheme}” is rarely registered as a system handler, so a link would do nothing. The address is put on the clipboard instead.` };
  }
  if (lower.startsWith("webrtc:") || lower.startsWith("stream:")) {
    return { status: "stream", kind: "webrtc", note: "A peer that offers a share is the only real remote screen a web app can show; the picture is the host's, sent deliberately." };
  }
  if (/^(https?|wss?):\/\//.test(lower)) {
    return { status: "blocked", kind: "unknown", reason: "an http address is a web page, not a remote desktop; opening it in a window would just nest a page", alternative: "Open it in the Browser module, or use a WebRTC stream if a host is sharing." };
  }
  return { status: "blocked", kind: "unknown", reason: `“${raw.slice(0, 40)}” is not an address this app recognises`, alternative: null };
}

/** Redact a credential from a connection string before it is ever displayed. */
export function redactAddress(address: string): string {
  return address.replace(/\/\/[^/@\s]+@/, "//***@").replace(/(password=)[^&;\s]+/gi, "$1***");
}

/** Which controls a stream session exposes; the shell renders exactly these. */
export function streamControls(kind: "view" | "control"): { id: string; label: string; needs: string }[] {
  return kind === "control"
    ? [
      { id: "pointer", label: "Pointer", needs: "the host's data channel accepts pointer events" },
      { id: "keyboard", label: "Keyboard", needs: "the host's data channel accepts key events and the page has focus" },
      { id: "clipboard", label: "Clipboard", needs: "an explicit paste action on both sides; the web cannot sync clipboards silently" },
    ]
    : [{ id: "view", label: "View only", needs: "nothing beyond the peer's track" }];
}
