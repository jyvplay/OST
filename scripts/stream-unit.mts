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

finish();
