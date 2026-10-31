"use client";

import { useState } from "react";
import { activityToken } from "@/lib/alarm-activity-core";
import { changeAlarmActivity, useAlarmActivity } from "@/lib/alarm-activity-store";
import { useAlarms } from "@/lib/alarm-store";
import { alarmSchedule } from "@/lib/alarm-activity-core";
import { privacy } from "@/lib/privacy/session";
import { fz } from "@/lib/uiscale";
import { useShell } from "./shell-context";
import { Btn } from "./ui";
import ActionGlyph from "./ActionGlyph";

/** Shell-owned, nonmodal acknowledgements: closing Clock or allowing its toast
 * to expire must not remove the only actionable snooze/dismiss controls. */
export default function AlarmCenter() {
  const shell = useShell(), alarms = useAlarms(), activities = useAlarmActivity();
  const [busy, setBusy] = useState<string | null>(null);
  const entries = activities.flatMap((entry) => {
    const alarm = alarms.find((a) => a.id === entry.alarmId && a.enabled && alarmSchedule(a) === entry.schedule);
    return alarm ? [{ entry, alarm }] : [];
  });
  if (!entries.length) return null;
  return <aside className="fs-panel fs-alarm-center" data-testid="alarm-center" aria-label="Alarm controls">
    <div className="fs-row" style={{ gap: 7, fontWeight: 700 }}><ActionGlyph name="bell" />Alarms</div>
    <div className="fs-alarm-list" role="log" aria-live="polite" aria-relevant="additions text">
      {entries.map(({ entry, alarm }) => {
        const token = activityToken(entry), label = alarm.label || alarm.time;
        const act = async (action: "snooze" | "dismiss") => {
          if (busy !== null) return;
          setBusy(token);
          try {
            const result = await changeAlarmActivity(token, action);
            if (!result.persisted && result.changed) shell.toast(privacy.status().amnesic ? "Amnesic alarm changes stay in this page." : "Storage unavailable: alarm changes stay in this page.", "warn");
          } catch { shell.toast("Alarm action failed. Try again.", "bad"); }
          finally { setBusy(null); }
        };
        return <div key={alarm.id} data-testid="alarm-occurrence" data-stage={entry.stage} style={{ display: "grid", gap: 5, borderTop: "1px solid var(--fs-border)", paddingTop: 7 }}>
          <div style={{ overflowWrap: "anywhere", fontSize: fz(13) }}>{label}</div>
          {entry.stage === "snoozed" ? <span className="fs-dim" style={{ fontSize: fz(11) }}>Snoozed until {new Date(entry.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span> :
            entry.stage === "missed" ? <span className="fs-dim" style={{ fontSize: fz(11) }}>Snooze missed while the page was suspended.</span> : null}
          <div className="fs-row" style={{ gap: 5, flexWrap: "wrap" }}>
            {entry.stage !== "snoozed" ? <Btn disabled={busy !== null} onClick={() => void act("snooze")} aria-label={`Snooze ${label} for ${alarm.snoozeMin} minutes`}><ActionGlyph name="snooze" size={15} />Snooze {alarm.snoozeMin}m</Btn> : null}
            <Btn variant="ghost" disabled={busy !== null} onClick={() => void act("dismiss")} aria-label={`${entry.stage === "snoozed" ? "Cancel snooze for" : "Dismiss"} ${label}`}>{entry.stage === "snoozed" ? "Cancel snooze" : "Dismiss"}</Btn>
          </div>
        </div>;
      })}
    </div>
    <small className="fs-dim">Fusion must stay running; frozen or closed pages can miss alarms.</small>
  </aside>;
}
