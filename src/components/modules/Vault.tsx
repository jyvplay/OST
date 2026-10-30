"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { toB64 } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Empty, Section } from "../ui";
import { reuseGroups, reuseReportText } from "@/lib/pwd-audit";
import { strengthBits, strengthLabel, generatePassphrase } from "@/lib/passphrase";
import { askText, askForm } from "@/lib/ask";

interface Item { id: string; title: string; username: string; secret: string; note: string }
interface VaultIdentity { id: number; version: number; sha256: string }
interface VaultNode extends VaultIdentity { content: string; kind: string; encoding: string; trashed: boolean }
interface VaultSession { identity: VaultIdentity; salt: Uint8Array }

const VAULT_PATH = "/System/vault.fvault";
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    // 600k iterations: OWASP's 2023 floor for PBKDF2-HMAC-SHA256
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 600_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
const b64 = (b: ArrayBuffer) => toB64(new Uint8Array(b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * SC-01. Zero-knowledge: the server stores one opaque blob. The derived key is
 * a non-extractable CryptoKey held in memory only and dropped on lock, and we
 * refuse to autofill into cross-origin frames because we cannot verify the
 * origin inside them.
 */
export default function VaultModule(_: ModuleProps) {
  const shell = useShell();
  const [pass, setPass] = useState("");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [audit, setAudit] = useState("");
  const [err, setErr] = useState("");
  const [exists, setExists] = useState<boolean | null>(null);
  const [reveal, setReveal] = useState<string | null>(null);

  // A failed lookup is not proof that there is no vault. In particular, never
  // offer Create on a network error or while the lookup is still pending.
  const epoch = useRef(0);
  const working = useRef(false);
  const session = useRef<VaultSession | null>(null);
  const [busy, setBusy] = useState(false);
  const checkVault = () => {
    setExists(null); setErr("");
    api<{ node: unknown }>(`/api/fs?op=read&path=${encodeURIComponent(VAULT_PATH)}`)
      .then(() => setExists(true)).catch((e: { status?: number }) => {
        if (e.status === 404) setExists(false);
        else setErr("Cannot check vault storage. Retry when the server is available.");
      });
  };
  useEffect(() => {
    let active = true;
    api<{ node: unknown }>(`/api/fs?op=read&path=${encodeURIComponent(VAULT_PATH)}`)
      .then(() => { if (active) setExists(true); }).catch((e: { status?: number }) => {
        if (!active) return;
        if (e.status === 404) setExists(false);
        else setErr("Cannot check vault storage. Retry when the server is available.");
      });
    return () => { active = false; epoch.current++; };
  }, []);

  const lock = () => {
    epoch.current++;
    session.current = null;
    setKey(null); setItems([]); setPass(""); setAudit(""); setReveal(null);
  };
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") lock(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const unlock = async () => {
    if (working.current || exists === null || pass.length < 6 || document.visibilityState === "hidden") return;
    working.current = true; setBusy(true); setErr("");
    const started = epoch.current;
    try {
      if (!exists) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const k = await deriveKey(pass, salt);
        const identity = await persist(k, [], salt, null);
        setExists(true);
        if (started === epoch.current) { session.current = { identity, salt }; setItems([]); setKey(k); setPass(""); }
        return;
      }
      const r = await api<{ node: VaultNode }>(`/api/fs?op=read&path=${encodeURIComponent(VAULT_PATH)}`);
      const node = r.node;
      if (node.kind !== "file" || node.trashed || node.encoding !== "utf8" || !Number.isSafeInteger(node.id) || node.id <= 0 || !Number.isSafeInteger(node.version) || node.version <= 0 || !/^[0-9a-f]{64}$/.test(node.sha256)) throw new Error("Vault is not an available file");
      const parsed = JSON.parse(node.content) as { salt: string; iv: string; data: string };
      const salt = unb64(parsed.salt);
      const k = await deriveKey(pass, salt);
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(parsed.iv) as unknown as BufferSource }, k, unb64(parsed.data) as unknown as BufferSource,
      );
      const decoded = JSON.parse(dec.decode(plain)) as Item[];
      if (!Array.isArray(decoded) || decoded.some((it) => !it || typeof it.id !== "string" || typeof it.title !== "string" || typeof it.username !== "string" || typeof it.secret !== "string" || typeof it.note !== "string")) throw new Error("Invalid vault contents");
      if (started === epoch.current) { session.current = { identity: { id: node.id, version: node.version, sha256: node.sha256 }, salt }; setItems(decoded); setKey(k); setPass(""); }
    } catch (e) {
      if (started === epoch.current) {
        if (!exists) { setExists(null); setErr("Creation was not confirmed. Retry to check storage before creating or unlocking."); }
        else setErr("Unlock failed. Check the passphrase and server connection.");
      }
    } finally { working.current = false; setBusy(false); }
  };

  const persist = async (k: CryptoKey, list: Item[], salt: Uint8Array, expected: VaultIdentity | null): Promise<VaultIdentity> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource }, k, enc.encode(JSON.stringify(list)) as unknown as BufferSource,
    );
    // Never enqueue ciphertext: use an atomic, version-checked write instead.
    const result = await api<{ id: number; version: number; sha256: string }>("/api/fs", { method: "POST", body: JSON.stringify({
      op: "writeIfUnchanged", path: VAULT_PATH, expected, encoding: "utf8",
      content: JSON.stringify({ salt: b64(salt.buffer as ArrayBuffer), iv: b64(iv.buffer as ArrayBuffer), data: b64(data), kdf: "PBKDF2-SHA256-600k", cipher: "AES-GCM-256" }),
    }) });
    if (!Number.isSafeInteger(result.id) || result.id <= 0 || !Number.isSafeInteger(result.version) || result.version <= 0 || !/^[0-9a-f]{64}$/.test(result.sha256)) throw new Error("Save identity was not confirmed");
    return { id: result.id, version: result.version, sha256: result.sha256 };
  };

  const saveItems = async (next: Item[]) => {
    const current = session.current;
    if (!key || !current || working.current) return;
    working.current = true; setBusy(true); setErr("");
    const started = ++epoch.current; // invalidate any in-flight audit of the old list
    try {
      const identity = await persist(key, next, current.salt, current.identity);
      if (started === epoch.current) { session.current = { ...current, identity }; setItems(next); setAudit(""); }
    } catch (e) {
      if (started === epoch.current) {
        const conflict = (e as { status?: number }).status === 409;
        lock(); setExists(null);
        setErr(conflict ? "Vault changed elsewhere. Retry to check storage, then unlock again." : "Save not confirmed. Retry to check storage; the last edit may or may not have saved.");
      }
    } finally { working.current = false; setBusy(false); }
  };

  if (!capAvailable(shell.caps, "webcrypto")) {
    return <div style={{ padding: 12 }}><Blocked what="Vault" missing="crypto.subtle (WebCrypto)" workaround="None — a plaintext fallback would be worse than no vault." /></div>;
  }

  if (!key) {
    return (
      <div style={{ padding: 14, display: "grid", gap: 10, alignContent: "start" }}>
        <Section title={exists === null ? "Vault storage" : exists ? "Unlock the vault" : "Create a vault"}>
          {exists === null && err ? <Btn variant="ghost" onClick={checkVault}>Retry</Btn> : null}
          <input className="fs-input" type="password" placeholder="passphrase" value={pass} aria-label="Passphrase"
            onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }} />
          {pass ? <Badge tone={strengthBits(pass) < 28 ? "bad" : strengthBits(pass) < 45 ? "warn" : "ok"} data-testid="vault-strength">{strengthLabel(strengthBits(pass))} · ~{strengthBits(pass)} bits (pool estimate)</Badge> : null}
          <Btn variant="ghost" onClick={() => { const buf = new Uint32Array(8); crypto.getRandomValues(buf); let i = 0; setPass(generatePassphrase(() => buf[i++ % buf.length] / 4294967296, 4)); }}>Generate passphrase</Btn>
          <Btn variant="primary" disabled={pass.length < 6 || exists === null || busy} onClick={() => void unlock()}>
            {exists ? "Unlock" : "Create"}
          </Btn>
          {err ? <Badge tone="bad">{err}</Badge> : null}
          <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.6 }}>
            PBKDF2-HMAC-SHA256, 600 000 iterations → AES-GCM-256. The server receives ciphertext only; it never sees
            the passphrase or the key. There is no recovery path: if you lose the passphrase the data is gone, and we
            say so before you create it.
          </div>
          <Badge tone={capAvailable(shell.caps, "webauthn") ? "ok" : "warn"}>
            {capAvailable(shell.caps, "webauthn")
              ? "Passkeys available — hardware-backed second factor is possible on this device"
              : "No WebAuthn — the vault key is software-only on this browser (HW-08 honest downgrade)"}
          </Badge>
        </Section>
      </div>
    );
  }

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6 }}>
        <Badge tone="ok">unlocked</Badge>
          <Btn variant="ghost" disabled={busy} title="Compares non-empty secrets locally" onClick={async () => { const started = epoch.current; const dig = await Promise.all(items.filter((it) => it.secret.length > 0).map(async (it) => { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(it.secret)); return { id: 0, label: it.title, digest: [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") }; })); if (started === epoch.current) setAudit(reuseReportText(reuseGroups(dig))); }} data-testid="vault-audit-btn">Audit reuse</Btn>
          {audit ? <span className="fs-dim" style={{ fontSize: fz(11), whiteSpace: "pre-wrap" }} data-testid="vault-audit">{audit}</span> : null}
        <Btn variant="ghost" onClick={lock}>Lock</Btn>
        <Btn variant="primary" disabled={busy} onClick={async () => {
          const started = epoch.current;
          const f = await askForm({
            title: "Add vault item", okLabel: "Add",
            fields: [{ name: "title", label: "Title" }, { name: "username", label: "Username" }, { name: "secret", label: "Secret", secret: true }],
            validate: (v) => (v.title.trim() ? null : "Give the item a title."),
          });
          if (!f || started !== epoch.current) return;
          const title = f.title.trim(), username = f.username, secret = f.secret;
          const next = [...items, { id: crypto.randomUUID(), title, username, secret, note: "" }];
          await saveItems(next);
        }}>Add item</Btn>
        <div style={{ flex: 1 }} />
        <Badge title="Sensitive clipboard entries are masked in history and never sent to the server.">clipboard-safe</Badge>
      </div>

      {err ? <Badge tone="bad">{err}</Badge> : null}
      {items.length === 0 ? <Empty title="Vault is empty" icon="🔐" /> : null}
      <div style={{ display: "grid", gap: 2 }}>
        {items.map((it) => (
          <div key={it.id} className="fs-list-item">
            <span style={{ flex: 1 }}>
              <div style={{ fontSize: fz(12) }}>{it.title}</div>
              <div className="fs-dim" style={{ fontSize: fz(11) }}>{it.username}</div>
            </span>
            <span className="fs-mono" style={{ fontSize: fz(11.5) }}>{reveal === it.id ? it.secret : "••••••••"}</span>
            <Btn variant="ghost" onClick={() => setReveal(reveal === it.id ? null : it.id)}>{reveal === it.id ? "Hide" : "Reveal"}</Btn>
            <Btn variant="ghost" onClick={() => void shell.copy(it.secret, "vault", true)}>Copy</Btn>
            <Btn variant="danger" disabled={busy} onClick={async () => {
              const next = items.filter((x) => x.id !== it.id);
              await saveItems(next);
            }}>Delete</Btn>
          </div>
        ))}
      </div>

      <Section title="Boundaries">
        <ul className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.7, margin: 0, paddingLeft: 18 }}>
          <li>Autofill into embedded third-party pages is refused: we cannot verify the real origin inside a frame.</li>
          <li>WebCrypto keys are not hardware-backed; a platform passkey is the only hardware binding the web offers.</li>
          <li>The window auto-locks when the shell is hidden, because no web API can exclude a window from screen capture.</li>
        </ul>
      </Section>
    </div>
  );
}
