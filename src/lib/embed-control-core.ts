/**
 * TT28 SM-04: two-way control of the providers' official embed players over window.postMessage — written from the
 * protocol messages themselves, without loading any provider SDK script (no iframe_api.js / player.js / api.js).
 *
 * Why: an <iframe> embed is a black box. Without this the app cannot know when a video or track ENDS, so the queue
 * could not advance on its own and the shell could not play / pause / show progress. Each provider's player already
 * speaks a small JSON protocol over postMessage (it is how their own SDKs work); this module implements the parent
 * side of it, pure and hook-free so it is unit-tested without a browser.
 *
 * Protocols (as published / observed — see docs/DESIGN-TT28.md for the sources):
 *   YouTube    src needs enablejsapi=1 (+ origin=<our origin>). Parent → player: JSON string
 *              {"event":"listening","id":<id>,"channel":"widget"} (handshake, repeated until the player answers),
 *              {"event":"command","func":"playVideo"|"pauseVideo"|"seekTo"|"loadVideoById","args":[…],"id","channel"}.
 *              Player → parent: {"event":"initialDelivery"|"infoDelivery","info":{playerState,currentTime,duration,…}}
 *              (infoDelivery = changed fields only), {"event":"onReady"}, {"event":"onStateChange","info":<state>}.
 *              playerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued.
 *   Vimeo      Player → parent: {"event":"ready"} first; parent → player {"method":"addEventListener","value":<ev>} for
 *              each event wanted, then events arrive as {"event":"ended"|"play"|"pause"|"timeupdate"|…,"data":{…}}.
 *              Older players name them finish / playProgress. Commands: {"method":"play"|"pause"|"setCurrentTime",value}.
 *              Messages may arrive as JSON strings or as objects.
 *   SoundCloud Widget → parent: JSON string {"method":"ready"|"play"|"pause"|"finish"|"playProgress"|…,"value":…};
 *              parent → widget: JSON string {"method":"addEventListener","value":<ev>} after ready, and commands
 *              {"method":"play"|"pause"|"seekTo","value":ms}. playProgress.value = {currentPosition (ms), relativePosition}.
 *
 *   Spotify    (TT29) Embed → parent: OBJECT messages {type:"ready"} first, then {type:"playback_update",
 *              payload:{position (ms), duration (ms), isPaused, isBuffering, playingURI}} roughly every second, and
 *              {type:"error",payload}. The embed's own controller accepts a message only when event.source is the iframe.
 *              Parent → embed: OBJECT {command:"toggle"} toggles play/pause — confirmed by two independent public
 *              sources (Stack Overflow q/71979852 and a Spotify Community thread). The controller also acknowledges
 *              "ready"; that command's string is NOT publicly confirmed, so it is sent best-effort (unknown commands are
 *              ignored by the embed) and nothing depends on it. Play / pause are derived from toggle + the last known
 *              isPaused; there is no seek (its message string is unconfirmed). Spotify emits no "ended" event: an end
 *              is inferred from the stream (paused within 0.5 s of the end, or paused after the position fell back from
 *              the last second) — see spotifyEnded().
 *
 *   TIDAL      (TT33) Read from TIDAL's own embed-player source (Apache-2.0, github.com/tidal-music/embed-player @0f4fb0f,
 *              src/client/js/message-bridge.js + app.js), not guessed. Parent → embed: a JSON string (or object)
 *              {commandName:"play"|"pause"} — the embed clicks its own play button when it is not / is PLAYING.
 *              Embed → parent: JSON string {activatePlayerId:<pid>} whenever playback STARTS (its "pause the other
 *              embeds" signal; pid is the ?pid= we put in the src), and size messages {height,width,newEmbed,pid}.
 *              Its broadcastMediaStatus (currentTime / duration / paused / ended) exists in the source but is never
 *              called, so the embed does NOT report pauses, progress or ends: our side knows "started" for certain
 *              and "pause sent" only as a request (status "paused" with `assumed`). No seek, no volume, no end →
 *              Auto-next cannot follow a TIDAL item. The embed speaks only when playback starts, so controls are
 *              enabled once the frame has loaded (`oneWay`), not after a handshake.
 *
 * Security: a message is only accepted when its origin is exactly the provider's player origin AND (checked by the
 * caller) event.source is our own iframe's window. Unknown shapes are ignored, never thrown.
 */

