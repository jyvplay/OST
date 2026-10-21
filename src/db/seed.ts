import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { features, indexDocs, licenseAuthority, notes, settings, spikes } from "@/db/schema";
import { shellFeatures } from "./seed-data/features-shell";
import { filesFeatures } from "./seed-data/features-files";
import { appFeatures } from "./seed-data/features-apps";
import { platformFeatures } from "./seed-data/features-platform";
import { spikeRows } from "./seed-data/spikes";
import { UPDATES_V31 } from "./seed-data/updates-v31";
import { tt15Features, UPDATES_TT15 } from "./seed-data/features-tt15";
import { tt16Features, UPDATES_TT16 } from "./seed-data/features-tt16";
import { tt17Features, UPDATES_TT17 } from "./seed-data/features-tt17";
import { tt18Features, UPDATES_TT18 } from "./seed-data/features-tt18";
import { tt19Features, UPDATES_TT19 } from "./seed-data/features-tt19";
import { tt20Features } from "./seed-data/features-tt20";
import { tt21Features, UPDATES_TT21 } from "./seed-data/features-tt21";
import { tt22Features, UPDATES_TT22 } from "./seed-data/features-tt22";
import { tt23Features, UPDATES_TT23 } from "./seed-data/features-tt23";
import { tt24Features, UPDATES_TT24 } from "./seed-data/features-tt24";
import { tt25Features, UPDATES_TT25 } from "./seed-data/features-tt25";
import { tt26Features, UPDATES_TT26 } from "./seed-data/features-tt26";
import { tt27Features, UPDATES_TT27 } from "./seed-data/features-tt27";
import { tt28Features, UPDATES_TT28 } from "./seed-data/features-tt28";
import { tt29Features, UPDATES_TT29 } from "./seed-data/features-tt29";
import { tt30Features } from "./seed-data/features-tt30";
import { tt31Features } from "./seed-data/features-tt31";
import { tt32Features } from "./seed-data/features-tt32";
import { tt33Features } from "./seed-data/features-tt33";
import { tt34Features } from "./seed-data/features-tt34";
import { tt35Features, UPDATES_TT35 } from "./seed-data/features-tt35";
import { UPDATES_TT36 } from "./seed-data/features-tt36";
import { tt37Features, UPDATES_TT37 } from "./seed-data/features-tt37";
import { tt38Features } from "./seed-data/features-tt38";
import { tt39Features, patchTT39 } from "./seed-data/features-tt39";
import { tt40Features, patchTT40 } from "./seed-data/features-tt40";
import { tt41Features, patchTT41 } from "./seed-data/features-tt41";
import { tt42Features, patchTT42 } from "./seed-data/features-tt42";
import { tt43Features, patchTT43 } from "./seed-data/features-tt43";
import { patchTT44 } from "./seed-data/features-tt44";
import { patchTT45 } from "./seed-data/features-tt45";
import { UPDATES_TT47 } from "./seed-data/features-tt47";
import { UPDATES_TT48 } from "./seed-data/features-tt48";
import { patchTT49 } from "./seed-data/features-tt49";
import { patchTT50 } from "./seed-data/features-tt50";
import { patchTT51 } from "./seed-data/features-tt51";
import { patchTT52 } from "./seed-data/features-tt52";
import { patchTT53 } from "./seed-data/features-tt53";
import { patchTT54 } from "./seed-data/features-tt54";
import { patchTT55 } from "./seed-data/features-tt55";
import { patchTT56 } from "./seed-data/features-tt56";
import { ensureDir, getNode, writeFile } from "@/lib/server/vfs";

export const SEED_VERSION = "3.42.0";

