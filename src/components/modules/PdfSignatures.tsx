"use client";
/**
 * PDF reader/editor — Signatures panel (TT77).
 *
 * Validation (src/lib/pdf/pdfsig.ts): for every signed field, whether the signed bytes still hash to what the signer
 * committed to, whether the signature verifies with the embedded certificate, whether later revisions were appended,
 * and the certificate chain that the signature itself carries. Fusion ships no trust store (no AATL/EUTL list, no
 * OCSP/CRL, no timestamps): identity is "not verified" unless the USER has added a certificate to their own trusted
 * list (TT79) and the chain reaches it — then the panel says "trusted (your list)" and why.
 *
 * Signing: a signature (adbe.pkcs7.detached, SHA-256) added as an incremental update — invisible, or (TT79) visible
 * as a framed box in a chosen corner of the current page, upright on rotated pages. Identities: a self-signed ECDSA
 * P-256 identity made on this device (non-extractable key in IndexedDB), an imported PKCS#8 key + certificate (PEM),
 * or (TT79) a PKCS#12 .p12/.pfx file with its password — the key is imported non-extractable and the issuer chain is
 * embedded in every signature. The signed bytes become a new revision in the editor; Save writes them unchanged.
 */
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { askConfirm, askText } from "@/lib/ask";
import { Badge, Btn } from "../ui";
import type { PdfDoc } from "@/lib/pdf/pdfdoc";
import { validateSignatures, signPdf, makeSelfSignedIdentity, importIdentity, parseCert, placeSignature, type SigReport, type SigCorner } from "@/lib/pdf/pdfsig";
import { signatureRectAt, type SignatureBox } from "@/lib/pdf/sigplacement";
import { identityFromPkcs12, P12PasswordError } from "@/lib/pdf/pkcs12";
import { listIdentities, putIdentity, deleteIdentity, listAnchors, putAnchor, deleteAnchor, type StoredIdentity, type StoredAnchor } from "@/lib/pdf/sigstore";

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
  /** 0-based index of the page on screen (where a visible signature goes) */
  page?: number;
}
const CORNERS: [SigCorner, string][] = [["bottom-right", "Bottom right"], ["bottom-left", "Bottom left"], ["top-right", "Top right"], ["top-left", "Top left"]];
const cnOf = (subject: string) => /(?:^|,\s*)CN=([^,]+)/.exec(subject)?.[1] ?? subject;
const pemOrDer = (b: Uint8Array) => { const t = new TextDecoder("latin1").decode(b.subarray(0, Math.min(b.length, 1 << 20))); const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(t); return m ? Uint8Array.from(atob(m[1].replace(/\s+/g, "")), (c) => c.charCodeAt(0)) : b; };