export type Ctl = "youtube" | "vimeo" | "soundcloud" | "spotify" | "tidal";
/** A message to post: YouTube / Vimeo / SoundCloud take JSON strings; Spotify's embed reads plain objects. */
export type Msg = string | Record<string, unknown>;
/** Spotify embed commands. TOGGLE is publicly confirmed; ACK is best-effort (see header). */
export const SPOTIFY_TOGGLE = { command: "toggle" } as const;
export const SPOTIFY_ACK_UNCONFIRMED = { command: "load_complete_ack" } as const;
export type Status = "loading" | "ready" | "playing" | "paused" | "buffering" | "ended" | "cued";

export interface CtlState {
  ctl: Ctl;
  /** the player has answered at least once (handshake complete) */
  connected: boolean;
  status: Status;
  /** seconds */
  time: number;
  /** seconds (0 = unknown) */
  duration: number;
  /** events already subscribed (Vimeo / SoundCloud) */
  subscribed: boolean;
  /** how many 'ended' transitions have been seen (an ended→ended repeat is not a new end) */
  ends: number;
  /** start playing as soon as the player is ready (auto-next into a provider that has no autoplay URL flag) */
  wantPlay?: boolean;
  /** this provider cannot seek through our controls */
  noSeek?: boolean;
  /** TT33 TIDAL: the player never speaks first and never confirms a pause — controls work from frame load */
  oneWay?: boolean;
  /** TT33: our player id inside the provider's messages (TIDAL ?pid=) */
  pid?: string;
  /** TT33: the status is what we last ASKED for (TIDAL pause), not something the player reported */
  assumed?: boolean;
  /** TT34 SM-09: volume 0–100 / muted / playback rate AS REPORTED BY THE PLAYER (undefined = never reported) */
  volume?: number;
  muted?: boolean;
  rate?: number;
  /** YouTube: the rates this video offers (info.availablePlaybackRates) */
  rates?: number[];
  /** YouTube playlist: number of entries and our index; SoundCloud playlist: number of sounds (from getSounds) */
  playlistSize?: number;
  playlistIndex?: number;
}

/**
 * TT34 SM-09: what our transport may drive on each provider (documented message APIs only):
 *   YouTube   seekTo, setVolume 0–100, mute/unMute, setPlaybackRate, nextVideo/previousVideo   (IFrame API)
 *   Vimeo     setCurrentTime, setVolume 0–1, setMuted, setPlaybackRate (only if the creator allows speed:
 *             the rate shown changes only when the player confirms with playbackratechange)   (player.js)
 *   SoundCloud seekTo ms, next, prev — NOT volume: the widget docs say 0–100 while public reports say 0–1, and we
 *             will not ship a guess                                                            (HTML5 widget API)
 *   Spotify   toggle only;  TIDAL  play / pause only  (see the header)
 */
export interface Caps { seek: boolean; volume: boolean; mute: boolean; rate: boolean; playlist: boolean }
export function capabilities(s: CtlState | null): Caps {
  const none = { seek: false, volume: false, mute: false, rate: false, playlist: false };
  if (!s || !s.connected) return none;
  if (s.ctl === "youtube") return { seek: true, volume: true, mute: true, rate: true, playlist: (s.playlistSize ?? 0) > 1 };
  if (s.ctl === "vimeo") return { seek: true, volume: true, mute: true, rate: true, playlist: false };
  if (s.ctl === "soundcloud") return { seek: true, volume: false, mute: false, rate: false, playlist: (s.playlistSize ?? 0) > 1 };
  return none;
}
export const DEFAULT_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export type CtlEvent = { type: "ready" } | { type: "status"; status: Status } | { type: "progress"; time: number; duration: number } | { type: "ended" } | { type: "settings" };