export const allFeatures = [...shellFeatures, ...filesFeatures, ...appFeatures, ...tt15Features, ...tt16Features, ...tt17Features, ...tt18Features, ...tt19Features, ...tt20Features, ...tt21Features, ...tt22Features, ...tt23Features, ...tt24Features, ...tt25Features, ...tt26Features, ...tt27Features, ...tt28Features, ...tt29Features, ...tt30Features, ...tt31Features, ...tt32Features, ...tt33Features, ...tt34Features, ...tt35Features, ...tt37Features, ...tt38Features, ...tt39Features, ...tt40Features, ...tt41Features, ...tt42Features, ...tt43Features, ...platformFeatures]
  .map((f) => (UPDATES_V31[f.code] ? { ...f, ...UPDATES_V31[f.code] } : f))
  .map((f) => (UPDATES_TT15[f.code] ? { ...f, ...UPDATES_TT15[f.code] } : f))
  .map((f) => (UPDATES_TT16[f.code] ? { ...f, ...UPDATES_TT16[f.code] } : f))
  .map((f) => (UPDATES_TT17[f.code] ? { ...f, ...UPDATES_TT17[f.code] } : f))
  .map((f) => (UPDATES_TT18[f.code] ? { ...f, ...UPDATES_TT18[f.code] } : f))
  .map((f) => (UPDATES_TT19[f.code] ? { ...f, ...UPDATES_TT19[f.code] } : f))
  .map((f) => (UPDATES_TT21[f.code] ? { ...f, ...UPDATES_TT21[f.code] } : f))
  .map((f) => (UPDATES_TT22[f.code] ? { ...f, ...UPDATES_TT22[f.code] } : f))
  .map((f) => (UPDATES_TT23[f.code] ? { ...f, ...UPDATES_TT23[f.code] } : f))
  .map((f) => (UPDATES_TT24[f.code] ? { ...f, ...UPDATES_TT24[f.code] } : f))
  .map((f) => (UPDATES_TT25[f.code] ? { ...f, ...UPDATES_TT25[f.code] } : f))
  .map((f) => (UPDATES_TT26[f.code] ? { ...f, ...UPDATES_TT26[f.code] } : f))
  .map((f) => (UPDATES_TT27[f.code] ? { ...f, ...UPDATES_TT27[f.code] } : f))
  .map((f) => (UPDATES_TT28[f.code] ? { ...f, ...UPDATES_TT28[f.code] } : f))
  .map((f) => (UPDATES_TT29[f.code] ? { ...f, ...UPDATES_TT29[f.code] } : f))
  .map((f) => (UPDATES_TT35[f.code] ? { ...f, ...UPDATES_TT35[f.code] } : f))
  .map((f) => (UPDATES_TT36[f.code] ? { ...f, ...UPDATES_TT36[f.code] } : f))
  .map((f) => (UPDATES_TT37[f.code] ? { ...f, ...UPDATES_TT37[f.code] } : f))
  .map(patchTT39)
  .map(patchTT40)
  .map(patchTT41)
  .map(patchTT42)
  .map(patchTT43)
  .map(patchTT44)
  .map(patchTT45)
  .map((f) => (UPDATES_TT47[f.code] ? { ...f, ...UPDATES_TT47[f.code] } : f))
  .map((f) => (UPDATES_TT48[f.code] ? { ...f, ...UPDATES_TT48[f.code] } : f))
  .map(patchTT49)
  .map(patchTT50)
  .map(patchTT51)
  .map(patchTT52)
  .map(patchTT53)
  .map(patchTT54)
  .map(patchTT55)
  .map(patchTT56);

