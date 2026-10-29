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

const announce = () => { snapshot = [...live]; for (const f of listeners) f(); };

export function registerProxySession(sid: string): void { if (sid && !live.has(sid)) { live.add(sid); announce(); } }
export function unregisterProxySession(sid: string): void { if (live.delete(sid)) announce(); }
export function proxySessionsSnapshot(): string[] { return snapshot; }
export function subscribeProxySessions(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
