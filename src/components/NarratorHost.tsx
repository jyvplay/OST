"use client";
/**
 * NarratorHost (TT30, AX-14): mounts Fusion's built-in screen reader when Settings → Narrator is on, and draws its two
 * visible parts — the caption panel (what is being spoken, newest last) and the Narrator cursor box. Both are
 * aria-hidden and marked data-narrator-ui so neither an external reader nor our own live-region watcher reads them.
 * The toggle chord (Ctrl+Win+Enter; Cmd+F5 on the Mac preset) works whether the reader is on or off.
 */
import { useEffect, useRef, useState } from "react";
import { useShell } from "./shell-context";
import { BINDINGS, comboFor, matchChord, type Preset } from "@/lib/shortcuts";
import { COMMANDS, stepRate, RATES } from "@/lib/narrator-core";
import { Narrator } from "@/lib/narrator-dom";
import { VOICE_PREFS, FUSION_VOICE_IDS, type EngineId, type VoicePref } from "@/lib/voice-engine";

type Line = { id: number; text: string; kind: string };
const keyName = (code: string) => code.replace(/^Key/, "").replace(/^Arrow/, "").replace("Equal", "=").replace("Minus", "−");

export function NarratorHost() {
  const shell = useShell();
  const on = shell.settings["accessibility.narrator"] === "on";
  const rate = (RATES as readonly string[]).includes(shell.settings["accessibility.narratorRate"] ?? "") ? shell.settings["accessibility.narratorRate"]! : "1";
  const captions = (shell.settings["accessibility.narratorCaptions"] ?? "on") !== "off";
  const speech = (shell.settings["accessibility.narratorSpeech"] ?? "on") !== "off";
  const preset = (shell.settings["shell.shortcutPreset"] ?? "hybrid") as Preset;
  const voicePref = ((VOICE_PREFS as readonly string[]).includes(shell.settings["accessibility.narratorVoice"] ?? "") ? shell.settings["accessibility.narratorVoice"] : "auto") as VoicePref;
  const fusionVoice = FUSION_VOICE_IDS.includes(shell.settings["accessibility.fusionVoice"] ?? "") ? shell.settings["accessibility.fusionVoice"]! : "standard";
  const [engine, setEngine] = useState<EngineId | "">("");
  const [lines, setLines] = useState<Line[]>([]);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [help, setHelp] = useState(false);
  const speechOk = typeof window !== "undefined" && ("speechSynthesis" in window || "AudioContext" in window);
  const [speechErr, setSpeechErr] = useState("");
  const live = useRef({ rate, speech, voicePref, fusionVoice });
  useEffect(() => { live.current = { rate, speech, voicePref, fusionVoice }; }, [rate, speech, voicePref, fusionVoice]);
  const reader = useRef<Narrator | null>(null);
  const seq = useRef(0);
  const setSetting = shell.setSetting;

  // toggle chord, active even while the reader is off
  useEffect(() => {
    const b = BINDINGS.find((x) => x.id === "narrator");
    const chord = b ? comboFor(b, preset) : "";
    const onKey = (e: KeyboardEvent) => {
      if (!chord || !matchChord(e, chord)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      void setSetting("accessibility.narrator", on ? "off" : "on");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [preset, on, setSetting]);

  useEffect(() => {
    if (!on) return;
    const r = new Narrator({
      rate: () => Number(live.current.rate),
      speech: () => live.current.speech,
      voicePref: () => live.current.voicePref,
      fusionVoice: () => live.current.fusionVoice,
      onEngine: (e) => setEngine(e),
      onSpeechError: (err) => setSpeechErr(err),
      onCaption: (text, kind) => setLines((ls) => [...ls.slice(-5), { id: ++seq.current, text, kind }]),
      onCursor: (rc) => setBox(rc ? { x: rc.left, y: rc.top, w: rc.width, h: rc.height } : null),
      onRate: (dir) => {
        const next = stepRate(live.current.rate, dir);
        void setSetting("accessibility.narratorRate", next);
        live.current.rate = next;
        r.say(`Speed ${next}`, "system", true);
      },
      onHelp: () => { setHelp(true); r.say(`Narrator commands. Hold Caps Lock or Insert, then: ${COMMANDS.slice(0, 6).map((c) => `${keyName(c.key)}${c.shift ? " with Shift" : ""}, ${c.label}`).join(". ")}. Press Escape to close the list.`, "system", true); },
    });
    reader.current = r;
    r.start();
    return () => { r.stop(); reader.current = null; setBox(null); };
  }, [on, setSetting]);

  // the help list closes on Escape and returns focus to where it was
  const helpRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!help) return;
    const prev = document.activeElement as HTMLElement | null;
    helpRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setHelp(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); prev?.focus?.(); };
  }, [help]);

  if (!on && !help) return null;
  return (
    <>
      {on && captions ? (
        <div className="fs-narrator-captions" data-testid="narrator-captions" data-narrator-ui aria-hidden="true">
          <div className="fs-narrator-title" data-testid="narrator-title" data-engine={speech ? engine : ""}><span className="fs-narrator-dot" />Narrator{speech ? (engine === "fusion" ? " · Fusion Voice" : engine === "system" ? " · system voice" : "") : " · captions only"}{!speechOk ? " · no speech in this browser" : speech && speechErr ? ` · speech failed (${speechErr}) — captions only` : ""}</div>
          {lines.slice(-3).map((l) => <div key={l.id} className="fs-narrator-line" data-testid="narrator-line" data-kind={l.kind}>{l.text}</div>)}
        </div>
      ) : null}
      {on && box ? <div className="fs-narrator-cursor" data-testid="narrator-cursor" data-narrator-ui aria-hidden="true" style={{ left: box.x - 4, top: box.y - 4, width: box.w + 8, height: box.h + 8 }} /> : null}
      {help ? (
        <div className="fs-panel fs-narrator-help" role="dialog" aria-label="Narrator commands" data-testid="narrator-help" tabIndex={-1} ref={helpRef} data-narrator-ui>
          <strong>Narrator commands</strong>
          <p className="fs-dim">Hold Caps Lock or Insert (the Narrator key) and press:</p>
          <table>
            <tbody>
              {COMMANDS.map((c) => <tr key={c.id}><th scope="row"><kbd>{c.shift ? "Shift+" : ""}{keyName(c.key)}</kbd></th><td>{c.label}</td></tr>)}
              <tr><th scope="row"><kbd>Ctrl</kbd></th><td>Stop speaking (on its own, no Narrator key)</td></tr>
            </tbody>
          </table>
          <button type="button" className="fs-btn" onClick={() => setHelp(false)}>Close</button>
        </div>
      ) : null}
    </>
  );
}