const DEFAULT_SETTINGS: { key: string; value: string; category: string; label: string; aliases: string; lock?: string }[] = [
  { key: "appearance.theme", value: "dark", category: "appearance", label: "Theme", aliases: "dark mode,light mode,colors,personalization" },
  { key: "appearance.accent", value: "auto", category: "appearance", label: "Accent colour", aliases: "highlight,tint" },
  { key: "appearance.style", value: "poolside", category: "appearance", label: "Style (colours, icons, logo)", aliases: "theme,palette,look,skin,miami,poolside,vice,neon,art deco,ocean drive,colours,enterprise,graphite,professional,office,corporate,silver,daylight,light,mac,windows 11" },
  { key: "appearance.layout", value: "fusion", category: "appearance", label: "Layout (Fusion, Business taskbar, Art dock)", aliases: "layout,taskbar,start menu,windows,dock,mac,macos,menu bar,business,art,desktop layout" },
  { key: "appearance.pairStyle", value: "on", category: "appearance", label: "Pair style with layout (Art → Silver, Business → Daylight, light theme)", aliases: "pair,match style,silver,daylight,layout style" },
  { key: "media.embeds", value: "ask", category: "media", label: "Embedded players (YouTube, Spotify, SoundCloud, TIDAL, Qobuz, Amazon Music…): ask before loading, or always load", aliases: "youtube,spotify,soundcloud,tidal,qobuz,amazon,embed,privacy,video,music,player" },
  { key: "maps.tiles", value: "off", category: "maps", label: "Map street tiles: off (offline world), OpenStreetMap, or custom", aliases: "map,tiles,openstreetmap,osm,offline map,street map" },
  { key: "maps.tileUrl", value: "", category: "maps", label: "Custom map tile URL template ({z}/{x}/{y})", aliases: "tile server,map provider" },
  { key: "appearance.dockSize", value: "auto", category: "appearance", label: "Dock icon size (Art layout): Auto picks a pleasing size", aliases: "dock size,icon size,dock icons,small,medium,large" },
  { key: "appearance.desktopView", value: "classic", category: "appearance", label: "Desktop view (Classic or Tabletop 3D)", aliases: "tabletop,3d,desktop view,piles,box,walls,micro peek" },
  { key: "appearance.dockMagnify", value: "on", category: "appearance", label: "Dock magnification (Art layout)", aliases: "dock,magnify,zoom icons,mac" },
  { key: "accessibility.narrator", value: "off", category: "accessibility", label: "Narrator: built-in screen reader that speaks what has focus", aliases: "screen reader,narrator,voiceover,speech,read aloud,blind" },
  { key: "accessibility.narratorRate", value: "1", category: "accessibility", label: "Narrator speaking speed", aliases: "speech rate,narrator speed" },
  { key: "accessibility.narratorCaptions", value: "on", category: "accessibility", label: "Show Narrator captions", aliases: "captions,narrator text" },
  { key: "accessibility.narratorSpeech", value: "on", category: "accessibility", label: "Narrator speaks aloud (off = captions only)", aliases: "speech,mute narrator" },
  { key: "accessibility.narratorVoice", value: "auto", category: "accessibility", label: "Narrator voice engine (auto = system voice if installed, else Fusion Voice)", aliases: "voice,tts,text to speech,fusion voice" },
  { key: "accessibility.fusionVoice", value: "standard", category: "accessibility", label: "Fusion Voice preset (standard, bright, high)", aliases: "voice pitch" },
  { key: "appearance.dockAutoHide", value: "off", category: "appearance", label: "Automatically hide and show the dock (Art layout)", aliases: "dock,auto hide,autohide,hide dock,mac" },
  { key: "appearance.density", value: "balanced", category: "appearance", label: "Density profile", aliases: "scale,compact,touch,ui size" },
  { key: "appearance.motion", value: "system", category: "appearance", label: "Motion", aliases: "animation,reduce motion" },
  { key: "appearance.wallpaper", value: "auto", category: "appearance", label: "Wallpaper", aliases: "background,desktop picture" },
  { key: "appearance.textScale", value: "125", category: "appearance", label: "Text size (%)", aliases: "font size,zoom,bigger text,large print,magnify,readability,accessibility" },
  { key: "shell.shelfEdge", value: "bottom", category: "shell", label: "Shelf edge", aliases: "taskbar,dock position" },
  { key: "shell.widgets", value: "clock,stickies,system", category: "shell", label: "Desktop widgets", aliases: "gadgets,sticky notes,desktop clock" },
  { key: "shell.hotCorners", value: "on", category: "shell", label: "Hot corners", aliases: "edge triggers" },
  { key: "shell.shortcutPreset", value: "hybrid", category: "input", label: "Shortcut preset", aliases: "keybindings,hotkeys,keyboard" },
  { key: "input.mouseBack", value: "3", category: "input", label: "Mouse back button index", aliases: "side button" },
  { key: "input.mouseForward", value: "4", category: "input", label: "Mouse forward button index", aliases: "side button" },
  { key: "input.linesPerNotch", value: "3", category: "input", label: "Scroll lines per notch", aliases: "wheel" },
  { key: "search.webResults", value: "off", category: "search", label: "Web results", aliases: "internet search", lock: "" },
  { key: "search.webProvider", value: "https://duckduckgo.com/?q=%s", category: "search", label: "Web search URL template (%s = query)", aliases: "search engine,provider" },
  { key: "search.excludes", value: "/System/Cache", category: "search", label: "Index exclusions", aliases: "private folders" },
  { key: "privacy.telemetry", value: "off", category: "privacy", label: "Telemetry", aliases: "analytics,usage data", lock: "No telemetry code exists in this build; the switch is informational." },
  { key: "privacy.clipboardHistory", value: "on", category: "privacy", label: "Clipboard history (in-app)", aliases: "copy paste" },
  { key: "perf.governor", value: "auto", category: "performance", label: "Load governor", aliases: "thermal,battery,throttle" },
  { key: "perf.effects", value: "auto", category: "performance", label: "Window effects", aliases: "blur,shadow" },
  { key: "beam.autoStopOnHide", value: "on", category: "beam", label: "Stop casting when hidden", aliases: "privacy,cast" },
  { key: "backup.autoVersion", value: "on", category: "backup", label: "Keep file versions", aliases: "timeline,history" },
  { key: "system.seedVersion", value: "", category: "system", label: "Seed version", aliases: "", lock: "Set by the installer." },
];

