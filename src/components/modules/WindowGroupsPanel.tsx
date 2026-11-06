"use client";
/**
 * TT136 WM-02 — window groups.
 *
 * A group is a set of windows that minimise, close and focus together. The
 * engine is pure (src/lib/shell/window-groups.ts); this panel is the control
 * surface: create a group from the current windows, see its members, and run
 * group operations.
 */
import { fz } from "@/lib/uiscale";
import { useCallback, useEffect, useState } from "react";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";
import { layoutGroup, minimizeGroup, closeGroup, focusGroup, summarize, describeGroup, makeGroup, type Group, type LayoutKind, type WindowRef } from "@/lib/shell/window-groups";
import { askText } from "@/lib/ask";

interface WinLike { id: string; app: string; title: string; x: number; y: number; w: number; h: number; z: number; minimised: boolean }

export default function WindowGroupsPanel(_: ModuleProps) {
  const shell = useShell();
  const [groups, setGroups] = useState<Group[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [layout, setLayout] = useState<LayoutKind>("stack");

  const reload = useCallback(() => {
    const stored = (shell.state as any).windowGroups as Group[] | undefined;
    if (stored) setGroups(stored);
  }, [shell]);
  useEffect(() => { reload(); }, [reload, shell.refreshTick]);

  const create = async () => {
    const n = name.trim() || `group-${groups.length + 1}`;
    const windows = (shell.state.windows as unknown as WinLike[]).filter((w) => w.id !== "__daemons__");
    if (windows.length === 0) { setMsg("No windows to group"); return; }
    const id = `g-${Math.random().toString(36).slice(2, 9)}`;
    const group = makeGroup(id, n, windows.map((w) => w.id), Date.now());
    const next = [...groups, group];
    setGroups(next);
    (shell.state as any).windowGroups = next;
    shell.bumpRefresh();
    setMsg(`Created "${n}" with ${windows.length} window(s)`);
  };

  const runGroup = (group: Group, op: (wins: WinLike[], g: Group) => { windows: WinLike[]; op: { ok: boolean; affected: number; reason: string } }) => {
    const windows = (shell.state.windows as unknown as WinLike[]).filter((w) => w.id !== "__daemons__");
    const result = op(windows, group);
    const nextWins = result.windows;
    const merged = { ...shell.state, windows: nextWins };
    (shell.state as any).windowGroups = groups;
    shell.bumpRefresh();
    setMsg(`${group.name}: ${result.op.reason}`);
    void merged;
  };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Window groups (WM-02)" icon="plus">
        <div className="fs-row" style={{ gap: 6 }}>
          <input className="fs-input" style={{ width: fz(200) }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name (optional)" aria-label="Group name" />
          <Btn variant="primary" onClick={() => void create()} data-testid="wg-create">Create from current windows</Btn>
        </div>
        {msg ? <div className="fs-dim" style={{ fontSize: fz(11) }}>{msg}</div> : null}
        {groups.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No groups yet. Create one from the windows currently on screen.</div> : null}
      </Section>

      <Section title="Groups" icon="tileLeft">
        {groups.map((g) => {
          const summary = summarize(g, (shell.state.windows as unknown as WinLike[]).filter((w) => w.id !== "__daemons__"));
          return (
            <div key={g.id} className="fs-row" style={{ justifyContent: "space-between", padding: 4, borderBottom: "1px solid var(--fs-border)" }}>
              <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
                <Badge>{describeGroup(summary)}</Badge>
              </div>
              <div className="fs-row" style={{ gap: 4 }}>
                <Btn variant="ghost" onClick={() => runGroup(g, minimizeGroup)}>Minimize</Btn>
                <Btn variant="ghost" onClick={() => runGroup(g, closeGroup)}>Close</Btn>
                <Btn variant="ghost" onClick={() => runGroup(g, (wins, grp) => focusGroup(wins as unknown as WindowRef[], grp, 100))}>Focus</Btn>
                <select className="fs-select" style={{ width: fz(90) }} value={layout} onChange={(e) => setLayout(e.target.value as LayoutKind)} aria-label="Layout kind">
                  <option value="stack">stack</option><option value="grid">grid</option><option value="dock">dock</option><option value="cascade">cascade</option>
                </select>
                <Btn variant="ghost" onClick={() => {
                  const wins = (shell.state.windows as unknown as WinLike[]).filter((w) => w.id !== "__daemons__");
                  const result = layoutGroup(g, wins, layout, { w: 1200, h: 700 });
                  if ("applied" in result) { shell.toast(`${g.name}: laid out ${result.applied.length} window(s)`, "ok"); }
                  else shell.toast(result.refused, "bad");
                }}>Layout</Btn>
                <Btn variant="ghost" onClick={async () => {
                  const n = await askText("Remove group", g.name, { okLabel: "Remove" });
                  if (!n) return;
                  setGroups((gs) => gs.filter((x) => x.id !== g.id));
                }}>✕</Btn>
              </div>
            </div>
          );
        })}
      </Section>
    </div>
  );
}
