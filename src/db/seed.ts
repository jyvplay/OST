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
import { ensureDir, getNode, writeFile } from "@/lib/server/vfs";

export const SEED_VERSION = "3.3.0";

export const allFeatures = [...shellFeatures, ...filesFeatures, ...appFeatures, ...tt15Features, ...platformFeatures]
  .map((f) => (UPDATES_V31[f.code] ? { ...f, ...UPDATES_V31[f.code] } : f))
  .map((f) => (UPDATES_TT15[f.code] ? { ...f, ...UPDATES_TT15[f.code] } : f));

const DEFAULT_SETTINGS: { key: string; value: string; category: string; label: string; aliases: string; lock?: string }[] = [
  { key: "appearance.theme", value: "dark", category: "appearance", label: "Theme", aliases: "dark mode,light mode,colors,personalization" },
  { key: "appearance.accent", value: "#5b8cff", category: "appearance", label: "Accent colour", aliases: "highlight,tint" },
  { key: "appearance.density", value: "balanced", category: "appearance", label: "Density profile", aliases: "scale,compact,touch,ui size" },
  { key: "appearance.motion", value: "system", category: "appearance", label: "Motion", aliases: "animation,reduce motion" },
  { key: "appearance.wallpaper", value: "aurora", category: "appearance", label: "Wallpaper", aliases: "background,desktop picture" },
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