const SAMPLE_FILES: { path: string; body: string }[] = [
  {
    path: "/Documents/welcome.md",
    body: `# Fusion Shell Web\n\nThis is a real file in Postgres, reachable from Files, the Editor,\nthe terminal (\`cat /Documents/welcome.md\`) and search.\n\n- Every write is journaled (Files → Jobs).\n- Every overwrite snapshots a version (Editor → History).\n- Deleting moves to Trash with the original path recorded.\n`,
  },
  {
    path: "/Documents/capabilities.md",
    body: `# Capability honesty\n\nOpen **Settings → Capabilities** to see what this browser actually grants.\nEvery blocked feature in the Spec module names the exact missing primitive\n(raw sockets, mDNS, system virtual camera, FLAG_SECURE, ...).\n`,
  },
  {
    path: "/Documents/budget.csv",
    body: `item,qty,unit,notes\n"Monitor, 27\\" 120Hz",1,549.00,"quoted CSV, with a comma"\nKeyboard,1,99.50,low profile\nMouse,1,59.00,"5 buttons, side buttons mapped"\n`,
  },
  {
    path: "/Documents/sample.json",
    body: JSON.stringify({ shell: "fusion", host: ["tab", "pip", "screen"], windows: 0 }, null, 2),
  },
  {
    path: "/Pictures/logo.svg",
    body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#b14bff"/></linearGradient></defs><rect width="120" height="120" rx="26" fill="url(#g)"/><rect x="26" y="34" width="68" height="46" rx="6" fill="#0b1020"/><rect x="34" y="42" width="30" height="12" rx="3" fill="#5b8cff"/><rect x="34" y="60" width="52" height="8" rx="3" fill="#2b3a66"/></svg>`,
  },
  { path: "/System/Templates/note.md", body: "# Title\n\n- \n" },
  {
    path: "/Widgets/counter.worker.js",
    body: "let n = 0;\nonmessage = (e) => {\n  if (e.data.type !== \"tick\") return;\n  n += 1;\n  postMessage({ type: \"render\", seq: e.data.seq, tree: { text: String(n), sub: \"ticks (worker-isolated)\", color: \"#bcd4ff\" } });\n};\n",
  },
  {
    path: "/Widgets/hello.html",
    body: `<div style="font:12px system-ui;color:#cfe0ff;padding:6px">\n  <b>Sandboxed widget</b><br>\n  <span id="t"></span>\n</div>\n<script>setInterval(()=>{document.getElementById('t').textContent=new Date().toLocaleTimeString()},1000)</script>\n`,
  },
  {
    path: "/Documents/sample.ics",
    body: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:sample-standup@fusion\r\nSUMMARY:Stand-up\\, team A\r\nDESCRIPTION:Line one\\nLine two\r\nDTSTART:20300105T090000Z\r\nDTEND:20300105T091500Z\r\nEND:VEVENT\r\nBEGIN:VTODO\r\nUID:sample-todo@fusion\r\nSUMMARY:Review the spec register\r\nDUE;VALUE=DATE:20300106\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
  },
  { path: "/System/Templates/table.csv", body: "column_a,column_b\n,\n" },
];