export function PdfSignatures({ doc, onSigned, onOpenRevision, toast, dirty, page = 0 }: SigPanelProps) {
  // the document is immutable per revision (each edit opens a new PdfDoc); doc.bytes is the current revision
  const bytes = doc.bytes;
  const [anchors, setAnchors] = useState<StoredAnchor[] | null>(null);
  const [checked, setChecked] = useState<{ doc: PdfDoc; anchors: StoredAnchor[] | null; reports: SigReport[] } | null>(null);
  const reports = checked && checked.doc === doc && checked.anchors === anchors ? checked.reports : null;
  const [visible, setVisible] = useState(false); const [corner, setCorner] = useState<SigCorner>("bottom-right");
  const [customBox, setCustomBox] = useState(false);
  const [box, setBox] = useState<SignatureBox>({ left: 36, top: 36, width: 220, height: 70 });
  const [ids, setIds] = useState<StoredIdentity[]>([]);
  const [idSel, setIdSel] = useState("");
  const [reason, setReason] = useState(""); const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // the toast callback may change identity on every parent render: keep it out of the validation effect's deps
  const toastRef = useRef(toast); useEffect(() => { toastRef.current = toast; }, [toast]);

  useEffect(() => {
    if (anchors === null) return; // wait for the trusted list (a verdict without it would flash "not verified")
    let live = true;
    validateSignatures(doc, { anchors: anchors.map((a) => a.der) }).then((r) => { if (live) setChecked({ doc, anchors, reports: r }); }).catch((e) => { if (live) { setChecked({ doc, anchors, reports: [] }); toastRef.current(`Signature check failed: ${(e as Error).message}`, "bad"); } });
    return () => { live = false; };
  }, [doc, anchors]);
  const reloadAnchors = () => listAnchors().then(setAnchors).catch(() => setAnchors([]));
  useEffect(() => { void reloadAnchors(); }, []);
  const trustCert = async (der: Uint8Array) => {
    let subject = ""; try { subject = parseCert(der).subjectName; } catch { toast("That is not an X.509 certificate", "bad"); return; }
    if (!(await askConfirm({ title: `Trust “${cnOf(subject)}”?`, detail: `Signatures whose certificate chain leads to this certificate will be shown as trusted on this device.\n\n${subject}\n\nOnly trust a certificate you received from its owner through a channel you trust. Revocation is not checked.`, okLabel: "Trust" }))) return;
    await putAnchor(der, subject); await reloadAnchors(); toast(`“${cnOf(subject)}” added to your trusted certificates`, "ok");
  };
  const addAnchorFile = async (f: File | undefined) => { if (!f) return; await trustCert(pemOrDer(new Uint8Array(await f.arrayBuffer()))); };
  const removeAnchor = async (a: StoredAnchor) => {
    if (!(await askConfirm({ title: `Stop trusting “${cnOf(a.subject)}”?`, detail: "Signatures that relied on it will show as not verified again.", okLabel: "Remove" }))) return;
    await deleteAnchor(a.id); await reloadAnchors();
  };
  const reloadIds = () => listIdentities().then((a) => { setIds(a); setIdSel((s) => (s && a.some((x) => x.id === s) ? s : a[a.length - 1]?.id ?? "")); }).catch(() => setIds([]));
  useEffect(() => { void reloadIds(); }, []);

  const createId = async () => {
    const name = await askText("Your name as it should appear in the signature", "", { okLabel: "Next", validate: (v) => (v.trim() ? null : "A name is required") }); if (!name) return;
    const email = (await askText("Email (optional)", "", { okLabel: "Create identity", detail: "Creates a self-signed ECDSA P-256 certificate on this device. The private key never leaves this browser and cannot be exported. Others will see your name but Fusion — and any reader — cannot confirm it is really you without a certificate from a trusted authority." })) ?? "";
    setBusy(true);
    try { const id = await makeSelfSignedIdentity(name.trim(), email.trim()); const st: StoredIdentity = { ...id, id: `dev-${Date.now()}`, created: Date.now(), source: "device" }; await putIdentity(st); await reloadIds(); setIdSel(st.id); toast(`Signing identity “${name.trim()}” created on this device`, "ok"); }
    catch (e) { toast(`Could not create the identity: ${(e as Error).message}`, "bad"); } finally { setBusy(false); }
  };
  const importP12 = async (f: File) => {
    const bytes = new Uint8Array(await f.arrayBuffer());
    for (let attempt = 0; attempt < 5; attempt++) {
      const pw = await askText(`Password for ${f.name}`, "", { secret: true, okLabel: "Import", title: attempt ? "Wrong password — try again" : `Import ${f.name}`, detail: "The password protecting this .p12/.pfx file. The private key is imported into this browser as non-exportable; the password is not stored." });
      if (pw === null) return;
      setBusy(true);
      try {
        const id = await identityFromPkcs12(bytes, pw);
        const st: StoredIdentity = { name: id.name, key: id.key, certDer: id.certDer, alg: id.alg, chain: id.chain, id: `p12-${Date.now()}`, created: Date.now(), source: "pkcs12" };
        await putIdentity(st); await reloadIds(); setIdSel(st.id);
        toast(`Imported “${id.name}”${id.chain.length ? ` with ${id.chain.length} issuer certificate${id.chain.length > 1 ? "s" : ""}` : ""}`, "ok"); return;
      } catch (e) {
        if (!(e instanceof P12PasswordError)) { toast(`Import failed: ${(e as Error).message}`, "bad"); return; }
      } finally { setBusy(false); }
    }
    toast("Import cancelled after 5 wrong passwords", "warn");
  };
  const importId = async (f: File | undefined) => {
    if (!f) return;
    if (/\.(p12|pfx)$/i.test(f.name)) { await importP12(f); return; }
    setBusy(true);
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
    try {
      const pg = doc.pages()[Math.min(page, doc.pages().length - 1)];
      const vis = visible && pg ? { page: pg.index, rect: customBox ? signatureRectAt(pg, box) : placeSignature(pg, corner) } : undefined;
      const out = await signPdf(doc, id, { reason: reason.trim() || undefined, location: location.trim() || undefined, visible: vis });
      onSigned(out, `Signed by ${id.name}`); toast(`Signed${vis ? ` (visible on page ${vis.page + 1})` : ""}. Save to keep it — any later edit shows up as a change after signing.`, "ok");
    }
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
            {r.trust === "trusted"
              ? <div style={{ ...small, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} data-testid="pdf-sig-trust" data-trust="trusted"><Badge tone="ok">Identity trusted</Badge><span>{r.trustNote} (your list; revocation not checked)</span></div>
              : r.trust === "untrusted"
                ? <div className="fs-dim" style={small} data-testid="pdf-sig-trust" data-trust="untrusted">Identity not verified — {r.trustNote}.</div>
                : <div className="fs-dim" style={small} data-testid="pdf-sig-trust" data-trust="no-anchors">Identity not verified — Fusion has no list of trusted authorities{r.selfSigned ? "; the certificate is self-signed" : ""}. You can trust a certificate under Details.</div>}
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
                <dt>Chain</dt><dd style={{ margin: 0 }}>{r.chain.length ? r.chain.map((c, k) => (
                  <div key={k} style={{ paddingLeft: k * 10, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span>{c.subject}{c.verifiedByIssuer === false ? " (issuer signature does not verify)" : c.verifiedByIssuer === null ? " (issuer not included)" : ""}</span>
                    {anchors?.some((a) => a.der.length === c.der.length && a.der.every((v, j) => v === c.der[j])) ? <Badge tone="ok">trusted</Badge>
                      : k === r.chain.length - 1 ? <Btn variant="ghost" data-testid="pdf-sig-trust-cert" onClick={() => void trustCert(c.der)}>Trust this certificate</Btn> : null}
                  </div>)) : "—"}</dd>
                <dt>Certificate</dt><dd style={{ margin: 0 }}>{r.certValidAtSigning === null ? "validity not checked" : r.certValidAtSigning ? "within its validity period at signing" : "outside its validity period at signing"}</dd>
                <dt>Trust</dt><dd style={{ margin: 0 }}>{r.trust === "no-anchors" ? "you have not trusted any certificate" : r.trustNote}</dd>
                <dt>Not checked</dt><dd style={{ margin: 0 }}>revocation (OCSP/CRL), timestamps, public trust lists</dd>
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
            <select className="fs-input" data-testid="pdf-sig-identity" value={idSel} onChange={(e) => setIdSel(e.target.value)}>{ids.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.source === "device" ? "self-signed, this device" : x.source === "pkcs12" ? `.p12${x.chain?.length ? ` + ${x.chain.length} issuer${x.chain.length > 1 ? "s" : ""}` : ""}` : "imported"})</option>)}</select>
          </label>
        ) : <div className="fs-dim" style={small}>No signing identity on this device yet.</div>}
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Btn variant="ghost" data-testid="pdf-sig-new" disabled={busy} onClick={() => void createId()}>New identity</Btn>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import .p12 / PEM…<input type="file" accept=".p12,.pfx,.pem,.crt,.key,.txt" data-testid="pdf-sig-import" style={{ display: "none" }} onChange={(e) => { void importId(e.target.files?.[0]); e.target.value = ""; }} /></label>
          {idSel ? <Btn variant="ghost" disabled={busy} onClick={() => void removeId()}>Delete identity</Btn> : null}
        </div>
        <input className="fs-input" placeholder="Reason (optional)" aria-label="Reason for signing" data-testid="pdf-sig-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        <input className="fs-input" placeholder="Location (optional)" aria-label="Signing location" value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 4, alignItems: "center" }}><input type="checkbox" data-testid="pdf-sig-visible" checked={visible} onChange={(e) => setVisible(e.target.checked)} />Visible on page {Math.min(page, doc.pages().length - 1) + 1}</label>
          {visible ? <select className="fs-input" aria-label="Signature position" data-testid="pdf-sig-corner" disabled={customBox} value={corner} onChange={(e) => setCorner(e.target.value as SigCorner)} style={{ width: "auto" }}>{CORNERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : null}
        </div>
        {visible ? <fieldset style={{ border: "1px solid var(--fs-border)", padding: 6 }}>
          <label><input type="checkbox" data-testid="pdf-sig-custom" checked={customBox} onChange={(e) => setCustomBox(e.target.checked)} /> Custom box</label>
          {customBox ? <><div className="fs-dim" style={small}>From the displayed page’s top-left, in PDF units (normally points). The whole box must fit.</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>{(["left", "top", "width", "height"] as const).map((k) => <label key={k} style={{ minWidth: 0 }}>{k[0].toUpperCase() + k.slice(1)}<input className="fs-input" style={{ width: "100%" }} type="number" step="any" min={k === "left" || k === "top" ? 0 : 1} aria-label={`Signature ${k}`} data-testid={`pdf-sig-${k}`} value={Number.isFinite(box[k]) ? box[k] : ""} onChange={(e) => setBox((b) => ({ ...b, [k]: e.target.value === "" ? NaN : Number(e.target.value) }))} /></label>)}</div></> : null}
        </fieldset> : null}
        <Btn variant="primary" data-testid="pdf-sig-sign" disabled={busy || !idSel} onClick={() => void sign()}>{busy ? "Working…" : "Sign"}</Btn>
        <div className="fs-dim" style={small}>Adds {visible ? "a visible" : "an invisible"} signature (SHA-256) as an incremental update{dirty ? "; your unsaved edits are included in what you sign" : ""}. Edits made after signing are visible to anyone checking the signature.</div>
      </section>
      <section aria-label="Trusted certificates" data-testid="pdf-sig-anchors" style={{ borderTop: "1px solid var(--fs-border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        <strong>Your trusted certificates</strong>
        {anchors?.length ? anchors.map((a) => (
          <div key={a.id} data-testid="pdf-sig-anchor" style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
            <span title={a.subject} style={{ wordBreak: "break-word" }}>{cnOf(a.subject)}</span>
            <Btn variant="ghost" aria-label={`Stop trusting ${cnOf(a.subject)}`} onClick={() => void removeAnchor(a)}>Remove</Btn>
          </div>)) : <div className="fs-dim" style={small}>None. Fusion ships no public trust list; add the certificates you trust (your company&apos;s CA, a colleague&apos;s certificate).</div>}
        <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer", alignSelf: "flex-start" }}>Add certificate…<input type="file" accept=".cer,.crt,.der,.pem" data-testid="pdf-sig-anchor-add" style={{ display: "none" }} onChange={(e) => { void addAnchorFile(e.target.files?.[0]); e.target.value = ""; }} /></label>
      </section>
    </div>
  );
}
