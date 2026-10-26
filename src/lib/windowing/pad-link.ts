/**
 * TT72 SH-11 — source device as touchpad / keyboard for the presenting window. Pure (no DOM, no channel).
 *
 * Transport: BroadcastChannel("fusion-shell") between same-origin windows of one browser profile (the channel never
 * leaves the browser). Every Fusion shell window announces itself (`presence`: its desktop-state id and host kind) and
 * answers `who`. A pad (the Blackout screen) sends `pad` messages addressed to ONE state id; only the shell whose state
 * id matches applies them, and it answers `pad-ack` with the title of the window it moved.
 *
 * Input becomes compositor COMMANDS (nudge / cycle / toggleMax / showDesktop), never synthetic DOM events: browsers mark
 * synthetic events untrusted and most handlers ignore them, and a command is exactly what the reducer already validates
 * and clamps. Text typing is deliberately not forwarded (no synthetic keystrokes into documents).
 *
 * Hardening: every message is validated field by field (unknown kinds / ops / keys dropped, numbers finite and clamped);
 * a per-sender sequence number drops replays and out-of-order duplicates; a pad message for another state id is ignored.
 */
import type { DesktopState, WindowCommand } from "./state";

export const CHANNEL = "fusion-shell";
export const MAX_STEP = 400; // px per message; a fast flick is split by the pointer events anyway
export const KEY_STEP = 10, KEY_STEP_BIG = 50;
export const PAD_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab", "Enter", "Home"] as const;
export type PadKey = (typeof PAD_KEYS)[number];
export type HostKind = "tab" | "pip" | "screen";

export type PadOp = { t: "move"; dx: number; dy: number } | { t: "key"; key: PadKey; shift: boolean };
export type Msg =
  | { v: 1; kind: "presence"; from: string; host: HostKind; bye?: boolean }
  | { v: 1; kind: "who"; from: string }
  | { v: 1; kind: "pad"; from: string; to: string; seq: number; op: PadOp }
  | { v: 1; kind: "pad-ack"; from: string; to: string; seq: number; moved: string | null };

const ID = /^[A-Za-z0-9:_-]{1,64}$/;
const HOSTS: readonly string[] = ["tab", "pip", "screen"];
const int = (x: unknown, lim: number): number | null => (typeof x === "number" && Number.isFinite(x) ? Math.max(-lim, Math.min(lim, Math.round(x))) : null);

/** Validate an untrusted channel message. Returns null for anything malformed (never throws). */
export function parseMsg(raw: unknown): Msg | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.v !== 1 || typeof m.from !== "string" || !ID.test(m.from)) return null;
  switch (m.kind) {
    case "presence":
      if (typeof m.host !== "string" || !HOSTS.includes(m.host)) return null;
      return { v: 1, kind: "presence", from: m.from, host: m.host as HostKind, ...(m.bye === true ? { bye: true } : {}) };
    case "who": return { v: 1, kind: "who", from: m.from };
    case "pad-ack": {
      if (typeof m.to !== "string" || !ID.test(m.to) || !Number.isSafeInteger(m.seq)) return null;
      const moved = typeof m.moved === "string" ? m.moved.slice(0, 120) : null;
      return { v: 1, kind: "pad-ack", from: m.from, to: m.to, seq: m.seq as number, moved };
    }
    case "pad": {
      if (typeof m.to !== "string" || !ID.test(m.to) || !Number.isSafeInteger(m.seq) || (m.seq as number) < 0) return null;
      const o = m.op as Record<string, unknown> | null;
      if (!o || typeof o !== "object") return null;
      if (o.t === "move") {
        const dx = int(o.dx, MAX_STEP), dy = int(o.dy, MAX_STEP);
        if (dx === null || dy === null) return null;
        return { v: 1, kind: "pad", from: m.from, to: m.to, seq: m.seq as number, op: { t: "move", dx, dy } };
      }
      if (o.t === "key" && typeof o.key === "string" && (PAD_KEYS as readonly string[]).includes(o.key)) {
        return { v: 1, kind: "pad", from: m.from, to: m.to, seq: m.seq as number, op: { t: "key", key: o.key as PadKey, shift: o.shift === true } };
      }
      return null;
    }
    default: return null;
  }
}

/** Replay / duplicate filter: accept a pad message only if its seq is above the last one seen from that sender. */
export function acceptSeq(last: Map<string, number>, from: string, seq: number): boolean {
  const prev = last.get(from);
  if (prev !== undefined && seq <= prev) return false;
  last.set(from, seq);
  if (last.size > 64) last.delete(last.keys().next().value as string); // bounded memory
  return true;
}

/** Translate one pad op into compositor commands for this desktop. Nothing is focused → only Tab / Home do anything. */
export function padCommands(op: PadOp, s: Pick<DesktopState, "focus" | "windows">): WindowCommand[] {
  const f = s.focus && s.windows.some((w) => w.id === s.focus && !w.minimized) ? s.focus : null;
  if (op.t === "move") return f && (op.dx || op.dy) ? [{ t: "nudge", id: f, dx: op.dx, dy: op.dy }] : [];
  const step = op.shift ? KEY_STEP_BIG : KEY_STEP;
  switch (op.key) {
    case "ArrowLeft": return f ? [{ t: "nudge", id: f, dx: -step, dy: 0 }] : [];
    case "ArrowRight": return f ? [{ t: "nudge", id: f, dx: step, dy: 0 }] : [];
    case "ArrowUp": return f ? [{ t: "nudge", id: f, dx: 0, dy: -step }] : [];
    case "ArrowDown": return f ? [{ t: "nudge", id: f, dx: 0, dy: step }] : [];
    case "Tab": return [{ t: "cycle", dir: op.shift ? -1 : 1 }];
    case "Enter": return f ? [{ t: "toggleMax", id: f }] : [];
    case "Home": return [{ t: "showDesktop" }];
  }
}

/** Which shell a pad on `self` should drive: the most recently announced presenting screen, never itself. */
export function pickTarget(peers: Map<string, { host: HostKind; at: number }>, self: string): string | null {
  let best: string | null = null, at = -1;
  for (const [id, p] of peers) if (id !== self && p.host === "screen" && p.at > at) { best = id; at = p.at; }
  return best;
}

/** Map a keyboard event (key name + shift) from the pad screen to a pad key, or null when it is not forwarded. */
export function padKeyOf(key: string): PadKey | null {
  return (PAD_KEYS as readonly string[]).includes(key) ? key as PadKey : null;
}
