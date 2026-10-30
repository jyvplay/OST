"use client";
import { fz } from "@/lib/uiscale";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "@/lib/api";
import * as S from "@/lib/stream-core";
import * as E from "@/lib/embed-control-core";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn } from "../ui";
import { askText } from "@/lib/ask";
import { showOsd } from "@/lib/osd";

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
import { loadPlays, storePlays, pushPlay, type RecentPlay } from "@/lib/recent-plays";
import { providersOf, filterByProvider } from "@/lib/provider-filter";
import { sortLibrary, type LibrarySort } from "@/lib/library-sort";
const STATUS_LABEL: Record<E.Status, string> = { loading: "Loading", ready: "Ready", cued: "Ready", playing: "Playing", paused: "Paused", buffering: "Buffering", ended: "Ended" };
/** TT33: a one-way player (TIDAL) reports starts only — say exactly what is known */
const statusText = (c: E.CtlState) => c.oneWay
  ? (c.status === "playing" ? "Started" : c.status === "paused" && c.assumed ? "Pause sent" : STATUS_LABEL[c.status])
  : `${STATUS_LABEL[c.status]} · ${E.formatClock(c.time, c.duration)}`;
/** TT33: one player at a time across every Video / Music window (a start anywhere pauses the others) */
const EXCLUSIVE = "fusion-media-exclusive";

