"use client";

import { useSyncExternalStore } from "react";
import { validateAlarms, type Alarm } from "./clock-core";
import { privacy } from "./privacy/session";

/** One browser-document store shared by Clock windows and the shell alarm
 * scheduler. Persisted alarms stay local; storage denial falls back to this
 * document's memory. The storage event synchronizes changes from other tabs. */
export const ALARMS_KEY = "fusion.alarms.v1";
const empty: Alarm[] = [];
let current: Alarm[] = empty;
let initialized = false;
const listeners = new Set<() => void>();

function decode(raw: string | null): Alarm[] {
  try { return validateAlarms(JSON.parse(raw ?? "[]")); } catch { return []; }
}
function publish() { for (const listener of listeners) listener(); }
function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  // An amnesic shell must not start normal-profile alarms or react to normal
  // tabs' storage events. New alarms in this session remain document-local.
  if (privacy.status().amnesic) current = empty;
  else try { current = decode(window.localStorage.getItem(ALARMS_KEY)); } catch { current = empty; }
  window.addEventListener("storage", (event) => {
    if (privacy.status().amnesic || (event.key !== ALARMS_KEY && event.key !== null)) return;
    current = decode(event.key === null ? null : event.newValue);
    publish();
  });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  initialize();
  return () => { listeners.delete(listener); };
}
function snapshot() { return current; }
function serverSnapshot() { return empty; }

export function useAlarms(): Alarm[] { return useSyncExternalStore(subscribe, snapshot, serverSnapshot); }
export function getAlarms(): Alarm[] { initialize(); return current; }
export function updateAlarms(change: (previous: Alarm[]) => Alarm[]): boolean {
  initialize();
  const next = validateAlarms(change(current));
  current = next;
  let persisted = true;
  try { window.localStorage.setItem(ALARMS_KEY, JSON.stringify(next)); } catch { persisted = false; }
  publish();
  return persisted;
}
