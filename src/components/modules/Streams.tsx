"use client";
import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import * as S from "@/lib/stream-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";

/**
 * TT27 SM-01 / SM-02 / SM-03: the Video and Music players. Both are the providers' *official* embed players in an
 * iframe (no scraping, no proxy, no SDK bundled) plus native <video>/<audio> for direct files, a click-to-load
 * privacy gate (nothing contacts a provider until you choose), and one shared library file /Documents/Streams.json.
 *
 * Referrer: the site sends Referrer-Policy: no-referrer globally; provider iframes (YouTube rejects embeds without a
 * Referer — "Error 153") opt in per element to strict-origin-when-cross-origin, which sends only this origin.
 */
const Ico = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" style={{ width: fz(14), height: fz(14) }}>
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const PENCIL = "M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12z", UP = "M8 13V3M3.5 7.5L8 3l4.5 4.5", CROSS = "M4 4l8 8M12 4l-8 8";

export const LIBRARY_PATH = "/Documents/Streams.json";

const EXAMPLES: Record<S.StreamKind, string[]> = {
  video: ["https://www.youtube.com/watch?v=…", "https://vimeo.com/…", "https://<peertube-instance>/w/…", "https://….mp4"],
  audio: ["https://open.spotify.com/track/…", "https://soundcloud.com/artist/track", "spotify:album:…", "https://….mp3"],
};

