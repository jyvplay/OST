/**
 * Suite "stream-unit" (TT27): the link grammar behind the Video and Music players, and their saved library.
 *   - every supported provider's link shapes map to the provider's official embed URL (and bad shapes are refused
 *     with a reason), start times, playlists, unlisted Vimeo hashes, Twitch parent=, PeerTube instances, direct files
 *   - SoundCloud widget parameters, player heights, the per-provider iframe allow list
 *   - library add / dedupe / move / rename / remove / filter / queue order, defensive normalisation, cap
 * Not covered here (needs the providers' servers, unreachable from this sandbox): that the embeds actually play.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/stream-unit.mts
 */
import { makeHarness } from "./harness.mts";
import * as S from "../src/lib/stream-core.ts";
import * as E from "../src/lib/embed-control-core.ts";

const { test, finish } = makeHarness("stream-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ref = (u: string, host?: string) => { const p = S.parseStream(u, host); if (!p.ok) throw new Error(`${u}: ${p.error}`); return p.ref; };
const bad = (u: string) => { const p = S.parseStream(u); ok(!p.ok, `${u} should be refused`); return (p as { error: string }).error; };

await test("YouTube: watch / youtu.be / shorts / live / embed / music links → youtube-nocookie embed; start times; playlists", { "SM-01": "partial" }, () => {
  const id = "dQw4w9WgXcQ";
  for (const u of [`https://www.youtube.com/watch?v=${id}`, `youtu.be/${id}`, `https://m.youtube.com/watch?v=${id}&feature=share`,
    `https://youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}?si=x`, `https://www.youtube.com/embed/${id}`, `https://music.youtube.com/watch?v=${id}`]) {
    const r = ref(u);
    ok(r.provider === "youtube" && r.kind === "video" && r.id === id, u);
    ok(r.embed.startsWith(`https://www.youtube-nocookie.com/embed/${id}?`) && r.host === "www.youtube-nocookie.com", `${u} embed ${r.embed}`);
  }
  ok(ref(`https://youtu.be/${id}?t=90`).start === 90, "t=90");
  ok(ref(`https://www.youtube.com/watch?v=${id}&t=1m30s`).embed.includes("start=90"), "t=1m30s");
  ok(ref(`https://www.youtube.com/watch?v=${id}&t=1h2m3s`).start === 3723, "1h2m3s");
  const pl = ref("https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG");
  ok(pl.sub === "playlist" && pl.embed === "https://www.youtube-nocookie.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", "playlist");
  ok(ref(`https://www.youtube.com/watch?v=${id}&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG`).embed.includes("list=PLx0"), "video in a list");
  ok(/video id/.test(bad("https://www.youtube.com/watch?v=short")), "short id refused");
  bad("https://www.youtube.com/@channel");
  ok(/https/.test(bad(`http://www.youtube.com/watch?v=${id}`)), "http refused (mixed content)");
});

await test("Vimeo, Dailymotion, Twitch (parent=host), PeerTube instances and direct media files", { "SM-01": "partial" }, () => {
  const v = ref("https://vimeo.com/76979871");
  ok(v.embed === "https://player.vimeo.com/video/76979871?dnt=1", v.embed);
  ok(ref("https://vimeo.com/76979871/abcdef1234").embed.includes("h=abcdef1234"), "unlisted hash");
  ok(ref("https://player.vimeo.com/video/76979871?h=99aa").embed.includes("h=99aa"), "player h=");
  ok(ref("https://www.dailymotion.com/video/x8abcd1_some-title").embed === "https://www.dailymotion.com/embed/video/x8abcd1", "dm");
  ok(ref("https://dai.ly/x8abcd1").id === "x8abcd1", "dai.ly");
  const t = ref("https://www.twitch.tv/videos/1234567890", "ost.example");
  ok(t.embed.includes("video=v1234567890") && t.embed.includes("parent=ost.example"), t.embed);
  ok(ref("https://twitch.tv/SomeChannel", "h").embed.includes("channel=somechannel"), "channel");
  ok(ref("https://clips.twitch.tv/FunnyClipSlug-abc", "h").sub === "clip", "clip");
  const pt = ref("https://framatube.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d".replace("/w/", "/videos/watch/"));
  ok(pt.provider === "peertube" && pt.embed === "https://framatube.org/videos/embed/9c9de5e8-0a1e-484a-b099-e80766180a6d", pt.embed);
  ok(ref("https://tube.example.org/w/kkGMgK9ZtnKfYAgnEtQxbv").host === "tube.example.org", "short uuid");
  const f = ref("https://cdn.example.com/clips/intro.webm");
  ok(f.provider === "file" && f.kind === "video" && f.embed === "https://cdn.example.com/clips/intro.webm", "video file");
  ok(ref("https://cdn.example.com/a/song.opus").kind === "audio", "audio file");
  ok(/not a supported player/.test(bad("https://example.com/page.html")), "unknown site");
  bad("not a link at all"); bad("javascript:alert(1)"); bad("");
});

await test("Spotify + SoundCloud: official embed URLs, URI form, intl paths, content types, widget params, heights, allow lists", { "SM-02": "partial" }, () => {
  const tid = "4cOdK2wGLETKBW3PvgPWqT";
  for (const u of [`https://open.spotify.com/track/${tid}`, `https://open.spotify.com/intl-de/track/${tid}?si=abc`, `spotify:track:${tid}`, `https://open.spotify.com/embed/track/${tid}`]) {
    const r = ref(u);
    ok(r.provider === "spotify" && r.kind === "audio" && r.sub === "track" && r.embed.startsWith(`https://open.spotify.com/embed/track/${tid}`), u);
  }
  for (const t of ["album", "playlist", "artist", "show", "episode"]) ok(ref(`https://open.spotify.com/${t}/${tid}`).sub === t, t);
  ok(S.playerHeight(ref(`spotify:track:${tid}`)) === 152 && S.playerHeight(ref(`https://open.spotify.com/album/${tid}`)) === 352, "spotify heights");
  ok(S.iframeAllow(ref(`spotify:track:${tid}`)).includes("encrypted-media"), "spotify allow");
  bad(`https://open.spotify.com/user/${tid}`); bad("https://open.spotify.com/track/tooShort");
  const sc = ref("https://soundcloud.com/forss/flickermood?si=123&utm_source=x");
  ok(sc.provider === "soundcloud" && sc.id === "https://soundcloud.com/forss/flickermood" && sc.sub === "track", "track permalink stripped of tracking");
  const q = new URL(sc.embed).searchParams;
  ok(new URL(sc.embed).origin === "https://w.soundcloud.com" && q.get("url") === "https://soundcloud.com/forss/flickermood" && q.get("auto_play") === "false" && q.get("visual") === "false", sc.embed);
  const set = ref("https://soundcloud.com/forss/sets/soulhack");
  ok(set.sub === "set" && S.playerHeight(set) === 450 && S.playerHeight(sc) === 166, "set");
  ok(new URL(S.soundcloudEmbed("https://soundcloud.com/a/b", "#ff5500")).searchParams.get("color") === "ff5500", "colour param without #");
  ok(/on\.soundcloud\.com/.test(bad("https://on.soundcloud.com/AbCdE")), "short links explained");
  bad("https://soundcloud.com/discover"); bad("https://soundcloud.com/onlyuser");
  ok(S.iframeAllow(sc) === "autoplay", "soundcloud allow is minimal");
});

await test("time parsing: seconds, h/m/s, clock forms, junk", { "SM-01": "partial" }, () => {
  ok(S.parseTime("90") === 90 && S.parseTime("90s") === 90 && S.parseTime("2m") === 120 && S.parseTime("1:02:03") === 3723 && S.parseTime("2:05") === 125, "forms");
  ok(S.parseTime("") === null && S.parseTime("abc") === null && S.parseTime("h") === null && S.parseTime(null) === null, "junk");
});

await test("library: add moves duplicates to the top, rename / move / remove / filter, queue order with loop, normalisation drops junk, cap", { "SM-03": "full" }, () => {
  let lib = S.emptyLibrary();
  const a = S.addToLibrary(lib, "https://youtu.be/dQw4w9WgXcQ", "", "2026-10-17T00:00:00Z", "a"); lib = a.lib;
  ok(a.item!.title === "YouTube dQw4w9WgXcQ", "default title");
  lib = S.addToLibrary(lib, "spotify:track:4cOdK2wGLETKBW3PvgPWqT", "Song", "t", "b").lib;
  lib = S.addToLibrary(lib, "https://soundcloud.com/forss/flickermood", "Flickermood", "t", "c").lib;
  ok(lib.items.map((i) => i.id).join() === "c,b,a", "newest first");
  const dup = S.addToLibrary(lib, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "Again", "t", "d");
  ok(dup.lib.items.length === 3 && dup.lib.items[0].id === "d" && dup.lib.items[0].title === "Again", "same player → moved, not duplicated");
  const badAdd = S.addToLibrary(lib, "https://example.com", "", "t", "z");
  ok(badAdd.error && badAdd.lib === lib, "bad link leaves the library untouched");
  lib = S.renameInLibrary(lib, "b", "  Renamed  ");
  ok(lib.items.find((i) => i.id === "b")!.title === "Renamed" && S.renameInLibrary(lib, "b", "   ").items.find((i) => i.id === "b")!.title === "Renamed", "rename trims, ignores blank");
  ok(S.moveInLibrary(lib, "a", -2).items[0].id === "a" && S.moveInLibrary(lib, "c", -1) === lib, "move + edge no-op");
  ok(S.filterLibrary(lib, "audio", "").length === 2 && S.filterLibrary(lib, "all", "spot").length === 1 && S.filterLibrary(lib, "video", "rick").length === 0, "filter");
  const q = S.filterLibrary(lib, "all", "");
  ok(S.nextIn(q, "c", false)!.id === "b" && S.nextIn(q, "a", false) === null && S.nextIn(q, "a", true)!.id === "c" && S.nextIn(q, null, false)!.id === "c" && S.nextIn([], "a", true) === null, "queue");
  ok(S.removeFromLibrary(lib, "b").items.length === 2, "remove");
  const norm = S.normalizeLibrary({ items: [null, { url: 5 }, { url: "https://example.com/x" }, { id: "k", url: "https://youtu.be/dQw4w9WgXcQ", title: "" }, { id: "k2", url: "https://youtube.com/watch?v=dQw4w9WgXcQ" }] });
  ok(norm.items.length === 1 && norm.items[0].id === "k" && norm.items[0].title.startsWith("YouTube"), "junk dropped, duplicate embed dropped");
  ok(S.normalizeLibrary("garbage").items.length === 0 && S.normalizeLibrary(null).v === 1, "garbage → empty");
  const many = { items: Array.from({ length: 600 }, (_, i) => ({ id: `i${i}`, url: `https://cdn.example.com/${i}.mp3` })) };
  ok(S.normalizeLibrary(many).items.length === S.LIBRARY_MAX, "cap");
});

await test("embed control protocol (TT28): YouTube handshake + infoDelivery/onStateChange → ended exactly once; Vimeo ready → subscriptions → ended/finish; SoundCloud ready → subscriptions → playProgress → finish; commands are the exact message strings", { "SM-04": "partial" }, () => {
  // YouTube
  ok(E.controllable("youtube") === "youtube" && E.controllable("spotify") === null && E.controllable("file") === null, "controllable set");
  const yu = new URL(E.controlUrl("youtube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0", "http://localhost:3999"));
  ok(yu.searchParams.get("enablejsapi") === "1" && yu.searchParams.get("origin") === "http://localhost:3999" && yu.searchParams.get("rel") === "0" && !yu.searchParams.has("autoplay"), `yt url ${yu}`);
  ok(new URL(E.controlUrl("youtube", "https://www.youtube-nocookie.com/embed/x", "javascript:alert(1)", true)).searchParams.get("origin") === null, "a non-http origin is never forwarded");
  ok(new URL(E.controlUrl("soundcloud", "https://w.soundcloud.com/player/?url=x&auto_play=false", "http://a", true)).searchParams.get("auto_play") === "true", "sc autoplay");
  ok(JSON.parse(E.handshake("youtube", "f1")[0]).event === "listening" && E.handshake("vimeo", "x").length === 0, "handshake");
  let y = E.initialState("youtube");
  let r = E.receive(y, JSON.stringify({ event: "initialDelivery", info: { playerState: 5, currentTime: 0, duration: 212.1 }, id: "f1", channel: "widget" }));
  ok(r.state.connected && r.state.status === "cued" && r.state.duration === 212.1 && r.events.some((e) => e.type === "ready"), "initialDelivery connects");
  y = r.state;
  y = E.receive(y, JSON.stringify({ event: "infoDelivery", info: { playerState: 1 } })).state;
  y = E.receive(y, JSON.stringify({ event: "infoDelivery", info: { currentTime: 211.9 } })).state;
  ok(y.status === "playing" && y.time === 211.9 && y.duration === 212.1, "partial infoDelivery keeps the other fields");
  r = E.receive(y, JSON.stringify({ event: "onStateChange", info: 0 }));
  ok(r.events.filter((e) => e.type === "ended").length === 1 && r.state.status === "ended" && r.state.ends === 1, "ended once");
  const r2 = E.receive(r.state, JSON.stringify({ event: "infoDelivery", info: { playerState: 0 } }));
  ok(r2.events.every((e) => e.type !== "ended") && r2.state.ends === 1, "a repeated ended state is not a second end");
  const r3 = E.receive(E.receive(r2.state, JSON.stringify({ event: "onStateChange", info: 1 })).state, JSON.stringify({ event: "onStateChange", info: 0 }));
  ok(r3.state.ends === 2, "play again → ends again");
  // garbage never throws and never changes state
  for (const g of [null, 5, "nope", "{", "[]", JSON.stringify({ event: "infoDelivery", info: { playerState: 42 } }), { event: "command" }, "x".repeat(300_000)]) {
    const q = E.receive(y, g);
    ok(q.events.length === 0 && q.state.status === y.status && q.send.length === 0, `garbage ${String(g).slice(0, 20)}`);
  }
  const cmd = JSON.parse(E.command("youtube", { op: "seek", seconds: -5 })!);
  ok(cmd.event === "command" && cmd.func === "seekTo" && cmd.args[0] === 0 && cmd.args[1] === true && cmd.channel === "widget", "seek clamps");
  ok(JSON.parse(E.command("youtube", { op: "load", id: "dQw4w9WgXcQ", start: 30 })!).args.join() === "dQw4w9WgXcQ,30" && E.command("youtube", { op: "load", id: "../evil" }) === null, "load validates the id");
  // Vimeo (string AND object messages)
  let v = E.initialState("vimeo");
  r = E.receive(v, { event: "ready", player_id: "x" });
  const subs = r.send.map((m) => JSON.parse(m));
  ok(r.state.connected && subs.every((m) => m.method === "addEventListener") && ["ended", "finish", "timeupdate"].every((e) => subs.some((m) => m.value === e)), "ready → subscriptions");
  ok(E.receive(r.state, { event: "ready" }).send.length === 0, "subscribes once");
  v = E.receive(r.state, JSON.stringify({ event: "timeupdate", data: { seconds: 10, duration: 60, percent: 0.16 } })).state;
  ok(v.status === "playing" && v.time === 10 && v.duration === 60, "timeupdate");
  ok(E.receive(v, JSON.stringify({ event: "ended", data: { seconds: 60, duration: 60 } })).events.some((e) => e.type === "ended"), "ended");
  ok(E.receive(v, { event: "finish" }).state.status === "ended", "legacy finish");
  ok(JSON.parse(E.command("vimeo", { op: "seek", seconds: 12 })!).method === "setCurrentTime" && E.command("vimeo", { op: "load", id: "1" }) === null, "vimeo commands");
  // SoundCloud
  let c = E.initialState("soundcloud");
  r = E.receive(c, JSON.stringify({ method: "ready", value: null }));
  ok(r.state.connected && r.send.map((m) => JSON.parse(m).value).sort().join() === "finish,pause,play,playProgress", `sc subs ${r.send}`);
  c = E.receive(r.state, JSON.stringify({ method: "playProgress", value: { currentPosition: 30_000, relativePosition: 0.25, loadedProgress: 1 } })).state;
  ok(c.status === "playing" && c.time === 30 && Math.abs(c.duration - 120) < 1e-9, "position + duration derived from the relative position");
  ok(E.receive(c, JSON.stringify({ method: "finish" })).events.some((e) => e.type === "ended"), "finish → ended");
  ok(JSON.parse(E.command("soundcloud", { op: "seek", seconds: 1.5 })!).value === 1500, "sc seek in ms");
  // origins: exact match only
  ok(E.originAllowed("youtube", "https://www.youtube-nocookie.com") && !E.originAllowed("youtube", "https://www.youtube-nocookie.com.evil.example") && !E.originAllowed("vimeo", "https://vimeo.com") && !E.originAllowed("soundcloud", "http://w.soundcloud.com"), "origins");
  ok(E.targetOrigin("youtube", "https://www.youtube-nocookie.com/embed/x") === "https://www.youtube-nocookie.com" && E.targetOrigin("youtube", "https://evil.example/embed") === null, "post target never *");
  ok(E.formatClock(65, 200) === "1:05 / 3:20" && E.formatClock(3725, 0) === "1:02:05" && E.formatClock(NaN, -1) === "0:00", "clock");
});

finish();
