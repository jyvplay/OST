"use client";
import { parseBackupManifest, compareManifests } from "@/lib/backup-compare";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { fmtBytes } from "@/lib/api";
import { fromB64, openText, sealText, type Envelope } from "@/lib/crypto";
import { MAX_BACKUP_BYTES, verifyBackup, type BackupBundle } from "@/lib/backup/bundle";
import { bundleTree } from "@/lib/bundle-tree";
import { folderSizes, formatBytes as fmtBundleBytes } from "@/lib/folder-size";
import { DRILL_HEALTH_KEY, drillHealthState, parseDrillHealth, recordDrill, type DrillAttempt, type DrillHealth } from "@/lib/backup/drill-health";
import { makeRecoveryKey, openRecoveryBundle, RECOVERY_FORMAT, sealRecoveryBundle } from "@/lib/backup/recovery";
import { privacy } from "@/lib/privacy/session";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";
import { heavyWorkRefusal } from "@/lib/governor";

interface Summary {
  filesCreate: number; filesReplace: number; filesUnchanged: number; foldersCreate: number; foldersRevive: number;
  notesAdd: number; notesUnchanged: number; settingsChange: number; settingsUnchanged: number;
  settingsLocked: string[]; settingsUnknown: string[];
}
interface Preview { previewToken: string; summary: Summary; warnings: string[]; legacy: boolean }
interface Pending extends Preview { bundle: unknown }
interface DrillCounts { files: number; folders: number; notes: number; settings: number }
interface DrillResponse { kind: "data" | "config"; sampled: DrillCounts; total: DrillCounts; skippedSettings: number }

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const b64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const readBytes = (value: unknown, label: string): Uint8Array => {
  if (typeof value !== "string" || !b64Pattern.test(value)) throw new Error(`Invalid ${label}`);
  return fromB64(value);
};

/** Decrypt old downloads as well as new AAD-bound envelopes, entirely in this browser. */
async function decryptBundle(input: unknown, pass: string, method: "passphrase" | "recovery", recovery: string): Promise<unknown> {
  if (!record(input) || typeof input.format !== "string") return input;
  if (input.format === RECOVERY_FORMAT) return JSON.parse(await openRecoveryBundle(input, method, method === "recovery" ? recovery : pass));
  if (method === "recovery") throw new Error("This encrypted backup has no recovery-key slot; use its passphrase.");
  if (input.format === "fusion-encrypted-bundle-2") {
    const env = input.envelope;
    if (!record(env) || env.format !== "fusion-envelope-1" || env.kdf !== "PBKDF2-SHA256" || env.cipher !== "AES-GCM-256"
      || !Number.isSafeInteger(env.iterations) || (env.iterations as number) < 100_000 || (env.iterations as number) > 2_000_000
      || readBytes(env.salt, "salt").length !== 16 || readBytes(env.iv, "IV").length !== 12 || readBytes(env.data, "ciphertext").length < 16) {
      throw new Error("Invalid encrypted-bundle header");
    }
    return JSON.parse(await openText(env as unknown as Envelope, pass));
  }
  if (input.format === "fusion-encrypted-bundle-1") {
    if (input.kdf !== "PBKDF2-SHA256-600k" || input.cipher !== "AES-GCM-256") throw new Error("Invalid legacy encrypted-bundle header");
    const salt = readBytes(input.salt, "salt"), iv = readBytes(input.iv, "IV"), data = readBytes(input.data, "ciphertext");
    if (salt.length !== 16 || iv.length !== 12 || data.length < 16) throw new Error("Invalid legacy encrypted-bundle lengths");
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: 600_000, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    try {
      return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, data as BufferSource)));
    } catch { throw new Error("Wrong passphrase or modified encrypted backup"); }
  }
  throw new Error("Unknown encrypted backup format");
}

