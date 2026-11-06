/**
 * TT137 (CA-15) — Multi-receiver synchronised playback.
 *
 * Pure synchronisation state machine for multi-device playback.
 * No network I/O — just the policy and state layer.
 */

export interface Receiver {
  id: string;
  label: string;
  /** Whether the receiver is currently playing. */
  playing: boolean;
  /** Current playback position in ms. */
  positionMs: number;
  /** Whether the receiver is in sync with the leader. */
  inSync: boolean;
  /** Latency to the leader in ms (positive = ahead, negative = behind). */
  offsetMs: number;
  /** Last sync time (epoch ms). */
  lastSync: number;
}

export interface SyncState {
  leader: string;
  receivers: Map<string, Receiver>;
  /** Playback position of the leader in ms. */
  leaderPositionMs: number;
  /** Whether playback is running. */
  running: boolean;
}

export const SYNC_DRIFT_LIMIT_MS = 200;

export function createSync(): SyncState {
  return { leader: "", receivers: new Map(), leaderPositionMs: 0, running: false };
}

export function addReceiver(state: SyncState, id: string, label: string, now: number): { ok: true } | { ok: false; reason: string } {
  if (!/^r-[a-z0-9-]{1,32}$/.test(id)) throw new Error("Receiver id invalid");
  if (state.receivers.has(id)) return { ok: false, reason: `Receiver ${id} already exists` };
  state.receivers.set(id, { id, label, playing: false, positionMs: 0, inSync: true, offsetMs: 0, lastSync: now });
  return { ok: true };
}

export function setLeader(state: SyncState, id: string): { ok: true } | { ok: false; reason: string } {
  if (!state.receivers.has(id)) return { ok: false, reason: `Receiver ${id} not found` };
  state.leader = id;
  state.leaderPositionMs = state.receivers.get(id)!.positionMs;
  return { ok: true };
}

export function startPlayback(state: SyncState, now: number): { ok: true } | { ok: false; reason: string } {
  if (!state.leader) return { ok: false, reason: "No leader set" };
  state.running = true;
  const leader = state.receivers.get(state.leader)!;
  leader.playing = true;
  for (const r of state.receivers.values()) {
    if (r.id !== state.leader) r.playing = true;
  }
  return { ok: true };
}

export function stopPlayback(state: SyncState): { ok: true } | { ok: false; reason: string } {
  state.running = false;
  for (const r of state.receivers.values()) r.playing = false;
  return { ok: true };
}

/** Advance the leader's position and re-sync all receivers. */
export function advance(state: SyncState, elapsedMs: number, now: number): { ok: true; drift: Record<string, number> } | { ok: false; reason: string } {
  if (!state.running) return { ok: false, reason: "Playback not running" };
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Elapsed must be non-negative");
  state.leaderPositionMs += elapsedMs;
  const leader = state.receivers.get(state.leader)!;
  leader.positionMs = state.leaderPositionMs;
  leader.lastSync = now;

  const drift: Record<string, number> = {};
  for (const r of state.receivers.values()) {
    if (r.id === state.leader) continue;
    r.positionMs += elapsedMs;
    r.offsetMs = r.positionMs - state.leaderPositionMs;
    r.inSync = Math.abs(r.offsetMs) <= SYNC_DRIFT_LIMIT_MS;
    r.lastSync = now;
    drift[r.id] = Math.round(r.offsetMs);
  }
  return { ok: true, drift };
}

/** Nudge a receiver to catch up or slow down. */
export function nudge(state: SyncState, receiverId: string, deltaMs: number): { ok: true } | { ok: false; reason: string } {
  const r = state.receivers.get(receiverId);
  if (!r) return { ok: false, reason: `Receiver ${receiverId} not found` };
  if (!Number.isFinite(deltaMs)) throw new Error("Delta must be finite");
  r.positionMs += deltaMs;
  r.offsetMs = r.positionMs - state.leaderPositionMs;
  r.inSync = Math.abs(r.offsetMs) <= SYNC_DRIFT_LIMIT_MS;
  return { ok: true };
}

export interface SyncReport {
  total: number;
  inSync: number;
  outOfSync: number;
  drift: { id: string; label: string; offsetMs: number; inSync: boolean }[];
}

export function reportSync(state: SyncState): SyncReport {
  const receivers = [...state.receivers.values()];
  const drift = receivers.filter((r) => r.id !== state.leader).map((r) => ({
    id: r.id, label: r.label, offsetMs: Math.round(r.offsetMs), inSync: r.inSync,
  }));
  const inSync = drift.filter((d) => d.inSync).length;
  return { total: receivers.length, inSync, outOfSync: drift.length - inSync, drift };
}

export function describeSync(state: SyncState): string {
  const r = reportSync(state);
  return `${r.inSync}/${r.total} receivers in sync (drift limit ${SYNC_DRIFT_LIMIT_MS}ms)`;
}
