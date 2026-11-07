/**
 * TT143 (AP-05) — what this app keeps running in the background, measured.
 *
 * A web app has exactly five background mechanisms and they are not
 * interchangeable; conflating them is how "background sync" turns into a promise
 * the platform never made:
 *
 *   1. **Service worker** — runs without a page, but only while the browser runs
 *      it and only for events it was woken for. It is not a daemon.
 *   2. **Periodic Background Sync** — Chromium-only, requires an installed
 *      context and a `periodicSync` permission, and its `minInterval` is a
 *      **floor the browser may ignore**. It is a suggestion, never a schedule.
 *   3. **Background Fetch** — a browser-managed download that survives the page;
 *      it reports progress events and a result, but it is not a queue the page
 *      controls tick-by-tick.
 *   4. **Web Push** — needs a push service and a server; this app has no server
 *      it does not run itself, so it is listed as unavailable rather than faked.
 *   5. **Timers in a live page** — throttled to ≥1 s in a hidden tab and frozen
 *      after minutes on mobile; fine for a clock, useless for a schedule.
 *
 * The inventory reports each mechanism with its *measured* availability, the
 * event it delivers, its real guarantee, and the count of deliveries actually
 * observed in this session. A count is a measurement, not a promise; the engine
 * never derives a "wake-up rate" from it.
 */

export type Mechanism = "service-worker" | "periodic-sync" | "background-fetch" | "push" | "page-timer";
export interface Availability {
  mechanism: Mechanism;
  available: boolean;
  /** What actually wakes it, in one phrase. */
  wokenBy: string;
  /** The strongest true statement about its timing. */
  guarantee: string;
  /** Why it is unavailable, when it is. */
  why: string | null;
}
export interface InventoryEntry extends Availability {
  /** Events observed in this session, as counted by the page. Not a rate. */
  observed: number;
  lastAt: number | null;
}

/** Fresh entries always carry a zero count; an unset count is what a UI shows as a blank. */
export function inventory(env: {
  serviceWorker: boolean;
  installed: boolean;
  periodicSyncApi: boolean;
  backgroundFetchApi: boolean;
  pushApi: boolean;
  /** A push service (and VAPID keys) configured for this deployment. */
  pushService?: boolean;
  visibilityHidden: boolean;
}): Availability[] {
  const base = (): { observed: number; lastAt: number | null } => ({ observed: 0, lastAt: null });
  return [
    {
      ...base(),
      mechanism: "service-worker",
      available: env.serviceWorker,
      wokenBy: "a fetch, a push, a sync tag, or the browser's own decision to validate the shell",
      guarantee: "the browser decides when to stop it; a page cannot keep it alive",
      why: env.serviceWorker ? null : "this browser exposes no navigator.serviceWorker",
    },
    {
      ...base(),
      mechanism: "periodic-sync",
      available: env.periodicSyncApi && env.installed,
      wokenBy: "the browser's (or the OS's) periodic wake, when it chooses to",
      guarantee: "minInterval is a floor the browser may ignore entirely; there is no promised cadence",
      why: !env.periodicSyncApi ? "no periodicSync API in this browser" : !env.installed ? "periodic sync requires the app to be installed" : null,
    },
    {
      ...base(),
      mechanism: "background-fetch",
      available: env.backgroundFetchApi,
      wokenBy: "the browser's download manager",
      guarantee: "progress and a final result are delivered; the page is not resumed between them",
      why: env.backgroundFetchApi ? null : "no Background Fetch API in this browser",
    },
    {
      ...base(),
      mechanism: "push",
      available: env.pushApi && env.pushService === true,
      wokenBy: "a push service, which needs a server and VAPID keys this app does not have",
      guarantee: "delivery is best-effort and gated by the browser's own push budget",
      why: env.pushApi ? "the API exists, but there is no push service or VAPID key configured for this deployment, so no subscription can be made" : "no Push API in this browser",
    },
    {
      ...base(),
      mechanism: "page-timer",
      available: true,
      wokenBy: "the page's own timer while it is open",
      guarantee: env.visibilityHidden ? "a hidden tab is throttled to at least 1 s, and may be frozen; a timer is not a schedule" : "runs while the tab is visible",
      why: null,
    },
  ];
}

/** Fold an observed event into the inventory. Only mechanisms that were available count. */
export function record(entries: readonly InventoryEntry[], mechanism: Mechanism, at: number): InventoryEntry[] {
  return entries.map((e) => (e.mechanism === mechanism && e.available ? { ...e, observed: e.observed + 1, lastAt: at } : e));
}

/** A single sentence a user can act on. */
export function summary(entries: readonly InventoryEntry[]): string {
  const live = entries.filter((e) => e.available).map((e) => e.mechanism);
  const observed = entries.reduce((n, e) => n + e.observed, 0);
  if (!live.length) return "Nothing can run in the background here: no service worker and no scheduling API.";
  return `${live.length} background mechanisms are available (${live.join(", ")}); ${observed} event${observed === 1 ? "" : "s"} observed this session. Observing an event is not a promise that the next one arrives.`;
}

/** Which mechanism to use for a stated need — and never a stronger one than the need. */
export function chooseFor(need: "refresh-while-open" | "survive-a-reload" | "large-download" | "daily-check", entries: readonly InventoryEntry[]): { mechanism: Mechanism | null; why: string } {
  const has = (m: Mechanism) => entries.some((e) => e.mechanism === m && e.available);
  switch (need) {
    case "refresh-while-open":
      return { mechanism: "page-timer", why: "a page timer is enough while the tab is open, and it makes no promise after it closes" };
    case "survive-a-reload":
      return has("service-worker") ? { mechanism: "service-worker", why: "the shell is served from the cache when the network is gone" } : { mechanism: null, why: "without a service worker an offline reload cannot be served" };
    case "large-download":
      return has("background-fetch") ? { mechanism: "background-fetch", why: "the browser's download manager continues after the page is closed" } : { mechanism: null, why: "no Background Fetch, so a download only continues while this tab is open" };
    case "daily-check":
      return has("periodic-sync") ? { mechanism: "periodic-sync", why: "requested as a floor, not a schedule; the browser may never fire it" } : { mechanism: null, why: "there is no periodic wake here, so a daily check happens only when the app is opened" };
  }
}
