"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { fmtBytes, post } from "@/lib/api";
import { privacy, PRIVATE_ROOT, EMERGENCY_CHORD, type PrivacyStatus } from "@/lib/privacy/session";
import { decryptPath, PBKDF2_FLOOR } from "@/lib/privacy/pcrypt";
import { cleanVfsFile, type CleanFileResult } from "@/lib/privacy/cleanfile";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, KV, Section, Tabs, Toggle } from "../ui";
import { AccessLogPanel } from "./AccessLog";

type Tab = "storage" | "amnesia" | "metadata" | "check" | "access";
type Audit = Awaited<ReturnType<typeof privacy.audit>>;
type Bench = Awaited<ReturnType<typeof privacy.benchmark>>;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * TT18 privacy centre — Tails' model mapped onto a web shell, then pushed further:
 *  · Encrypted Persistent Storage (/Private): Argon2id keyslots, names + content + versions encrypted in
 *    the browser, recovery key, passphrase change without re-encryption, idle auto-lock.
 *  · Amnesic session: host writes denied by default, RAM overlay for files, nothing new in the profile.
 *  · Emergency shutdown, metadata removal (MAT2-like, in-browser), host-side audit, real benchmark.
 */
export default function PrivacyModule(_: ModuleProps) {
  const shell = useShell();
  const [st, setSt] = useState<PrivacyStatus>(() => privacy.status());
  const [tab, setTab] = useState<Tab>("storage");
  const [pass, setPass] = useState(""); const [pass2, setPass2] = useState(""); const [next, setNext] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string | null>(null);
  const [audit, setAudit] = useState<(Audit & { logical: Record<string, string> }) | null>(null);
  const [bench, setBench] = useState<Bench | null>(null);
  const [cacheClear, setCacheClear] = useState<{ nodes: number; versions: number; index: number } | null>(null);
  const [cleanPath, setCleanPath] = useState(""); const [overwrite, setOverwrite] = useState(false);
  const [cleaned, setCleaned] = useState<CleanFileResult | null>(null);
  const [blocked, setBlocked] = useState<{ at: number; what: string }[]>([]);
  const [bk, setBk] = useState<{ name: string; text: string } | null>(null); // backup file chosen for verify/restore
  const [bkPass, setBkPass] = useState("");
  const [bkReport, setBkReport] = useState<string | null>(null);

  useEffect(() => {
    const off = privacy.subscribe((s) => { setSt(s); setBlocked(privacy.blockedLog().slice(-40).reverse()); if (s.storage === "locked") { setRecovery(null); setPass(""); setPass2(""); setNext(""); setBkPass(""); setAudit(null); setBkReport(null); } });
    void privacy.refreshHeader();
    return off;
  }, []);

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what); setErr(null);
    try { await f(); } catch (e) { setErr(`${what}: ${(e as Error).message}`); } finally { setBusy(null); }
  };

  const doUnlock = () => run("unlock", async () => { const kind = await privacy.unlock(pass); setPass(""); shell.toast(`Unlocked with the ${kind} key`, "ok"); shell.bumpRefresh(); });
  const readBackupFile = async (f: File | undefined) => { setBkReport(null); setBk(f ? { name: f.name, text: await f.text() } : null); };
  const doBackup = () => run("backup", async () => {
    const r = await privacy.backup();
    const url = URL.createObjectURL(new Blob([r.text], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `fusion-private-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setBkReport(`Backup made: ${r.files} files, ${r.dirs} folders, ${fmtBytes(r.text.length)} file. Nothing was decrypted to make it.${r.skipped.length ? ` Skipped ${r.skipped.length} host-cleartext entr${r.skipped.length === 1 ? "y" : "ies"} (seal them in Audit first): ${r.skipped.join(", ")}` : ""}`);
  });
  const doVerify = () => run("verify", async () => {
    if (!bk) return;
    const v = await privacy.verifyBackupText(bk.text, bkPass ? bkPass : undefined);
    setBkReport(v.failures.length ? `Backup DAMAGED: ${v.failures.length} problem(s): ${v.failures.slice(0, 5).join("; ")}`
      : `Backup OK (${v.created}): ${v.files} files and ${v.dirs} folders decrypt and authenticate, ${fmtBytes(v.plainBytes)} of content.`);
  });
  const doRestore = () => run("restore", async () => {
    if (!bk) return;
    const r = await privacy.restoreBackupText(bk.text, bkPass); setBkPass("");
    setBkReport(`Restored: ${r.written} files written, ${r.kept} already present, ${r.dirs} folders${r.failures.length ? `, ${r.failures.length} failed` : ""}. Unlock with the passphrase that was valid when the backup was made.`);
    shell.toast("Persistent Storage restored", "ok"); shell.bumpRefresh();
  });
  const ram = st.amnesic ? privacy.ramFiles() : [];
  const doRescue = (paths: string[]) => run("rescue", async () => {
    const r = await privacy.rescue(paths);
    shell.toast(`${r.moved.length} file(s) kept in Persistent Storage${r.failed.length ? `, ${r.failed.length} failed` : ""}`, r.failed.length ? "warn" : "ok");
    if (r.failed.length) setErr(`rescue: ${r.failed.map((f) => `${f.path}: ${f.error}`).join("; ")}`);
    shell.bumpRefresh();
  });
  const backupPicker = (
    <>
      <input type="file" accept=".json,application/json" aria-label="Backup file" data-testid="backup-file" onChange={(e) => void readBackupFile(e.currentTarget.files?.[0])} />
      <input className="fs-input" type="password" placeholder="Passphrase or recovery key for this backup" value={bkPass} onChange={(e) => setBkPass(e.target.value)} data-testid="backup-pass" />
    </>
  );
  const bkOut = bkReport ? <div className="fs-panel fs-mono" role="status" data-testid="backup-report" style={{ fontSize: fz(12), whiteSpace: "pre-wrap", padding: 8 }}>{bkReport}</div> : null;
  const storageTone = st.storage === "unlocked" ? "ok" : st.storage === "locked" ? "warn" : "default";

  return (
    <div className="fs-scroll" style={{ padding: 12, display: "grid", gap: 10, alignContent: "start" }} data-testid="privacy">
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Badge tone={st.amnesic ? "info" : "default"}>{st.amnesic ? "AMNESIC session" : "normal session"}</Badge>
        <Badge tone={storageTone}>Persistent Storage: {st.storage}</Badge>
        {st.fingerprint ? <Badge title="Volume key fingerprint — compare across devices">key {st.fingerprint}</Badge> : null}
        {st.blocked ? <Badge tone="warn">{st.blocked} host writes blocked</Badge> : null}
        <div style={{ flex: 1 }} />
        <Btn variant="danger" data-testid="emergency" title={`Emergency shutdown (${EMERGENCY_CHORD})`}
          onClick={() => { if (confirm("Emergency shutdown: forget keys, wipe RAM files and leave this page now?")) void privacy.emergencyShutdown(); }}>
          Emergency shutdown
        </Btn>
      </div>
      {err || st.lastError ? <div className="fs-panel" role="alert" style={{ padding: 8, color: "var(--fs-bad, #e66)" }}>{err ?? st.lastError}</div> : null}

      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: "storage", label: "Persistent Storage" }, { id: "amnesia", label: "Amnesia" },
        { id: "metadata", label: "Remove metadata" }, { id: "check", label: "Audit & speed" }, { id: "access", label: "Device access" },
      ]} />

      {tab === "access" ? <AccessLogPanel /> : null}

      {tab === "storage" ? (
        <>
          {bkOut}
          {recovery && st.storage === "unlocked" ? (
            <Section title="Recovery key — shown once">
              <div className="fs-mono" data-testid="recovery-key" style={{ fontSize: fz(15), userSelect: "all", wordBreak: "break-all" }}>{recovery}</div>
              <div className="fs-dim" style={{ fontSize: fz(12) }}>Write it down. It unlocks the storage if you forget the passphrase; it is not stored anywhere in clear.</div>
              <div className="fs-row"><Btn onClick={() => setRecovery(null)}>I have saved it</Btn></div>
            </Section>
          ) : null}

          {st.storage === "absent" ? (
            <Section title="Create encrypted Persistent Storage">
              <div className="fs-dim" style={{ fontSize: fz(12) }}>
                Files under <span className="fs-mono">{PRIVATE_ROOT}</span> are encrypted in this browser before upload — names, contents,
                versions. Like Tails, use 5–7 random words. Unlocking costs ~1 s by design (Argon2id, 64 MiB).
              </div>
              <input className="fs-input" type="password" placeholder="Passphrase" value={pass} onChange={(e) => setPass(e.target.value)} data-testid="pp1" />
              <input className="fs-input" type="password" placeholder="Repeat passphrase" value={pass2} onChange={(e) => setPass2(e.target.value)} data-testid="pp2" />
              <div className="fs-row" style={{ gap: 8 }}>
                <Badge tone={words(pass) >= 5 ? "ok" : words(pass) >= 3 ? "warn" : "bad"}>{words(pass)} words</Badge>
                <Btn variant="primary" disabled={!!busy || pass.length < 8 || pass !== pass2} data-testid="create"
                  onClick={() => run("create", async () => { const rk = await privacy.create(pass); setRecovery(rk); setPass(""); setPass2(""); shell.toast("Persistent Storage created and unlocked", "ok"); })}>
                  {busy === "create" ? "Deriving key…" : "Create"}
                </Btn>
              </div>
            </Section>
          ) : null}

          {st.storage === "absent" ? (
            <Section title="Restore from an encrypted backup file">
              <div className="fs-dim" style={{ fontSize: fz(12) }}>Everything is checked before anything is written; a damaged or tampered backup writes nothing.</div>
              {backupPicker}
              <div className="fs-row"><Btn variant="primary" disabled={!!busy || !bk || !bkPass} data-testid="backup-restore" onClick={() => void doRestore()}>{busy === "restore" ? "Restoring…" : "Verify & restore"}</Btn></div>
            </Section>
          ) : null}

          {st.storage === "locked" || st.storage === "unknown" ? (
            <Section title="Unlock Persistent Storage">
              <input className="fs-input" type="password" placeholder="Passphrase or recovery key" value={pass} data-testid="unlock-pass"
                onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && pass && !busy) void doUnlock(); }} />
              <div className="fs-row"><Btn variant="primary" disabled={!!busy || !pass} data-testid="unlock"
                onClick={() => void doUnlock()}>
                {busy === "unlock" ? "Deriving key…" : "Unlock"}
              </Btn></div>
            </Section>
          ) : null}

          {st.storage === "unlocked" ? (
            <>
              <Section title="Unlocked" right={<Btn data-testid="lock" onClick={() => { privacy.lock(); shell.bumpRefresh(); }}>Lock now</Btn>}>
                <KV k="Encrypted root" v={<span className="fs-mono">{PRIVATE_ROOT}</span>} />
                <KV k="Auto-lock when idle" v={
                  <select className="fs-select" value={st.autoLockMin} onChange={(e) => privacy.setAutoLock(Number(e.target.value))} aria-label="Auto-lock minutes">
                    {[0, 5, 15, 30, 60, 240].map((m) => <option key={m} value={m}>{m === 0 ? "never" : `${m} min`}</option>)}
                  </select>} />
                <table style={{ borderCollapse: "collapse", fontSize: fz(11.5), textAlign: "left" }}>
                  <thead><tr><th>Keyslot</th><th>Kind</th><th>KDF</th><th>Created</th></tr></thead>
                  <tbody>{st.slots.map((s) => <tr key={s.id}><td className="fs-mono">{s.id}</td><td>{s.kind}</td><td>{s.kdf}</td><td suppressHydrationWarning>{new Date(s.created).toLocaleDateString()}</td></tr>)}</tbody>
                </table>
              </Section>
              <Section title="Change passphrase (re-wraps the key; files are not re-encrypted)">
                <input className="fs-input" type="password" placeholder="Current passphrase" value={pass} onChange={(e) => setPass(e.target.value)} />
                <input className="fs-input" type="password" placeholder="New passphrase" value={next} onChange={(e) => setNext(e.target.value)} />
                <div className="fs-row" style={{ gap: 8 }}>
                  <Btn disabled={!!busy || !pass || next.length < 8} onClick={() => run("change", async () => { await privacy.changePassphrase(pass, next); setPass(""); setNext(""); shell.toast("Passphrase changed", "ok"); })}>Change</Btn>
                  <Btn disabled={!!busy || !pass} title="Issue a new recovery key; the old one stops working"
                    onClick={() => run("rotate", async () => { setRecovery(await privacy.rotateRecovery(pass)); setPass(""); })}>New recovery key</Btn>
                </div>
              </Section>
              <Section title="Backup — one encrypted file, no second USB stick, no admin password">
                <div className="fs-dim" style={{ fontSize: fz(12) }}>
                  Downloads the stored ciphertext plus the keyslot header as one file; names, folder layout and sizes are sealed inside it.
                  It opens with the passphrase or recovery key valid when it was made. Verify any backup here without restoring it.
                  Not included: version history and trash.
                </div>
                <div className="fs-row" style={{ gap: 8 }}>
                  <Btn variant="primary" disabled={!!busy} data-testid="backup-download" onClick={() => void doBackup()}>{busy === "backup" ? "Packing…" : "Download encrypted backup"}</Btn>
                </div>
                {backupPicker}
                <div className="fs-row"><Btn disabled={!!busy || !bk} data-testid="backup-verify" title="Leave the passphrase empty to use the unlocked key" onClick={() => void doVerify()}>{busy === "verify" ? "Checking…" : "Verify backup file"}</Btn></div>
                </Section>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "amnesia" ? (
        <>
          <Section title="Session">
            <div className="fs-dim" style={{ fontSize: fz(12) }}>
              An amnesic session writes nothing new to the host or this browser profile: file changes live in RAM, settings and notes are refused,
              local storage is shadowed in memory, and IndexedDB is blocked. Persistent Storage still works when unlocked. Close the tab or use
              Emergency shutdown and it is gone.
            </div>
            <div className="fs-row" style={{ gap: 8 }}>
              {st.amnesic
                ? <Btn data-testid="restart-normal" onClick={() => { if (confirm(ram.length ? `Restart normally? ${ram.length} file(s) exist only in RAM and will be lost — use "Keep" below first.` : "Restart normally? Everything in this amnesic session is wiped.")) privacy.restart(false); }}>Restart normally (wipe)</Btn>
                : <Btn variant="primary" data-testid="restart-amnesic" onClick={() => privacy.restart(true)}>Restart amnesic</Btn>}
            </div>
            <Toggle on={st.bootAmnesic} label="Always start amnesic on this device" disabled={st.amnesic}
              reason={st.amnesic ? "change this from a normal session (an amnesic session must not write the preference)" : undefined}
              onChange={(v) => privacy.setBootAmnesic(v)} />
          </Section>
          {st.amnesic ? (
            <Section title="Held in RAM only">
              <KV k="Files" v={`${st.ram.files} (${fmtBytes(st.ram.bytes)})`} />
              <KV k="Folders" v={st.ram.dirs} />
              <KV k="Host files hidden (untouched on host)" v={st.ram.whiteouts} />
              <KV k="Shadowed local-storage keys" v={st.shadowKeys} />
            </Section>
          ) : null}
          {st.amnesic ? (
            <Section title={`Unsaved work — lost when this tab closes (${ram.length})`} right={ram.length ? (
              <Btn variant="primary" data-testid="rescue-all" disabled={!!busy || st.storage !== "unlocked"} title={st.storage !== "unlocked" ? "Unlock Persistent Storage first" : "Move every RAM-only file to /Private/Rescued (encrypted)"}
                onClick={() => void doRescue(ram.map((f) => f.path))}>Keep all in Persistent Storage</Btn>) : null}>
              {ram.length ? (
                <ul className="fs-mono" data-testid="ram-files" style={{ margin: 0, paddingLeft: 16, fontSize: fz(11.5) }}>
                  {ram.slice(0, 50).map((f) => (
                    <li key={f.path}>{f.path} · {fmtBytes(f.size)}{" "}
                      <Btn data-testid="rescue-one" disabled={!!busy || st.storage !== "unlocked"} onClick={() => void doRescue([f.path])}>Keep</Btn></li>))}
                </ul>
              ) : <div className="fs-dim" style={{ fontSize: fz(12) }}>No RAM-only files. Closing the tab now loses nothing you saved.</div>}
              <div className="fs-dim" style={{ fontSize: fz(12) }}>While this list is not empty, closing or reloading the tab asks for confirmation (Emergency shutdown never asks).
                {st.storage !== "unlocked" ? " Unlock Persistent Storage to keep files." : " Kept files go to /Private/Rescued, encrypted."}</div>
            </Section>
          ) : null}
          <Section title={`Blocked host writes (${st.blocked})`}>
            {blocked.length ? <ul className="fs-mono" style={{ margin: 0, paddingLeft: 16, fontSize: fz(11.5) }} data-testid="blocked-log">{blocked.map((b, i) => <li key={i} suppressHydrationWarning>{new Date(b.at).toLocaleTimeString()} · {b.what}</li>)}</ul>
              : <div className="fs-dim" style={{ fontSize: fz(12) }}>Nothing blocked yet.</div>}
          </Section>
        </>
      ) : null}

      {tab === "metadata" ? (
        <Section title="Remove metadata (in this browser — /Private files never reach the host in clear)">
          <div className="fs-dim" style={{ fontSize: fz(12) }}>
            JPEG, PNG, WebP, GIF, SVG, DOCX, XLSX, PPTX. Pixels and text are not re-encoded; JPEG keeps only the rotation tag so photos still display
            upright. PDF is refused rather than half-cleaned.
          </div>
          <input className="fs-input fs-mono" placeholder="/Pictures/photo.jpg" value={cleanPath} onChange={(e) => setCleanPath(e.target.value)} data-testid="clean-path" />
          <Toggle on={overwrite} onChange={setOverwrite} label="Overwrite the original and forget its version history" />
          <div className="fs-row"><Btn variant="primary" disabled={!!busy || !cleanPath.startsWith("/")} data-testid="clean"
            onClick={() => run("clean", async () => { setCleaned(await cleanVfsFile(cleanPath, { overwrite })); shell.bumpRefresh(); })}>Clean</Btn></div>
          {cleaned ? <CleanReportView r={cleaned} /> : null}
        </Section>
      ) : null}

      {tab === "check" ? (
        <>
          <Section title="Host audit" right={<Btn disabled={st.storage !== "unlocked" || !!busy} data-testid="audit"
            onClick={() => run("audit", async () => {
              const a = await privacy.audit(); const logical: Record<string, string> = {};
              const k = privacy.layer?.keys;
              if (k) for (const p of new Set([...a.plainNames, ...a.plainContent])) logical[p] = (await decryptPath(k, p)).path;
              setAudit({ ...a, logical });
            })}>Run audit</Btn>}>
            <div className="fs-dim" style={{ fontSize: fz(12) }}>Reads exactly what the host stores under {PRIVATE_ROOT} and flags anything not encrypted (e.g. written by another client or a script).</div>
            {audit ? (
              <div data-testid="audit-result" style={{ display: "grid", gap: 4 }}>
                <KV k="Files / folders" v={`${audit.files} / ${audit.dirs}`} />
                <KV k="Encrypted names / contents" v={`${audit.encryptedNames} / ${audit.encryptedContent}`} />
                <KV k="Undecryptable (other key?)" v={audit.undecryptable.length} />
                {[...new Set([...audit.plainNames, ...audit.plainContent])].map((p) => (
                  <div key={p} className="fs-row" style={{ gap: 8 }}>
                    <span style={{ flex: "none" }}><Badge tone="bad">in clear</Badge></span><span className="fs-mono" style={{ fontSize: fz(12) }}>{audit.logical[p] ?? p}</span>
                    <Btn onClick={() => run("seal", async () => {
                      const from = audit.logical[p]; if (!from) throw new Error("unlock first");
                      const to = from.replace(/\[clear\] /g, "");
                      await post("/api/fs", { op: "move", src: from, dst: to });
                      shell.toast(`Sealed: ${to}`, "ok"); setAudit(null);
                    })}>Encrypt it</Btn>
                  </div>
                ))}
                {audit.plainNames.length + audit.plainContent.length === 0 ? <div style={{ justifySelf: "start" }}><Badge tone="ok">nothing stored in clear</Badge></div> : null}
              </div>
            ) : null}
          </Section>
          <Section title="Old thumbnail cache" right={<Btn disabled={!!busy || st.amnesic} data-testid="clear-old-thumbnails"
            onClick={() => {
              if (!confirm("Remove ALL server thumbnail cache entries and their saved versions? Thumbnails will be regenerated. This does not erase backups or database history. Close older app tabs first.")) return;
              void run("clear thumbnail cache", async () => {
                if (privacy.status().amnesic) throw new Error("not available in an amnesic session");
                const result = await post<{ nodes: number; versions: number; index: number }>("/api/privacy/thumbnail-cache", { confirm: "CLEAR THUMBNAIL CACHE" });
                setCacheClear(result);
              });
            }}>Clear thumbnail cache…</Btn>}>
            <div className="fs-dim" style={{ fontSize: fz(12) }}>Earlier versions could save previews of /Private files unencrypted in the shared server cache. Clear all thumbnails and saved cache versions after closing older app tabs. This removes current database rows only—not backups, replicas, database logs or residual disk data; it is not secure erasure.</div>
            {st.amnesic ? <div className="fs-dim" style={{ fontSize: fz(12) }}>Unavailable in an amnesic session because this changes host data.</div> : null}
            {cacheClear ? <div role="status" data-testid="thumbnail-cache-result">Removed {cacheClear.nodes} cache entries, {cacheClear.versions} saved versions and {cacheClear.index} index entries from the current database.</div> : null}
          </Section>
          <Section title="Encryption speed (this device, real AES-256-GCM)" right={<Btn disabled={!!busy} data-testid="bench"
            onClick={() => run("bench", async () => setBench(await privacy.benchmark()))}>{busy === "bench" ? "Measuring…" : "Measure"}</Btn>}>
            {bench ? (
              <div data-testid="bench-result">
                <KV k="Encrypt" v={`${bench.encryptMBps} MB/s (${bench.encryptMs.toFixed(1)} ms per ${fmtBytes(bench.bytes)})`} />
                <KV k="Decrypt" v={`${bench.decryptMBps} MB/s (${bench.decryptMs.toFixed(1)} ms per ${fmtBytes(bench.bytes)})`} />
                <KV k="Largest file (8 MB VFS cap)" v={`≈ ${Math.ceil((8 / bench.encryptMBps) * 1000)} ms extra to save`} />
              </div>
            ) : <div className="fs-dim" style={{ fontSize: fz(12) }}>Unlock cost is deliberate (Argon2id, or PBKDF2 ≥ {PBKDF2_FLOOR.toLocaleString()}); per-file cost is what this measures.</div>}
          </Section>
        </>
      ) : null}
    </div>
  );
}

function CleanReportView({ r }: { r: CleanFileResult }) {
  const rep = r.report;
  return (
    <div data-testid="clean-report" style={{ display: "grid", gap: 4, fontSize: fz(12) }}>
      <div className="fs-row" style={{ gap: 6 }}>
        <Badge tone={!rep.supported ? "warn" : rep.removed.length ? "ok" : "default"}>{rep.kind}</Badge>
        <span>{!rep.supported ? "not supported — file unchanged" : rep.removed.length ? `${rep.removed.length} items removed → ${r.written}` : "nothing to remove"}</span>
        {r.droppedVersions ? <Badge>{r.droppedVersions} old versions forgotten</Badge> : null}
      </div>
      {rep.removed.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{rep.removed.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
      {rep.kept.length ? <div className="fs-dim">Kept: {rep.kept.join("; ")}</div> : null}
      <div className="fs-dim">{fmtBytes(rep.before)} → {fmtBytes(rep.after)}</div>
    </div>
  );
}
