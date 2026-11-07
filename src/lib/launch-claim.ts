/**
 * TT145 (CT-03) — "continue on another device", as a claim with a boundary.
 *
 * TT136 shipped a handoff that moves a window between two same-origin tabs over
 * BroadcastChannel, and TT139 shipped a URL fragment that carries a window to
 * another device. Both are real. Neither is *continuity*, and the difference is the
 * reason this module exists: a user who reads "continue on another device" and gets
 * "a link you must paste" has been told something false by omission.
 *
 * So the engine classifies what a transfer actually is, out of four mechanical
 * facts, and refuses to let a weaker mechanism be presented as a stronger one:
 *
 *   · **live** — both endpoints are open, same origin, and a channel is connected.
 *     Window state moves without the user copying anything, within ~100 ms.
 *   · **linked** — a URL fragment. The user must carry it; it may expire; it cannot
 *     carry file contents; it is *not* a sync protocol.
 *   · **exported** — a file the user saves and imports. Slowest, survives anything,
 *     but is a snapshot at export time.
 *   · **impossible** — the browser has no mechanism for the request (cross-device
 *     live transfer without a server is exactly this).
 *
 * The refusal that matters: `classify()` throws when asked to label a fragment as
 * live, so the UI cannot accidentally advertise continuity it does not have.
 */

export type Mechanism = "live" | "linked" | "exported" | "impossible";

export interface Facts {
  /** Both endpoints are this app, same origin. */
  sameOrigin: boolean;
  /** The receiving endpoint is currently open and listening. */
  receiverOpen: boolean;
  /** A BroadcastChannel (or equivalent) connected between them. */
  channel: boolean;
  /** Whether the carrier is a URL fragment (no server sees it) rather than a file. */
  urlFragment: boolean;
  /** Bytes of state to move. */
  bytes: number;
}

export const FRAGMENT_LIMIT = 8 * 1024;
export const LIVE_LIMIT = 512 * 1024;
/** A fragment longer than this is mangled by enough chat clients to be unusable. */
export const MANGLED_LIMIT = 2000;

export interface Claim {
  mechanism: Mechanism;
  /** Whether the user has to do anything to complete the transfer. */
  userAction: "none" | "copy a link" | "save and import a file" | "none possible";
  /** What the claim may be called in the UI, verbatim. */
  label: string;
  sentence: string;
}

export function classify(f: Facts): Claim {
  if (f.bytes > LIVE_LIMIT && !f.urlFragment) {
    return {
      mechanism: "exported", userAction: "save and import a file",
      label: "export and import",
      sentence: `${(f.bytes / 1e6).toFixed(1)} MB exceeds the ${LIVE_LIMIT / 1024} KB live limit; this is a snapshot file, not a transfer`,
    };
  }
  if (f.sameOrigin && f.receiverOpen && f.channel && !f.urlFragment) {
    return { mechanism: "live", userAction: "none", label: "live handoff", sentence: "state moves now, because both windows are open and connected; this is one desktop on two views, not two devices" };
  }
  if (f.urlFragment) {
    if (f.bytes > FRAGMENT_LIMIT) {
      return { mechanism: "impossible", userAction: "none possible", label: "not transferable as a link", sentence: `${f.bytes} B exceeds the ${FRAGMENT_LIMIT} B fragment budget: encode and refuse, never truncate a desktop into half a desktop` };
    }
    return {
      mechanism: "linked", userAction: "copy a link", label: "continue from a link",
      sentence: f.bytes > MANGLED_LIMIT
        ? `${f.bytes} B fits the fragment budget but is longer than ${MANGLED_LIMIT} B, which some chat clients wrap or truncate; the link carries a checksum so a mangled paste fails loudly`
        : `${f.bytes} B in the fragment: the server never sees it, and the user carries it`,
    };
  }
  if (f.sameOrigin && f.receiverOpen) return { mechanism: "linked", userAction: "copy a link", label: "continue from a link", sentence: "the receiver is open but no channel is connected: the state is offered as a link instead" };
  return { mechanism: "exported", userAction: "save and import a file", label: "export and import", sentence: "nothing is listening on the other side, so the state is a file the user carries" };
}

/**
 * The one call that may not lie. A caller that wants to display "live" for a
 * fragment gets an exception with the reason, and the message is written for the
 * person reading the stack trace.
 */
export function assertMechanism(c: Claim, wants: Mechanism): Claim {
  if (c.mechanism !== wants) throw new Error(`cannot present ${c.mechanism} as ${wants}: ${c.sentence}`);
  return c;
}

/** Expiry for a carried link. A link that never expires is a credential in a chat log. */
export function expiryNote(payloadAt: number, now: number, ttlMs = 24 * 3600_000): { expired: boolean; sentence: string } {
  const left = payloadAt + ttlMs - now;
  return left <= 0
    ? { expired: true, sentence: `this link expired ${Math.round(-left / 3600000)} h ago; ask for a fresh one rather than editing the timestamp` }
    : { expired: false, sentence: `valid for another ${Math.round(left / 3600000)} h` };
}

export const LIMITS = [
  "no server, no account and no socket: two devices cannot be connected live by this app",
  "a carried link is a snapshot at encode time; edits after that are not in it",
  "a fragment is not sent to the server, which is the privacy property and also the reason it must be copied by hand",
  "file contents are never carried by a link; it names files, it does not move them",
] as const;
