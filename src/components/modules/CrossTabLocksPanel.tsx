"use client";
/**
 * TT136 SH-06 — cross-tab locks.
 *
 * Every Shell window that writes to a shared document must claim a lease. This
 * panel shows the leases a tab currently holds, lets you test the claim /
 * renewal / expiry path, and records the heartbeat the engine requires.
 */
import { fz } from "@/lib/uiscale";
import { useCallback, useEffect, useState } from "react";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section } from "../ui";
import { leaseFor, claim, renew, checkHeartbeat, describeLease, type Lease, type Heartbeat } from "@/lib/crosstab/locks";

const TAB_ID = () => `tab-${Math.random().toString(36).slice(2, 9)}`;

export default function CrossTabLocksPanel(_: ModuleProps) {
  const shell = useShell();
  const [identity] = useState(() => TAB_ID());
  const [lease, setLease] = useState<Lease | null>(null);
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);
  const [doc, setDoc] = useState("/Documents/Shared.md");
  const [msg, setMsg] = useState("No lease held in this tab");
  const [live, setLive] = useState(false);

  const beat = useCallback((now: number): Heartbeat => ({ id: identity, identity, at: now }), [identity]);

  const claimLease = () => {
    const candidate = leaseFor(doc, "me", identity, Date.now());
    const result = claim(lease, candidate, Date.now());
    setLease(result.lease);
    setHeartbeat(beat(Date.now()));
    setMsg(result.reason);
    setLive(true);
  };

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      const now = Date.now();
      const target: Lease = lease ?? leaseFor(doc, "me", identity, Date.now());
      const r = renew(target, identity, now);
      if (lease === null || r.state !== "acquired") {
        setLive(false);
        setMsg(r.reason);
        return;
      }
      setLease(r.lease);
      const hb = beat(now);
      const chk = r.lease ? checkHeartbeat(r.lease, hb, now) : { ok: false, reason: "Lease lost" };
      setHeartbeat(hb);
      setMsg(chk.ok ? "Heartbeat accepted" : chk.reason);
    }, 5_000);
    return () => window.clearInterval(t);
  }, [live, lease, identity, beat]);

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Cross-tab locks (SH-06)" icon="plus">
        <KV k="tab identity" v={identity} />
        <KV k="document" v={doc} />
        <div className="fs-row" style={{ gap: 6 }}>
          <input className="fs-input" style={{ width: fz(220) }} value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Document path" />
          <Btn variant="primary" onClick={claimLease} data-testid="lock-claim">Claim lock</Btn>
          <Btn variant="ghost" onClick={() => { setLease(null); setLive(false); setMsg("Lock released"); }}>Release</Btn>
        </div>
      </Section>

      <Section title="Current lease" icon="timer">
        {lease ? (
          <>
            <KV k="holder" v={`${lease.owner} (${lease.identity})`} />
            <KV k="expires" v={describeLease(lease)} />
            <KV k="revision" v={String(lease.revision)} />
            <Badge tone={live ? "ok" : "warn"}>{live ? "heartbeat active" : "lease expired or lost"}</Badge>
          </>
        ) : <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No lease held.</div>}
        <div className="fs-mono" style={{ fontSize: fz(10.5), whiteSpace: "pre-wrap" }}>{msg}</div>
        <div className="fs-dim" style={{ fontSize: fz(10.5) }}>Leases expire after 15 s without a heartbeat; a stale tab cannot renew, and a new tab must wait for the expiry.</div>
      </Section>

      <Section title="Adversary test" icon="shield">
        <Btn variant="ghost" onClick={() => {
          const other = leaseFor(doc, "other-tab", `other-${identity}`, Date.now());
          const r = claim(lease, other, Date.now());
          setMsg(r.state === "acquired" ? "Adversary acquired the lock (lease was expired)" : `Adversary ${r.state}: ${r.reason}`);
        }}>Simulate another tab claiming</Btn>
        <Btn variant="ghost" onClick={() => {
          const stale = lease ? { ...lease, expiresAt: Date.now() - 1000 } : null;
          const r = renew(stale, identity, Date.now());
          setMsg(`Stale renewal: ${r.state} — ${r.reason}`);
        }}>Renew a stale lease</Btn>
      </Section>
    </div>
  );
}
