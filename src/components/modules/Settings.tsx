"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, clientId, fmtTime, post } from "@/lib/api";
import type { Capability, CapabilityReport } from "@/lib/capabilities";
import { diffCapabilities, type CapDiff } from "@/lib/policy";
import { BINDINGS, BROWSER_RESERVED, comboFor, conflicts, type Preset } from "@/lib/shortcuts";
import { useShell, type ModuleProps } from "../shell-context";
import DefaultAppsGuide from "../DefaultAppsGuide";
import ContextProfiles from "../ContextProfiles";
import { Badge, Btn, KV, Section, Tabs } from "../ui";
import DisplaySettings from "../DisplaySettings";
import MouseButtonsSettings from "../MouseButtonsSettings";
import { layoutSource, useChordLabel } from "@/lib/keyboard-layout";
import { auditPermissions, type PermRow } from "@/lib/permissions";

interface SettingRow { key: string; value: string; category: string; label: string; aliases: string; lockReason: string }
interface HistRow { id: number; key: string; oldValue: string; newValue: string; createdAt: string }

type Tab = "settings" | "contexts" | "defaults" | "capabilities" | "shortcuts" | "licence" | "about";

export default function SettingsModule({ win }: ModuleProps) {
  const shell = useShell();
  const [tab, setTab] = useState<Tab>("settings");
  const chordLabel = useChordLabel(); // TT67 IN-03
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [history, setHistory] = useState<HistRow[]>([]);
  const [q, setQ] = useState((win.props.focus as string) ?? "");
  const [ent, setEnt] = useState<{ tier: string; publicKey: string; entitlements: { kind: string; status: string; expiresAt: string | null }[] } | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [perms, setPerms] = useState<PermRow[]>([]);
  const [capDiff, setCapDiff] = useState<(CapDiff & { from: string }) | null>(null);

  const load = () => api<{ rows: SettingRow[]; history: HistRow[] }>("/api/settings?history=1")
    .then((r) => { setRows(r.rows); setHistory(r.history); })
    .catch(() => undefined);
  useEffect(() => { void load(); }, [shell.refreshTick]);

  useEffect(() => {
    api<typeof ent>(`/api/entitlement?clientId=${clientId()}`).then(setEnt).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (tab !== "capabilities" || !navigator.permissions) return;
    void auditPermissions().then(setPerms);
  }, [tab]);

  const preset = (shell.settings["shell.shortcutPreset"] ?? "hybrid") as Preset;
  const filtered = rows.filter((r) => !q || `${r.key} ${r.label} ${r.aliases}`.toLowerCase().includes(q.toLowerCase()));
  const byCategory = filtered.reduce<Record<string, SettingRow[]>>((acc, r) => { (acc[r.category] ??= []).push(r); return acc; }, {});
  const capGroups = (shell.caps?.capabilities ?? []).reduce<Record<string, Capability[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: "settings", label: "Settings graph" },
        { id: "contexts", label: "Context profiles" },
        { id: "defaults", label: "Default apps" },
        { id: "capabilities", label: "Capabilities", badge: shell.caps ? ` ${shell.caps.capabilities.filter((c) => c.available).length}/${shell.caps.capabilities.length}` : "" },
        { id: "shortcuts", label: "Shortcuts" },
        { id: "licence", label: "Licence" },
        { id: "about", label: "About" },
      ]} />

      {tab === "settings" ? (
        <>
          {!q || /display|text|font|size|zoom|theme|wallpaper|read|access|dark|light/i.test(q)
            ? <DisplaySettings locked={Object.fromEntries(rows.filter((r) => r.lockReason).map((r) => [r.key, r.lockReason]))} /> : null}
          <input className="fs-input" placeholder="Search settings — try 'dark mode', 'taskbar', 'analytics'"
            value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
          {Object.entries(byCategory).map(([cat, list]) => (
            <Section key={cat} title={cat}>
              {list.map((r) => (
                <div key={r.key} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: fz(12) }}>{r.label || r.key}</div>
                    <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>{r.key}{r.aliases ? ` · aka ${r.aliases}` : ""}</div>
                  </span>
                  {r.lockReason ? <Badge tone="warn" title={r.lockReason}>locked</Badge> : null}
                  <input className="fs-input" style={{ width: fz(150) }} value={shell.settings[r.key] ?? r.value}
                    disabled={Boolean(r.lockReason)} aria-label={r.label || r.key}
                    onChange={(e) => void shell.setSetting(r.key, e.target.value)} />
                </div>
              ))}
            </Section>
          ))}
          <Section title="History (every change is undoable)">
            <div className="fs-scroll fs-mono" style={{ maxHeight: 120, fontSize: fz(10.5) }}>
              {history.map((h) => (
                <div key={h.id} className="fs-row" style={{ justifyContent: "space-between" }}>
                  <span>{fmtTime(h.createdAt)} {h.key}: {h.oldValue || "∅"} → {h.newValue}</span>
                  <Btn variant="ghost" onClick={() => void shell.setSetting(h.key, h.oldValue)}>revert</Btn>
                </div>
              ))}
              {history.length === 0 ? <span className="fs-dim">no changes yet</span> : null}
            </div>
          </Section>
        </>
      ) : null}

      {tab === "contexts" ? <ContextProfiles /> : null}
      {tab === "defaults" ? <DefaultAppsGuide /> : null}

      {tab === "capabilities" ? (
        <>
          <Section title="What this browser grants" right={
            <Btn variant="ghost" onClick={async () => {
              await post("/api/probe", { clientId: clientId(), ua: shell.caps?.ua, report: shell.caps });
              shell.toast("Capability report saved on the server (only when you ask).", "ok");
            }}>Save report</Btn>
          }>
            <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Badge tone="info">{shell.caps?.hardwareConcurrency ?? "?"} threads</Badge>
              <Badge tone="info">{shell.caps?.deviceMemoryGb ? `${shell.caps.deviceMemoryGb} GB` : "memory not reported"}</Badge>
              <Badge tone={shell.caps?.secureContext ? "ok" : "bad"}>{shell.caps?.secureContext ? "secure context" : "insecure context"}</Badge>
              <Badge tone={shell.caps?.prefersReducedMotion ? "warn" : "ok"}>reduced motion: {String(shell.caps?.prefersReducedMotion)}</Badge>
              <Badge>{shell.caps?.screens.width}×{shell.caps?.screens.height} @{shell.caps?.screens.dpr}x</Badge>
            </div>
          </Section>
          {Object.entries(capGroups).map(([group, list]) => (
            <Section key={group} title={group} dense>
              <div style={{ display: "grid", gap: 3 }}>
                {list.map((c) => (
                  <div key={c.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: fz(12) }}>{c.label}</div>
                      <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>{c.available ? c.detail : c.degrade}</div>
                    </span>
                    <Badge tone={c.available ? "ok" : "bad"}>{c.available ? "yes" : "no"}</Badge>
                  </div>
                ))}
              </div>
            </Section>
          ))}
          <Section title="New-device checklist (BK-04)" right={
            <Btn variant="ghost" onClick={async () => {
              const r = await api<{ rows: { report: CapabilityReport; ua: string; createdAt: string }[] }>("/api/probe");
              const prev = r.rows[0];
              if (!prev || !shell.caps) { shell.toast("Save a report on the old device/browser first (button above).", "warn"); return; }
              setCapDiff({ ...diffCapabilities(prev.report, shell.caps), from: `${prev.ua.slice(0, 60)}… @ ${fmtTime(prev.createdAt)}` });
            }}>Compare with last saved report</Btn>
          }>
            {capDiff ? (
              <>
                <div className="fs-dim" style={{ fontSize: fz(11) }}>vs {capDiff.from} · {capDiff.unchanged} unchanged</div>
                {capDiff.lost.map((c) => <div key={c.id} style={{ fontSize: fz(11.5) }}><Badge tone="bad">lost</Badge> {c.label} — {c.degrade}</div>)}
                {capDiff.gained.map((c) => <div key={c.id} style={{ fontSize: fz(11.5) }}><Badge tone="ok">gained</Badge> {c.label}</div>)}
                {capDiff.lost.length + capDiff.gained.length === 0 ? <Badge tone="ok">identical capability set</Badge> : null}
              </>
            ) : <div className="fs-dim" style={{ fontSize: fz(11.5) }}>Save a report on the old environment, open Fusion on the new one, then compare. Capability varies by browser, so this diff is the real migration checklist.</div>}
          </Section>
          <Section title="Permission audit (SC-03)">
            <div style={{ display: "grid", gap: 2 }}>
              <div className="fs-dim" style={{ fontSize: fz(11) }}>{perms.length} permission names checked · {perms.filter((p) => p.used).length} can be requested by a Fusion feature · {perms.filter((p) => !p.used).length} are never requested</div>
              <div data-testid="perm-audit" style={{ display: "grid", gap: 2 }}>
                {perms.map((p) => (
                  <div key={p.name} data-perm={p.name} data-state={p.state} data-used={p.used ? "1" : "0"}>
                    <KV k={p.name} v={<span className="fs-row" style={{ gap: 4 }}><Badge tone={p.state === "granted" ? "ok" : p.state === "denied" ? "bad" : "default"}>{p.state}</Badge>{p.used ? null : <Badge>never requested</Badge>}</span>} />
                  </div>
                ))}
              </div>
              {perms.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11.5) }}>Permissions API unavailable.</span> : null}
            </div>
            <div className="fs-dim" style={{ fontSize: fz(11) }}>
              Everything listed as <span className="fs-mono">prompt</span> has never been requested: Fusion asks only at
              the moment of first use (DP-11).
            </div>
          </Section>
        </>
      ) : null}

      {tab === "shortcuts" ? (
        <>
          <Section title="Preset">
            <div className="fs-row" style={{ gap: 6 }}>
              {(["hybrid", "windows", "mac"] as Preset[]).map((p) => (
                <Btn key={p} variant={preset === p ? "primary" : "ghost"} onClick={() => void shell.setSetting("shell.shortcutPreset", p)}>{p}</Btn>
              ))}
            </div>
            {conflicts(preset).length ? (
              <Badge tone="bad">{conflicts(preset).map((c) => `${c.a} ↔ ${c.b} (${c.chord})`).join("; ")}</Badge>
            ) : <Badge tone="ok">no internal conflicts</Badge>}
          </Section>
          <Section title="Bindings">
            <div style={{ display: "grid", gap: 3 }}>
              {BINDINGS.map((b) => {
                const chord = comboFor(b, preset);
                const reserved = BROWSER_RESERVED.includes(chord) || Boolean(b.reservedBy);
                return (
                  <div key={b.id} className="fs-row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: fz(12) }}>{b.label}</span>
                    <span className="fs-row" style={{ gap: 6 }}>
                      {reserved ? <Badge tone="warn" title={b.reservedBy ?? "The browser intercepts this chord unless Keyboard Lock is active in fullscreen."}>browser-reserved</Badge> : null}
                      <span className="fs-kbd" title={`physical key: ${chord} (US-layout name)`} data-chord={chord}>{chordLabel(chord)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="fs-dim" data-testid="layout-source" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
              Letter and punctuation shortcuts are physical keys, labelled with what they type on your keyboard layout
              ({{ api: "from the browser's keyboard map", observed: "learned from your typing", "api+observed": "browser keyboard map + your typing", none: "layout unknown yet — US names shown" }[layoutSource()]}).
            </div>
            <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
              A conflict detector that only checks our own table would be useless here: on the web the real competitor
              is the browser itself. Reserved chords are marked, and Keyboard Lock (fullscreen only) is the one way to
              claim them.
            </div>
          </Section>
          <MouseButtonsSettings />
        </>
      ) : null}

      {tab === "licence" ? (
        <Section title="Entitlement (BL-01..05)">
          <KV k="Client id" v={clientId()} mono />
          <KV k="Current tier" v={<Badge tone={ent?.tier === "none" ? "warn" : "ok"}>{ent?.tier ?? "…"}</Badge>} />
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <Btn variant="primary" onClick={async () => {
              try {
                const r = await post<{ kind: string }>("/api/entitlement", { action: "trial", clientId: clientId() });
                shell.toast(`Trial started: ${r.kind}`, "ok");
                setEnt(await api(`/api/entitlement?clientId=${clientId()}`));
              } catch (e) { shell.toast(String((e as Error).message), "warn"); }
            }}>Start 14-day trial</Btn>
            <Btn variant="ghost" onClick={async () => {
              const r = await post<{ licenseKey: string }>("/api/entitlement", { action: "issue", clientId: clientId(), kind: "pro" });
              setLicenseKey(r.licenseKey);
              shell.toast("Issued a signed key from the local authority (this is the 'store' side, in-tree so the path is verifiable).", "ok");
            }}>Issue a key (self-hosted authority)</Btn>
          </div>
          <textarea className="fs-textarea" rows={3} value={licenseKey} placeholder="paste a licence key"
            onChange={(e) => setLicenseKey(e.target.value)} aria-label="Licence key" />
          <div className="fs-row" style={{ gap: 6 }}>
            <Btn variant="primary" disabled={!licenseKey} onClick={async () => {
              try {
                await post("/api/entitlement", { action: "activate", clientId: clientId(), key: licenseKey });
                setEnt(await api(`/api/entitlement?clientId=${clientId()}`));
                shell.toast("Activated — Ed25519 signature verified server-side.", "ok");
              } catch (e) { shell.toast(String((e as Error).message), "bad"); }
            }}>Activate</Btn>
            <Btn variant="ghost" disabled={!licenseKey} onClick={async () => {
              const r = await post<{ valid: boolean }>("/api/entitlement", { action: "verify", key: licenseKey });
              shell.toast(r.valid ? "Signature valid." : "Signature INVALID — tampered or wrong authority.", r.valid ? "ok" : "bad");
            }}>Verify only</Btn>
            <Btn variant="ghost" onClick={() => void shell.copy((licenseKey || "").slice(0, 24) + "…", "licence")}>Copy</Btn>
          </div>
          <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
            Keys are Ed25519-signed JSON claims. The public key is published at <span className="fs-mono">/api/entitlement</span>,
            so verification works offline from a cached claim: features never disappear because the network did.
            Revocation marks status only — there is no remote wipe, ever.
          </div>
          <details>
            <summary style={{ fontSize: fz(11.5), cursor: "pointer" }}>Authority public key</summary>
            <pre className="fs-mono" style={{ fontSize: fz(10), whiteSpace: "pre-wrap" }}>{ent?.publicKey}</pre>
          </details>
        </Section>
      ) : null}

      {tab === "about" ? (
        <>
          <Section title="Fusion Shell Web">
            <KV k="Build" v="3.0 — PWA conversion of the Fusion Shell Android master spec" />
            <KV k="Runtime" v="Next.js App Router · React · PostgreSQL via Drizzle · zero UI dependencies" />
            <KV k="Telemetry" v={<Badge tone="ok">none in the bundle — grep it</Badge>} />
            <KV k="User agent" v={shell.caps?.ua ?? ""} mono />
          </Section>
          <Section title="Diagnostics export">
            <Btn variant="ghost" onClick={() => {
              const payload = { caps: shell.caps, gov: shell.gov, settings: shell.settings, windows: shell.state.windows.length };
              const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
              const a = document.createElement("a"); a.href = url; a.download = "fusion-diagnostics.json"; a.click();
              URL.revokeObjectURL(url);
            }}>Download redacted diagnostics</Btn>
          </Section>
        </>
      ) : null}
    </div>
  );
}
