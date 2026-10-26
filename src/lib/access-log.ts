/**
 * TT72 SC-05 — device-access log for the Privacy dashboard. Original code.
 *
 * Every request for the camera, microphone, screen, clipboard contents or location made by a Fusion module goes
 * through these wrappers, which record WHEN, WHICH MODULE, WHAT, and the OUTCOME (granted / denied / failed), and keep
 * granted streams "live" until their last track ends — including tracks stopped by code (MediaStreamTrack.stop() fires no
 * "ended" event, so stop is wrapped).
 *
 * Privacy: the log lives in this tab's memory only (amnesic like the rest of RAM state) — it is never sent to the server,
 * never written to storage, and it records no content (no clipboard text, no coordinates, no frames). Clear empties it.
 */
export type AccessKind = "camera" | "microphone" | "screen" | "clipboard-read" | "location";
export type Outcome = "granted" | "denied" | "failed";
export interface AccessEntry { id: number; at: number; app: string; kinds: AccessKind[]; outcome: Outcome; error?: string; endedAt?: number; live: boolean }

export const MAX_ENTRIES = 200;
let entries: AccessEntry[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const stops = new Map<number, () => void>();
const emit = () => { for (const f of subs) f(); };

export function subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
/** newest first */
export function snapshot(): readonly AccessEntry[] { return entries; }
export function clearLog(): void { entries = entries.filter((e) => e.live); emit(); }

/** "denied" is the user's (or policy's) refusal; anything else that throws is a failure (no device, aborted…). */
export function outcomeOf(err: unknown): { outcome: Outcome; error: string } {
  const name = (err as { name?: string })?.name ?? "Error";
  return { outcome: name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" ? "denied" : "failed", error: name };
}

export function record(app: string, kinds: AccessKind[], outcome: Outcome, error?: string, live = false): AccessEntry {
  const e: AccessEntry = { id: nextId++, at: Date.now(), app: app.slice(0, 60) || "Unknown", kinds, outcome, ...(error ? { error } : {}), live };
  entries = [e, ...entries].slice(0, MAX_ENTRIES);
  // an evicted live entry keeps its stop hook only while it is listed
  for (const id of [...stops.keys()]) if (!entries.some((x) => x.id === id)) stops.delete(id);
  emit();
  return e;
}

function end(id: number) {
  const i = entries.findIndex((e) => e.id === id && e.live);
  stops.delete(id);
  if (i < 0) return;
  entries = entries.map((e, j) => (j === i ? { ...e, live: false, endedAt: Date.now() } : e));
  emit();
}

/** Track a granted stream: the entry stays live until EVERY track has ended or been stopped. */
export function track(entry: AccessEntry, stream: MediaStream): MediaStream {
  const tracks = stream.getTracks();
  if (!tracks.length) { end(entry.id); return stream; }
  let left = tracks.length;
  const done = new Set<MediaStreamTrack>();
  const one = (t: MediaStreamTrack) => { if (done.has(t)) return; done.add(t); left -= 1; if (left === 0) end(entry.id); };
  for (const t of tracks) {
    t.addEventListener("ended", () => one(t));
    const stop = t.stop.bind(t);
    t.stop = () => { stop(); one(t); };
  }
  stops.set(entry.id, () => { for (const t of tracks) t.stop(); });
  return stream;
}

/** Stop a live entry's devices from the dashboard. */
export function stopLive(id: number): boolean { const s = stops.get(id); if (!s) return false; s(); return true; }

export const kindsOf = (c: MediaStreamConstraints): AccessKind[] => [...(c.video ? ["camera" as const] : []), ...(c.audio ? ["microphone" as const] : [])];

export async function userMedia(app: string, c: MediaStreamConstraints): Promise<MediaStream> {
  const kinds = kindsOf(c);
  try {
    const s = await navigator.mediaDevices.getUserMedia(c);
    return track(record(app, kinds, "granted", undefined, true), s);
  } catch (err) { const o = outcomeOf(err); record(app, kinds, o.outcome, o.error); throw err; }
}

export async function displayMedia(app: string, c?: DisplayMediaStreamOptions): Promise<MediaStream> {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia(c);
    const kinds: AccessKind[] = ["screen", ...(s.getAudioTracks().length ? ["microphone" as const] : [])];
    return track(record(app, kinds, "granted", undefined, true), s);
  } catch (err) { const o = outcomeOf(err); record(app, ["screen"], o.outcome, o.error); throw err; }
}

export async function clipboardRead(app: string): Promise<string> {
  try { const t = await navigator.clipboard.readText(); record(app, ["clipboard-read"], "granted"); return t; }
  catch (err) { const o = outcomeOf(err); record(app, ["clipboard-read"], o.outcome, o.error); throw err; }
}

export function location(app: string, ok: (p: GeolocationPosition) => void, fail: (e: GeolocationPositionError) => void, opts?: PositionOptions): void {
  navigator.geolocation.getCurrentPosition(
    (p) => { record(app, ["location"], "granted"); ok(p); },
    (e) => { record(app, ["location"], e.code === e.PERMISSION_DENIED ? "denied" : "failed", e.code === e.PERMISSION_DENIED ? "PermissionDenied" : e.code === e.TIMEOUT ? "Timeout" : "PositionUnavailable"); fail(e); },
    opts,
  );
}

/** test hook: reset (unit tests only) */
export function _reset(): void { entries = []; nextId = 1; stops.clear(); emit(); }
