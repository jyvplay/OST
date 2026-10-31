"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { api, patch, post, replayQueue } from "@/lib/api";
import { taskSnapshot, type PlannerTask } from "@/lib/task-model";
import type { RoutineAction } from "@/lib/routines";
import { useShell } from "./shell-context";
import { recordBackgroundCallback, updateBackgroundStatus } from "@/lib/background-inventory";
import { getAlarms, useAlarms } from "@/lib/alarm-store";
import { ALARM_WINDOW_MS, planAlarmChecks } from "@/lib/clock-alarm-plan";
import { claimAlarm } from "@/lib/clock-alarm-claim";
import { privacy } from "@/lib/privacy/session";
import { activityToken, alarmSchedule, planAlarmActivity } from "@/lib/alarm-activity-core";
import { activateAlarm, changeAlarmActivity, isSnoozePending, reconcileLiveAlarmActivity, ringSnoozedAlarm, useAlarmActivity } from "@/lib/alarm-activity-store";

interface Task extends PlannerTask { reminded: boolean }
interface Routine { id: number; name: string; trigger: string; triggerArg: string; actions: RoutineAction[]; enabled: boolean; lastRun: string | null }

/**
 * Background loops owned by the SHELL, not by module windows, so closing the
 * Planner window does not stop reminders (PR-03) and routines keep their
 * triggers (AU-01). All loops respect the governor: when background work is
 * paused (THROTTLED/CRITICAL, low battery) they skip their tick.
 */
