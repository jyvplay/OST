"use client";

import { CONTEXTS, type ContextKind, type Density } from "@/lib/context-profiles";
import { TEXT_SCALE_STEPS, fz } from "@/lib/uiscale";
import { useShell } from "./shell-context";
import { Badge, Btn, Section } from "./ui";

const NAMES: Record<ContextKind, string> = {
  "single-pointer": "Single screen · primary pointer",
  "single-touch": "Single screen · primary touch",
  extended: "Multiple screens",
};

export default function ContextProfiles() {
  const { contextProfiles: p } = useShell();
  const o = p.observation;
  return <Section title="Automatic context profiles" right={<Badge tone={p.config.enabled ? "info" : "default"}>{p.config.enabled ? "on" : "off"}</Badge>}>
    <div data-testid="context-profiles" style={{ display: "grid", gap: 10 }}>
      <p className="fs-dim" style={{ margin: 0, fontSize: fz(11.5) }}>
        Opt in to switch this tab&apos;s density and, if chosen, text size for the current display/input context.
        Your shared display settings remain unchanged and return when this is off. Profiles are stored in this browser,
        not sent to the server; in amnesia or if storage is blocked they last only for this session.
      </p>
      <label className="fs-row" style={{ gap: 8 }}>
        <input type="checkbox" checked={p.config.enabled} onChange={(e) => p.setEnabled(e.target.checked)} data-testid="context-enabled" />
        Automatically use context profiles
      </label>
      <div role="status" aria-live="polite" data-testid="context-status" className="fs-dim" style={{ fontSize: fz(11.5) }}>
        {!p.config.enabled ? "Automatic profiles are off." : !o ? "Checking this browser…" : <>
          Active: {NAMES[o.kind]}. {o.displayDetection ? "This browser reports whether the desktop spans multiple screens." : "This browser cannot report extra screens; a single-screen profile is used."}
          {" "}The primary pointer, not screen width or every connected device, is used. Site policy can hide extra displays.
        </>}
        {" "}{p.storage === "memory" ? "Changes are session-only." : p.storage === "browser" ? "Settings are saved in this browser." : "Checking browser storage…"}
      </div>
      {CONTEXTS.map((kind) => {
        const profile = p.config.profiles[kind];
        return <div key={kind} data-context={kind} style={{ display: "grid", gap: 6, borderTop: "1px solid var(--fs-border)", paddingTop: 8 }}>
          <strong style={{ fontSize: fz(12) }}>{NAMES[kind]}</strong>
          <label className="fs-row" style={{ gap: 8 }}>
            <span style={{ minWidth: 95 }}>Density</span>
            <select className="fs-input" style={{ width: "auto" }} aria-label={`${NAMES[kind]} density`} value={profile.density}
              onChange={(e) => p.setProfile(kind, { ...profile, density: e.target.value as Density })}>
              <option value="compact">Compact</option><option value="balanced">Balanced</option><option value="touch">Touch</option>
            </select>
          </label>
          <label className="fs-row" style={{ gap: 8 }}>
            <span style={{ minWidth: 95 }}>Text size</span>
            <select className="fs-input" style={{ width: "auto" }} aria-label={`${NAMES[kind]} text size`} value={profile.textScale ?? "base"}
              onChange={(e) => p.setProfile(kind, { ...profile, textScale: e.target.value === "base" ? null : Number(e.target.value) })}>
              <option value="base">Follow shared setting</option>
              {TEXT_SCALE_STEPS.map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>
          </label>
        </div>;
      })}
      <div><Btn variant="ghost" onClick={p.reset}>Reset profiles and turn off</Btn></div>
    </div>
  </Section>;
}
