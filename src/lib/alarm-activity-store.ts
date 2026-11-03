"use client";

import { useSyncExternalStore } from "react";
import { getAlarms } from "./alarm-store";
import { ALARM_LOCK } from "./clock-alarm-claim";
import { privacy } from "./privacy/session";
import type { Alarm } from "./clock-core";
import {
  activityToken, reconcileAlarmActivity, startAlarmActivity, transitionAlarmActivity, validateAlarmActivity,
  type AlarmActivity, type AlarmActivityAction,
} from "./alarm-activity-core";

/** Local, bounded acknowledgement state. Normal-profile snoozes survive reload;
 * amnesic snoozes stay in this document and never read normal-profile activity.
 * With Web Locks and working localStorage, actions and alarm claims serialize
 * on the SAME lock. Without either, delivery remains best effort, not exactly once. */
export const ALARM_ACTIVITY_KEY = "fusion.clock.activity.v1";
const empty: AlarmActivity[] = [];
let current = empty, initialized = false, memoryOnly = false;
const listeners = new Set<() => void>();
function decode(text: string | null): AlarmActivity[] {
  try { return text && text.length <= 32_768 ? validateAlarmActivity(JSON.parse(text)) : []; } catch { return []; }
}
function publish() { for (const listener of listeners) listener(); }
function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  if (!privacy.status().amnesic) try { current = decode(localStorage.getItem(ALARM_ACTIVITY_KEY)); } catch { memoryOnly = true; }
  window.addEventListener("storage", (event) => {
    if (privacy.status().amnesic || memoryOnly || (event.key !== ALARM_ACTIVITY_KEY && event.key !== null)) return;
    current = decode(event.key === null ? null : event.newValue); publish();
  });
}
function fresh(): AlarmActivity[] {
  initialize();
  if (privacy.status().amnesic || memoryOnly) return current;
  try { return decode(localStorage.getItem(ALARM_ACTIVITY_KEY)); } catch { memoryOnly = true; return current; }
}
function commit(next: AlarmActivity[]): { changed: boolean; persisted: boolean } {
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  current = next;
  let persisted = false;
  if (!privacy.status().amnesic) {
    try { localStorage.setItem(ALARM_ACTIVITY_KEY, JSON.stringify(next)); persisted = true; memoryOnly = false; } catch { memoryOnly = true; }
  }
  if (changed) publish();
  return { changed, persisted };
}
function subscribe(listener: () => void) { listeners.add(listener); initialize(); return () => { listeners.delete(listener); }; }
export function useAlarmActivity(): AlarmActivity[] { return useSyncExternalStore(subscribe, () => current, () => empty); }
export function getAlarmActivity(): AlarmActivity[] { initialize(); return current; }

/** Called synchronously INSIDE claimAlarm's lock, never acquires a nested lock. */
export function activateAlarm(alarm: Alarm, at: number): void {
  const live = reconcileAlarmActivity(fresh(), getAlarms(), Date.now());
  commit(startAlarmActivity(live, alarm, at));
}
/** Called synchronously inside a snoozed occurrence claim. A stale callback is
 * checked again against storage after acquiring the lock, before publishing. */
export function ringSnoozedAlarm(token: string): boolean {
  const before = reconcileAlarmActivity(fresh(), getAlarms(), Date.now());
  const entry = before.find((x) => activityToken(x) === token);
  if (!entry) return false;
  const after = transitionAlarmActivity(before, token, "ring", getAlarms().find((a) => a.id === entry.alarmId), Date.now());
  const changed = after.some((x) => activityToken(x) === token && x.stage === "ringing") && entry.stage !== "ringing";
  commit(after);
  return changed;
}
export function isSnoozePending(token: string): boolean {
  return fresh().some((x) => activityToken(x) === token && x.stage === "snoozed");
}

async function locked<T>(attempt: () => T): Promise<T> {
  if (privacy.status().amnesic || !navigator.locks?.request) return attempt();
  // Distinguish a rejected lock request from an exception inside our callback:
  // do not retry a transition after it already ran.
  let entered = false;
  try { return await navigator.locks.request(ALARM_LOCK, () => { entered = true; return attempt(); }); }
  catch (error) { if (entered) throw error; return attempt(); }
}
export async function changeAlarmActivity(token: string, action: Exclude<AlarmActivityAction, "ring">): Promise<{ changed: boolean; persisted: boolean }> {
  return locked(() => {
    const now = Date.now(), alarms = getAlarms();
    const before = reconcileAlarmActivity(fresh(), alarms, now);
    const entry = before.find((x) => activityToken(x) === token);
    const next = transitionAlarmActivity(before, token, action, alarms.find((a) => a.id === entry?.alarmId), now);
    return commit(next);
  });
}
export async function reconcileLiveAlarmActivity(): Promise<void> {
  await locked(() => {
    const before = fresh(), next = reconcileAlarmActivity(before, getAlarms(), Date.now());
    if (JSON.stringify(before) !== JSON.stringify(next)) commit(next);
    else if (JSON.stringify(current) !== JSON.stringify(next)) { current = next; publish(); }
  });
}
