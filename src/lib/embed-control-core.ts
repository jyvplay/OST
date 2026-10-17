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
 * Security: a message is only accepted when its origin is exactly the provider's player origin AND (checked by the
 * caller) event.source is our own iframe's window. Unknown shapes are ignored, never thrown.
 */

export type Ctl = "youtube" | "vimeo" | "soundcloud";
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
}

export type CtlEvent = { type: "ready" } | { type: "status"; status: Status } | { type: "progress"; time: number; duration: number } | { type: "ended" };

/** Exact player origins we accept messages from (and post to). */
export const PLAYER_ORIGINS: Record<Ctl, readonly string[]> = {
  youtube: ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
  vimeo: ["https://player.vimeo.com"],
  soundcloud: ["https://w.soundcloud.com"],
};

export const initialState = (ctl: Ctl): CtlState => ({ ctl, connected: false, status: "loading", time: 0, duration: 0, subscribed: false, ends: 0 });

/** Which providers this module can control. Spotify's embed has no published postMessage protocol → none. */
export function controllable(provider: string): Ctl | null {
  return provider === "youtube" || provider === "vimeo" || provider === "soundcloud" ? provider : null;
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
export function controlUrl(ctl: Ctl, embed: string, parentOrigin: string, autoplay = false): string {
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
  }
  return u.toString();
}

/** Messages to send right after the iframe loads (and again on a retry tick until `connected`). */
export function handshake(ctl: Ctl, id: string): string[] {
  if (ctl === "youtube") return [JSON.stringify({ event: "listening", id, channel: "widget" })];
  return []; // Vimeo and SoundCloud speak first ("ready")
}

const VIMEO_EVENTS = ["ended", "finish", "play", "pause", "timeupdate", "playProgress"] as const;
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
export function receive(s: CtlState, data: unknown): { state: CtlState; send: string[]; events: CtlEvent[] } {
  const m = parse(data);
  const out = { state: s, send: [] as string[], events: [] as CtlEvent[] };
  if (!m) return out;
  let st = { ...s };
  const ev: CtlEvent[] = [];
  const send: string[] = [];
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
    else return out;
  } else {
    const e = typeof m.method === "string" ? m.method : null;
    if (!e) return out;
    const v = m.value as Record<string, unknown> | undefined;
    if (e === "ready") {
      connect();
      if (!st.subscribed) { st.subscribed = true; for (const x of SC_EVENTS) send.push(JSON.stringify({ method: "addEventListener", value: x })); }
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

export type Command = { op: "play" } | { op: "pause" } | { op: "seek"; seconds: number } | { op: "load"; id: string; start?: number };

/** One command as the exact message string for the provider. `load` (same player, new item) only exists for YouTube. */
export function command(ctl: Ctl, c: Command, id = "fusion"): string | null {
  if (ctl === "youtube") {
    const call = (func: string, args: unknown[] = []) => JSON.stringify({ event: "command", func, args, id, channel: "widget" });
    if (c.op === "play") return call("playVideo");
    if (c.op === "pause") return call("pauseVideo");
    if (c.op === "seek") return call("seekTo", [Math.max(0, c.seconds), true]);
    if (c.op === "load") return /^[A-Za-z0-9_-]{11}$/.test(c.id) ? call("loadVideoById", [c.id, Math.max(0, c.start ?? 0)]) : null;
    return null;
  }
  if (ctl === "vimeo") {
    if (c.op === "play") return JSON.stringify({ method: "play" });
    if (c.op === "pause") return JSON.stringify({ method: "pause" });
    if (c.op === "seek") return JSON.stringify({ method: "setCurrentTime", value: Math.max(0, c.seconds) });
    return null;
  }
  if (c.op === "play") return JSON.stringify({ method: "play" });
  if (c.op === "pause") return JSON.stringify({ method: "pause" });
  if (c.op === "seek") return JSON.stringify({ method: "seekTo", value: Math.round(Math.max(0, c.seconds) * 1000) });
  return null;
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