export default function ShellDaemons() {
  const shell = useShell();
  const ref = useRef(shell);
  // Update only after a committed render, before browser events and timer callbacks.
  useLayoutEffect(() => { ref.current = shell; }, [shell]);
  const extended = useRef<boolean | null>(null);
  const alarms = useAlarms();
  const activities = useAlarmActivity();
  useEffect(() => { void reconcileLiveAlarmActivity().catch(() => undefined); }, [alarms]);
  const claimedAlarms = useRef(new Set<string>());
  const pendingAlarms = useRef(new Set<string>());
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // PR-10: this is shell-owned, not Clock-window-owned. Do not pause an
  // enabled alarm for the background-work governor; the page itself can still
  // be throttled, frozen or closed by the browser.
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      recordBackgroundCallback("clock-alarms", "checking enabled local alarms");
      const plan = planAlarmChecks(alarms, Date.now());
      for (const { alarm, at } of plan.due) {
        const key = `${alarm.id}@${at}`;
        if (claimedAlarms.current.has(key) || pendingAlarms.current.has(key)) continue;
        pendingAlarms.current.add(key);
        void claimAlarm(alarm.id, at, () => {
          if (!alive.current || Date.now() < at || Date.now() - at >= ALARM_WINDOW_MS) return false;
          const current = getAlarms().find((a) => a.id === alarm.id);
          return !!current && current.enabled && current.time === alarm.time && current.days.join(",") === alarm.days.join(",");
        }, () => {
          claimedAlarms.current.add(key);
          if (claimedAlarms.current.size > 512) claimedAlarms.current.delete(claimedAlarms.current.values().next().value!);
          activateAlarm(alarm, at);
          ref.current.toast(`Alarm: ${alarm.label || alarm.time}`, "ok");
          try { if (!privacy.status().amnesic && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(`Alarm: ${alarm.label || alarm.time}`); } catch { /* toast is the foreground fallback */ }
        }).catch(() => { updateBackgroundStatus("clock-alarms", "alarm claim failed; delivery is not assured"); }).finally(() => { pendingAlarms.current.delete(key); });
      }
      const snoozes = planAlarmActivity(activities, Date.now());
      for (const entry of snoozes.missed) {
        const key = `miss:${activityToken(entry)}`;
        if (pendingAlarms.current.has(key)) continue;
        pendingAlarms.current.add(key);
        void changeAlarmActivity(activityToken(entry), "miss").catch(() => undefined).finally(() => pendingAlarms.current.delete(key));
      }
      for (const entry of snoozes.due) {
        const token = activityToken(entry), key = `snooze:${token}`;
        if (claimedAlarms.current.has(key) || pendingAlarms.current.has(key)) continue;
        pendingAlarms.current.add(key);
        void claimAlarm(`snooze-${entry.alarmId}-${entry.occurrenceAt}-${entry.sequence}`, entry.dueAt, () => {
          const current = getAlarms().find((a) => a.id === entry.alarmId);
          return alive.current && Date.now() >= entry.dueAt && Date.now() - entry.dueAt < ALARM_WINDOW_MS &&
            !!current?.enabled && alarmSchedule(current) === entry.schedule && isSnoozePending(token);
        }, () => {
          if (!ringSnoozedAlarm(token)) return;
          claimedAlarms.current.add(key);
          if (claimedAlarms.current.size > 512) claimedAlarms.current.delete(claimedAlarms.current.values().next().value!);
          const alarm = getAlarms().find((a) => a.id === entry.alarmId);
          if (!alarm) return;
          ref.current.toast(`Alarm: ${alarm.label || alarm.time}`, "ok");
          try { if (!privacy.status().amnesic && typeof Notification !== "undefined" && Notification.permission === "granted") new Notification(`Alarm: ${alarm.label || alarm.time}`); } catch { /* actionable in-page controls remain */ }
        }).catch(() => { updateBackgroundStatus("clock-alarms", "snooze claim failed; delivery is not assured"); }).finally(() => pendingAlarms.current.delete(key));
      }
      updateBackgroundStatus("clock-alarms", `${alarms.filter((a) => a.enabled).length} enabled; ${plan.due.length + snoozes.due.length} in the delivery window`);
      const delay = Math.min(plan.delay ?? Infinity, snoozes.delay ?? Infinity);
      if (Number.isFinite(delay)) timer = window.setTimeout(tick, delay);
    };
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    tick();
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [alarms, activities]);

  // PR-03 reminders (AP-05 inventory counts actual page callbacks, not assumed OS wakes)
  useEffect(() => {
    const tick = async () => {
      const s = ref.current;
      recordBackgroundCallback("planner-reminders", s.gov.backgroundWork ? "checking due reminders" : "paused by load governor");
      if (!s.gov.backgroundWork) return;
      try {
        const r = await api<{ rows: Task[] }>("/api/tasks");
        let delivered = 0, held = 0;
        for (const t of r.rows) {
          if (t.kind !== "task" || t.done || t.reminded || !t.dueAt) continue;
          if (new Date(t.dueAt).getTime() > Date.now()) continue;
          // TT71 NC-02: the server applies the focus rules first; a held reminder waits in Alerts with its reason
          const a = await post<{ delivered?: boolean }>("/api/alerts", { app: "Planner", title: `Reminder: ${t.title}`, priority: "high", groupKey: "Planner" });
          if (a.delivered !== false) {
            delivered++;
            s.toast(`Reminder: ${t.title}`, "warn", { label: "Open Planner", run: () => s.open("planner") });
            if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Fusion reminder", { body: t.title });
          } else held++;
          // A reminder sampled before a reschedule must not mark the new
          // due instant delivered. This snapshot is compared under the row lock.
          await patch("/api/tasks", { id: t.id, reminded: true, expected: taskSnapshot(t) });
        }
        updateBackgroundStatus("planner-reminders", `checked ${r.rows.length} task row(s); ${delivered} delivered; ${held} held by alert rules`);
      } catch { updateBackgroundStatus("planner-reminders", "server unavailable; retrying on the next page timer"); }
    };
    void tick();
    const t = window.setInterval(tick, 30_000);
    return () => window.clearInterval(t);
  }, []);

  // AU-01 routine triggers
  useEffect(() => {
    const tick = async () => {
      const s = ref.current;
      // TT85/AP-05: the previous loop bypassed the governor despite the module contract; pause it like reminder work.
      recordBackgroundCallback("routine-triggers", s.gov.backgroundWork ? "checking enabled triggers" : "paused by load governor");
      if (!s.gov.backgroundWork) return;
      try {
        const r = await api<{ rows: Routine[] }>("/api/routines");
        const now = new Date();
        const isExt = typeof window !== "undefined" ? Boolean((window.screen as Screen & { isExtended?: boolean }).isExtended) : false;
        const displayRose = extended.current === false && isExt;
        extended.current = isExt;
        let ran = 0;
        for (const rt of r.rows) {
          if (!rt.enabled || rt.trigger === "manual") continue;
          const last = rt.lastRun ? new Date(rt.lastRun) : null;
          let due = false;
          if (rt.trigger === "interval") {
            const mins = Math.max(1, Number(rt.triggerArg) || 60);
            due = !last || now.getTime() - last.getTime() >= mins * 60_000;
          } else if (rt.trigger === "time-of-day") {
            const [h, m] = rt.triggerArg.split(":").map(Number);
            const at = new Date(now); at.setHours(h || 0, m || 0, 0, 0);
            due = now >= at && (!last || last < at);
          } else if (rt.trigger === "display-connected") {
            due = displayRose;
          }
          if (due) {
            await s.runActions(rt.actions);
            await post("/api/routines", { ranId: rt.id });
            s.toast(`Routine "${rt.name}" ran (trigger: ${rt.trigger}).`, "info");
            ran++;
          }
        }
        updateBackgroundStatus("routine-triggers", `checked ${r.rows.length} routine row(s); ${ran} ran`);
      } catch { updateBackgroundStatus("routine-triggers", "server unavailable; retrying on the next page timer"); }
    };
    const t = window.setInterval(tick, 60_000);
    void tick();
    return () => window.clearInterval(t);
  }, []);

  // SH-14 offline write queue replay
  useEffect(() => {
    const replay = async () => {
      recordBackgroundCallback("offline-replay", navigator.onLine ? "startup/online replay check" : "startup while offline");
      try {
        const r = await replayQueue();
        if (r.replayed) { ref.current.toast(`Back online: replayed ${r.replayed} queued write(s) through the journal.`, "ok"); ref.current.bumpRefresh(); }
        if (r.storageError === "read") ref.current.toast("The offline queue could not be read; no further replay was attempted. Check browser storage before retrying.", "warn");
        else if (r.storageError === "dequeue") ref.current.toast("The offline queue could not be updated after a server response. A write may have succeeded; check it before retrying.", "warn");
        else if (r.failed) ref.current.toast(`${r.failed} queued write(s) were rejected by the server and kept in the queue.`, "warn");
        updateBackgroundStatus("offline-replay", r.storageError ? `${r.replayed} replayed; queue storage ${r.storageError} failed` : `${r.replayed} replayed; ${r.failed} rejected and retained`);
      } catch { updateBackgroundStatus("offline-replay", "queue check failed; queued writes remain for a later retry"); }
    };
    void replay();
    window.addEventListener("online", replay);
    return () => window.removeEventListener("online", replay);
  }, []);

  // AP-04 update prompt: never reload under the user
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const offer = (w: ServiceWorker) => ref.current.toast("A new version of Fusion is ready.", "info", {
        label: "Reload when ready",
        run: () => { w.postMessage("skip-waiting"); navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true }); },
      });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => { if (w.state === "installed" && navigator.serviceWorker.controller) offer(w); });
      });
    }).catch(() => undefined);
  }, []);

  return null;
}