const problem = (body: Record<string, unknown>, status: number) => {
  const failures = Array.isArray(body.failures) ? body.failures.map((x) => record(x) ? `${String(x.path)}: ${String(x.reason)}` : String(x)).join("; ") : "";
  return String(body.error || failures || `HTTP ${status}`);
};
async function send(body: unknown) {
  const response = await fetch("/api/backup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok || json.ok !== true) throw new Error(problem(json, response.status));
  return json;
}

/** BK-03 portable settings + bounded data snapshots; no restore is applied without a fresh preview. */
export default function BackupModule(_: ModuleProps) {
  const shell = useShell();
  const [bundle, setBundle] = useState<BackupBundle | null>(null);
  const [showContents, setShowContents] = useState(false);
  const [report, setReport] = useState("");
  const [pass, setPass] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  const [unlockMethod, setUnlockMethod] = useState<"passphrase" | "recovery">("passphrase");
  const [unlockKey, setUnlockKey] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const drillInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [held, setHeld] = useState<{ kind: "data" | "config"; why: string } | null>(null);
  const [health, setHealth] = useState<DrillHealth | null>(null);
  const [healthStorage, setHealthStorage] = useState(false);
  const [healthNow, setHealthNow] = useState(0);
  const [drillReport, setDrillReport] = useState("");

  useEffect(() => {
    const load = () => {
      setHealthNow(Date.now());
      try { setHealth(parseDrillHealth(window.localStorage.getItem(DRILL_HEALTH_KEY))); setHealthStorage(!privacy.status().amnesic); }
      catch { setHealthStorage(false); }
    };
    // Avoid a hydration mismatch: localStorage is client-only.
    const first = window.setTimeout(load, 0);
    window.addEventListener("storage", load);
    window.addEventListener("focus", load);
    const timer = window.setInterval(() => setHealthNow(Date.now()), 60_000);
    return () => { window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener("storage", load); window.removeEventListener("focus", load); };
  }, []);

  const rememberDrill = (attempt: DrillAttempt) => {
    let previous = health;
    try { previous = parseDrillHealth(window.localStorage.getItem(DRILL_HEALTH_KEY)) ?? previous; } catch { /* session-only */ }
    const next = recordDrill(previous, attempt);
    setHealth(next); setHealthNow(Date.now());
    try { window.localStorage.setItem(DRILL_HEALTH_KEY, JSON.stringify(next)); setHealthStorage(true); }
    catch { setHealthStorage(false); }
  };

  const fetchBundle = async (kind: "data" | "config", force = false) => {
    const why = force ? null : heavyWorkRefusal(shell.gov);
    if (why) { setHeld({ kind, why }); return; }
    setHeld(null); setBusy(true); setReport("");
    setRecoveryKey(""); setConfirmKey("");
    try {
      const res = await fetch(`/api/backup?kind=${kind}`, { cache: "no-store" });
      const value: unknown = await res.json();
      if (!res.ok) throw new Error(record(value) ? problem(value, res.status) : `HTTP ${res.status}`);
      const verified = await verifyBackup(value);
      if (!verified.ok) throw new Error(verified.failures.map((f) => `${f.path}: ${f.reason}`).join("; "));
      setBundle(value as BackupBundle);
      const p = verified.payload;
      setReport(`${p.entries.length} entries · ${p.notes.length} notes · ${p.settings.length} settings · ${fmtBytes(p.entries.reduce((sum, e) => sum + e.size, 0))} · snapshot checksum verified in this browser.`);
    } catch (e) { setBundle(null); setReport(`Build failed: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      const result = await verifyBackup(bundle);
      setReport(result.ok ? "Verified the complete snapshot checksum in this browser. A plain checksum does not authenticate its source."
        : `Verification failed: ${result.failures.map((f) => `${f.path}: ${f.reason}`).join("; ")}`);
    } catch (e) { setReport(`Verification failed: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };

  const download = async (encrypted: boolean) => {
    if (!bundle) return;
    setBusy(true);
    try {
      const result = await verifyBackup(bundle);
      if (!result.ok) throw new Error("The snapshot failed verification; build it again.");
      let text = JSON.stringify(bundle);
      let name = `fusion-${bundle.kind}-${Date.now()}.json`;
      if (encrypted) {
        if (pass.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
        text = JSON.stringify({ format: "fusion-encrypted-bundle-2", envelope: await sealText(text, pass) });
        name = name.replace(".json", ".enc.json");
      }
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = name; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setReport(encrypted ? "Encrypted download started. Keep the passphrase separately; it cannot be recovered." : "Plain download started. It is readable by anyone who can open the file.");
    } catch (e) { setReport(`Download failed: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };

  const downloadRecovery = async () => {
    if (!bundle || !recoveryKey || confirmKey.trim().toUpperCase() !== recoveryKey) return;
    setBusy(true);
    try {
      const result = await verifyBackup(bundle);
      if (!result.ok) throw new Error("The snapshot failed verification; build it again.");
      const text = JSON.stringify(await sealRecoveryBundle(JSON.stringify(bundle), pass, recoveryKey));
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `fusion-${bundle.kind}-${Date.now()}.recovery.json`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setRecoveryKey(""); setConfirmKey("");
      setReport("Recovery-key encrypted download started. Keep the saved key separate from the backup; either it or the passphrase can decrypt it.");
    } catch (e) { setReport(`Download failed: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    setPending(null); setBusy(true); setReport("");
    try {
      // Ciphertext is base64, so the encrypted wrapper is larger than the plain API limit.
      if (file.size > MAX_BACKUP_BYTES * 2) throw new Error("File exceeds the backup import limit");
      const parsed = await decryptBundle(JSON.parse(await file.text()), pass, unlockMethod, unlockKey);
      if (unlockMethod === "recovery") setUnlockKey("");
      const check = await verifyBackup(parsed);
      if (!check.ok) throw new Error(check.failures.map((f) => `${f.path}: ${f.reason}`).join("; "));
      const preview = await send({ bundle: parsed, dryRun: true }) as unknown as Preview;
      setPending({ bundle: parsed, ...preview });
      setReport("Preview ready. Nothing has been changed yet.");
    } catch (e) { setReport(`Import failed: ${String((e as Error).message)}`); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await send({ bundle: pending.bundle, previewToken: pending.previewToken, allowLegacy: pending.legacy });
      const summary = result.summary as Summary;
      setPending(null);
      shell.bumpRefresh();
      let reloadWarning = "";
      if (summary.settingsChange) {
        try { await shell.reloadSettings(); }
        catch { reloadWarning = " Settings were saved; reload the shell to display them."; }
      }
      setReport(`Restore committed: ${summary.filesCreate} new and ${summary.filesReplace} replaced files; ${summary.notesAdd} notes; ${summary.settingsChange} settings.${reloadWarning}`);
    } catch (e) { setPending(null); setReport(`Restore failed or could not be confirmed: ${String((e as Error).message)} Check the destination, then choose the bundle again for a fresh preview.`); }
    finally { setBusy(false); }
  };

  const runDrill = async (file: File) => {
    // This endpoint sends decrypted content to the server and does temp database writes;
    // amnesic sessions intentionally cannot perform or persist the drill.
    if (!privacy.status().installed || privacy.status().amnesic) {
      setDrillReport("Restore drills are unavailable in an amnesic or uninitialised privacy session."); return;
    }
    setBusy(true); setDrillReport("");
    let kind: DrillAttempt["kind"] = "unknown";
    try {
      if (file.size > MAX_BACKUP_BYTES * 2) throw new Error("File exceeds the backup import limit");
      const parsed = await decryptBundle(JSON.parse(await file.text()), pass, unlockMethod, unlockKey);
      if (unlockMethod === "recovery") setUnlockKey("");
      const check = await verifyBackup(parsed);
      if (!check.ok) throw new Error(check.failures.map((f) => `${f.path}: ${f.reason}`).join("; "));
      kind = check.payload.kind;
      const result = await send({ bundle: parsed, drill: true });
      const drill = result.drill as DrillResponse | undefined;
      if (result.verified !== true || !drill || drill.kind !== kind || !drill.sampled || !drill.total ||
        !["files", "folders", "notes", "settings"].every((k) => {
          const key = k as keyof DrillCounts, n = drill.sampled[key], total = drill.total[key];
          return Number.isSafeInteger(n) && Number.isSafeInteger(total) && n >= 0 && n <= total && total <= 10_000;
        }) || !Number.isSafeInteger(drill.skippedSettings) || drill.skippedSettings < 0 || drill.skippedSettings > drill.sampled.settings ||
        drill.sampled.files + drill.sampled.folders + drill.sampled.notes + drill.sampled.settings - drill.skippedSettings < 1) {
        throw new Error("The server did not return a valid drill result.");
      }
      const partial = check.legacy || result.legacy === true || drill.skippedSettings > 0;
      rememberDrill({ at: new Date().toISOString(), outcome: partial ? "partial" : "passed", kind, ...drill.sampled });
      const s = drill.sampled, t = drill.total;
      setDrillReport(`${partial ? "Partial drill" : "Drill passed"}: read back ${s.files}/${t.files} files, ${s.folders}/${t.folders} folders, ${s.notes}/${t.notes} notes and ${s.settings - drill.skippedSettings}/${t.settings} settings in temporary tables; rollback confirmed.${drill.skippedSettings ? ` ${drill.skippedSettings} sampled settings were locked or unknown.` : ""}${check.legacy ? " Legacy metadata is not checksum-protected." : ""}`);
    } catch (e) {
      rememberDrill({ at: new Date().toISOString(), outcome: "failed", kind, files: 0, folders: 0, notes: 0, settings: 0 });
      setDrillReport(`Drill failed or could not be confirmed: ${String((e as Error).message)}`);
    } finally { setBusy(false); }
  };

  const healthView = drillHealthState(health, healthNow);
  const healthLabels = { never: "No drill recorded", passed: "Last selected backup passed", partial: "Last drill was partial", failed: "Last drill failed", due: "Monthly drill due", clock: "Check the device clock or local status" };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Export" right={busy ? <Badge tone="warn">working…</Badge> : null}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="primary" disabled={busy} onClick={() => void fetchBundle("data")}>Build data bundle</Btn>
          <Btn variant="ghost" disabled={busy} onClick={() => void fetchBundle("config")}>Build config bundle</Btn>
          <Btn variant="ghost" disabled={busy || !bundle} onClick={() => void verify()}>Verify digests</Btn>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Compare with an older bundle
            <input type="file" accept=".json,application/json" hidden aria-label="Compare with an older bundle" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f || !bundle) return;
              try {
                const before = parseBackupManifest(await f.text());
                const after = bundle.entries.map((en) => ({ path: en.path, bytes: en.size, sha256: en.sha256 }));
                const d = compareManifests(before, after);
                setReport(`Compared with ${f.name}: ${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed, ${d.unchanged} unchanged; size ${d.bytesDelta >= 0 ? "+" : ""}${d.bytesDelta} B.${d.changed.length ? ` Changed: ${d.changed.slice(0, 8).map((c) => c.path).join(", ")}` : ""}${d.added.length ? ` Added: ${d.added.slice(0, 8).join(", ")}` : ""}${d.removed.length ? ` Removed: ${d.removed.slice(0, 8).join(", ")}` : ""}`);
              } catch (err) { setReport(`Compare refused: ${String((err as Error).message)}`); }
              e.target.value = "";
            }} />
          </label>
          <Btn variant="ghost" disabled={busy || !bundle} onClick={() => void download(false)}>Download plain</Btn>
          <Btn variant="ghost" disabled={busy || !bundle || pass.length < 8} onClick={() => void download(true)}>Download encrypted</Btn>
        </div>
        <input className="fs-input" type="password" placeholder="bundle passphrase" value={pass}
          onChange={(e) => setPass(e.target.value)} aria-label="Bundle passphrase" />
        <div className="fs-dim" style={{ fontSize: fz(11.5) }}>“Download encrypted” is passphrase-only. For a separate recovery key, use the section below.</div>
        {held ? <div role="alert" data-testid="backup-held" className="fs-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: fz(12) }}>
          <span>{held.why}</span><Btn variant="ghost" onClick={() => void fetchBundle(held.kind, true)}>Build anyway</Btn>
          <Btn variant="ghost" onClick={() => setHeld(null)}>Not now</Btn>
        </div> : null}
        {report ? <div role="status" data-testid="backup-report" className="fs-mono" style={{ fontSize: fz(11.5) }}>{report}</div> : null}
        {bundle ? <div style={{ marginTop: 8 }}>
          <Btn variant="ghost" aria-expanded={showContents} onClick={() => setShowContents((v) => !v)}>{showContents ? "Hide contents" : "Show contents"}</Btn>
          {showContents ? <div data-testid="backup-contents" style={{ display: "grid", gap: 2, marginTop: 6 }}>
            {folderSizes(bundleTree(bundle.entries)).slice(0, 10).map((f) => (
              <div key={f.path} className="fs-row" style={{ justifyContent: "space-between", fontSize: fz(11.5) }}>
                <span className="fs-mono">{f.path}</span>
                <span className="fs-dim">{fmtBundleBytes(f.bytes)} · {f.files} file{f.files === 1 ? "" : "s"}</span>
              </div>
            ))}
            <span className="fs-dim" style={{ fontSize: fz(11) }}>Largest folders in this bundle, from its own entry list.</span>
          </div> : null}
        </div> : null}
      </Section>

      <Section title="Optional recovery key">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          A recovery-key download can be opened with either its passphrase or its separate key. Anyone with the key can read the backup.
          Save the key somewhere safe and separate; it is not sent to Fusion or stored in the cloud. Losing both secrets means losing access.
        </div>
        <Btn variant="ghost" disabled={busy || !bundle} onClick={() => {
          try { setRecoveryKey(makeRecoveryKey()); setConfirmKey(""); }
          catch { setReport("Could not generate a secure recovery key in this browser."); }
        }}>Generate recovery key</Btn>
        {recoveryKey ? <div className="fs-panel" style={{ padding: 8, marginTop: 8 }}>
          <strong>Save this key now</strong>
          <div className="fs-mono" data-testid="backup-recovery-key" style={{ overflowWrap: "anywhere", userSelect: "all" }}>{recoveryKey}</div>
          <label>Re-enter your saved key to confirm
            <input className="fs-input" type="password" value={confirmKey} onChange={(e) => setConfirmKey(e.target.value)} aria-label="Confirm saved recovery key" autoComplete="off" />
          </label>
          <Btn variant="primary" disabled={busy || pass.length < 8 || confirmKey.trim().toUpperCase() !== recoveryKey} onClick={() => void downloadRecovery()}>Download with recovery key</Btn>
          <div className="fs-dim" style={{ fontSize: fz(11.5) }}>The key will be cleared from this panel after the download starts. Confirmation cannot prove you saved it.</div>
        </div> : null}
      </Section>

      <Section title="Restore">
        <label>Decrypt with
          <select className="fs-select" aria-label="Decrypt with" value={unlockMethod} onChange={(e) => { setUnlockMethod(e.target.value as "passphrase" | "recovery"); setUnlockKey(""); }}>
            <option value="passphrase">Bundle passphrase above</option>
            <option value="recovery">Recovery key</option>
          </select>
        </label>
        {unlockMethod === "recovery" ? <input className="fs-input" type="password" autoComplete="off" value={unlockKey} onChange={(e) => setUnlockKey(e.target.value)} aria-label="Recovery key for restore" /> : null}
        <Btn variant="primary" disabled={busy} onClick={() => fileInput.current?.click()}>Choose bundle…</Btn>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden disabled={busy} aria-label="Choose backup bundle" data-testid="backup-file"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          A preview is required before applying changes. Existing files are versioned before replacement; notes are merged as copies,
          and identical copies are skipped. Existing folders retain their tags. A changed destination requires a new preview.
        </div>
        {pending ? <div data-testid="backup-preview" className="fs-panel" style={{ padding: 8, marginTop: 8 }}>
          <strong>Restore preview — nothing changed yet</strong>
          <div>{pending.summary.filesCreate} new files · {pending.summary.filesReplace} replacements · {pending.summary.filesUnchanged} unchanged files</div>
          <div>{pending.summary.foldersCreate} new folders · {pending.summary.foldersRevive} revived folders · {pending.summary.notesAdd} new notes · {pending.summary.notesUnchanged} existing notes</div>
          <div>{pending.summary.settingsChange} settings to change · {pending.summary.settingsUnchanged} unchanged</div>
          {pending.summary.settingsLocked.length ? <div>Locked settings skipped: {pending.summary.settingsLocked.join(", ")}</div> : null}
          {pending.summary.settingsUnknown.length ? <div>Unknown settings skipped: {pending.summary.settingsUnknown.join(", ")}</div> : null}
          {pending.warnings.map((warning) => <div role="alert" key={warning}>{warning}</div>)}
          <div className="fs-row" style={{ gap: 6, marginTop: 6 }}>
            <Btn variant="primary" disabled={busy} onClick={() => void apply()}>Restore now</Btn>
            <Btn variant="ghost" disabled={busy} onClick={() => { setPending(null); setReport("Restore cancelled; nothing changed."); }}>Cancel restore</Btn>
          </div>
        </div> : null}
      </Section>

      <Section title="Backup health and restore drill">
        <div data-testid="backup-drill-health" role="status" className="fs-mono" style={{ fontSize: fz(12) }}>
          <strong>{healthLabels[healthView.state]}</strong>
          {health ? <div>Last attempt: {health.lastAttempt.at} · {health.lastAttempt.kind} · {health.lastAttempt.outcome}</div> : null}
          {healthView.dueAt ? <div>Next monthly check: {healthView.dueAt} (UTC)</div> : null}
          {!healthStorage ? <div>Local status is unavailable or session-only; reminders may not survive closing this tab.</div> : null}
        </div>
        <p className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Select a previously saved backup, using the decryption controls above. The complete bundle is checked, then a limited sample is
          actually restored and read back in temporary PostgreSQL tables. The transaction is rolled back; your live files and settings are not replaced.
          The decrypted bundle goes to this Fusion server; PostgreSQL temporary tables and indexes may put plaintext on its disk, and rollback is not secure erasure.
          This does not test Private-volume unlocking, other devices or the continued health of the saved copy.
        </p>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="primary" disabled={busy} onClick={() => drillInput.current?.click()}>Choose backup to drill…</Btn>
          <Btn variant="ghost" disabled={busy || !health} onClick={() => {
            try { window.localStorage.removeItem(DRILL_HEALTH_KEY); } catch { setHealthStorage(false); }
            setHealth(null); setDrillReport("Local drill status cleared.");
          }}>Clear local drill status</Btn>
        </div>
        <input ref={drillInput} type="file" accept="application/json,.json" hidden disabled={busy} aria-label="Choose backup for restore drill" data-testid="backup-drill-file"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void runDrill(f); }} />
        {drillReport ? <div role="status" data-testid="backup-drill-report" className="fs-mono" style={{ fontSize: fz(11.5) }}>{drillReport}</div> : null}
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          The reminder is shown only when this Backup window is open; it is not an automatic monthly job or notification. Status is kept on this browser
          without file names, contents or secrets. A pass describes only the selected copy and sampled restore at that time, not all backups.
        </div>
      </Section>

      <Section title="Scope and key custody">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Config bundles contain editable settings only. Data bundles contain current, non-trashed Fusion files, folders and notes;
          they do not include tasks, contacts, file history, trash, or every app database. This is not an incremental timeline or an automatic scheduled restore drill.
          Plain backups are readable and their SHA-256 checksum detects corruption but does not authenticate the source.
          Encrypted downloads use PBKDF2-SHA256 (600,000 iterations) and authenticated AES-GCM. The passphrase and optional recovery key stay in this browser;
          decrypted contents are sent to this Fusion server when restoring. Passphrase-only downloads have no separate recovery key. There is no escrow;
          for a recovery-key download either secret can decrypt it, and losing both makes it unreadable.
        </div>
      </Section>
    </div>
  );
}
