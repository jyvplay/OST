"use client";

/**
 * TT146 (PR-06) — Mail handoff.
 *
 * This module composes a message and hands it to a real mail client through an
 * RFC 6068 `mailto:` URL, or to the operating system's share sheet when the
 * message carries something mailto cannot (a file). It never sends anything
 * itself: no SMTP socket exists in a browser, and a relay would read the mail.
 *
 * The pane shows what the link will contain *before* it is used — the byte
 * count, any truncation, and anything the chosen channel cannot carry. That is
 * the whole button: a handoff that hides its own limits is the usual failure.
 */

import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useState } from "react";
import { Badge, Btn, KV, Section } from "../ui";
import { useShell } from "../shell-context";
import { buildMailto, describeBuilt, parseMailto, planHandoff, sharePayload, validateAddress, type HandoffCaps } from "@/lib/mail/handoff";
import { useQuality } from "@/lib/net/use-quality";

interface DraftState { to: string; cc: string; bcc: string; subject: string; body: string }

const EMPTY: DraftState = { to: "", cc: "", bcc: "", subject: "", body: "" };
const splitList = (v: string) => v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);

export default function MailModule() {
  const shell = useShell();
  const [draft, setDraft] = useState<DraftState>(EMPTY);
  const [handlers, setHandlers] = useState<{ register: boolean; share: boolean }>({ register: false, share: false });
  const [handlerNote, setHandlerNote] = useState("");
  const net = useQuality("prefetch");

  // A `?mailto=` launch (from the protocol handler or a link) prefills the pane.
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("mailto");
    if (!raw) return;
    try {
      const parsed = parseMailto(raw);
      setDraft({ to: parsed.to.join(", "), cc: parsed.cc.join(", "), bcc: parsed.bcc.join(", "), subject: parsed.subject, body: parsed.body });
      setHandlerNote("prefilled by a mailto: link");
    } catch { setHandlerNote("that mailto: link could not be parsed"); }
  }, []);

  useEffect(() => {
    const nav = navigator as Navigator & { registerProtocolHandler?: (s: string, u: string) => void };
    setHandlers({
      register: typeof nav.registerProtocolHandler === "function",
      share: typeof navigator.share === "function",
    });
  }, []);

  const caps: HandoffCaps = useMemo(() => ({
    shareApi: typeof navigator !== "undefined" && typeof navigator.share === "function",
    canShareText: typeof navigator !== "undefined" && typeof navigator.canShare === "function"
      ? navigator.canShare({ text: "x" })
      : false,
    canShareFiles: typeof navigator !== "undefined" && typeof navigator.canShare === "function" && typeof File !== "undefined"
      ? navigator.canShare({ files: [new File(["x"], "x.txt", { type: "text/plain" })] })
      : false,
    canRegisterProtocol: handlers.register,
  }), [handlers.register]);

  const plan = useMemo(() => planHandoff(caps, {
    to: splitList(draft.to), cc: splitList(draft.cc), bcc: splitList(draft.bcc), subject: draft.subject, body: draft.body,
  }, false), [caps, draft]);

  const built = useMemo(() => {
    try {
      return { ok: true as const, value: buildMailto({ to: splitList(draft.to), cc: splitList(draft.cc), bcc: splitList(draft.bcc), subject: draft.subject, body: draft.body }) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [draft]);

  const problems = useMemo(() => splitList(draft.to).concat(splitList(draft.cc), splitList(draft.bcc))
    .map((a) => ({ address: a, problem: validateAddress(a) })).filter((x) => x.problem), [draft]);

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }} data-testid="mail-app">
      <Section title="Compose (PR-06)" icon="spark" right={<Badge tone={built.ok ? "ok" : "bad"} data-testid="mail-bytes">{built.ok ? describeBuilt(built.value) : "refused"}</Badge>}>
        <label style={{ display: "grid", gap: 3 }}>
          <span className="fs-dim" style={{ fontSize: fz(11) }}>To (comma separated)</span>
          <input className="fs-input" data-testid="mail-to" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} placeholder="name@example.com" spellCheck={false} />
        </label>
        <div className="fs-row" style={{ gap: 6 }}>
          <input className="fs-input" aria-label="Cc" placeholder="Cc" value={draft.cc} onChange={(e) => setDraft({ ...draft, cc: e.target.value })} spellCheck={false} />
          <input className="fs-input" aria-label="Bcc" placeholder="Bcc" value={draft.bcc} onChange={(e) => setDraft({ ...draft, bcc: e.target.value })} spellCheck={false} />
        </div>
        <input className="fs-input" aria-label="Subject" placeholder="Subject" data-testid="mail-subject" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
        <textarea className="fs-textarea" rows={9} aria-label="Message" data-testid="mail-body" placeholder="Message" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        {problems.length ? problems.map((p) => <Badge key={p.address} tone="bad">{p.address}: {p.problem}</Badge>) : null}
        {!built.ok ? <Badge tone="bad">{built.error}</Badge> : null}
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="primary" disabled={!built.ok} data-testid="mail-open"
            onClick={() => { if (!built.ok) return; window.location.href = built.value.url; shell.toast("Handed to your mail app — Fusion does not send it.", "info"); }}>
            Open in mail app
          </Btn>
          <Btn variant="ghost" disabled={!built.ok} data-testid="mail-copy"
            onClick={() => { if (built.ok) void shell.copy(built.value.url, "Mail", false); }}>Copy link</Btn>
          <Btn variant="ghost" disabled={!caps.shareApi || !caps.canShareText}
            title={caps.shareApi ? (caps.canShareText ? "Share with the operating system" : "Share cannot carry text in this browser") : "this browser has no Web Share"}
            onClick={async () => {
              try { await navigator.share(sharePayload({ subject: draft.subject, body: draft.body })); shell.toast("Shared.", "ok"); }
              catch (e) { if ((e as Error).name !== "AbortError") shell.toast("Share failed.", "warn"); }
            }}>Share…</Btn>
          <Btn variant="ghost" onClick={() => { setDraft(EMPTY); setHandlerNote(""); }}>Clear</Btn>
        </div>
      </Section>

      <Section title="How it is sent" icon="shield">
        <KV k="Channel" v={plan.primary} mono />
        <KV k="Why" v={plan.reason} />
        {plan.cannot.map((c) => <KV key={c} k="Cannot" v={c} />)}
        {built.ok && built.value.truncated ? <KV k="Truncated" v={`${built.value.droppedChars} characters, with a visible marker in the body`} /> : null}
        {built.ok && built.value.dropped.length ? <KV k="Dropped fields" v={built.value.dropped.join(", ")} /> : null}
        <KV k="Network plan" v={`${net.decision.label} — prefetch ${net.decision.rung.prefetchBytes} B`} />
      </Section>

      <Section title="Be the mail app" icon="popout">
        <div className="fs-dim" style={{ fontSize: fz(11) }}>
          Register Fusion as a <span className="fs-mono">mailto:</span> handler and a link from any page opens this composer.
        </div>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="ghost" disabled={!handlers.register} data-testid="mail-register"
            onClick={() => {
              const nav = navigator as Navigator & { registerProtocolHandler?: (s: string, u: string) => void };
              try {
                nav.registerProtocolHandler?.("mailto", `${window.location.origin}/?open=mail&mailto=%s`);
                setHandlerNote("the browser was asked; whether it became the default is the browser's decision, not ours");
              } catch (e) { setHandlerNote(`refused: ${(e as Error).message}`); }
            }}>Register mailto: handler</Btn>
          <span className="fs-dim" style={{ fontSize: fz(11) }} data-testid="mail-handler-note">{handlerNote || (handlers.register ? "not registered yet" : "registerProtocolHandler is not available here")}</span>
        </div>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>
          No IMAP, no SMTP, no relay: a browser cannot open those sockets, and a server-side relay would read every message.
        </div>
      </Section>
    </div>
  );
}
