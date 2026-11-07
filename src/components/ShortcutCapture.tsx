"use client";

/**
 * TT148 (IN-04) — a capture surface that tells the truth about where a chord
 * goes.
 *
 * Press a combination here and the app says three things: what the physical
 * chord is (independent of the keyboard layout), whether the browser would take
 * it first (with the reason), and whether it would shadow one of this app's own
 * bindings. It also states what it cannot do — nothing here is an OS-wide
 * hotkey; outside fullscreen the browser keeps its reserved keys.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { Badge, Btn, KV, Section } from "./ui";
import { capturePlan, chordFromEvent, classifyChord, describeChordCapture, RESERVED_CHORDS } from "@/lib/keyboard/system-keys";
import { BINDINGS, comboFor, type Preset } from "@/lib/shortcuts";

export default function ShortcutCapture({ preset }: { preset: Preset }) {
  const [chord, setChord] = useState("");
  const [plan, setPlan] = useState(() => capturePlan({ keyboardLockAvailable: typeof navigator !== "undefined" && "keyboard" in navigator, fullscreen: false, hasPageFocus: true }));
  const [lastEvent, setLastEvent] = useState<string>("");
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sync = () => setPlan(capturePlan({
      keyboardLockAvailable: typeof navigator !== "undefined" && "keyboard" in navigator,
      fullscreen: typeof document !== "undefined" && Boolean(document.fullscreenElement),
      hasPageFocus: typeof document === "undefined" || document.hasFocus(),
    }));
    sync();
    document.addEventListener("fullscreenchange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    // The capture is the point of this box, so it consumes the event: letting a
    // chord through to the shell while capturing is how a settings panel ends up
    // opening six windows because someone pressed the tiling shortcut.
    e.preventDefault();
    e.stopPropagation();
    const c = chordFromEvent(e.nativeEvent);
    if (c.modifierOnly) { setLastEvent(`${c.chord || "modifier"} held…`); return; }
    setChord(c.chord);
    setLastEvent("");
  }, []);

  const bindings = BINDINGS.map((b) => comboFor(b, preset));
  const verdict = classifyChord(chord, bindings);

  return (
    <Section title="Capture a shortcut (IN-04)" icon="terminal"
      right={<Badge tone={verdict.usable ? "ok" : chord ? "warn" : "default"} data-testid="capture-verdict">{chord ? (verdict.usable ? "reaches the page" : "not usable") : "press a chord"}</Badge>}>
      <div ref={box} tabIndex={0} role="button" aria-label="Shortcut capture area" data-testid="capture-box"
        onKeyDown={onKeyDown} onFocus={() => setLastEvent("focused — press a combination")}
        className="fs-panel" style={{ padding: 12, minHeight: fz(46), display: "grid", placeItems: "center", outline: "none" }}>
        <span className="fs-mono" style={{ fontSize: fz(13) }} data-testid="capture-chord">{chord || lastEvent || "click here, then press a combination"}</span>
      </div>
      <KV k="Where it goes" v={chord ? describeChordCapture(chord, plan) : plan.reason} />
      {chord && !verdict.usable ? <Badge tone="bad" data-testid="capture-why">{verdict.reason}</Badge> : null}
      {chord && verdict.usable ? <Badge tone="ok" data-testid="capture-why">{verdict.reason}</Badge> : null}
      <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="ghost" data-testid="capture-clear" onClick={() => { setChord(""); setLastEvent("cleared"); }}>Clear</Btn>
        <span className="fs-dim" style={{ fontSize: fz(10.5) }}>{RESERVED_CHORDS.length} browser-reserved combinations are named, not guessed</span>
      </div>
      <div className="fs-dim" style={{ fontSize: fz(10.5) }} data-testid="capture-limit">
        Nothing here is an OS-wide hotkey: a chord is observed only while this window has focus{plan.lockedKeys.length ? ", except inside fullscreen where Keyboard Lock hands over the reserved keys" : ""}.
      </div>
    </Section>
  );
}
