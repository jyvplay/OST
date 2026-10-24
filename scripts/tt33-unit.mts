/**
 * Suite "tt33-unit" (TT33): TIDAL, Qobuz and Amazon Music in the Video / Music players, without a browser.
 *   - link grammar → each provider's official embed URL, using real ids where the provider published them (TIDAL's
 *     ids are the sample items in TIDAL's own embed-player test page; the Amazon embed code is a real Share → Embed
 *     snippet quoted on a public forum; the Qobuz widget shapes match the EmbedVideo MediaWiki extension's tests)
 *   - ≥ 15 refused shapes with a reason (artists, short links, bad ids, playlists without a widget, hostile snippets)
 *   - pasted <iframe> embed codes reduced to their src (only src is read), SoundCloud api.soundcloud.com widgets
 *   - player heights / allow lists / access notes (what the embed can and cannot do), library round-trip + dedupe
 *   - the TIDAL control protocol (parent side): pid, one-way state, exact command strings, start signal, foreign
 *     pids and junk ignored, "pause sent" is flagged as assumed, no seek / no end
 * Not covered here: that the providers' players load and play (their hosts are unreachable from this sandbox).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt33-unit.mts
 */
import { makeHarness } from "./harness.mts";
import * as S from "../src/lib/stream-core.ts";
import * as E from "../src/lib/embed-control-core.ts";