/** Exact player origins we accept messages from (and post to). */
export const PLAYER_ORIGINS: Record<Ctl, readonly string[]> = {
  youtube: ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
  vimeo: ["https://player.vimeo.com"],
  soundcloud: ["https://w.soundcloud.com"],
  spotify: ["https://open.spotify.com"],
  tidal: ["https://embed.tidal.com"],
};

export const initialState = (ctl: Ctl, autoplay = false, pid?: string): CtlState => ({ ctl, connected: false, status: "loading", time: 0, duration: 0, subscribed: false, ends: 0,
  ...(ctl === "spotify" ? { noSeek: true, wantPlay: autoplay } : {}),
  ...(ctl === "tidal" ? { noSeek: true, oneWay: true, wantPlay: autoplay, pid: pid ?? "fusion" } : {}) });

/** TIDAL's pid: what we put in ?pid= and expect back in activatePlayerId (short, URL-safe). */
export const tidalPid = (key: number | string) => `fusion-${String(key).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}`;

/**
 * TT33: the frame finished loading. A one-way player (TIDAL) cannot confirm anything before playback, so this is the
 * moment its controls become usable; returns the messages to send (a queued autoplay request).
 */
export function frameLoaded(s: CtlState): { state: CtlState; send: Msg[] } {
  if (!s.oneWay || s.connected) return { state: s, send: [] };
  const st: CtlState = { ...s, connected: true, status: s.status === "loading" ? "ready" : s.status };
  const send: Msg[] = [];
  if (st.wantPlay) { st.wantPlay = false; send.push(JSON.stringify({ commandName: "play" })); }
  return { state: st, send };
}

/**
 * TT33: record a command we just sent to a one-way player. Pause is never confirmed by TIDAL, so the state shows
 * "paused" flagged `assumed`; play is left to the player's own start signal (activatePlayerId).
 */
export function afterCommand(s: CtlState, c: Command): CtlState {
  if (!s.oneWay) return s;
  if (c.op === "pause" && (s.status === "playing" || s.status === "buffering")) return { ...s, status: "paused", assumed: true };
  return s;
}

/** Which providers this module can control (Dailymotion / Twitch / PeerTube: not implemented). */
export function controllable(provider: string): Ctl | null {
  return provider === "youtube" || provider === "vimeo" || provider === "soundcloud" || provider === "spotify" || provider === "tidal" ? provider : null;
}

/**
 * Spotify sends no "ended": infer it from two consecutive playback updates (seconds). An end is
 *   (a) paused with the position within 0.5 s of the duration, or
 *   (b) paused after the position fell back from within the last 1 s (the embed rewinds to 0 at the end).
 * A user pause earlier than that is a pause; playlists that roll on to the next track never pause, so never "end".
 */
export function spotifyEnded(prevTime: number, time: number, duration: number, paused: boolean): boolean {
  if (!paused || !(duration > 0)) return false;
  return time >= duration - 0.5 || (prevTime >= duration - 1 && time < prevTime);
}

export function originAllowed(ctl: Ctl, origin: string): boolean {
  return PLAYER_ORIGINS[ctl].includes(origin);
}

/** The origin to post to for an embed src (must equal the iframe's actual origin, never "*"). */
export function targetOrigin(ctl: Ctl, embed: string): string | null {
  let o: string;
  try { o = new URL(embed).origin; } catch { return null; }
  return PLAYER_ORIGINS[ctl].includes(o) ? o : null;
}

/**
 * The embed URL with what the protocol needs. YouTube: enablejsapi=1 and origin=<parent origin> (the player only
 * answers pages whose origin matches). `autoplay` asks the player to start (the browser may still refuse, e.g. no
 * user activation — reported as status, never assumed).
 */
