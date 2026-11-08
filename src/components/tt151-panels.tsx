"use client";
/**
 * TT151 panels — three small surfaces over engines that would otherwise be
 * unclaimed code: QR (Beam/Share hand-off), one-time codes (Vault), cron
 * (Routines).
 *
 * Each panel states its own boundary in the interface rather than in a tooltip,
 * because the boundary is the part users get wrong: a QR that is too long is
 * refused with the byte count, a code card says plainly that it does not store the
 * secret, and a cron preview shows the *resolved* next times in the local zone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { encodeQr, qrToSvg, byteCapacity } from "@/lib/qr";
import { parseOtpAuthUri, totp } from "@/lib/totp";
import { Badge, Btn, Section } from "./ui";

// ── QR ─────────────────────────────────────────────────────────────────────

export function QrCard({ value, title = "Open on a phone", onChange }: { value: string; title?: string; onChange?: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const result = useMemo(() => encodeQr(text, { ecc: "M" }), [text]);
  const svg = useMemo(() => (result.ok ? qrToSvg(result.symbol, { moduleSize: 5 }).replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"') : ""), [result]);

  const download = () => {
    if (!result.ok) return;
    const url = URL.createObjectURL(new Blob([qrToSvg(result.symbol, { moduleSize: 8 })], { type: "image/svg+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "fusion-qr.svg";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <Section title={title} icon="qr">
      <div className="fs-row" style={{ gap: 10, alignItems: "flex-start" }}>
        <div
          data-testid="qr-canvas"
          aria-label={result.ok ? `QR code, version ${result.symbol.version}, level ${result.symbol.ecc}` : "QR code unavailable"}
          role="img"
          style={{ width: fz(132), height: fz(132), flex: "0 0 auto", background: "#fff", padding: 4, borderRadius: 6 }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div style={{ display: "grid", gap: 6, minWidth: 0, flex: 1 }}>
          <input
            className="fs-input fs-mono"
            style={{ fontSize: fz(11) }}
            aria-label="QR content"
            data-testid="qr-input"
            value={text}
            onChange={(e) => { setText(e.target.value); onChange?.(e.target.value); }}
          />
          {result.ok ? (
            <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
              <Badge tone="ok">v{result.symbol.version} · {result.symbol.ecc} · mask {result.symbol.mask}</Badge>
              <Badge tone="default">{new TextEncoder().encode(text).length}/{byteCapacity(10, "M")} bytes</Badge>
              <Btn variant="ghost" onClick={download} data-testid="qr-download">SVG</Btn>
            </div>
          ) : (
            <Badge tone="bad">{result.error}</Badge>
          )}
        </div>
      </div>
    </Section>
  );
}

// ── one-time codes ─────────────────────────────────────────────────────────

interface OtpEntry { id: number; account: string; issuer?: string; secret: Uint8Array; digits: 6 | 7 | 8; period: number }

/**
 * Deliberately session-only. A TOTP secret in `localStorage` is a plaintext secret at
 * rest, and the Vault's sealed store is the right home for one — this card is the
 * *verifier* (paste a URI, read the code), and it says so instead of pretending to be
 * a password manager.
 */
export function OtpCard({ onCopy }: { onCopy: (code: string) => Promise<void> }) {
  const [uri, setUri] = useState("");
  const [entries, setEntries] = useState<OtpEntry[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const nextId = useRef(1);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);

  const add = () => {
    const parsed = parseOtpAuthUri(uri.trim());
    if (!parsed.ok) { setError(parsed.error); return; }
    setError("");
    setEntries((rows) => [...rows, {
      id: nextId.current++,
      account: parsed.account,
      issuer: parsed.issuer,
      secret: parsed.secret,
      digits: parsed.digits as 6 | 7 | 8,
      period: parsed.period,
    }]);
    setUri("");
  };

  return (
    <Section title="One-time codes" icon="keycap">
      <div className="fs-row" style={{ gap: 6 }}>
        <input className="fs-input fs-mono" style={{ fontSize: fz(11) }} type="password" autoComplete="off" placeholder="otpauth://totp/…" aria-label="otpauth URI" data-testid="otp-uri" value={uri} onChange={(e) => setUri(e.target.value)} />
        <Btn variant="primary" onClick={add} data-testid="otp-add">Add</Btn>
      </div>
      {error ? <Badge tone="bad" >{error}</Badge> : null}
      <div className="fs-dim" style={{ fontSize: fz(11) }}>Session only — codes are cleared on lock and are not saved.</div>
      {entries.map((e) => {
        const code = totp(e.secret, now, { digits: e.digits as 6 | 7 | 8, period: e.period });
        return (
          <div key={e.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: fz(11.5), minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {e.issuer ? `${e.issuer} · ` : ""}{e.account}
            </span>
            <span className="fs-row" style={{ gap: 6 }}>
              <span className="fs-mono" style={{ fontSize: fz(15), letterSpacing: 1 }} data-testid="otp-code">{code.code}</span>
              <span style={{ width: fz(34), height: 4, background: "var(--line, #333)", borderRadius: 2, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${Math.round(code.remainingRatio * 100)}%`, background: "var(--accent, #4ea1ff)" }} />
              </span>
              <Btn variant="ghost" onClick={() => { void onCopy(code.code).catch(() => setError("Clipboard unavailable")); }} aria-label="Copy code">Copy</Btn>
              <Btn variant="ghost" onClick={() => setEntries((rows) => rows.filter((r) => r.id !== e.id))} aria-label="Remove">Remove</Btn>
            </span>
          </div>
        );
      })}
    </Section>
  );
}

