"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, post } from "@/lib/api";
import { capAvailable } from "@/lib/capabilities";
import { toB64 } from "@/lib/crypto";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Empty, Section } from "../ui";
import { reuseGroups, reuseReportText } from "@/lib/pwd-audit";
import { strengthBits, strengthLabel, generatePassphrase } from "@/lib/passphrase";
import { askText, askForm } from "@/lib/ask";

interface Item { id: string; title: string; username: string; secret: string; note: string }

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

  useEffect(() => {
    api<{ node: unknown }>(`/api/fs?op=read&path=${encodeURIComponent(VAULT_PATH)}`)
      .then(() => setExists(true)).catch(() => setExists(false));
  }, []);

  // auto-lock when the shell is hidden (the best available substitute for FLAG_SECURE)
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") { setKey(null); setItems([]); } };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  const unlock = async () => {
    setErr("");
    try {
      if (!exists) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const k = await deriveKey(pass, salt);
        setKey(k);
        setItems([]);
        await persist(k, [], salt);
        setExists(true);
        return;
      }
      const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(VAULT_PATH)}`);
      const parsed = JSON.parse(r.node.content) as { salt: string; iv: string; data: string };
      const k = await deriveKey(pass, unb64(parsed.salt));
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unb64(parsed.iv) as unknown as BufferSource }, k, unb64(parsed.data) as unknown as BufferSource,
      );
      setItems(JSON.parse(dec.decode(plain)) as Item[]);
      setKey(k);
      setPass("");
    } catch {
      setErr("Decryption failed — wrong passphrase, or the blob was tampered with (AES-GCM authentication rejected it).");
    }
  };

  const persist = async (k: CryptoKey, list: Item[], saltOverride?: Uint8Array) => {
    let salt = saltOverride;
    if (!salt) {
      const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(VAULT_PATH)}`);
      salt = unb64((JSON.parse(r.node.content) as { salt: string }).salt);
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource }, k, enc.encode(JSON.stringify(list)) as unknown as BufferSource,
    );
    await post("/api/fs", {
      op: "write", path: VAULT_PATH, reason: "vault",
      content: JSON.stringify({ salt: b64(salt.buffer as ArrayBuffer), iv: b64(iv.buffer as ArrayBuffer), data: b64(data), kdf: "PBKDF2-SHA256-600k", cipher: "AES-GCM-256" }),
    });
  };

  if (!capAvailable(shell.caps, "webcrypto")) {
    return <div style={{ padding: 12 }}><Blocked what="Vault" missing="crypto.subtle (WebCrypto)" workaround="None — a plaintext fallback would be worse than no vault." /></div>;
  }

  if (!key) {
    return (
      <div style={{ padding: 14, display: "grid", gap: 10, alignContent: "start" }}>
        <Section title={exists ? "Unlock the vault" : "Create a vault"}>
          <input className="fs-input" type="password" placeholder="passphrase" value={pass} aria-label="Passphrase"
            onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void unlock(); }} />
          {pass ? <Badge tone={strengthBits(pass) < 28 ? "bad" : strengthBits(pass) < 45 ? "warn" : "ok"} data-testid="vault-strength">{strengthLabel(strengthBits(pass))} · ~{strengthBits(pass)} bits (pool estimate)</Badge> : null}
          <Btn variant="ghost" onClick={() => { const buf = new Uint32Array(8); crypto.getRandomValues(buf); let i = 0; setPass(generatePassphrase(() => buf[i++ % buf.length] / 4294967296, 4)); }}>Generate passphrase</Btn>
          <Btn variant="primary" disabled={pass.length < 6} onClick={() => void unlock()}>
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
          <Btn variant="ghost" onClick={async () => { const dig = await Promise.all(items.map(async (it) => { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(it.secret)); return { id: 0, label: it.title, digest: [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("") }; })); setAudit(reuseReportText(reuseGroups(dig))); }} data-testid="vault-audit-btn">Audit reuse</Btn>
          {audit ? <span className="fs-dim" style={{ fontSize: fz(11), whiteSpace: "pre-wrap" }} data-testid="vault-audit">{audit}</span> : null}
        <Btn variant="ghost" onClick={() => { setKey(null); setItems([]); setReveal(null); }}>Lock</Btn>
        <Btn variant="primary" onClick={async () => {
          const f = await askForm({
            title: "Add vault item", okLabel: "Add",
            fields: [{ name: "title", label: "Title" }, { name: "username", label: "Username" }, { name: "secret", label: "Secret", secret: true }],
            validate: (v) => (v.title.trim() ? null : "Give the item a title."),
          });
          if (!f) return;
          const title = f.title.trim(), username = f.username, secret = f.secret;
          const next = [...items, { id: crypto.randomUUID(), title, username, secret, note: "" }];
          setItems(next);
          await persist(key, next);
        }}>Add item</Btn>
        <div style={{ flex: 1 }} />
        <Badge title="Sensitive clipboard entries are masked in history and never sent to the server.">clipboard-safe</Badge>
      </div>

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
            <Btn variant="danger" onClick={async () => {
              const next = items.filter((x) => x.id !== it.id);
              setItems(next);
              await persist(key, next);
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
