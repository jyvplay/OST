"use client";
/**
 * TT72 SH-11: BroadcastChannel("fusion-shell") wiring for one shell window — presence, pad input in, pad input out.
 * The protocol, validation and command translation are pure (src/lib/windowing/pad-link.ts); this hook only moves
 * messages. Every shell window both answers (applies pads addressed to its own state id) and can drive (the Blackout pad).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { acceptSeq, CHANNEL, padCommands, parseMsg, pickTarget, type HostKind, type PadOp } from "@/lib/windowing/pad-link";
import type { DesktopState, WindowCommand } from "@/lib/windowing/state";

export interface PadLink {
  /** state id of the presenting screen this window's pad drives, or null (then the pad acts on this window) */
  target: string | null;
  /** last acknowledgement from the target: the title of the window it moved (null = the op changed no window) */
  ack: { seq: number; moved: string | null } | null;
  send: (op: PadOp) => boolean;
  /** forget peers and ask who is there (a display closed without saying goodbye must not stay a target) */
  refresh: () => void;
}

export function usePadLink(stateId: string, hostKind: HostKind, stateRef: RefObject<DesktopState>, dispatch: (c: WindowCommand) => void): PadLink {
  const [peers, setPeers] = useState<Map<string, { host: HostKind; at: number }>>(() => new Map());
  const [ack, setAck] = useState<PadLink["ack"]>(null);
  const chan = useRef<BroadcastChannel | null>(null);
  const seq = useRef(0);
  const lastSeq = useRef(new Map<string, number>());
  const dispatchRef = useRef(dispatch);
  useEffect(() => { dispatchRef.current = dispatch; }, [dispatch]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CHANNEL); chan.current = ch;
    const hello = (bye = false) => ch.postMessage({ v: 1, kind: "presence", from: stateId, host: hostKind, ...(bye ? { bye: true } : {}) });
    ch.onmessage = (e: MessageEvent) => {
      const m = parseMsg(e.data);
      if (!m || m.from === stateId) return;
      if (m.kind === "who") hello();
      else if (m.kind === "presence") setPeers((p) => { const n = new Map(p); if (m.bye) n.delete(m.from); else n.set(m.from, { host: m.host, at: Date.now() }); return n; });
      else if (m.kind === "pad") {
        if (m.to !== stateId || !acceptSeq(lastSeq.current, m.from, m.seq)) return;
        const s = stateRef.current;
        const cmds = padCommands(m.op, s);
        for (const c of cmds) dispatchRef.current(c);
        const id = cmds.map((c) => ("id" in c ? c.id : null)).find(Boolean) ?? null;
        ch.postMessage({ v: 1, kind: "pad-ack", from: stateId, to: m.from, seq: m.seq, moved: id ? s.windows.find((w) => w.id === id)?.title ?? null : null });
      } else if (m.kind === "pad-ack" && m.to === stateId) setAck({ seq: m.seq, moved: m.moved });
    };
    hello();
    ch.postMessage({ v: 1, kind: "who", from: stateId });
    const bye = () => hello(true);
    window.addEventListener("pagehide", bye);
    return () => { bye(); window.removeEventListener("pagehide", bye); ch.close(); chan.current = null; };
  }, [stateId, hostKind, stateRef]);

  const target = pickTarget(peers, stateId);
  const send = useCallback((op: PadOp) => {
    if (!target || !chan.current) return false;
    // monotonic across reloads of the pad (the receiver drops seq <= last seen from this sender id)
    seq.current = Math.max(seq.current + 1, Date.now());
    chan.current.postMessage({ v: 1, kind: "pad", from: stateId, to: target, seq: seq.current, op });
    return true;
  }, [target, stateId]);
  const refresh = useCallback(() => {
    setPeers(new Map());
    chan.current?.postMessage({ v: 1, kind: "who", from: stateId });
  }, [stateId]);
  return { target, ack, send, refresh };
}