const { test, finish } = makeHarness("tt33-unit");
const eq = (a: unknown, b: unknown, msg = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ref = (u: string) => { const p = S.parseStream(u); if (!p.ok) throw new Error(`${u}: ${p.error}`); return p.ref; };
const bad = (u: string, re?: RegExp) => { const p = S.parseStream(u); ok(!p.ok, `${u} should be refused`); const e = (p as { error: string }).error; if (re) ok(re.test(e), `${u}: reason "${e}" !~ ${re}`); return e; };

// TIDAL's own embed-player test page sample ids (src/server/test-page/handler.js @0f4fb0f)
const T = { track: "1766030", album: "1550545", playlist: "b0d95b5e-7c4f-4dae-b042-b8c6228c2ba4", video: "71196108", mix: "00893bafbc41a9d6a7282dd3fb9849" };

await test("TIDAL link grammar (SM-05): tidal.com / browse / listen.tidal.com / album…track / embed.tidal.com → embed.tidal.com/<types>/<id>; kinds, heights, allow", { "SM-05": "partial" }, () => {
  const cases: [string, string, string, S.StreamKind][] = [
    [`https://tidal.com/track/${T.track}`, `tracks/${T.track}`, "track", "audio"],
    [`https://tidal.com/browse/track/${T.track}?u`, `tracks/${T.track}`, "track", "audio"],
    [`https://listen.tidal.com/album/${T.album}`, `albums/${T.album}`, "album", "audio"],
    [`https://tidal.com/browse/album/${T.album}/track/${T.track}`, `tracks/${T.track}`, "track", "audio"],
    [`https://tidal.com/browse/playlist/${T.playlist.toUpperCase()}`, `playlists/${T.playlist}`, "playlist", "audio"],
    [`https://tidal.com/video/${T.video}`, `videos/${T.video}`, "video", "video"],
    [`https://listen.tidal.com/mix/${T.mix}`, `mix/${T.mix}`, "mix", "audio"],
    [`https://embed.tidal.com/tracks/${T.track}`, `tracks/${T.track}`, "track", "audio"],
    [`https://embed.tidal.com/playlists/${T.playlist}?layout=gridify`, `playlists/${T.playlist}`, "playlist", "audio"],
    [`www.tidal.com/album/${T.album}`, `albums/${T.album}`, "album", "audio"],
  ];
  for (const [u, path, sub, kind] of cases) {
    const r = ref(u);
    eq([r.provider, r.embed, r.sub, r.kind, r.host], ["tidal", `https://embed.tidal.com/${path}`, sub, kind, "embed.tidal.com"], u);
    ok(r.page === `https://tidal.com/${sub}/${path.split("/")[1]}`, `${u} page ${r.page}`);
  }
  eq([S.playerHeight(ref(`tidal.com/track/${T.track}`)), S.playerHeight(ref(`tidal.com/album/${T.album}`)), S.playerHeight(ref(`tidal.com/mix/${T.mix}`)), S.playerHeight(ref(`tidal.com/video/${T.video}`))], [120, 275, 275, null], "TIDAL's default sizes");
  ok(S.iframeAllow(ref(`tidal.com/track/${T.track}`)).includes("encrypted-media"), "DRM playback needs encrypted-media");
  eq(S.PROVIDER_LABEL.tidal, "TIDAL");
});

await test("Qobuz link grammar (SM-06): widget / open / play / store pages → widget.qobuz.com with zone; track compact; heights", { "SM-06": "partial" }, () => {
  eq(ref("https://widget.qobuz.com/album/a1nkwok5snthb?zone=NL-nl").embed, "https://widget.qobuz.com/album/a1nkwok5snthb?zone=NL-nl");
  eq(ref("https://widget.qobuz.com/track/359452978?zone=NL-nl&display=compact").embed, "https://widget.qobuz.com/track/359452978?zone=NL-nl&display=compact");
  eq(ref("https://open.qobuz.com/album/0075597939187").embed, "https://widget.qobuz.com/album/0075597939187?zone=US-en", "default zone");
  eq(ref("https://play.qobuz.com/track/359452978").embed, "https://widget.qobuz.com/track/359452978?zone=US-en&display=compact");
  const store = ref("https://www.qobuz.com/fr-fr/album/embed-lux/v6lslmwybzkbb");
  eq([store.embed, store.page, store.sub], ["https://widget.qobuz.com/album/v6lslmwybzkbb?zone=FR-fr", "https://open.qobuz.com/album/v6lslmwybzkbb", "album"], "store page");
  eq([S.qobuzZone("us-en"), S.qobuzZone("GB-EN"), S.qobuzZone("english"), S.qobuzZone(null)], ["US-en", "GB-en", null, null]);
  eq([S.playerHeight(ref("open.qobuz.com/album/abc123")), S.playerHeight(ref("open.qobuz.com/track/123"))], [390, 100]);
  eq(ref("open.qobuz.com/album/abc123").host, "widget.qobuz.com");
});

await test("Amazon Music grammar (SM-07): Share → Embed code kept as issued (tracking params dropped); page links → embed shape flagged unverified; 12 storefronts", { "SM-07": "partial" }, () => {
  // a real Share → Embed snippet (quoted on community.mybb.com), with an affiliate tag added and HTML-escaped &
  const snippet = `<iframe id='AmazonMusicEmbedB001MTVGS8' src='https://music.amazon.co.uk/embed/B001MTVGS8/?id=FpAGPnGH0e&amp;tag=someone-21&amp;marketplaceId=A1F83G8C2ARO7P&amp;musicTerritory=GB' width='100%' height='550px' style='border:1px solid rgba(0, 0, 0, 0.12);max-width:'></iframe>`;
  const e = ref(snippet);
  eq([e.provider, e.embed, e.unverified ?? false, e.host], ["amazonmusic", "https://music.amazon.co.uk/embed/B001MTVGS8/?id=FpAGPnGH0e&marketplaceId=A1F83G8C2ARO7P&musicTerritory=GB", false, "music.amazon.co.uk"], "issued embed");
  const a = ref("https://music.amazon.com/albums/B076YSK8CS");
  eq([a.sub, a.embed, a.unverified], ["album", "https://music.amazon.com/embed/B076YSK8CS/?marketplaceId=ATVPDKIKX0DER&musicTerritory=US", true]);
  const t = ref("https://music.amazon.co.uk/albums/B076YSK8CS?trackAsin=B076YT2CBT&ref=dm_sh");
  eq([t.sub, t.id, t.page, t.embed], ["track", "B076YT2CBT", "https://music.amazon.co.uk/albums/B076YSK8CS?trackAsin=B076YT2CBT", "https://music.amazon.co.uk/embed/B076YT2CBT/?marketplaceId=A1F83G8C2ARO7P&musicTerritory=GB"]);
  eq(ref("https://music.amazon.de/playlists/B0822YKQNT").embed, "https://music.amazon.de/embed/B0822YKQNT/?marketplaceId=A1PA6795UKMFR9&musicTerritory=DE");
  eq(ref("https://music.amazon.co.jp/tracks/B076YT2CBT").embed.includes("A1VC38T7YXB528&musicTerritory=JP"), true);
  const up = ref("https://music.amazon.co.uk/embed/ae4b1c8ca72c4b54b2e45baed51168e7engb/?id=Qx1&marketplaceId=A1F83G8C2ARO7P&musicTerritory=GB");
  eq([up.sub, up.page], ["user playlist", "https://music.amazon.co.uk/user-playlists/ae4b1c8ca72c4b54b2e45baed51168e7engb"]);
  const ids = Object.values(S.AMAZON_MUSIC_STORES).map((x) => x[1]);
  eq([ids.length, new Set(ids).size, Object.values(S.AMAZON_MUSIC_STORES).every(([c]) => /^[A-Z]{2}$/.test(c))], [12, 12, true], "storefront table");
  eq(S.playerHeight(a), 550);
});

await test("≥ 15 refused shapes, each with a reason (negative space)", { "SM-05": "partial", "SM-06": "partial", "SM-07": "partial", "SM-08": "partial" }, () => {
  const shapes: [string, RegExp][] = [
    [`https://tidal.com/browse/artist/7804`, /artist/],
    [`https://link.tidal.com/AbCd1`, /redirect/],
    [`https://tidal.com/browse/playlist/not-a-uuid`, /UUID/],
    [`https://tidal.com/track/12ab`, /valid id/],
    [`https://tidal.com/mix/zz`, /mix/],
    [`https://tidal.com/browse/genre/pop`, /track, album, playlist, video or mix/],
    [`https://embed.tidal.com/upload/abc`, /track, album/],
    [`https://open.qobuz.com/playlist/1234`, /albums and tracks/],
    [`https://www.qobuz.com/us-en/interpreter/lux/123`, /albums and tracks/],
    [`https://open.qobuz.com/album/bad-id!`, /album id/],
    [`https://music.amazon.com/artists/B000QJPQTA/pharrell`, /artists/],
    [`https://music.amazon.co.uk/user-playlists/ae4b1c8ca72c4b54b2e45baed51168e7engb`, /Share → Embed/],
    [`https://music.amazon.com/albums/b076ysk8cs`, /ASIN/],
    [`https://music.amazon.com/podcasts/abc`, /podcasts/],
    [`https://music.amazon.com/embed/xyz/`, /embed address/],
    [`https://music.amazon.nl/albums/B076YSK8CS`, /not a supported player/],
    [`<iframe srcdoc="<script>alert(1)</script>"></iframe>`, /no src/],
    [`<iframe src="javascript:alert(1)"></iframe>`, /https/],
    [`<iframe src="http://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"></iframe>`, /https/],
    [`https://w.soundcloud.com/player/?url=https%3A//evil.example/tracks/1`, /url= parameter/],
  ];
  for (const [u, re] of shapes) bad(u, re);
  ok(shapes.length >= 15, "≥ 15 shapes");
});

await test("embed codes (SM-08): any provider's <iframe> snippet → its src only (data-src ignored, protocol-relative ok); SoundCloud api widget", { "SM-08": "partial" }, () => {
  eq(ref(`<iframe style="border-radius:12px" src="https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=generator" width="100%" height="152" allow="autoplay"></iframe>`).provider, "spotify");
  eq(ref(`<IFRAME data-src="https://evil.example/x.mp4" SRC='https://embed.tidal.com/tracks/${T.track}'>`).embed, `https://embed.tidal.com/tracks/${T.track}`, "data-src is not src");
  eq(ref(`<iframe src="//www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`).id, "dQw4w9WgXcQ", "protocol-relative");
  const sc = ref(`<iframe width="100%" height="166" scrolling="no" frameborder="no" allow="autoplay" src="https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&color=%23ff5500&auto_play=false"></iframe>`);
  eq([sc.provider, sc.sub, sc.id], ["soundcloud", "track", "https://api.soundcloud.com/tracks/293"]);
  ok(sc.embed.startsWith("https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293"), sc.embed);
  eq(ref(`https://w.soundcloud.com/player/?url=https%3A//soundcloud.com/artist/a-track`).id, "https://soundcloud.com/artist/a-track", "permalink widget → permalink");
  eq(ref(`https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/77`).sub, "set");
});

await test("access notes say what each embed can and cannot do; library round-trip and dedupe across link forms", { "SM-05": "partial", "SM-06": "partial", "SM-07": "partial" }, () => {
  ok(/30-second/.test(S.accessNote(ref(`tidal.com/track/${T.track}`))) && /sign/.test(S.accessNote(ref(`tidal.com/track/${T.track}`))), "TIDAL note");
  ok(/excerpts/.test(S.accessNote(ref("open.qobuz.com/album/abc"))), "Qobuz note");
  const amzPage = S.accessNote(ref("music.amazon.com/albums/B076YSK8CS")), amzCode = S.accessNote(ref("https://music.amazon.co.uk/embed/B001MTVGS8/?id=FpAGPnGH0e&marketplaceId=A1F83G8C2ARO7P&musicTerritory=GB"));
  ok(/30-second/.test(amzPage) && /Share → Embed/.test(amzPage) && !/Share → Embed/.test(amzCode), "Amazon: the unverified sentence only for built addresses");
  eq(S.accessNote(ref("https://youtu.be/dQw4w9WgXcQ")), "", "no note where there is nothing to say");
  let lib = S.emptyLibrary();
  lib = S.addToLibrary(lib, `https://tidal.com/browse/track/${T.track}`, "", "t", "a").lib;
  lib = S.addToLibrary(lib, "https://open.qobuz.com/album/abc123", "", "t", "b").lib;
  lib = S.addToLibrary(lib, "https://music.amazon.com/albums/B076YSK8CS", "", "t", "c").lib;
  lib = S.addToLibrary(lib, `https://listen.tidal.com/track/${T.track}`, "Same track", "t", "d").lib; // same embed → moves to top
  eq(lib.items.map((i) => [i.id, i.provider]), [["d", "tidal"], ["c", "amazonmusic"], ["b", "qobuz"]], "dedupe by embed");
  eq(S.normalizeLibrary(JSON.parse(JSON.stringify(lib))).items.length, 3, "round-trip");
  eq(S.filterLibrary(lib, "audio", "qobuz").map((i) => i.id), ["b"], "filter by provider label");
  eq(S.filterLibrary(lib, "audio", "amazon music").map((i) => i.id), ["c"]);
});

await test("TIDAL control protocol, parent side (SM-05): pid in src, one-way state, exact {commandName} strings, start signal, foreign pid/junk ignored, pause flagged as assumed, no seek/end", { "SM-05": "partial" }, () => {
  eq(E.controllable("tidal"), "tidal");
  eq([E.controllable("qobuz"), E.controllable("amazonmusic")], [null, null], "no known control protocol → not controllable");
  const pid = E.tidalPid("w1-3");
  eq(pid, "fusion-w1-3");
  eq(E.tidalPid("a b/c?d"), "fusion-abcd", "pid is URL-safe");
  eq(E.controlUrl("tidal", `https://embed.tidal.com/tracks/${T.track}`, "https://x.test", false, pid), `https://embed.tidal.com/tracks/${T.track}?pid=fusion-w1-3`);
  eq([E.originAllowed("tidal", "https://embed.tidal.com"), E.originAllowed("tidal", "https://tidal.com"), E.originAllowed("tidal", "https://embed.tidal.com.evil.example")], [true, false, false]);
  eq(E.targetOrigin("tidal", "https://embed.tidal.com/tracks/1?pid=x"), "https://embed.tidal.com");
  let s = E.initialState("tidal", false, pid);
  eq([s.oneWay, s.noSeek, s.connected, s.status, E.handshake("tidal", "x").length], [true, true, false, "loading", 0]);
  let fl = E.frameLoaded(s);
  eq([fl.state.connected, fl.state.status, fl.send], [true, "ready", []], "usable once loaded");
  eq(E.frameLoaded(fl.state).state, fl.state, "idempotent");
  const auto = E.frameLoaded(E.initialState("tidal", true, pid));
  eq(auto.send, ['{"commandName":"play"}'], "queued autoplay is a play command");
  eq(auto.state.wantPlay, false);
  s = fl.state;
  // the embed's bridge accepts a JSON string or an object; it answers a start with a JSON string
  eq([E.command("tidal", { op: "play" }), E.command("tidal", { op: "pause" }), E.command("tidal", { op: "seek", seconds: 3 })], ['{"commandName":"play"}', '{"commandName":"pause"}', null]);
  let r = E.receive(s, JSON.stringify({ activatePlayerId: pid }));
  eq([r.state.status, r.events.map((e) => e.type)], ["playing", ["status"]], "start signal");
  const playing = r.state;
  eq(E.receive(s, { activatePlayerId: pid }).state.status, "playing", "object form too");
  eq(E.receive(s, JSON.stringify({ activatePlayerId: "fusion-other" })).state, s, "another embed's start is not ours");
  for (const junk of [null, 7, "{", "[]", [], { commandName: "play" }, { type: "ended" }, { activatePlayerId: 5 }, { newEmbed: true }, { currentTime: 30, duration: 30, paused: true, type: "ended" }]) {
    const j = E.receive(playing, junk);
    ok(j.state.status === "playing" && j.events.length === 0, `junk ${JSON.stringify(junk)} ignored`);
  }
  const size = E.receive(E.initialState("tidal", false, pid), JSON.stringify({ height: 120, width: 500, newEmbed: true, pid }));
  eq([size.state.connected, size.state.status], [true, "ready"], "size report = proof of life");
  const paused = E.afterCommand(playing, { op: "pause" });
  eq([paused.status, paused.assumed], ["paused", true], "pause is only a request");
  eq(E.afterCommand(paused, { op: "pause" }), paused, "no double change");
  eq(E.afterCommand(playing, { op: "play" }), playing, "play waits for the player's own start");
  r = E.receive(paused, JSON.stringify({ activatePlayerId: pid }));
  eq([r.state.status, r.state.assumed], ["playing", false], "a real start clears the assumption");
  eq(r.state.ends, 0, "TIDAL never ends (no end signal exists)");
  const yt = { ...E.initialState("youtube"), connected: true, status: "playing" as const };
  eq(E.afterCommand(yt, { op: "pause" }), yt, "two-way players are not assumed");
});

finish();