export function controlUrl(ctl: Ctl, embed: string, parentOrigin: string, autoplay = false, pid?: string): string {
  let u: URL;
  try { u = new URL(embed); } catch { return embed; }
  if (ctl === "youtube") {
    u.searchParams.set("enablejsapi", "1");
    if (/^https?:\/\/[^/]+$/.test(parentOrigin)) u.searchParams.set("origin", parentOrigin);
    if (autoplay) u.searchParams.set("autoplay", "1");
  } else if (ctl === "vimeo") {
    if (autoplay) u.searchParams.set("autoplay", "1");
  } else if (ctl === "soundcloud") {
    u.searchParams.set("auto_play", autoplay ? "true" : "false");
  } else if (ctl === "tidal") {
    // the embed echoes ?pid= in activatePlayerId — how we know a start came from THIS player
    u.searchParams.set("pid", pid ?? "fusion");
  }
  return u.toString();
}

/** Messages to send right after the iframe loads (and again on a retry tick until `connected`). */
export function handshake(ctl: Ctl, id: string): Msg[] {
  if (ctl === "youtube") return [JSON.stringify({ event: "listening", id, channel: "widget" })];
  return []; // Vimeo, SoundCloud and Spotify speak first ("ready")
}

const VIMEO_EVENTS = ["ended", "finish", "play", "pause", "timeupdate", "playProgress", "volumechange", "playbackratechange"] as const;
const SC_EVENTS = ["finish", "play", "pause", "playProgress"] as const;

