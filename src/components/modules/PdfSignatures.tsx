"use client";
/**
 * PDF reader/editor — Signatures panel (TT77).
 *
 * Validation (src/lib/pdf/pdfsig.ts): for every signed field, whether the signed bytes still hash to what the signer
 * committed to, whether the signature verifies with the embedded certificate, whether later revisions were appended,
 * and the certificate chain that the signature itself carries. Identity is NEVER claimed: Fusion has no trust store
 * (no AATL/EUTL list, no OCSP/CRL, no timestamps), so the panel says "identity not verified" for every signer.
 *
 * Signing: an invisible signature (adbe.pkcs7.detached, SHA-256) added as an incremental update, with either a
 * self-signed ECDSA P-256 identity made on this device (non-extractable key in IndexedDB) or an imported PKCS#8 key +
 * X.509 certificate (PEM). The signed bytes become a new revision in the editor; Save writes them unchanged.
 */
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { askConfirm, askText } from "@/lib/ask";
import { Badge, Btn } from "../ui";
import type { PdfDoc } from "@/lib/pdf/pdfdoc";
import { validateSignatures, signPdf, makeSelfSignedIdentity, importIdentity, type SigReport } from "@/lib/pdf/pdfsig";
import { listIdentities, putIdentity, deleteIdentity, type StoredIdentity } from "@/lib/pdf/sigstore";

const STATUS: Record<SigReport["status"], { tone: "ok" | "warn" | "bad" | "info"; label: string; what: string }> = {
  valid: { tone: "ok", label: "Signature valid", what: "The document has not changed since it was signed." },
  modified: { tone: "warn", label: "Valid · changed after signing", what: "The signed version is intact, but later revisions were added after this signature." },
  invalid: { tone: "bad", label: "Invalid", what: "The document was altered after signing, or the signature does not verify." },
  unsupported: { tone: "info", label: "Cannot check", what: "This signature uses an algorithm or format Fusion cannot verify." },
  malformed: { tone: "bad", label: "Damaged signature", what: "The signature data is damaged or not a signature." },
};

export interface SigPanelProps {
  doc: PdfDoc;
  /** push signed bytes as a new revision */
  onSigned: (bytes: Uint8Array, what: string) => void;
  /** open a byte range (the signed revision) read-only for comparison */
  onOpenRevision: (bytes: Uint8Array, label: string) => void;
  toast: (msg: string, tone?: "ok" | "warn" | "bad") => void;
  dirty: boolean;
}

