"use client";

import { useEffect, useRef } from "react";
import { api, patch, post, replayQueue } from "@/lib/api";
import type { RoutineAction } from "@/lib/routines";
import { useShell } from "./shell-context";
import { recordBackgroundCallback, updateBackgroundStatus } from "@/lib/background-inventory";

interface Task { id: number; title: string; done: boolean; dueAt: string | null; reminded: boolean; kind: string }
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
  ref.current = shell;
  const extended = useRef<boolean | null>(null);

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
          await patch("/api/tasks", { id: t.id, reminded: true });
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
        if (r.failed) ref.current.toast(`${r.failed} queued write(s) were rejected by the server and kept in the queue.`, "warn");
        updateBackgroundStatus("offline-replay", `${r.replayed} replayed; ${r.failed} rejected and retained`);
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
