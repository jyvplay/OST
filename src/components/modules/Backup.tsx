"use client";

import { useState } from "react";
import { fmtBytes } from "@/lib/api";
import { toB64 } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Section } from "../ui";

interface Bundle {
  version: string; exportedAt: string; kind: string;
  entries: { path: string; kind: string; mime: string; encoding: string; content: string; sha256: string }[];
  manifest: { path: string; sha256: string; size: number }[];
}

const enc = new TextEncoder();
// FIX: chunked encoder — spreading a large bundle into fromCharCode overflowed the stack
const b64 = (b: ArrayBuffer) => toB64(new Uint8Array(b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * BK-01/05/06. "Healthy" is only displayed after a verification pass that
 * recomputes every digest in the manifest. Import verifies the whole bundle
 * BEFORE writing anything, so a truncated or tampered file cannot half-restore.
 */
export default function BackupModule(_: ModuleProps) {
  const shell = useShell();
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [report, setReport] = useState<string>("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchBundle = async (kind: "data" | "config") => {
    setBusy(true);
    try {
      const res = await fetch(`/api/backup?kind=${kind}`, { cache: "no-store" });
      const b = (await res.json()) as Bundle;
      setBundle(b);
      setReport(`${b.entries.length} entries · ${fmtBytes(b.manifest.reduce((a, m) => a + m.size, 0))} · manifest carries a SHA-256 for every entry`);
    } finally { setBusy(false); }
  };

  const verify = async () => {
    if (!bundle) return;
    let bad = 0;
    for (const m of bundle.manifest) {
      const entry = bundle.entries.find((e) => e.path === m.path);
      if (!entry) { bad += 1; continue; }
      const digest = await crypto.subtle.digest("SHA-256", enc.encode(entry.content));
      const hex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
      if (hex !== m.sha256) bad += 1;
    }
    setReport(bad === 0
      ? `Verified: all ${bundle.manifest.length} digests match (recomputed in the browser, independently of the server).`
      : `FAILED: ${bad} entries do not match their manifest digest. Restore would be refused.`);
  };

  const download = async (encrypted: boolean) => {
    if (!bundle) return;
    let blob: Blob;
    let name = `fusion-${bundle.kind}-${Date.now()}.json`;
    if (encrypted) {
      if (pass.length < 8) { shell.toast("Use a passphrase of at least 8 characters.", "warn"); return; }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 600_000, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
      );
      const data = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as unknown as BufferSource }, key, enc.encode(JSON.stringify(bundle)) as unknown as BufferSource,
      );
      blob = new Blob([JSON.stringify({
        format: "fusion-encrypted-bundle-1", kdf: "PBKDF2-SHA256-600k", cipher: "AES-GCM-256",
        salt: b64(salt.buffer as ArrayBuffer), iv: b64(iv.buffer as ArrayBuffer), data: b64(data),
      })], { type: "application/json" });
      name = name.replace(".json", ".enc.json");
    } else {
      blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      let parsed = JSON.parse(text) as Bundle | { format: string; salt: string; iv: string; data: string };
      if ("format" in parsed && parsed.format === "fusion-encrypted-bundle-1") {
        const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
        const key = await crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: unb64(parsed.salt) as unknown as BufferSource, iterations: 600_000, hash: "SHA-256" },
          base, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
        );
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: unb64(parsed.iv) as unknown as BufferSource }, key, unb64(parsed.data) as unknown as BufferSource,
        );
        parsed = JSON.parse(new TextDecoder().decode(plain)) as Bundle;
      }
      const dry = await fetch("/api/backup", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...(parsed as Bundle), dryRun: true }),
      });
      const dryJson = await dry.json();
      if (!dryJson.ok) { setReport(`Verification failed: ${JSON.stringify(dryJson.failures)}`); return; }
      if (!confirm(`Verification passed. Restore ${dryJson.wouldRestore} entries?`)) return;
      const res = await fetch("/api/backup", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(parsed),
      });
      const json = await res.json();
      setReport(`Restored ${json.restored} entries (each written through the journal with a version snapshot).`);
      shell.bumpRefresh();
    } catch (e) {
      setReport(`Import failed: ${String((e as Error).message)}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Export" right={busy ? <Badge tone="warn">working…</Badge> : null}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="primary" onClick={() => void fetchBundle("data")}>Build data bundle</Btn>
          <Btn variant="ghost" onClick={() => void fetchBundle("config")}>Build config bundle</Btn>
          <Btn variant="ghost" disabled={!bundle} onClick={() => void verify()}>Verify digests</Btn>
          <Btn variant="ghost" disabled={!bundle} onClick={() => void download(false)}>Download plain</Btn>
          <Btn variant="ghost" disabled={!bundle || pass.length < 8} onClick={() => void download(true)}>Download encrypted</Btn>
        </div>
        <input className="fs-input" type="password" placeholder="bundle passphrase (never leaves this device)"
          value={pass} onChange={(e) => setPass(e.target.value)} aria-label="Bundle passphrase" />
        {report ? <div className="fs-mono" style={{ fontSize: 11.5 }}>{report}</div> : null}
      </Section>

      <Section title="Restore">
        <label className="fs-btn" data-variant="primary" style={{ cursor: "pointer", width: "fit-content" }}>
          Choose bundle…
          <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} />
        </label>
        <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          Restore runs in two phases: verify every digest, then apply. A single mismatch aborts the whole restore and
          names the entry. Config and data are separate bundles so settings can move without documents.
        </div>
      </Section>

      <Section title="Key custody (BK-06)">
        <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          The passphrase is used only in this browser (PBKDF2-SHA256, 600 000 iterations → AES-GCM-256) and is never
          transmitted. There is no escrow and no recovery: if you lose it, that bundle is unreadable. Said plainly,
          before you need it.
        </div>
      </Section>
    </div>
  );
}
