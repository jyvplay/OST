/**
 * Per-page inventory of Fusion-owned foreground background work.
 *
 * This records callbacks that actually ran in this JavaScript page. It is
 * deliberately in memory only: counts reset on reload and do not leave the
 * browser or imply that a timer ran while the page was suspended. Browser
 * service-worker / Background Sync registrations are queried separately from
 * the browser's live APIs in the Apps module.
 */
export type BackgroundJobId = "planner-reminders" | "routine-triggers" | "offline-replay";
export interface BackgroundJobDefinition {
  id: BackgroundJobId;
  title: string;
  trigger: string;
  scope: string;
  data: string;
}
export interface BackgroundJobSnapshot extends BackgroundJobDefinition {
  callbacks: number;
  lastAt: number | null;
  lastStatus: string;
}
export type BackgroundJobListener = (jobs: BackgroundJobSnapshot[]) => void;

export const BACKGROUND_JOBS: readonly BackgroundJobDefinition[] = [
  {
    id: "planner-reminders",
    title: "Planner reminder check",
    trigger: "30-second page timer",
    scope: "Fusion tab while its JavaScript is running; governor may pause work",
    data: "Reads due task rows; only due reminders create an alert/notification.",
  },
  {
    id: "routine-triggers",
    title: "Routine trigger check",
    trigger: "60-second page timer",
    scope: "Fusion tab while its JavaScript is running; governor may pause work",
    data: "Reads enabled routines and runs due local actions; browser may throttle or suspend the page.",
  },
  {
    id: "offline-replay",
    title: "Offline write replay check",
    trigger: "Shell startup and browser online event",
    scope: "Foreground only; queued writes remain stored until the server accepts them",
    data: "Replays the app's own queued writes through the journal; rejected writes remain queued.",
  },
] as const;

const state = new Map<BackgroundJobId, { callbacks: number; lastAt: number | null; lastStatus: string }>(
  BACKGROUND_JOBS.map((job) => [job.id, { callbacks: 0, lastAt: null, lastStatus: "not run in this page" }]),
);
const listeners = new Set<BackgroundJobListener>();

function snapshot(): BackgroundJobSnapshot[] {
  return BACKGROUND_JOBS.map((job) => ({ ...job, ...(state.get(job.id) ?? { callbacks: 0, lastAt: null, lastStatus: "not run in this page" }) }));
}
function publish(): void {
  const value = snapshot();
  for (const listener of listeners) listener(value);
}

/** Increment only at a real callback entry; the label is intentionally not "OS wake count". */
export function recordBackgroundCallback(id: BackgroundJobId, status: string): void {
  const old = state.get(id);
  if (!old) return;
  state.set(id, { callbacks: old.callbacks + 1, lastAt: Date.now(), lastStatus: String(status).slice(0, 240) });
  publish();
}

export function updateBackgroundStatus(id: BackgroundJobId, status: string): void {
  const old = state.get(id);
  if (!old) return;
  state.set(id, { ...old, lastAt: Date.now(), lastStatus: String(status).slice(0, 240) });
  publish();
}

export function getBackgroundInventory(): BackgroundJobSnapshot[] { return snapshot(); }

export function subscribeBackgroundInventory(listener: BackgroundJobListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