const EXAMPLES: Record<S.StreamKind, string[]> = {
  video: ["https://www.youtube.com/watch?v=…", "https://vimeo.com/…", "https://<peertube-instance>/w/…", "https://tidal.com/video/…", "https://….mp4"],
  audio: ["https://open.spotify.com/track/…", "https://soundcloud.com/artist/track", "https://tidal.com/album/…", "https://open.qobuz.com/album/…", "https://music.amazon.com/albums/…", "an embed code <iframe …>", "https://….mp3"],
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
  // TT34 SM-11: shuffle (no repeats within a round) + a history so Previous retraces shuffled picks
  const [shuffle, setShuffle] = useState(false);
  const history = useRef<string[]>([]);
  const played = useRef<string[]>([]);
  // TT34 SM-09: native <video>/<audio> state for the shared transport (embeds report through `ctl`)
  const [media, setMedia] = useState<{ time: number; duration: number; volume: number; muted: boolean; rate: number; paused: boolean } | null>(null);
  // TT28 SM-04: two-way control of the embed (ended → auto-next, play/pause, progress) — see embed-control-core.ts
  const [autoNext, setAutoNext] = useState(true);
  const [ctl, setCtl] = useState<E.CtlState | null>(null);
  const ctlRef = useRef<E.CtlState | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  /** the iframe's identity: a new key/src only when a NEW player is needed (a same-player load keeps the frame) */
  const [plays, setPlays] = useState<RecentPlay[]>(() => { try { return loadPlays(localStorage); } catch { return []; } });
  const [frame, setFrame] = useState<{ key: number; src: string; ctl: E.Ctl | null } | null>(null);
  const frameSeq = useRef(0);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const selfId = useRef(`${win.id}`);
  const autoplayNext = useRef(false);
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
    setError("");
    const c = E.controllable(p.ref.provider);
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    // same YouTube player already connected → load the new video into it (keeps the browser's playback permission)
    const live = ctlRef.current, cur = frame;
    if (c === "youtube" && cur?.ctl === "youtube" && live?.connected && frameRef.current?.contentWindow && p.ref.sub !== "playlist") {
      const msg = E.command("youtube", { op: "load", id: p.ref.id, start: p.ref.start ?? 0 });
      const to = E.targetOrigin("youtube", cur.src);
      if (msg && to) {
        frameRef.current.contentWindow.postMessage(msg, to);
        ctlRef.current = { ...live, status: "loading", time: 0, duration: 0 };
        setCtl(ctlRef.current);
        setCurrent({ ref: p.ref, itemId });
        return;
      }
    }
    const auto = autoplayNext.current; autoplayNext.current = false;
    frameSeq.current += 1;
    const pid = E.tidalPid(`${selfId.current}-${frameSeq.current}`);
    setFrame({ key: frameSeq.current, src: c ? E.controlUrl(c, p.ref.embed, origin, auto, pid) : p.ref.embed, ctl: c });
    ctlRef.current = c ? E.initialState(c, auto, pid) : null; setCtl(ctlRef.current);
    setCurrent({ ref: p.ref, itemId });
    const item = itemId ? libRef.current?.items.find((i) => i.id === itemId) : undefined;
    const title = item?.title ?? `${S.PROVIDER_LABEL[p.ref.provider]} · ${p.ref.id}`;
    setPlays((l) => { const n = pushPlay(l, { id: item?.id ?? `${p.ref.provider}:${p.ref.id}`, title, at: Date.now() }); try { storePlays(localStorage, n); } catch { /* private mode */ } return n; });
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

  const [providerFacet, setProviderFacet] = useState("all");
  const [libSort, setLibSort] = useState<LibrarySort>("added");
  const items = useMemo(() => (lib ? sortLibrary(filterByProvider(S.filterLibrary(lib, kind, q), providerFacet), libSort) : []), [lib, kind, q, providerFacet, libSort]);
  const next = () => {
    const cur = current?.itemId ?? null;
    let n: S.LibraryItem | null;
    if (shuffle) {
      const r = S.shuffleNext(items, cur, played.current, loop);
      if (r?.newRound) played.current = [];
      n = r?.item ?? null;
      if (n) played.current = [...played.current, n.id];
    } else n = S.nextIn(items, cur, loop);
    if (!n) return;
    if (cur) history.current = [...history.current.slice(-99), cur];
    play(n.url, n.id);
  };
  const prev = () => {
    const cur = current?.itemId ?? null;
    let n: S.LibraryItem | null = null;
    while (!n && history.current.length) { const id = history.current[history.current.length - 1]; history.current = history.current.slice(0, -1); n = items.find((x) => x.id === id) ?? null; }
    if (!n && !shuffle) n = S.prevIn(items, cur, loop);
    if (n) play(n.url, n.id);
  };
  const nextRef = useRef(next);
  const autoRef = useRef(autoNext);
  useEffect(() => { nextRef.current = next; autoRef.current = autoNext; });

  // messages from OUR iframe only (source + exact origin), fed through the protocol state machine
  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const st = ctlRef.current, fr = frameRef.current;
      if (!st || !fr || ev.source !== fr.contentWindow || !E.originAllowed(st.ctl, ev.origin)) return;
      const r = E.receive(st, ev.data);
      ctlRef.current = r.state;
      for (const m of r.send) fr.contentWindow?.postMessage(m, ev.origin);
      if (r.events.length) setCtl(r.state);
      if (r.events.some((e) => e.type === "status" && e.status === "playing")) announce();
      if (r.events.some((e) => e.type === "ended") && autoRef.current) { autoplayNext.current = true; nextRef.current(); }
    };
    // another Video / Music window started playing → pause ours (embed via its protocol, native media directly)
    const onExclusive = (ev: Event) => {
      const who = (ev as CustomEvent<string>).detail;
      if (who === selfId.current) return;
      const m = mediaRef.current;
      if (m && !m.paused) m.pause();
      const st = ctlRef.current, fr = frameRef.current;
      if (!st || !fr?.contentWindow || !st.connected || !(st.status === "playing" || st.status === "buffering")) return;
      const src = fr.getAttribute("src") ?? "";
      const msg = E.command(st.ctl, { op: "pause" }, "fusion", st), to = E.targetOrigin(st.ctl, src);
      if (msg && to) { fr.contentWindow.postMessage(msg, to); ctlRef.current = E.afterCommand(st, { op: "pause" }); setCtl(ctlRef.current); }
    };
    window.addEventListener("message", onMsg);
    window.addEventListener(EXCLUSIVE, onExclusive);
    return () => { window.removeEventListener("message", onMsg); window.removeEventListener(EXCLUSIVE, onExclusive); };
  }, []);
  function announce() { window.dispatchEvent(new CustomEvent(EXCLUSIVE, { detail: selfId.current })); }
  // YouTube speaks only after a "listening" handshake: repeat it until the player answers (≤ 10 s)
  const onFrameLoad = () => {
    const st = ctlRef.current, fr = frameRef.current, f = frame;
    if (!st || !fr || !f?.ctl) return;
    const to = E.targetOrigin(f.ctl, f.src);
    if (!to) return;
    if (st.oneWay) {
      // TIDAL never speaks first: usable from load; a queued autoplay is retried until the player reports a start
      const r = E.frameLoaded(st);
      ctlRef.current = r.state; setCtl(r.state);
      if (r.send.length) {
        let n = 0;
        const again = () => {
          if (ctlRef.current?.status === "playing" || frameRef.current !== fr || n++ > 8) return;
          for (const m of r.send) fr.contentWindow?.postMessage(m, to);
          setTimeout(again, 750);
        };
        again();
      }
      return;
    }
    const msgs = E.handshake(f.ctl, `fusion-${f.key}`);
    if (!msgs.length) return;
    let n = 0;
    const tick = () => {
      if (ctlRef.current?.connected || frameRef.current !== fr || n++ > 40) return;
      for (const m of msgs) fr.contentWindow?.postMessage(m, to);
      setTimeout(tick, 250);
    };
    tick();
  };
  const send = (c: E.Command) => {
    const st = ctlRef.current, fr = frameRef.current, f = frame;
    if (!st || !fr || !f?.ctl) return;
    const msg = E.command(f.ctl, c, "fusion", st), to = E.targetOrigin(f.ctl, f.src);
    if (msg && to) {
      fr.contentWindow?.postMessage(msg, to);
      const nx = E.afterCommand(st, c);
      if (nx !== st) { ctlRef.current = nx; setCtl(nx); }
    }
  };
  const ref = current?.ref ?? null;
  const loaded = !!ref && (ref.provider === "file" || alwaysLoad || consented.has(ref.host));

  /* ------------------------------------------------ TT34 SM-09/10: one transport for embeds and native files */
  const native = ref?.provider === "file";
  const caps: E.Caps = native ? { seek: true, volume: true, mute: true, rate: true, playlist: false } : E.capabilities(ctl);
  const tp = native
    ? { time: media?.time ?? 0, duration: media?.duration ?? 0, volume: media ? Math.round(media.volume * 100) : undefined, muted: media?.muted, rate: media?.rate, rates: E.DEFAULT_RATES as readonly number[], playing: media ? !media.paused : false }
    : { time: ctl?.time ?? 0, duration: ctl?.duration ?? 0, volume: ctl?.volume, muted: ctl?.muted, rate: ctl?.rate, rates: (ctl?.rates?.length ? ctl.rates : E.DEFAULT_RATES) as readonly number[], playing: ctl?.status === "playing" || ctl?.status === "buffering" };
  const syncMedia = (el: HTMLMediaElement) => setMedia({ time: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : 0, volume: el.volume, muted: el.muted, rate: el.playbackRate, paused: el.paused });
  const t = {
    toggle: () => {
      if (native) { const m = mediaRef.current; if (m) { if (m.paused) void m.play().catch(() => {}); else m.pause(); } return; }
      if (ctl?.connected) send(tp.playing ? { op: "pause" } : { op: "play" });
    },
    seekTo: (sec: number) => {
      const d = tp.duration, x = Math.max(0, d > 0 ? Math.min(d - 0.25, sec) : sec);
      if (native) { const m = mediaRef.current; if (m) m.currentTime = x; return; }
      if (caps.seek) { send({ op: "seek", seconds: x }); if (ctlRef.current) { ctlRef.current = { ...ctlRef.current, time: x }; setCtl(ctlRef.current); } }
    },
    volume: (v: number) => {
      const x = Math.max(0, Math.min(100, Math.round(v)));
      if (native) { const m = mediaRef.current; if (m) { m.volume = x / 100; if (x > 0 && m.muted) m.muted = false; } return; }
      if (caps.volume) { send({ op: "volume", value: x }); if (x > 0 && tp.muted) send({ op: "mute", on: false }); }
    },
    mute: () => {
      if (native) { const m = mediaRef.current; if (m) m.muted = !m.muted; return; }
      if (caps.mute) send({ op: "mute", on: !tp.muted });
    },
    rate: (r: number) => {
      if (native) { const m = mediaRef.current; if (m) m.playbackRate = r; return; }
      if (caps.rate) send({ op: "rate", value: r });
    },
  };
  /** keyboard: only while focus is inside this app (not inside the provider's iframe, which keeps its own keys) */
  const onKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    const a = E.keyAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, tag: el.tagName, type: (el as HTMLInputElement).type, editable: el.isContentEditable });
    if (!a) return;
    if (a.op === "libNext") { if (items.length) next(); }
    else if (a.op === "libPrev") prev();
    else if (!ref || !loaded) return;
    else if (a.op === "toggle") t.toggle();
    else if (a.op === "skip") { if (!caps.seek) return; t.seekTo(tp.time + a.seconds); }
    else if (a.op === "seekFraction") { if (!caps.seek || !(tp.duration > 0)) return; t.seekTo(tp.duration * a.f); }
    else if (a.op === "volume") { if (!caps.volume) return; t.volume((tp.volume ?? 100) + a.delta); }
    else if (a.op === "mute") { if (!caps.mute) return; t.mute(); }
    else if (a.op === "rate") { if (!caps.rate) return; t.rate(E.stepRate(tp.rates, tp.rate ?? 1, a.dir)); }
    e.preventDefault();
  };
  const h = ref ? S.playerHeight(ref) : null;

  return (
    <div className="fs-stream" data-testid={`${pfx}-app`} data-kind={kind} onKeyDown={onKeys}>
      <form className="fs-stream-bar" onSubmit={(e) => { e.preventDefault(); play(url); }}>
        <input className="fs-input" data-testid={`${pfx}-url`} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false}
          aria-label={kind === "video" ? "Video link" : "Music link"} placeholder={`Paste a link — ${EXAMPLES[kind].slice(0, 2).join(" or ")}`} />
        <Btn type="submit" variant="primary" data-testid={`${pfx}-play`}>Play</Btn>
        <Btn onClick={save} disabled={!lib || !url.trim()} data-testid={`${pfx}-save`} title="Add this link to the library (Streams.json)">Save</Btn>
      </form>
      {error ? <p className="fs-stream-err" role="alert" data-testid={`${pfx}-error`}>{error}</p> : null}

      <div className="fs-stream-main">
        <section className="fs-stream-stage" aria-label="Player" data-testid={`${pfx}-stage`} data-provider={ref?.provider ?? ""} data-loaded={loaded ? "1" : "0"}
          tabIndex={-1} aria-keyshortcuts="Space K J L ArrowLeft ArrowRight ArrowUp ArrowDown M Shift+N Shift+P < >">
          {!ref ? (
            <div className="fs-stream-empty">
              <strong>{kind === "video" ? "Play a video from YouTube, Vimeo, Dailymotion, Twitch, PeerTube, TIDAL or a file link" : "Stream from Spotify, SoundCloud, TIDAL, Qobuz or Amazon Music, or play an audio file link"}</strong>
              <span className="fs-dim">Examples: {EXAMPLES[kind].join(" · ")}</span>
            </div>
          ) : !loaded ? (
            <div className="fs-stream-facade" data-testid={`${pfx}-facade`} style={h ? { minHeight: Math.max(h, 180) } : undefined}>
              <Badge tone="info">{S.PROVIDER_LABEL[ref.provider]}{ref.sub ? ` · ${ref.sub}` : ""}</Badge>
              <strong className="fs-stream-facade-title">Load the {S.PROVIDER_LABEL[ref.provider]} player?</strong>
              <span className="fs-dim">This connects to <b>{ref.host}</b>, which sees your IP address and may set cookies. Nothing has been sent yet.
                {S.accessNote(ref) ? <span data-testid={`${pfx}-access-note`}>{" "}{S.accessNote(ref)}</span> : null}</span>
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
              ? <video key={ref.embed} ref={(el) => { mediaRef.current = el; }} className="fs-stream-video" src={ref.embed} controls playsInline data-testid={`${pfx}-media`} onPlay={(e) => { announce(); syncMedia(e.currentTarget); }} onEnded={() => { if (autoNext) next(); }} onTimeUpdate={(e) => syncMedia(e.currentTarget)} onDurationChange={(e) => syncMedia(e.currentTarget)} onVolumeChange={(e) => syncMedia(e.currentTarget)} onRateChange={(e) => syncMedia(e.currentTarget)} onPause={(e) => syncMedia(e.currentTarget)} onLoadedMetadata={(e) => syncMedia(e.currentTarget)} />
              : <audio key={ref.embed} ref={(el) => { mediaRef.current = el; }} className="fs-stream-audio" src={ref.embed} controls data-testid={`${pfx}-media`} onPlay={(e) => { announce(); syncMedia(e.currentTarget); }} onEnded={() => { if (autoNext) next(); }} onTimeUpdate={(e) => syncMedia(e.currentTarget)} onDurationChange={(e) => syncMedia(e.currentTarget)} onVolumeChange={(e) => syncMedia(e.currentTarget)} onRateChange={(e) => syncMedia(e.currentTarget)} onPause={(e) => syncMedia(e.currentTarget)} onLoadedMetadata={(e) => syncMedia(e.currentTarget)} />
          ) : (
            <iframe key={frame?.key ?? ref.embed} ref={frameRef} onLoad={onFrameLoad} className="fs-stream-frame" data-testid={`${pfx}-frame`} src={frame?.src ?? ref.embed}
              title={`${S.PROVIDER_LABEL[ref.provider]} player`} allow={S.iframeAllow(ref)} allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin" loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
              style={h ? { height: h, aspectRatio: "auto" } : undefined} />
          )}
          {ref ? (
            <div className="fs-stream-meta">
              <span className="fs-dim" data-testid={`${pfx}-now`}>{S.PROVIDER_LABEL[ref.provider]}{ref.start ? ` · from ${ref.start}s` : ""}</span>
              {loaded && ctl ? (
                <>
                  {ctl.oneWay ? (
                    <>
                      {/* TT33 TIDAL: the player does not report pauses, so our state can be stale — offer both */}
                      <Btn variant="ghost" data-testid={`${pfx}-ctl-play`} disabled={!ctl.connected} onClick={() => send({ op: "play" })}>Play</Btn>
                      <Btn variant="ghost" data-testid={`${pfx}-ctl-pause`} disabled={!ctl.connected} onClick={() => send({ op: "pause" })}>Pause</Btn>
                    </>
                  ) : (
                    <Btn variant="ghost" data-testid={`${pfx}-toggle`} disabled={!ctl.connected}
                      onClick={() => send(ctl.status === "playing" || ctl.status === "buffering" ? { op: "pause" } : { op: "play" })}>
                      {ctl.status === "playing" || ctl.status === "buffering" ? "Pause" : "Play"}
                    </Btn>
                  )}
                  <span className="fs-dim fs-stream-clock" role="status" data-testid={`${pfx}-clock`} data-status={ctl.status} data-assumed={ctl.assumed ? "1" : "0"} data-connected={ctl.connected ? "1" : "0"}
                    title={ctl.oneWay ? `${S.PROVIDER_LABEL[ref.provider]}'s player reports when playback starts, not pauses, progress or the end` : undefined}>
                    {ctl.connected ? statusText(ctl) : "Connecting to the player…"}
                  </span>
                </>
              ) : null}
              <span style={{ flex: 1 }} />
              <Btn variant="ghost" onClick={prev} disabled={!items.length} data-testid={`${pfx}-prev`} title="Previous in the library (Shift+P)">Previous</Btn>
              <Btn variant="ghost" onClick={next} disabled={!items.length} data-testid={`${pfx}-next`} title={ref.provider === "file" || ctl ? "Next in the library (Auto-next also moves on when this one ends)" : "Next in the library (this provider's player does not report when it ends, so Auto-next cannot follow it)"}>Next</Btn>
              <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} data-testid={`${pfx}-auto`} />Auto-next</label>
              <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} data-testid={`${pfx}-loop`} />Loop list</label>
              <label className="fs-row" style={{ gap: 6 }}><input type="checkbox" checked={shuffle} onChange={(e) => { setShuffle(e.target.checked); played.current = current?.itemId ? [current.itemId] : []; }} data-testid={`${pfx}-shuffle`} />Shuffle</label>
              <a className="fs-btn" data-variant="ghost" href={ref.page} target="_blank" rel="noopener noreferrer">Open on site</a>
            </div>
          ) : null}
          {ref && loaded && (native ? media : ctl?.connected) && (caps.seek || caps.volume || caps.rate || caps.playlist) ? (
            <div className="fs-stream-transport" role="group" aria-label="Playback controls" data-testid={`${pfx}-transport`}
              data-caps={(Object.keys(caps) as (keyof E.Caps)[]).filter((k) => caps[k]).join(" ")}>
              {caps.playlist ? <Btn variant="ghost" onClick={() => send({ op: "prev" })} data-testid={`${pfx}-pl-prev`} aria-label="Previous in this playlist">Prev track</Btn> : null}
              {caps.seek ? <Btn variant="ghost" onClick={() => t.seekTo(tp.time - 10)} data-testid={`${pfx}-back10`} aria-label="Back 10 seconds" title="Back 10 s (J)">−10 s</Btn> : null}
              {native ? <Btn variant="ghost" onClick={t.toggle} data-testid={`${pfx}-toggle`}>{tp.playing ? "Pause" : "Play"}</Btn> : null}
              {caps.seek ? <Btn variant="ghost" onClick={() => t.seekTo(tp.time + 10)} data-testid={`${pfx}-fwd10`} aria-label="Forward 10 seconds" title="Forward 10 s (L)">+10 s</Btn> : null}
              {caps.playlist ? <Btn variant="ghost" onClick={() => send({ op: "next" })} data-testid={`${pfx}-pl-next`} aria-label="Next in this playlist">Next track</Btn> : null}
              {caps.seek && tp.duration > 0 ? (
                <input type="range" className="fs-stream-seek" min={0} max={Math.max(1, Math.floor(tp.duration))} step={1} value={Math.min(Math.floor(tp.time), Math.floor(tp.duration))}
                  onChange={(e) => t.seekTo(Number(e.target.value))} data-testid={`${pfx}-seek`} aria-label="Seek" aria-valuetext={E.formatClock(tp.time, tp.duration)} />
              ) : null}
              {native ? <span className="fs-dim fs-stream-clock" data-testid={`${pfx}-native-clock`}>{E.formatClock(tp.time, tp.duration)}</span> : null}
              {caps.mute ? <Btn variant="ghost" onClick={t.mute} data-testid={`${pfx}-mute`} aria-pressed={!!tp.muted} title="Mute (M)">{tp.muted ? "Unmute" : "Mute"}</Btn> : null}
              {caps.volume ? (
                <input type="range" className="fs-stream-vol" min={0} max={100} step={5} value={tp.volume ?? 100} onChange={(e) => { const v = Number(e.target.value); t.volume(v); showOsd("volume", v <= 0 ? "Muted" : `Volume ${v}%`, v); }}
                  data-testid={`${pfx}-volume`} data-reported={tp.volume === undefined ? "0" : "1"} aria-label="Volume" aria-valuetext={tp.volume === undefined ? "not reported yet" : `${tp.volume} %`} />
              ) : null}
              {caps.rate ? (
                <label className="fs-row" style={{ gap: 4 }}><span className="fs-dim">Speed</span>
                  <select className="fs-input fs-stream-rate" value={String(tp.rate ?? 1)} onChange={(e) => t.rate(Number(e.target.value))} data-testid={`${pfx}-rate`} data-reported={tp.rate === undefined ? "0" : "1"}
                    title={ref.provider === "vimeo" ? "Vimeo applies speed only when the video's owner allows it; the value shown is what the player reports" : "Playback speed (< and >)"}>
                    {[...new Set([...tp.rates, tp.rate ?? 1])].sort((a, b) => a - b).map((r) => <option key={r} value={String(r)}>{r}×</option>)}
                  </select>
                </label>
              ) : null}
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
          {lib && providersOf(lib.items.filter((i) => i.kind === kind)).length > 1 ? (
            <><select className="fs-select" aria-label="Filter by provider" data-testid={`${pfx}-provider`} value={providerFacet} onChange={(e) => setProviderFacet(e.target.value)}>
              <option value="all">All providers</option>
              {providersOf(lib.items.filter((i) => i.kind === kind)).map((pr) => <option key={pr.provider} value={pr.provider}>{pr.provider} ({pr.count})</option>)}
            </select>
            <select className="fs-select" aria-label="Sort library" data-testid={`${pfx}-sort`} value={libSort} onChange={(e) => setLibSort(e.target.value as LibrarySort)}>
              <option value="added">Recently added</option><option value="title">Title A–Z</option><option value="provider">Provider</option>
            </select></>
          ) : null}
          {libErr ? <p className="fs-stream-err" role="alert">{libErr}</p> : null}
          <ul className="fs-stream-list" data-testid={`${pfx}-lib`}>
            {plays.length ? <li style={{ padding: "4px 8px" }} data-testid={`${pfx}-recents`}><span className="fs-dim" style={{ fontSize: fz(11), marginRight: 6 }}>Recent:</span>{plays.slice(0, 6).map((pl) => {
              const target = lib?.items.find((i) => i.id === pl.id);
              return <Btn key={pl.id} variant="ghost" disabled={!target} title={target ? `Play ${pl.title}` : "No longer in the library"} onClick={() => target && play(target.url, target.id)}>{pl.title}</Btn>;
            })}</li> : null}
            {lib && !items.length ? <li className="fs-dim" style={{ padding: 8 }}>{q ? "Nothing matches." : "Saved links appear here. Paste a link and press Save."}</li> : null}
            {items.map((it, i) => (
              <li key={it.id} data-testid={`${pfx}-item`} data-current={current?.itemId === it.id ? "1" : undefined}>
                <button type="button" className="fs-stream-item-play" onClick={() => { setUrl(it.url); play(it.url, it.id); }} data-testid={`${pfx}-item-play`} title={`Play ${it.title}`}>
                  <span className="fs-stream-item-title">{it.title}</span>
                  <span className="fs-dim fs-stream-item-sub">{S.PROVIDER_LABEL[it.provider]}</span>
                </button>
                <div className="fs-stream-item-tools">
                  <Btn variant="ghost" aria-label={`Rename ${it.title}`} title="Rename" data-testid={`${pfx}-item-rename`} onClick={async () => {
                    const t = await askText("Rename", it.title, { okLabel: "Rename" }); if (t !== null && lib) change(S.renameInLibrary(lib, it.id, t));
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
