/**
 * Suite "a11y-unit" (TT21): accessibility facts that can be checked without a browser.
 *   - icon glyph contrast vs the tile gradient (WCAG 1.4.11, ≥3:1) for every palette
 *   - every module and the common file types map to a real glyph; no emoji left in shell chrome
 *   - text-scale maths + "no raw px font sizes left" (the 2× default can only hold if every size goes through fz())
 *   - token text contrast (WCAG 1.4.3, ≥4.5:1) incl. desktop labels over the brightest wallpaper spot
 *   - settings value validation (bad text sizes / wallpapers refused)
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/a11y-unit.mts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { PALETTES, MODULE_ICONS, GLYPH_NAMES, fileIconSpec, INK, WHITE } from "../src/lib/icon-data.ts";
import { MODULES } from "../src/lib/registry.ts";
import { clampTextScale, stepTextScale, DEFAULT_TEXT_SCALE, LARGE_TEXT_SCALE, isLargeText, TEXT_SCALE_STEPS } from "../src/lib/uiscale-core.ts";
import { STYLES, STYLE_IDS, DEFAULT_STYLE, styleCss, resolveWallpaper, isStyle } from "../src/lib/style-core.ts";
import { autoInk } from "../src/lib/auto-ink.ts";
import { validateSetting } from "../src/lib/settings-validate.ts";
import { WALLPAPERS, DEFAULT_WALLPAPER } from "../src/lib/appearance.ts";

const { test, finish } = makeHarness("a11y-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: RGB, b: RGB) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t) as RGB;
const over = (fg: RGB, alpha: number, bg: RGB): RGB => mix(bg, fg, alpha);

await test("icon contrast: every palette's glyph colour is ≥3:1 against its tile gradient across the whole glyph area (WCAG 1.4.11)", { "AX-10": "full" }, () => {
  const worst: string[] = [];
  for (const [name, p] of Object.entries(PALETTES)) {
    // the tile spans y 1..46 of the 48 box; glyphs live in y 10..38 (below the highlight band, which ends at y≈11)
    for (let y = 11; y <= 38; y++) {
      const bg = mix(hex(p.top), hex(p.bottom), (y - 1) / 45);
      const r = ratio(hex(p.fg), bg);
      if (r < 3) worst.push(`${name}@y${y}=${r.toFixed(2)}`);
    }
  }
  ok(worst.length === 0, `below 3:1: ${worst.slice(0, 8).join(", ")}`);
  // negative control: the TT21 first draft (white on #4fb3ff) fails, so the check can fail
  ok(ratio(hex(WHITE), mix(hex("#4fb3ff"), hex("#1f6fe5"), 0.22)) < 3, "negative control should fail");
  ok(ratio(hex(INK), hex(WHITE)) > 15, "ink is near-black");
});

await test("every registered module and every common file type has a real glyph; tile palettes exist", { "AX-10": "partial" }, () => {
  const missing = MODULES.filter((m) => !MODULE_ICONS[m.id]).map((m) => m.id);
  ok(missing.length === 0, `modules without an icon: ${missing.join(", ")}`);
  for (const [id, [pal, glyph]] of Object.entries(MODULE_ICONS)) {
    ok(pal in PALETTES, `${id}: palette ${pal}`);
    ok((GLYPH_NAMES as readonly string[]).includes(glyph), `${id}: glyph ${glyph}`);
  }
  const files = ["a.xlsx", "b.docx", "c.pptx", "d.png", "e.svg", "f.md", "g.json", "h.mp3", "i.mp4", "j.ics", "k.zip", "l.pdf", "noext", "m.fvault"];
  for (const f of files) { const [pal, g] = fileIconSpec(f); ok(pal in PALETTES && (GLYPH_NAMES as readonly string[]).includes(g), f); }
  ok(fileIconSpec("x", "dir")[1] === "folder", "folders");
  ok(fileIconSpec("weird.qqq")[1] === "blank", "unknown ext falls back to blank");
});

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const tsx = walk("src/components").filter((f) => f.endsWith(".tsx"));

await test("no emoji glyphs left in the shell chrome (they render blank without a colour-emoji font)", { "AX-10": "partial" }, () => {
  const chrome = ["TopBar", "Shelf", "WindowFrame", "Palette", "QuickPanel", "DesktopSurface", "Overview", "ui", "DisplaySettings"].map((n) => `src/components/${n}.tsx`);
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{25A0}-\u{25FF}\u{29C9}]/u;
  const hits: string[] = [];
  for (const f of chrome) readFileSync(f, "utf8").split("\n").forEach((l, i) => { if (emoji.test(l) && !l.trim().startsWith("//") && !l.includes("* ")) hits.push(`${f}:${i + 1}`); });
  ok(hits.length === 0, `emoji in chrome: ${hits.join(", ")}`);
  const shell = readFileSync("src/components/Shell.tsx", "utf8");
  ok(!/\{m\.icon\}/.test(shell) && !/\{mod\?\.icon/.test(readFileSync("src/components/WindowFrame.tsx", "utf8")), "launcher/titlebar no longer print registry emoji");
});

await test("text-scale maths: default 125 %, Large text mode 200 %, clamps, steps; every inline font size goes through fz()", { "AX-09": "partial" }, () => {
  ok(DEFAULT_TEXT_SCALE === 125, "default is 125 % (TT22: large text is an option, not the default)");
  ok(LARGE_TEXT_SCALE === 200 && isLargeText(200) && isLargeText(250) && !isLargeText(175) && !isLargeText(DEFAULT_TEXT_SCALE), "Large text mode = ≥200 %");
  ok(clampTextScale("abc") === 125 && clampTextScale(20) === 100 && clampTextScale(999) === 300 && clampTextScale("149.6") === 150, "clamp");
  ok(stepTextScale(200, 1) === 250 && stepTextScale(200, -1) === 175 && stepTextScale(300, 1) === 300 && stepTextScale(100, -1) === 100 && stepTextScale(160, 1) === 175, "steps");
  ok(TEXT_SCALE_STEPS.includes(200 as never), "200 is a step");
  // raw numeric fontSize in a style object = text that ignores the setting. Allowed: document-model data (Vector text shape).
  const raw: string[] = [];
  let smallest = Infinity;
  for (const f of tsx) {
    readFileSync(f, "utf8").split("\n").forEach((l, i) => {
      for (const m of l.matchAll(/fontSize: fz\(([\d.]+)\)/g)) smallest = Math.min(smallest, Number(m[1]));
      if (/fontSize: \d/.test(l) && !l.includes('kind: "text"')) raw.push(`${f}:${i + 1}`);
    });
  }
  ok(raw.length === 0, `raw px font sizes: ${raw.slice(0, 10).join(", ")}`);
  const px = smallest * DEFAULT_TEXT_SCALE / 100, pxLarge = smallest * LARGE_TEXT_SCALE / 100;
  // WCAG sets no minimum px size; house rule: nothing under 12px at the default, nothing under 16px in Large text mode
  ok(px >= 12, `smallest UI text at the default scale is ${px}px (want ≥12)`);
  ok(pxLarge >= 16, `smallest UI text in Large text mode is ${pxLarge}px (want ≥16)`);
  ok(13 * DEFAULT_TEXT_SCALE / 100 >= 16, "body text (fz 13) is ≥16px at the default");
  console.log(`    smallest inline size fz(${smallest}) → ${px}px at 125 %, ${pxLarge}px in Large text mode (16px browser default)`);
  const css = readFileSync("src/app/globals.css", "utf8");
  ok(/--fs-ts:\s*1\.25;/.test(css) && /--fs-u:\s*calc\(var\(--fs-ts\) \* 1rem \/ 16\)/.test(css), "CSS unit is rem-based (browser font preference multiplies in)");
  ok(/forced-colors: active/.test(css) && /prefers-contrast: more/.test(css), "AX-03 media queries exist");
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  ok(!/maximumScale|userScalable/.test(layout.replace(/\/\/.*$/gm, "")), "viewport does not block pinch-zoom");
});

await test("token text contrast ≥4.5:1 (WCAG 1.4.3): body, muted, badges, desktop labels over the brightest wallpaper spot", { "AX-09": "partial", "AX-08": "partial" }, () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const tok = (n: string) => hex(new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, "i").exec(css)![1]);
  const panel = tok("fs-panel-solid"), bg = tok("fs-bg");
  const pairs: [string, RGB, RGB][] = [
    ["text/panel", tok("fs-text"), panel], ["muted/panel", tok("fs-muted"), panel], ["muted/bg", tok("fs-muted"), bg],
    ["ok badge", hex("#8df0c0"), over(hex("#39d98a"), 0.12, panel)], ["warn badge", hex("#ffd98a"), over(hex("#ffc453"), 0.12, panel)],
    // label pill rgba(10,19,48,.78) over the sun core of the sunrise wallpaper (#ffd65a), white bold text
    ["desk label on sun", hex("#ffffff"), over(hex("#0a1330"), 0.78, hex("#ffd65a"))],
    // titlebar bubble glyphs (ink on yellow/green/red bubbles)
    ["min bubble", hex(INK), hex("#ffd34d")], ["max bubble", hex(INK), hex("#5ee39b")], ["close bubble", hex(INK), hex("#ff7a7a")],
    // top-bar launcher pill: ink on the sun gradient's darker end
    ["launcher pill", hex(INK), hex("#ffb020")],
  ];
  const bad = pairs.map(([n, a, b]) => [n, ratio(a, b)] as const).filter(([, r]) => r < 4.5);
  ok(bad.length === 0, bad.map(([n, r]) => `${n} ${r.toFixed(2)}`).join(", "));
});

await test("settings validation: text size must be an integer 100–300, wallpaper/theme/density from their lists, accent a hex colour", { "AX-09": "partial" }, () => {
  for (const v of ["100", "200", "300", "175"]) ok(validateSetting("appearance.textScale", v) === null, v);
  for (const v of ["99", "301", "", "abc", "150.5", "1e2", "-200", " 200"]) ok(validateSetting("appearance.textScale", v) !== null, `should refuse ${JSON.stringify(v)}`);
  for (const w of WALLPAPERS) ok(validateSetting("appearance.wallpaper", w.id) === null, w.id);
  ok(DEFAULT_WALLPAPER === "auto", "default wallpaper follows the style");
  for (const id of STYLE_IDS) ok(validateSetting("appearance.style", id) === null, id);
  ok(validateSetting("appearance.style", "miami") !== null && validateSetting("appearance.style", "") !== null, "style enum");
  ok(validateSetting("appearance.accent", "auto") === null, "accent 'auto' = the style accent");
  ok(validateSetting("appearance.wallpaper", "../../etc") !== null && validateSetting("appearance.theme", "neon") !== null && validateSetting("appearance.density", "huge") !== null, "enums");
  ok(validateSetting("appearance.accent", "#5b8cff") === null && validateSetting("appearance.accent", "red;}") !== null, "accent");
  ok(validateSetting("shell.widgets", "anything at all") === null, "free-form keys stay free-form");
});

await test("style system: every style's glyphs ≥3:1 on their tiles, chrome ink ≥4.5:1, dark+light text tokens ≥4.5:1, accent buttons ≥4.5:1; CSS emitted for each", { "AX-11": "full", "AX-10": "partial" }, () => {
  ok(DEFAULT_STYLE === "poolside" && STYLE_IDS.length === 4 && isStyle("vice") && !isStyle("neon"), "ids");
  const bad: string[] = [];
  const need = (name: string, a: string, b: RGB, min: number) => { const r = ratio(hex(a), b); if (r < min) bad.push(`${name} ${r.toFixed(2)}`); };
  const rgba = (s: string): [RGB, number] => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(s)!; return [[+m[1] / 255, +m[2] / 255, +m[3] / 255], m[4] ? +m[4] : 1]; };
  for (const id of STYLE_IDS) {
    const st = STYLES[id];
    for (const [pn, p] of Object.entries(st.palettes)) for (let y = 11; y <= 38; y++) need(`${id}/${pn}@y${y}`, p.fg, mix(hex(p.top), hex(p.bottom), (y - 1) / 45), 3);
    const INK2 = "#14213d";
    need(`${id} pill`, INK2, hex(st.chrome.pill[1]), 4.5); need(`${id} pill-a`, INK2, hex(st.chrome.pill[0]), 4.5);
    st.chrome.win.forEach((w, i) => need(`${id} win${i}`, INK2, hex(w), 4.5));
    need(`${id} accent button`, "#04102b", hex(st.accent), 4.5);
    // desk label: white text on the label backing composited over pure white (worst case: brightest wallpaper spot)
    const [lc, la] = rgba(st.chrome.deskLabel); need(`${id} desk label`, "#ffffff", over(lc, la, [1, 1, 1]), 4.5);
    for (const theme of ["dark", "light"] as const) {
      const t = st[theme];
      need(`${id}/${theme} text`, t.text, hex(t.panelSolid), 4.5); need(`${id}/${theme} muted`, t.muted, hex(t.panelSolid), 4.5);
      need(`${id}/${theme} muted/bg`, t.muted, hex(t.bg), 4.5);
    }
    ok(resolveWallpaper("auto", id) === st.wallpaper && resolveWallpaper(undefined, id) === st.wallpaper && resolveWallpaper("slate", id) === "slate", `${id} wallpaper resolve`);
  }
  ok(bad.length === 0, `below threshold: ${bad.slice(0, 10).join(", ")}`);
  const css = styleCss();
  for (const id of STYLE_IDS) ok(css.includes(`:root[data-style="${id}"]{`) && css.includes(`:root[data-style="${id}"][data-theme="light"]{`), `css for ${id}`);
  ok(css.startsWith("@media not (prefers-contrast: more)"), "high-contrast mode wins over every style");
  for (const v of ["--fs-pill-a", "--fs-win-close", "--fs-desk-label", "--fs-style-accent"]) ok(css.includes(v), v);
  // the components actually consume the chrome variables (TT22 found the TT21 colours hard-coded)
  ok(readFileSync("src/components/TopBar.tsx", "utf8").includes("var(--fs-pill-a"), "TopBar uses the pill vars");
  ok(readFileSync("src/components/WindowFrame.tsx", "utf8").includes("var(--fs-win-close"), "WindowFrame uses the button vars");
});

await test("light theme: field background and status-text tokens reach ≥4.5:1; filled spreadsheet cells get automatic ink", { "AX-11": "partial", "AX-09": "partial" }, () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const light = /:root\[data-theme="light"\]\s*\{([^}]*)\}/.exec(css)![1];
  const v = (n: string) => new RegExp(`--${n}:\\s*(#[0-9a-f]{6})`, "i").exec(light)?.[1];
  ok(v("fs-field") === "#ffffff", "white input fields in light theme (TT22 found dark-grey fields)");
  for (const id of STYLE_IDS) {
    const panel = hex(STYLES[id].light.panelSolid);
    for (const [n, tint] of [["fs-ok-text", "#39d98a"], ["fs-warn-text", "#ffc453"], ["fs-bad-text", "#ff6b6b"], ["fs-info-text", "#5b8cff"]] as const) {
      const r = ratio(hex(v(n)!), over(hex(tint), 0.14, panel)); ok(r >= 4.5, `${id} ${n} ${r.toFixed(2)}`);
    }
    ok(ratio(hex(v("fs-cell-formula")!), panel) >= 4.5, `${id} formula colour`);
  }
  for (const f of ["#14532d", "#7f1d1d", "#1e3a5f", "#0f172a", "#fde68a", "#ffffff", "#60a5fa", "#a3a3a3", "#777777"]) {
    const ink = autoInk(f)!; ok(ratio(hex(ink), hex(f)) >= 4.5, `auto ink on ${f}: ${ink} ${ratio(hex(ink), hex(f)).toFixed(2)}`);
  }
  ok(autoInk(undefined) === undefined && autoInk("transparent") === undefined && autoInk("rgba(0,0,0,.5)") === undefined, "non-hex fills keep the default colour");
  ok(autoInk("#000") === "#ffffff" && autoInk("#fff") === "#000000", "3-digit hex");
  // exhaustive over the grey ramp + a coarse RGB lattice: the guarantee holds for every fill
  for (let r = 0; r < 256; r += 17) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 17) {
    const f = "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join(""); ok(ratio(hex(autoInk(f)!), hex(f)) >= 4.5, `auto ink on ${f}`);
  }
});

finish();