export function PdfSignatures({ doc, onSigned, onOpenRevision, toast, dirty }: SigPanelProps) {
  // the document is immutable per revision (each edit opens a new PdfDoc); doc.bytes is the current revision
  const bytes = doc.bytes;
  const [checked, setChecked] = useState<{ doc: PdfDoc; reports: SigReport[] } | null>(null);
  const reports = checked && checked.doc === doc ? checked.reports : null;
  const [ids, setIds] = useState<StoredIdentity[]>([]);
  const [idSel, setIdSel] = useState("");
  const [reason, setReason] = useState(""); const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // the toast callback may change identity on every parent render: keep it out of the validation effect's deps
  const toastRef = useRef(toast); useEffect(() => { toastRef.current = toast; }, [toast]);

  useEffect(() => {
    let live = true;
    validateSignatures(doc).then((r) => { if (live) setChecked({ doc, reports: r }); }).catch((e) => { if (live) { setChecked({ doc, reports: [] }); toastRef.current(`Signature check failed: ${(e as Error).message}`, "bad"); } });
    return () => { live = false; };
  }, [doc]);
  const reloadIds = () => listIdentities().then((a) => { setIds(a); setIdSel((s) => (s && a.some((x) => x.id === s) ? s : a[a.length - 1]?.id ?? "")); }).catch(() => setIds([]));
  useEffect(() => { void reloadIds(); }, []);

  const createId = async () => {
    const name = await askText("Your name as it should appear in the signature", "", { okLabel: "Next", validate: (v) => (v.trim() ? null : "A name is required") }); if (!name) return;
    const email = (await askText("Email (optional)", "", { okLabel: "Create identity", detail: "Creates a self-signed ECDSA P-256 certificate on this device. The private key never leaves this browser and cannot be exported. Others will see your name but Fusion — and any reader — cannot confirm it is really you without a certificate from a trusted authority." })) ?? "";
    setBusy(true);
    try { const id = await makeSelfSignedIdentity(name.trim(), email.trim()); const st: StoredIdentity = { ...id, id: `dev-${Date.now()}`, created: Date.now(), source: "device" }; await putIdentity(st); await reloadIds(); setIdSel(st.id); toast(`Signing identity “${name.trim()}” created on this device`, "ok"); }
    catch (e) { toast(`Could not create the identity: ${(e as Error).message}`, "bad"); } finally { setBusy(false); }
  };
  const importId = async (f: File | undefined) => {
    if (!f) return; setBusy(true);
    try {
      const text = await f.text();
      const key = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(text)?.[0];
      const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text)?.[0];
      if (!key || !cert) throw new Error(/ENCRYPTED PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY/.test(text) ? "the key must be an unencrypted PKCS#8 “BEGIN PRIVATE KEY” block (convert with: openssl pkcs8 -topk8 -nocrypt)" : "the file needs a “BEGIN PRIVATE KEY” and a “BEGIN CERTIFICATE” block");
      const id = await importIdentity(key, cert); const st: StoredIdentity = { ...id, id: `imp-${Date.now()}`, created: Date.now(), source: "imported" };
      await putIdentity(st); await reloadIds(); setIdSel(st.id); toast(`Imported “${id.name}”`, "ok");
    } catch (e) { toast(`Import failed: ${(e as Error).message}`, "bad"); } finally { setBusy(false); }
  };
  const removeId = async () => {
    const id = ids.find((x) => x.id === idSel); if (!id) return;
    if (!(await askConfirm({ title: `Delete the signing identity “${id.name}”?`, detail: "Its private key is deleted from this device. Documents already signed stay valid.", okLabel: "Delete" }))) return;
    await deleteIdentity(id.id); await reloadIds();
  };
  const sign = async () => {
    const id = ids.find((x) => x.id === idSel); if (!id) return;
    if (doc.sec) { toast("Signing encrypted PDFs is not supported — save a decrypted copy first", "warn"); return; }
    setBusy(true);
    try { const out = await signPdf(doc, id, { reason: reason.trim() || undefined, location: location.trim() || undefined }); onSigned(out, `Signed by ${id.name}`); toast("Signed. Save to keep it — any later edit shows up as a change after signing.", "ok"); }
    catch (e) { toast(`Signing failed: ${(e as Error).message}`, "bad"); } finally { setBusy(false); }
  };

  const small = { fontSize: fz(11.5) } as const;
  return (
    <div data-testid="pdf-sigs" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: fz(12) }}>
      {reports === null ? <div className="fs-dim">Checking signatures…</div> : null}
      {reports && !reports.length ? <div className="fs-dim" data-testid="pdf-sig-none">This document has no signatures.</div> : null}
      {reports?.map((r, i) => {
        const st = STATUS[r.status];
        return (
          <section key={`${r.field}-${i}`} data-testid="pdf-sig" data-status={r.status} aria-label={`Signature ${r.field}`} style={{ border: "1px solid var(--fs-border)", borderRadius: 8, padding: 8, display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}><Badge tone={st.tone} data-testid="pdf-sig-status">{st.label}</Badge><strong style={{ wordBreak: "break-word" }} title={r.signer}>{/(?:^|,\s*)CN=([^,]+)/.exec(r.signer)?.[1] ?? (r.signer || "(unnamed signer)")}</strong></div>
            <div style={small}>{st.what}</div>
            <div className="fs-dim" style={small} data-testid="pdf-sig-trust">Identity not verified — Fusion has no list of trusted authorities{r.selfSigned ? "; the certificate is self-signed" : ""}.</div>
            {r.signingTime ? <div style={small}>Signed {new Date(r.signingTime).toLocaleString()}</div> : null}
            {r.reason ? <div style={small}>Reason: {r.reason}</div> : null}
            {r.location ? <div style={small}>Location: {r.location}</div> : null}
            {r.status === "modified" ? <div style={small}>{(r.appendedBytes / 1024).toFixed(1)} KB added after signing.</div> : null}
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              <Btn variant="ghost" aria-expanded={open === i} data-testid="pdf-sig-details" onClick={() => setOpen(open === i ? null : i)}>{open === i ? "Hide details" : "Details"}</Btn>
              {r.status === "modified" && r.signedLength > 0 && r.signedLength <= bytes.length ? <Btn variant="ghost" data-testid="pdf-sig-revision" onClick={() => onOpenRevision(bytes.slice(0, r.signedLength), `${r.field} (as signed)`)}>Open signed version</Btn> : null}
            </div>
            {open === i ? (
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 6px", ...small }}>
                <dt>Signer</dt><dd style={{ margin: 0, wordBreak: "break-word" }}>{r.signer || "—"}</dd>
                <dt>Field</dt><dd style={{ margin: 0, wordBreak: "break-all" }}>{r.field}</dd>
                <dt>Format</dt><dd style={{ margin: 0 }}>{r.subFilter || "—"}</dd>
                <dt>Document hash</dt><dd style={{ margin: 0 }}>{r.digestOk === null ? "not checked" : r.digestOk ? "matches" : "does NOT match"}</dd>
                <dt>Signature</dt><dd style={{ margin: 0 }}>{r.signatureOk === null ? "not checked" : r.signatureOk === "unsupported" ? "algorithm not supported" : r.signatureOk ? "verifies" : "does NOT verify"}</dd>
                <dt>Issuer</dt><dd style={{ margin: 0, wordBreak: "break-word" }}>{r.issuer || "—"}</dd>
                <dt>Chain</dt><dd style={{ margin: 0 }}>{r.chain.length ? r.chain.map((c, k) => <div key={k} style={{ paddingLeft: k * 10 }}>{c.subject}{c.verifiedByIssuer === false ? " (issuer signature does not verify)" : c.verifiedByIssuer === null ? " (issuer not included)" : ""}</div>) : "—"}</dd>
                <dt>Certificate</dt><dd style={{ margin: 0 }}>{r.certValidAtSigning === null ? "validity not checked" : r.certValidAtSigning ? "within its validity period at signing" : "outside its validity period at signing"}</dd>
                <dt>Not checked</dt><dd style={{ margin: 0 }}>revocation (OCSP/CRL), timestamps, trust lists</dd>
                {r.notes.length ? <><dt>Notes</dt><dd style={{ margin: 0 }}>{r.notes.map((n, k) => <div key={k}>{n}</div>)}</dd></> : null}
              </dl>
            ) : null}
          </section>
        );
      })}
      <section aria-label="Sign this document" style={{ borderTop: "1px solid var(--fs-border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        <strong>Sign this document</strong>
        {ids.length ? (
          <label style={{ display: "flex", flexDirection: "column", gap: 2 }}>Signing identity
            <select className="fs-input" data-testid="pdf-sig-identity" value={idSel} onChange={(e) => setIdSel(e.target.value)}>{ids.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.source === "device" ? "self-signed, this device" : "imported"})</option>)}</select>
          </label>
        ) : <div className="fs-dim" style={small}>No signing identity on this device yet.</div>}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Btn variant="ghost" data-testid="pdf-sig-new" disabled={busy} onClick={() => void createId()}>New identity</Btn>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import PEM…<input type="file" accept=".pem,.crt,.key,.txt" data-testid="pdf-sig-import" style={{ display: "none" }} onChange={(e) => { void importId(e.target.files?.[0]); e.target.value = ""; }} /></label>
          {idSel ? <Btn variant="ghost" disabled={busy} onClick={() => void removeId()}>Delete identity</Btn> : null}
        </div>
        <input className="fs-input" placeholder="Reason (optional)" aria-label="Reason for signing" data-testid="pdf-sig-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        <input className="fs-input" placeholder="Location (optional)" aria-label="Signing location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
        <Btn variant="primary" data-testid="pdf-sig-sign" disabled={busy || !idSel} onClick={() => void sign()}>{busy ? "Working…" : "Sign"}</Btn>
        <div className="fs-dim" style={small}>Adds an invisible signature (SHA-256) as an incremental update{dirty ? "; your unsaved edits are included in what you sign" : ""}. Edits made after signing are visible to anyone checking the signature.</div>
      </section>
    </div>
  );
}