function parse(data: unknown): Record<string, unknown> | null {
  if (typeof data === "string") {
    if (data.length > 200_000) return null;
    try { const v = JSON.parse(data); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
  }
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const YT_STATE: Record<number, Status> = { [-1]: "ready", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued" };

/**
 * Feed one incoming message (already origin- and source-checked by the caller). Returns the next state, any messages
 * to send back (subscriptions), and the semantic events it produced. Total: garbage in → same state, nothing out.
 */
export function receive(s: CtlState, data: unknown): { state: CtlState; send: Msg[]; events: CtlEvent[] } {
  const m = parse(data);
  const out = { state: s, send: [] as Msg[], events: [] as CtlEvent[] };
  if (!m) return out;
  let st = { ...s };
  const ev: CtlEvent[] = [];
  const send: Msg[] = [];
  const setStatus = (next: Status) => {
    if (next === st.status) return;
    if (next === "ended") { st.ends += 1; ev.push({ type: "ended" }); }
    st.status = next;
    ev.push({ type: "status", status: next });
  };
  const connect = () => { if (!st.connected) { st.connected = true; ev.push({ type: "ready" }); if (st.status === "loading") st.status = "ready"; } };
  const progress = (t: number | null, d: number | null) => {
    if (t === null && d === null) return;
    if (t !== null) st.time = Math.max(0, t);
    if (d !== null && d > 0) st.duration = d;
    ev.push({ type: "progress", time: st.time, duration: st.duration });
  };

  if (s.ctl === "youtube") {
    const e = m.event;
    if (e === "onReady") connect();
    else if (e === "initialDelivery" || e === "infoDelivery") {
      connect();
      const info = (m.info && typeof m.info === "object" ? m.info : {}) as Record<string, unknown>;
      const ps = num(info.playerState);
      if (ps !== null && YT_STATE[ps]) setStatus(YT_STATE[ps]);
      progress(num(info.currentTime), num(info.duration));
      // TT34: volume / mute / speed / playlist position, whenever the player includes them
      const vol = num(info.volume), rt = num(info.playbackRate);
      let touched = false;
      if (vol !== null && vol >= 0 && vol <= 100) { st.volume = vol; touched = true; }
      if (typeof info.muted === "boolean") { st.muted = info.muted; touched = true; }
      if (rt !== null && rt > 0 && rt <= 16) { st.rate = rt; touched = true; }
      if (Array.isArray(info.availablePlaybackRates)) {
        const rs = info.availablePlaybackRates.filter((x): x is number => typeof x === "number" && x > 0 && x <= 16).slice(0, 16);
        if (rs.length) { st.rates = rs; touched = true; }
      }
      if (Array.isArray(info.playlist)) { st.playlistSize = info.playlist.length; touched = true; }
      else if (info.playlist === null) { st.playlistSize = 0; touched = true; }
      const pi = num(info.playlistIndex);
      if (pi !== null && pi >= 0) { st.playlistIndex = pi; touched = true; }
      if (touched) ev.push({ type: "settings" });
    } else if (e === "onStateChange") {
      connect();
      const ps = num(m.info);
      if (ps !== null && YT_STATE[ps]) setStatus(YT_STATE[ps]);
    } else return out;
  } else if (s.ctl === "vimeo") {
    const e = typeof m.event === "string" ? m.event : typeof m.method === "string" ? m.method : null;
    if (!e) return out;
    const data2 = (m.data && typeof m.data === "object" ? m.data : {}) as Record<string, unknown>;
    if (e === "ready") {
      connect();
      if (!st.subscribed) { st.subscribed = true; for (const v of VIMEO_EVENTS) send.push(JSON.stringify({ method: "addEventListener", value: v })); }
    } else if (e === "ended" || e === "finish") { connect(); progress(num(data2.duration) ?? num(data2.seconds), num(data2.duration)); setStatus("ended"); }
    else if (e === "play" || e === "playing") { connect(); setStatus("playing"); }
    else if (e === "pause") { connect(); setStatus("paused"); }
    else if (e === "timeupdate" || e === "playProgress") { connect(); progress(num(data2.seconds), num(data2.duration)); if (st.status !== "playing" && st.status !== "paused") setStatus("playing"); }
    else if (e === "volumechange") {
      connect();
      const v = num(data2.volume);
      if (v !== null && v >= 0 && v <= 1) st.volume = Math.round(v * 100);
      if (typeof data2.muted === "boolean") st.muted = data2.muted;
      ev.push({ type: "settings" });
    } else if (e === "playbackratechange") {
      connect();
      const r = num(data2.playbackRate);
      if (r !== null && r > 0 && r <= 16) { st.rate = r; ev.push({ type: "settings" }); }
    } else return out;
  } else if (s.ctl === "tidal") {
    if (typeof m.activatePlayerId === "string") {
      // a start of ANOTHER TIDAL embed is not ours (the bridge broadcasts to its parent; pids tell them apart)
      if (s.pid && m.activatePlayerId !== s.pid) return out;
      connect();
      st.assumed = false;
      setStatus("playing");
    } else if (m.newEmbed === true && typeof m.height === "number") {
      connect(); // size report: proof of life only
      if (!ev.length) return { state: st, send, events: [] };
    } else return out;
  } else if (s.ctl === "spotify") {
    const t = m.type;
    if (t === "ready") {
      connect();
      if (!st.subscribed) {
        st.subscribed = true;
        send.push({ ...SPOTIFY_ACK_UNCONFIRMED });
        if (st.wantPlay) { st.wantPlay = false; send.push({ ...SPOTIFY_TOGGLE }); }
      }
    } else if (t === "playback_update") {
      connect();
      const p = (m.payload && typeof m.payload === "object" ? m.payload : {}) as Record<string, unknown>;
      const pos = num(p.position), dur = num(p.duration);
      if (pos === null && dur === null && typeof p.isPaused !== "boolean") return out;
      const prev = st.time;
      progress(pos !== null ? pos / 1000 : null, dur !== null ? dur / 1000 : null);
      const paused = p.isPaused === true, buffering = p.isBuffering === true;
      if (buffering && !paused) setStatus("buffering");
      else if (!paused) setStatus("playing");
      else if (st.status === "ended") { /* the rewound, paused player after an end stays "ended" */ }
      else setStatus(spotifyEnded(prev, st.time, st.duration, true) ? "ended" : "paused");
    } else if (t === "error") { connect(); }
    else return out;
  } else {
    const e = typeof m.method === "string" ? m.method : null;
    if (!e) return out;
    const v = m.value as Record<string, unknown> | undefined;
    if (e === "ready") {
      connect();
      if (!st.subscribed) {
        st.subscribed = true;
        for (const x of SC_EVENTS) send.push(JSON.stringify({ method: "addEventListener", value: x }));
        send.push(JSON.stringify({ method: "getSounds" })); // a set (playlist) answers with its sounds → next / prev
      }
    } else if (e === "getSounds") {
      connect();
      if (Array.isArray(m.value)) { st.playlistSize = m.value.length; ev.push({ type: "settings" }); }
    } else if (e === "finish") { connect(); setStatus("ended"); }
    else if (e === "play") { connect(); setStatus("playing"); }
    else if (e === "pause") { connect(); setStatus("paused"); }
    else if (e === "playProgress") {
      connect();
      const pos = num(v?.currentPosition), rel = num(v?.relativePosition);
      const t = pos !== null ? pos / 1000 : null;
      const d = t !== null && rel !== null && rel > 0.001 ? t / rel : null;
      progress(t, d);
      if (st.status !== "playing") setStatus("playing");
    } else return out;
  }
  // a fresh play after an end re-arms 'ended' (the same track can end again)
  if (st === s) st = { ...s };
  return { state: st, send, events: ev };
}

export type Command = { op: "play" } | { op: "pause" } | { op: "seek"; seconds: number } | { op: "load"; id: string; start?: number }
  | { op: "volume"; value: number } | { op: "mute"; on: boolean } | { op: "rate"; value: number } | { op: "next" } | { op: "prev" };
const clampVol = (v: number) => Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)));

