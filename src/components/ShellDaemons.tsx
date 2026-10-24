"use client";

import { useEffect, useRef } from "react";
import { api, patch, post, replayQueue } from "@/lib/api";
import type { RoutineAction } from "@/lib/routines";
import { useShell } from "./shell-context";

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

  // PR-03 reminders
  useEffect(() => {
    const tick = async () => {
      const s = ref.current;
      if (!s.gov.backgroundWork) return;
      try {
        const r = await api<{ rows: Task[] }>("/api/tasks");
        for (const t of r.rows) {
          if (t.kind !== "task" || t.done || t.reminded || !t.dueAt) continue;
          if (new Date(t.dueAt).getTime() > Date.now()) continue;
          // TT71 NC-02: the server applies the focus rules first; a held reminder waits in Alerts with its reason
          const a = await post<{ delivered?: boolean }>("/api/alerts", { app: "Planner", title: `Reminder: ${t.title}`, priority: "high", groupKey: "Planner" });
          if (a.delivered !== false) {
            s.toast(`Reminder: ${t.title}`, "warn", { label: "Open Planner", run: () => s.open("planner") });
            if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("Fusion reminder", { body: t.title });
          }
          await patch("/api/tasks", { id: t.id, reminded: true });
        }
      } catch { /* offline: next tick */ }
    };
    void tick();
    const t = window.setInterval(tick, 30_000);
    return () => window.clearInterval(t);
  }, []);

  // AU-01 routine triggers
  useEffect(() => {
    const tick = async () => {
      const s = ref.current;
      if (!s.gov.backgroundWork) return;
      try {
        const r = await api<{ rows: Routine[] }>("/api/routines");
        const now = new Date();
        const isExt = typeof window !== "undefined" ? Boolean((window.screen as Screen & { isExtended?: boolean }).isExtended) : false;
        const displayRose = extended.current === false && isExt;
        extended.current = isExt;
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
          }
        }
      } catch { /* offline */ }
    };
    const t = window.setInterval(tick, 60_000);
    void tick();
    return () => window.clearInterval(t);
  }, []);

  // SH-14 offline write queue replay
  useEffect(() => {
    const replay = async () => {
      const r = await replayQueue();
      if (r.replayed) { ref.current.toast(`Back online: replayed ${r.replayed} queued write(s) through the journal.`, "ok"); ref.current.bumpRefresh(); }
      if (r.failed) ref.current.toast(`${r.failed} queued write(s) were rejected by the server and kept in the queue.`, "warn");
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
