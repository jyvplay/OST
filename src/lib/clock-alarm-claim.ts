"use client";

import { privacy } from "./privacy/session";

/** Best-effort cross-tab suppression. Under Web Locks, a same-origin tab reads
 * and writes the small local marker while holding one exclusive lock. With no
 * Web Locks or storage, duplicate notifications across tabs remain possible.
 * The marker contains IDs and instants, not alarm labels; it is not a durable
 * exactly-once delivery guarantee (a tab can crash after recording its claim). */
export const ALARM_CLAIMS_KEY = "fusion.clock.claims.v1";
export const ALARM_LOCK = "fusion-clock-alarm-claims";
const MAX_CLAIMS = 512;
const RETAIN_MS = 48 * 60 * 60 * 1000;

export async function claimAlarm(id: string, at: number, stillDue: () => boolean, deliver: () => void): Promise<boolean> {
  // Amnesic alarms are per-page and must not read or persist normal claims.
  if (privacy.status().amnesic) {
    if (!stillDue()) return false;
    deliver();
    return true;
  }
  const attempt = () => {
    if (!stillDue()) return false;
    const key = `${id}@${at}`;
    try {
      const stored = localStorage.getItem(ALARM_CLAIMS_KEY) ?? "[]";
      let raw: unknown = [];
      try { if (stored.length <= 65_536) raw = JSON.parse(stored); } catch { /* recover from a malformed marker */ }
      const now = Date.now();
      const retained = Array.isArray(raw) ? raw.filter((value): value is string => {
        if (typeof value !== "string") return false;
        const when = Number(value.slice(value.lastIndexOf("@") + 1));
        return value.includes("@") && Number.isFinite(when) && Math.abs(now - when) <= RETAIN_MS;
      }) : [];
      if (retained.includes(key)) return false;
      localStorage.setItem(ALARM_CLAIMS_KEY, JSON.stringify([...retained.slice(-(MAX_CLAIMS - 1)), key]));
    } catch { /* local delivery still works; cross-tab suppression is unavailable */ }
    deliver();
    return true;
  };
  if (!navigator.locks?.request) return attempt();
  let entered = false;
  try { return await navigator.locks.request(ALARM_LOCK, () => { entered = true; return attempt(); }); }
  catch (error) { if (entered) throw error; return attempt(); }
}
