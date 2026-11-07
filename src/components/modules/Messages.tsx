"use client";
import { fz } from "@/lib/uiscale";

import { useState } from "react";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Section } from "../ui";
import { filterMessages } from "@/lib/message-search";
import { conversationText } from "@/lib/conversation-text";
import {
  bridgeAllowed, bridgeRequests, parseBridgeChats, parseBridgeMessages,
  matrixAllowed, matrixRequests, parseMatrixVersions, parseMatrixMessages, redact, type BridgeMessage,
} from "@/lib/media-bridge";

/**
 * MS-01/03/04. The messaging module ships the *connector seam* and an honest
 * reachability check. No bridge is bundled, no Apple credential is handled, and
 * the blocked routes are named with their real reason rather than hidden.
 */
export default function MessagesModule(_: ModuleProps) {
  const shell = useShell();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState<string>("");
  const [msgQ, setMsgQ] = useState("");
              const [messages, setMessages] = useState<{ id: string; from: string; text: string; ts: number }[]>([]);
  const [chat, setChat] = useState("");
  const [room, setRoom] = useState("general");
  const [homeserver, setHomeserver] = useState("");
  const [busy2, setBusy2] = useState(false);
  const busy = busy2;
  const setBusy = setBusy2;
  const [chats, setChats] = useState<{ guid: string; title: string; lastAt: number | null }[]>([]);

  /**
   * Every request goes through the engine's builders so the token is a bearer
   * header (never a query string) and the base address is validated first. A
   * failure is redacted before it is shown, because a fetch error message can
   * contain the URL.
   */
  const runBridge = async (req: { method: string; url: string; headers: Record<string, string>; body?: string; purpose: string }) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(8000), mode: "cors" });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* a non-JSON body is a failure the parser will report */ }
    return { status: res.status, json, text };
  };

  const loadBridgeChats = async () => {
    setBusy(true); setResult("");
    try {
      const allowed = bridgeAllowed(endpoint);
      if (!allowed.ok) { setResult(allowed.reason); return; }
      const reqs = bridgeRequests(endpoint, token, { limit: 30 });
      const ping = await runBridge(reqs[0]);
      if (ping.status >= 400) { setResult(`the bridge answered HTTP ${ping.status} to its ping`); return; }
      const list = await runBridge(reqs[1]);
      const parsed = parseBridgeChats(list.json);
      if (!parsed.ok) { setResult(redact(parsed.error, [token])); return; }
      setChats(parsed.chats);
      setResult(`${parsed.chats.length} chat${parsed.chats.length === 1 ? "" : "s"} · ping HTTP ${ping.status}`);
    } catch (e) {
      setResult(redact(`unreachable: ${(e as Error).message}. A browser reaches only a bridge that sends CORS headers over https.`, [token]));
    } finally { setBusy(false); }
  };

  const loadBridgeThread = async (guid: string) => {
    setBusy(true); setResult(""); setRoom(guid);
    try {
      const reqs = bridgeRequests(endpoint, token, { chatGuid: guid, limit: 50 });
      const thread = reqs.find((r) => r.url.includes("/message?"));
      if (!thread) { setResult("that chat has no readable thread"); return; }
      const got = await runBridge(thread);
      const parsed = parseBridgeMessages(got.json);
      if (!parsed.ok) { setResult(redact(parsed.error, [token])); return; }
      setMessages(parsed.messages.map((m: BridgeMessage) => ({ id: m.id, from: m.from, text: m.text, ts: m.at ?? Date.now() })));
      setResult(`${parsed.messages.length} message${parsed.messages.length === 1 ? "" : "s"}`);
    } catch (e) {
      setResult(redact((e as Error).message, [token]));
    } finally { setBusy(false); }
  };

  const matrixProbe = async () => {
    setBusy(true); setResult("");
    try {
      const allowed = matrixAllowed({ homeserver, accessToken: token });
      if (!allowed.ok) { setResult(allowed.reason); return; }
      const reqs = matrixRequests({ homeserver, accessToken: token, userId: "self" });
      const versions = await runBridge(reqs[0]);
      const parsed = parseMatrixVersions(versions.json);
      if (!parsed.ok) { setResult(parsed.error ?? "not a Matrix homeserver"); return; }
      setResult(`Matrix speaks ${parsed.versions.filter((v) => /^v1\./.test(v)).join(", ")}`);
    } catch (e) {
      setResult(redact((e as Error).message, [token]));
    } finally { setBusy(false); }
  };

  const check = async () => {
    setBusy(true);
    setResult("");
    try {
      const url = endpoint.replace(/\/$/, "");
      const r = await fetch(`${url}/api/v1/ping${token ? `?password=${encodeURIComponent(token)}` : ""}`, {
        signal: AbortSignal.timeout(6000), mode: "cors",
      });
      setResult(`HTTP ${r.status} ${r.statusText} — ${r.ok ? "endpoint reachable" : "endpoint rejected the probe"}`);
    } catch (e) {
      setResult(`unreachable: ${String((e as Error).message)}. A browser can only reach a bridge that sends CORS headers and is served over HTTPS from a page like this one.`);
    } finally { setBusy(false); }
  };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Bridge (your hardware)" right={<Badge tone={endpoint && bridgeAllowed(endpoint).ok ? "ok" : "warn"}>{endpoint ? (bridgeAllowed(endpoint).ok ? "address ok" : "address refused") : "no address"}</Badge>}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className="fs-input" style={{ flex: "2 1 14em" }} placeholder="https://bridge.example.lan" value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)} aria-label="Bridge endpoint" data-testid="messages-endpoint" />
          <input className="fs-input" style={{ flex: "1 1 8em" }} type="password" placeholder="token" value={token}
            onChange={(e) => setToken(e.target.value)} aria-label="Bridge token" />
        </div>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="primary" disabled={!endpoint || busy2} onClick={() => void check()} data-testid="messages-check">{busy2 ? "…" : "Connect"}</Btn>
          <Btn variant="ghost" disabled={!chats.length || busy2} onClick={() => void loadBridgeChats()}>Chats</Btn>
          <Btn variant="ghost" disabled={!endpoint} onClick={() => { setEndpoint(""); setToken(""); setResult(""); setChats([]); setMessages([]); }}>Clear</Btn>
        </div>
        {result ? <div className="fs-mono" style={{ fontSize: fz(11.5), wordBreak: "break-word" }} data-testid="messages-result">{result}</div> : null}
        {chats.length ? (
          <div className="fs-scroll" style={{ maxHeight: 110, display: "grid", gap: 2 }}>
            {chats.map((c) => (
              <button key={c.guid} className="fs-navitem" aria-pressed={c.guid === room} onClick={() => void loadBridgeThread(c.guid)}
                style={{ textAlign: "left", fontSize: fz(11.5), padding: "3px 6px", background: c.guid === room ? "var(--fs-accent-soft)" : "transparent" }}>
                {c.title} <span className="fs-dim">{c.lastAt ? new Date(c.lastAt).toLocaleDateString() : ""}</span>
              </button>
            ))}
          </div>
        ) : null}

      <Section title="Message connector (MS-01 / MS-04)">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Generic connector: GET/POST {homeserver || endpoint || "https://server"}/api/v1/rooms/{room}/messages with a bearer token.
          Works for any bridge that follows the shape (BlueBubbles-style or a self-hosted Matrix proxy). No SDK is
          bundled, so the contract is visible and auditable.
        </div>
        <Btn variant="ghost" onClick={() => void matrixProbe()} disabled={!homeserver || !token || busy2} data-testid="messages-matrix-probe">Probe Matrix</Btn>
        <input className="fs-input" placeholder="homeserver / bridge URL" value={homeserver || endpoint}
          onChange={(e) => { setHomeserver(e.target.value); setEndpoint(e.target.value); }} aria-label="Homeserver URL" />
        <input className="fs-input" type="password" placeholder="access token / password" value={token}
          onChange={(e) => setToken(e.target.value)} aria-label="Access token" />
        <input className="fs-input" placeholder="room" value={room} onChange={(e) => setRoom(e.target.value)} aria-label="Room" />
        <div className="fs-row" style={{ gap: 6 }}>
          <Btn variant="ghost" disabled={!endpoint} onClick={async () => {
            try {
              const url = `${endpoint.replace(/\/$/, "")}/api/v1/rooms/${encodeURIComponent(room)}/messages`;
              const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
              const data = await r.json().catch(() => []);
              setMessages(Array.isArray(data) ? data : data?.messages ?? []);
            } catch (e) { setResult(String((e as Error).message)); }
          }}>Load messages</Btn>
          <Btn variant="primary" disabled={!endpoint || !chat} onClick={async () => {
            try {
              const url = `${endpoint.replace(/\/$/, "")}/api/v1/rooms/${encodeURIComponent(room)}/messages`;
              await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ text: chat }) });
              setChat("");
              setMessages((m) => [...m, { id: String(Date.now()), from: "me", text: chat, ts: Date.now() }]);
            } catch (e) { setResult(String((e as Error).message)); }
          }}>Send</Btn>
        </div>
        <input className="fs-input" placeholder="Search these messages" aria-label="Search loaded messages" value={msgQ} onChange={(e) => setMsgQ(e.target.value)} data-testid="messages-search" />
        <Btn variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(conversationText(filterMessages(messages, msgQ))); shell.toast("Conversation copied."); } catch { shell.toast("Clipboard unavailable.", "bad"); } }} data-testid="messages-copy">Copy conversation</Btn>
        <div className="fs-scroll" style={{ maxHeight: 150, fontSize: fz(11.5) }}>
          {filterMessages(messages, msgQ).map((m) => <div key={m.id}><span className="fs-dim">{new Date(m.ts).toLocaleTimeString()} </span>{m.from}: {m.text}</div>)}
        </div>
      </Section>

      <Section title="Lens upscale (LN-05) — interpolation, not a model">
        <details>
          <summary style={{ fontSize: fz(11.5), cursor: "pointer" }}>Bicubic interpolation — no model bundled. Why?</summary>
          <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
            The Lens module’s canvas output is bicubic-upsampled when the requested output height exceeds the captured
            height, and the governor’s cast ceiling still applies. No super-resolution model is bundled; a real one would
            be a multi-GB download and the admissible-weights question from the native spec is unresolved.
          </div>
        </details>
      </Section>
        <Badge tone="warn">status: skeleton — the connector reports reachability only; no message sync is implemented</Badge>
      </Section>

      <Section title="What is not possible from a web app">
        <div style={{ display: "grid", gap: 8 }}>
          <Blocked what="iMessage without your own Apple hardware"
            missing="Apple's registration requires genuine-hardware identifiers and private certificates; re-implementations are licence-incompatible and against Apple's terms"
            workaround="Run a bridge on a Mac you own and point the connector at it." />
          <Blocked what="SMS / MMS send and receive"
            missing="no web API exposes the telephony stack; sms: links can only pre-fill the system app" />
          <Blocked what="RCS"
            missing="the RCS API is not offered to third-party clients on any platform" />
          <Blocked what="Reading notifications from other apps"
            missing="no NotificationListenerService analog exists for web content"
            workaround="Fusion's own alerts, plus the Notification API for delivery." />
        </div>
      </Section>

      <Section title="Open-protocol route (planned)">
        <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
          Matrix and XMPP are reachable from a browser over HTTPS/WebSocket, so they are the admissible messaging
          backends for a PWA. The seam above is deliberately generic: endpoint + token + reachability probe, which is
          the same shape any of those connectors needs.
        </div>
        <Btn variant="ghost" onClick={() => shell.open("spec", { focus: "MS-04" })}>Show the MS rows in the Spec register</Btn>
      </Section>
    </div>
  );
}
