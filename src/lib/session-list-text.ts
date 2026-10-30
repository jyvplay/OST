/** BM-02: the Beam session journal as text, newest first (the order the
 *  list shows). Ended sessions say so; active ones carry their elapsed
 *  time from BM-01's instant math, not a stored counter. */
import { elapsedLabel } from "./elapsed";
export interface SessionLike { transport: string; targetName: string; state: string; startedAt: string }
export function sessionListText(sessions: readonly SessionLike[], nowMs: number): string {
  if (!sessions.length) return "(no sessions)";
  return [...sessions].reverse().map((s) => {
    const started = new Date(s.startedAt).getTime();
    const elapsed = s.state === "active" && Number.isFinite(started) ? ` · up ${elapsedLabel(started, nowMs)}` : "";
    return `${s.transport} → ${s.targetName} · ${s.state}${elapsed}`;
  }).join("\n");
}