export async function ensureSeeded(): Promise<{ seeded: boolean; features: number }> {
  const marker = await db.select().from(settings).where(sql`${settings.key} = 'system.seedVersion'`).limit(1);
  const already = marker[0]?.value === SEED_VERSION;
  const previous = marker[0]?.value ?? "";

  // Feature + spike registers are always reconciled: the running app must never
  // show a stale copy of its own specification.
  for (let i = 0; i < allFeatures.length; i++) {
    const f = allFeatures[i];
    await db.insert(features).values({ ...f, sort: i }).onConflictDoUpdate({
      target: features.code,
      set: { family: f.family, name: f.name, tier: f.tier, phase: f.phase, route: f.route,
             nuance: f.nuance, status: f.status, test: f.test, sort: i },
    });
  }
  for (const s of spikeRows) {
    await db.insert(spikes).values(s).onConflictDoUpdate({
      target: spikes.code,
      set: { question: s.question, pass: s.pass, fallback: s.fallback, status: s.status, result: s.result },
    });
  }
  for (const s of DEFAULT_SETTINGS) {
    await db.insert(settings).values({
      key: s.key, value: s.key === "system.seedVersion" ? SEED_VERSION : s.value,
      category: s.category, label: s.label, aliases: s.aliases, lockReason: s.lock ?? "",
    }).onConflictDoUpdate({
      target: settings.key,
      set: { category: s.category, label: s.label, aliases: s.aliases, lockReason: s.lock ?? "" },
    });
    await db.insert(indexDocs).values({
      source: "setting", ref: s.key, title: s.label, body: `${s.key} ${s.aliases}`,
    }).onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: s.label, body: `${s.key} ${s.aliases}` } });
  }

  // Licence authority: generated once, private key never leaves the server.
  const auth = await db.select().from(licenseAuthority).limit(1);
  if (auth.length === 0) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await db.insert(licenseAuthority).values({
      id: "default",
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }).onConflictDoNothing();
  }

  if (!already) {
    for (const d of ["/Documents", "/Pictures", "/Downloads", "/Projects", "/System/Templates", "/System/Cache", "/System/Recovery"]) {
      await ensureDir(d);
    }
    for (const f of SAMPLE_FILES) {
      // never overwrite: a seed-version bump must not clobber the user's edits
      if (await getNode(f.path)) continue;
      await writeFile({ path: f.path, content: f.body, reason: "seed" }).catch(() => undefined);
    }
    const stickies = await db.execute(sql`select count(*)::int as n from notes where tags like '%sticky%'`);
    if (Number((stickies.rows[0] as { n: number }).n) === 0) {
      await db.insert(notes).values({ title: "Sticky", body: "Tag any note 'sticky' and it appears on the desktop.", tags: "sticky" });
    }
    const existingNotes = await db.select({ n: sql<number>`count(*)` }).from(notes);
    if (Number(existingNotes[0]?.n ?? 0) === 0) {
      await db.insert(notes).values([
        { title: "Read me first", body: "Fusion Shell Web is the PWA conversion of the Fusion Shell Android specification.\nEverything the browser cannot do is marked blocked in the Spec module with the missing primitive named.", tags: "fusion,start", pinned: true },
        { title: "Keyboard", body: "Ctrl+Space palette · Ctrl+` switcher · Meta+Arrows tile · Meta+Shift+Arrows move · F2 rename in Files.", tags: "shortcuts" },
      ]);
    }
    await db.update(settings).set({ value: SEED_VERSION }).where(sql`${settings.key} = 'system.seedVersion'`);
  }


  // v3.3 migrations (guarded so user changes are never overwritten):
  //  - remove the "Hang me" button seeded in v3.1: the real-browser suite proved a
  //    hung sandboxed widget freezes the whole shell unless the browser runs full
  //    site isolation, so shipping that button on every desktop was a footgun.
  //  - user widgets become opt-in, but only if the setting still has the old default.
  const hello = await getNode("/Widgets/hello.html");
  if (hello && hello.content.includes("Hang me")) {
    await writeFile({ path: "/Widgets/hello.html", content: hello.content.replace(/<br>\s*<button onclick="while\(true\)\{\}"[^<]*<\/button>/, ""), reason: "migration-3.3" });
  }
  await db.update(settings).set({ value: "clock,stickies,system" })
    .where(sql`${settings.key} = 'shell.widgets' and ${settings.value} = 'clock,stickies,system,user'`);

  // v3.9 (TT21) migration: the cheerful 'sunrise' wallpaper becomes the default. Only when upgrading FROM a pre-3.9
  // version and only if the wallpaper is still the old default — a user who later picks aurora keeps it.
  if (previous && versionLess(previous, "3.9.0")) {
    await db.update(settings).set({ value: "sunrise" })
      .where(sql`${settings.key} = 'appearance.wallpaper' and ${settings.value} = 'aurora'`);
  }

  // v3.10 (TT22) migration, only when upgrading FROM a pre-3.10 version and only for values still at the old default:
  //  - text size 200 % (the TT21 default) → 125 %: large text becomes an opt-in "Large text mode" (user decision)
  //  - accent #5b8cff (old default) → "auto" (follow the style); wallpaper "sunrise" (TT21 default) → "auto"
  if (previous && versionLess(previous, "3.10.0")) {
    await db.update(settings).set({ value: "125" })
      .where(sql`${settings.key} = 'appearance.textScale' and ${settings.value} = '200'`);
    await db.update(settings).set({ value: "auto" })
      .where(sql`${settings.key} = 'appearance.accent' and lower(${settings.value}) = '#5b8cff'`);
    await db.update(settings).set({ value: "auto" })
      .where(sql`${settings.key} = 'appearance.wallpaper' and ${settings.value} = 'sunrise'`);
  }

  // notes are indexed every boot (cheap, keeps search truthful)
  const noteRows = await db.select().from(notes);
  for (const n of noteRows) {
    await db.insert(indexDocs).values({ source: "note", ref: String(n.id), title: n.title, body: n.body })
      .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: n.title, body: n.body } });
  }
  for (const f of allFeatures) {
    await db.insert(indexDocs).values({ source: "spec", ref: f.code, title: `${f.code} ${f.name}`, body: `${f.route} ${f.nuance}` })
      .onConflictDoUpdate({ target: [indexDocs.source, indexDocs.ref], set: { title: `${f.code} ${f.name}`, body: `${f.route} ${f.nuance}` } });
  }

  return { seeded: !already, features: allFeatures.length };
}

function versionLess(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d !== 0) return d < 0; }
  return false;
}
