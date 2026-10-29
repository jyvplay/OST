/**
 * TT111 (RC-37) — which proxy sessions are alive in this window.
 *
 * The media tap is per browsing session, and the sessions are owned by the frames that minted them.
 * Recall is a different window, so it needs a way to ask "what is this desktop browsing right now?"
 * without reaching into another component's state. A tiny module-level registry does that honestly:
 * a frame registers while it is mounted and withdraws when it goes, so a listing can never show the
 * held media of a session that has already been closed.
 */
const live = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: string[] = [];

/**
 * TT112 (RC-38) — the frame each live session is painting into.
 *
 * Objects a page holds itself (blob: / data:) can only be read by that document, and the document
 * runs in an opaque-origin sandbox, so the only way to ask it anything is to post a message to its
 * own window. The frame registers that window here while it is mounted; Recall asks the registry
 * rather than reaching into another component, and a window that has gone simply is not listed.
 */
const windows = new Map<string, Window>();

const announce = () => { snapshot = [...live]; for (const f of listeners) f(); };

export function registerProxySession(sid: string, win?: Window | null): void {
  if (!sid) return;
  if (win) windows.set(sid, win);
  if (!live.has(sid)) { live.add(sid); announce(); }
}
export function unregisterProxySession(sid: string): void { windows.delete(sid); if (live.delete(sid)) announce(); }
/** The frame window of a live session, or null when nothing is open for it any more. */
export function proxyWindowFor(sid: string): Window | null {
  const w = windows.get(sid);
  if (!w) return null;
  try { if (w.closed) { windows.delete(sid); return null; } } catch { return null; }
  return w;
}
export function proxySessionsSnapshot(): string[] { return snapshot; }
export function subscribeProxySessions(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