/**
 * One command as the exact message for the provider. `load` (same player, new item) only exists for YouTube. Spotify
 * has only a confirmed toggle: play / pause send it unless `state` shows the player is already in that state.
 */
export function command(ctl: Ctl, c: Command, id = "fusion", state?: CtlState | null): Msg | null {
  if (ctl === "tidal") {
    // the embed ignores play while PLAYING and pause while not, so both are always safe to send (our state may be stale)
    if (c.op === "play") return JSON.stringify({ commandName: "play" });
    if (c.op === "pause") return JSON.stringify({ commandName: "pause" });
    return null;
  }
  if (ctl === "spotify") {
    const active = state?.status === "playing" || state?.status === "buffering";
    if (c.op === "play") return state && active ? null : { ...SPOTIFY_TOGGLE };
    if (c.op === "pause") return state && !active ? null : { ...SPOTIFY_TOGGLE };
    return null;
  }
  if (ctl === "youtube") {
    const call = (func: string, args: unknown[] = []) => JSON.stringify({ event: "command", func, args, id, channel: "widget" });
    if (c.op === "play") return call("playVideo");
    if (c.op === "pause") return call("pauseVideo");
    if (c.op === "seek") return call("seekTo", [Math.max(0, c.seconds), true]);
    if (c.op === "load") return /^[A-Za-z0-9_-]{11}$/.test(c.id) ? call("loadVideoById", [c.id, Math.max(0, c.start ?? 0)]) : null;
    if (c.op === "volume") return call("setVolume", [clampVol(c.value)]);
    if (c.op === "mute") return call(c.on ? "mute" : "unMute");
    if (c.op === "rate") return c.value > 0 && c.value <= 16 ? call("setPlaybackRate", [c.value]) : null;
    if (c.op === "next") return call("nextVideo");
    if (c.op === "prev") return call("previousVideo");
    return null;
  }
  if (ctl === "vimeo") {
    if (c.op === "play") return JSON.stringify({ method: "play" });
    if (c.op === "pause") return JSON.stringify({ method: "pause" });
    if (c.op === "seek") return JSON.stringify({ method: "setCurrentTime", value: Math.max(0, c.seconds) });
    if (c.op === "volume") return JSON.stringify({ method: "setVolume", value: clampVol(c.value) / 100 }); // 0–1
    if (c.op === "mute") return JSON.stringify({ method: "setMuted", value: c.on });
    if (c.op === "rate") return c.value > 0 && c.value <= 2 ? JSON.stringify({ method: "setPlaybackRate", value: c.value }) : null; // player.js: 0–2
    return null;
  }
  if (c.op === "play") return JSON.stringify({ method: "play" });
  if (c.op === "pause") return JSON.stringify({ method: "pause" });
  if (c.op === "seek") return JSON.stringify({ method: "seekTo", value: Math.round(Math.max(0, c.seconds) * 1000) });
  if (c.op === "next") return JSON.stringify({ method: "next" });
  if (c.op === "prev") return JSON.stringify({ method: "prev" });
  return null; // SoundCloud volume / mute / rate: deliberately not sent (see capabilities)
}

