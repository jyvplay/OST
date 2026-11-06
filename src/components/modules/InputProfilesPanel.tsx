"use client";
/**
 * TT136 ST-09 — accessibility input profiles.
 *
 * Profiles reduce the precision a user needs. Selection is refused on
 * mismatch (a touch profile on a mouse, for example) rather than silently
 * applied. The panel reports the exact target size and whether a timed
 * gesture is required.
 */
import { fz } from "@/lib/uiscale";
import { useEffect, useState } from "react";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section } from "../ui";
import { PROFILES, profileFor, describeProfile, mismatchReason, canApply, needsTimedGesture, enlarges, delaysClick, type ProfileName } from "@/lib/input-profiles";

type Pointer = "mouse" | "touch" | "pen";

export default function InputProfilesPanel(_: ModuleProps) {
  const [selected, setSelected] = useState<ProfileName>("precision");
  const [pointer, setPointer] = useState<Pointer>("mouse");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const detect = () => {
      const coarse = (matchMedia("(pointer: coarse)").matches || matchMedia("(hover: none)").matches) as boolean;
      setPointer(coarse ? "touch" : "mouse");
    };
    detect();
    const mq = matchMedia("(pointer: coarse)");
    const on = () => detect();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);

  const spec = profileFor(selected);
  const applies = canApply(spec, pointer);

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Input profiles (ST-09)" icon="sliders">
        <KV k="detected pointer" v={pointer} />
        <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
          {(Object.keys(PROFILES) as ProfileName[]).map((name) => (
            <button
              key={name}
              className="fs-btn"
              data-variant={selected === name ? "primary" : "ghost"}
              aria-pressed={selected === name}
              onClick={() => {
                const s = profileFor(name);
                if (!canApply(s, pointer)) { setMsg(mismatchReason(s, pointer)); return; }
                setSelected(name);
                setMsg(`${describeProfile(name)}`);
              }}
            >{name}</button>
          ))}
        </div>
      </Section>

      <Section title="Selected profile" icon="sliders">
        <KV k="profile" v={describeProfile(selected)} />
        <KV k="hit target" v={`${spec.hitPx}px`} />
        <KV k="timed gesture" v={needsTimedGesture(spec) ? `click delay ${spec.clickDelayMs}ms · hold ${spec.holdMs}ms` : "immediate"} />
        <KV k="target enlarged" v={enlarges(spec) ? "yes" : "no"} />
        <KV k="click-through delayed" v={delaysClick(spec) ? "yes" : "no"} />
        <Badge tone={applies ? "ok" : "bad"}>{applies ? "applies to this device" : mismatchReason(spec, pointer)}</Badge>
        {msg ? <div className="fs-mono" style={{ fontSize: fz(10.5), whiteSpace: "pre-wrap" }}>{msg}</div> : null}
      </Section>

      <Section title="Adversary test" icon="shield">
        <Btn variant="ghost" onClick={() => {
          const touchProfile = profileFor("touch");
          setMsg(`Touch profile on ${pointer} pointer: ${canApply(touchProfile, pointer) ? "applies" : mismatchReason(touchProfile, pointer)}`);
        }}>Test touch profile on current device</Btn>
        <Btn variant="ghost" onClick={() => {
          const p = profileFor("precision");
          setMsg(`Precision profile hit target: ${p.hitPx}px (minimum 44px)`);
        }}>Show precision target</Btn>
      </Section>
    </div>
  );
}