export function StreamApp({ win, kind }: ModuleProps & { kind: S.StreamKind }) {
  const shell = useShell();
  const pfx = kind === "video" ? "sv" : "sa";
  const [url, setUrl] = useState<string>((win.props.url as string) ?? "");
  const [current, setCurrent] = useState<{ ref: S.StreamRef; itemId: string | null } | null>(null);
  const [error, setError] = useState("");
  const [lib, setLib] = useState<S.Library | null>(null);
  const [libErr, setLibErr] = useState("");
  const [q, setQ] = useState("");
  const [consented, setConsented] = useState<Set<string>>(() => new Set());
  const [remember, setRemember] = useState(false);
  const [loop, setLoop] = useState(false);
  const dirty = useRef(false);
  const libRef = useRef<S.Library | null>(null);
  const alwaysLoad = shell.settings["media.embeds"] === "allow";
  const parentHost = typeof window === "undefined" ? "localhost" : window.location.hostname;

  // load the shared library (a missing file is an empty library)
  useEffect(() => {
    let live = true;
    api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(LIBRARY_PATH)}`)
      .then((r) => { if (!live) return; let raw: unknown = null; try { raw = JSON.parse(r.node.content); } catch { setLibErr("Streams.json is not valid JSON — it will be replaced on the next save"); } setLib(S.normalizeLibrary(raw)); })
      .catch((e: Error) => { if (!live) return; if (/not found|404/i.test(e.message)) setLib(S.emptyLibrary()); else setLibErr(e.message); });
    return () => { live = false; };
  }, []);

  // debounced save; flushed on unmount (keepalive capped below the 64 KiB browser limit)
  useEffect(() => {
    libRef.current = lib;
    if (!lib || !dirty.current) return;
    const t = setTimeout(() => {
      dirty.current = false;
      post("/api/fs", { op: "write", path: LIBRARY_PATH, content: JSON.stringify(lib, null, 1), mime: "application/json", reason: "streams" })
        .then(() => setLibErr("")).catch((e: Error) => setLibErr(`Save failed: ${e.message}`));
    }, 400);
    return () => clearTimeout(t);
  }, [lib]);
  // flush a pending save when the tab is hidden/closed (pagehide) and on unmount — the debounce must never lose an edit
  useEffect(() => {
    const flush = () => {
      if (!dirty.current || !libRef.current) return;
      dirty.current = false;
      const body = JSON.stringify({ op: "write", path: LIBRARY_PATH, content: JSON.stringify(libRef.current, null, 1), mime: "application/json", reason: "streams" });
      void fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: body.length < 60_000 }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  const change = (next: S.Library) => { dirty.current = true; setLib(next); };

  const play = (raw: string, itemId: string | null = null) => {
    const p = S.parseStream(raw, parentHost);
    if (!p.ok) { setError(p.error); return; }
    if (p.ref.kind !== kind) { setError(`That is a ${p.ref.kind === "audio" ? "music" : "video"} link — open it in ${p.ref.kind === "audio" ? "Music" : "Video"}.`); return; }
    setError(""); setCurrent({ ref: p.ref, itemId });
  };
  // a link handed over by another app (open-with / routine) starts in the player
  const initial = useRef((win.props.url as string) ?? "");
  useEffect(() => { if (initial.current) play(initial.current); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const save = () => {
    if (!lib) return;
    const r = S.addToLibrary(lib, url, "", new Date().toISOString(), `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    if (r.error) { setError(r.error); return; }
    const p = S.parseStream(url);
    if (p.ok && p.ref.kind !== kind) { setError(`That is a ${p.ref.kind === "audio" ? "music" : "video"} link — save it from ${p.ref.kind === "audio" ? "Music" : "Video"}.`); return; }
    setError(""); change(r.lib); shell.toast(`Saved to ${kind === "video" ? "Video" : "Music"} library`, "ok");
  };

  const items = useMemo(() => (lib ? S.filterLibrary(lib, kind, q) : []), [lib, kind, q]);
  const next = () => { const n = S.nextIn(items, current?.itemId ?? null, loop); if (n) play(n.url, n.id); };
  const ref = current?.ref ?? null;
  const loaded = !!ref && (ref.provider === "file" || alwaysLoad || consented.has(ref.host));
  const h = ref ? S.playerHeight(ref) : null;

  return (
    <div className="fs-stream" data-testid={`${pfx}-app`} data-kind={kind}>
      <form className="fs-stream-bar" onSubmit={(e) => { e.preventDefault(); play(url); }}>
        <input className="fs-input" data-testid={`${pfx}-url`} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}
          aria-label={kind === "video" ? "Video link" : "Music link"} placeholder={`Paste a link — ${EXAMPLES[kind].slice(0, 2).join(" or ")}`} />
        <Btn type="submit" variant="primary" data-testid={`${pfx}-play`}>Play</Btn>
        <Btn onClick={save} disabled={!lib || !url.trim()} data-testid={`${pfx}-save`} title="Add this link to the library (Streams.json)">Save</Btn>
      </form>
      {error ? <p className="fs-stream-err" role="alert" data-testid={`${pfx}-error`}>{error}</p> : null}

      <div className="fs-stream-main">
        <section className="fs-stream-stage" aria-label="Player" data-testid={`${pfx}-stage`} data-provider={ref?.provider ?? ""} data-loaded={loaded ? "1" : "0"}>
          {!ref ? (
            <div className="fs-stream-empty">
              <strong>{kind === "video" ? "Play a video from YouTube, Vimeo, Dailymotion, Twitch, PeerTube or a file link" : "Stream from Spotify or SoundCloud, or play an audio file link"}</strong>
              <span className="fs-dim">Examples: {EXAMPLES[kind].join(" · ")}</span>
            </div>
          ) : !loaded ? (
            <div className="fs-stream-facade" data-testid={`${pfx}-facade`} style={h ? { minHeight: Math.max(h, 180) } : undefined}>
              <Badge tone="info">{S.PROVIDER_LABEL[ref.provider]}{ref.sub ? ` · ${ref.sub}` : ""}</Badge>
              <strong className="fs-stream-facade-title">Load the {S.PROVIDER_LABEL[ref.provider]} player?</strong>
              <span className="fs-dim">This connects to <b>{ref.host}</b>, which sees your IP address and may set cookies. Nothing has been sent yet.
                {ref.provider === "spotify" ? " Full tracks need you to be signed in to Spotify in this browser; otherwise Spotify plays 30-second previews." : ""}</span>
              <label className="fs-row" style={{ gap: 8 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-testid={`${pfx}-remember`} />
                Always load embedded players without asking
              </label>
              <div className="fs-row" style={{ gap: 8 }}>
                <Btn variant="primary" data-testid={`${pfx}-load`} onClick={() => {
                  setConsented((s) => new Set(s).add(ref.host));
                  if (remember) void shell.setSetting("media.embeds", "allow");
                }}>Load player</Btn>
                <a className="fs-btn" href={ref.page} target="_blank" rel="noopener noreferrer" data-testid={`${pfx}-open-site`}>Open on {S.PROVIDER_LABEL[ref.provider]}</a>
              </div>
            </div>
          ) : ref.provider === "file" ? (
            ref.kind === "video"
              ? <video key={ref.embed} className="fs-stream-video" src={ref.embed} controls playsInline data-testid={`${pfx}-media`} onEnded={next} />
              : <audio key={ref.embed} className="fs-stream-audio" src={ref.embed} controls data-testid={`${pfx}-media`} onEnded={next} />
          ) : (
            <iframe key={ref.embed} className="fs-stream-frame" data-testid={`${pfx}-frame`} src={ref.embed}
              title={`${S.PROVIDER_LABEL[ref.provider]} player`} allow={S.iframeAllow(ref)} allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin" loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
              style={h ? { height: h, aspectRatio: "auto" } : undefined} />
          )}
          {ref ? (
            <div className="fs-stream-meta">
              <span className="fs-dim" data-testid={`${pfx}-now`}>{S.PROVIDER_LABEL[ref.provider]}{ref.start ? ` · from ${ref.start}s` : ""}</span>
              <span style={{ flex: 1 }} />
              <Btn variant="ghost" onClick={next} disabled={!items.length} data-testid={`${pfx}-next`} title={ref.provider === "file" ? "Next in the library (also plays automatically at the end)" : "Next in the library (embedded players do not report when they end, so this is manual)"}>Next</Btn>
              <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} data-testid={`${pfx}-loop`} />Loop list</label>
              <a className="fs-btn" data-variant="ghost" href={ref.page} target="_blank" rel="noopener noreferrer">Open on site</a>
            </div>
          ) : null}
        </section>

        <aside className="fs-stream-lib" aria-label="Library">
          <div className="fs-row" style={{ gap: 8 }}>
            <strong style={{ fontSize: fz(14) }}>Library</strong>
            <Badge>{lib ? S.filterLibrary(lib, kind, "").length : "…"}</Badge>
            <span style={{ flex: 1 }} />
          </div>
          <input className="fs-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter the library" data-testid={`${pfx}-filter`} />
          {libErr ? <p className="fs-stream-err" role="alert">{libErr}</p> : null}
          <ul className="fs-stream-list" data-testid={`${pfx}-lib`}>
            {lib && !items.length ? <li className="fs-dim" style={{ padding: 8 }}>{q ? "Nothing matches." : "Saved links appear here. Paste a link and press Save."}</li> : null}
            {items.map((it, i) => (
              <li key={it.id} data-testid={`${pfx}-item`} data-current={current?.itemId === it.id ? "1" : undefined}>
                <button type="button" className="fs-stream-item-play" onClick={() => { setUrl(it.url); play(it.url, it.id); }} data-testid={`${pfx}-item-play`} title={`Play ${it.title}`}>
                  <span className="fs-stream-item-title">{it.title}</span>
                  <span className="fs-dim fs-stream-item-sub">{S.PROVIDER_LABEL[it.provider]}</span>
                </button>
                <div className="fs-stream-item-tools">
                  <Btn variant="ghost" aria-label={`Rename ${it.title}`} title="Rename" data-testid={`${pfx}-item-rename`} onClick={() => {
                    const t = window.prompt("Name", it.title); if (t !== null && lib) change(S.renameInLibrary(lib, it.id, t));
                  }}><Ico d={PENCIL} /></Btn>
                  <Btn variant="ghost" aria-label={`Move ${it.title} up`} disabled={i === 0 || !!q} onClick={() => lib && change(S.moveInLibrary(lib, it.id, -1))}><Ico d={UP} /></Btn>
                  <Btn variant="ghost" aria-label={`Remove ${it.title}`} data-testid={`${pfx}-item-remove`} onClick={() => lib && change(S.removeFromLibrary(lib, it.id))}><Ico d={CROSS} /></Btn>
                </div>
              </li>
            ))}
          </ul>
          {alwaysLoad ? (
            <Btn variant="ghost" onClick={() => void shell.setSetting("media.embeds", "ask")} data-testid={`${pfx}-ask-again`}>Ask before loading players</Btn>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