/* ---------------------------------------------------------------- TT34 SM-10 keyboard */

export type KeyAction = { op: "toggle" } | { op: "skip"; seconds: number } | { op: "volume"; delta: number } | { op: "mute" }
  | { op: "rate"; dir: 1 | -1 } | { op: "libNext" } | { op: "libPrev" } | { op: "seekFraction"; f: number };
export interface KeyInput { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; tag?: string; type?: string; editable?: boolean }
const TEXT_TYPES = new Set(["text", "search", "url", "email", "password", "number", "tel", ""]);
/**
 * Media keys while focus is in the player (YouTube-style): Space/K play·pause, J/L ±10 s, ←/→ ±5 s, ↑/↓ volume ±5,
 * M mute, Shift+N / Shift+P next / previous in the library, < / > slower / faster, 0–9 jump to 0–90 %.
 * Nothing fires while typing (text inputs, textareas, selects, contenteditable) or with Ctrl/⌘/Alt held; on a range
 * slider the arrow keys and digits stay the slider's own.
 */
export function keyAction(k: KeyInput): KeyAction | null {
  if (k.ctrlKey || k.metaKey || k.altKey) return null;
  const tag = (k.tag ?? "").toLowerCase(), type = (k.type ?? "").toLowerCase();
  if (k.editable || tag === "textarea" || tag === "select" || (tag === "input" && TEXT_TYPES.has(type))) return null;
  const onSlider = tag === "input" && type === "range";
  const onButton = tag === "button" || (tag === "input" && (type === "checkbox" || type === "radio")) || tag === "a" || tag === "summary";
  const key = k.key;
  if (key === " " || key === "Spacebar") return onButton || onSlider ? null : { op: "toggle" }; // Space activates the focused button
  if (key === "k" || key === "K") return { op: "toggle" };
  if (key === "j" || key === "J") return { op: "skip", seconds: -10 };
  if (key === "l" || key === "L") return { op: "skip", seconds: 10 };
  if (key === "m" || key === "M") return { op: "mute" };
  if (key === "N" && k.shiftKey) return { op: "libNext" };
  if (key === "P" && k.shiftKey) return { op: "libPrev" };
  if (key === ">" || (key === "." && k.shiftKey)) return { op: "rate", dir: 1 };
  if (key === "<" || (key === "," && k.shiftKey)) return { op: "rate", dir: -1 };
  if (onSlider) return null;
  if (key === "ArrowLeft") return { op: "skip", seconds: -5 };
  if (key === "ArrowRight") return { op: "skip", seconds: 5 };
  if (key === "ArrowUp") return { op: "volume", delta: 5 };
  if (key === "ArrowDown") return { op: "volume", delta: -5 };
  if (/^[0-9]$/.test(key) && !k.shiftKey) return { op: "seekFraction", f: Number(key) / 10 };
  return null;
}
/** the next rate up / down from the list (current rate snapped to the nearest entry) */
export function stepRate(rates: readonly number[], current: number, dir: 1 | -1): number {
  const rs = [...rates].sort((a, b) => a - b);
  if (!rs.length) return current;
  let i = 0;
  for (let k = 1; k < rs.length; k++) if (Math.abs(rs[k] - current) < Math.abs(rs[i] - current)) i = k;
  return rs[Math.max(0, Math.min(rs.length - 1, i + dir))];
}

/** "1:05 / 3:20" (h:mm:ss over an hour); unknown duration → just the time. */
export function formatClock(time: number, duration: number): string {
  const f = (x: number) => {
    const t = Math.max(0, Math.floor(Number.isFinite(x) ? x : 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  return duration > 0 ? `${f(time)} / ${f(duration)}` : f(time);
}
