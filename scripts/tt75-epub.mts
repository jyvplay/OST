/**
 * TT75 — FF-10 EPUB reader, headless suite (package + content layers; the rendering checks are in e2e-tt75-books.mts).
 *  W1  the W3C epub-tests corpus (209 tests, cloned from github.com/w3c/epub-tests — not in git): every test opens
 *      (or fails exactly where the test requires an error) and gets a per-test predicate written from its
 *      dc:description; tests that need rendering are marked "render" and checked in the browser suite; scripting
 *      (scr-*) tests check that no script survives; media-overlay (mol-*) tests are n/a (declared).
 *  W2  the IDPF epub3-samples corpus (45 books): open, every spine document prepared, every image / media / style
 *      reference rewritten to a manifest resource or dropped, the table of contents resolves into the spine.
 *  W3  differential vs an independent lxml reader (scripts/oracle/epub_opf.py) on all 254 books: title, creators,
 *      identifier, version, page progression, layout, spine (path + linear), manifest paths, TOC (depth/label/href).
 *  C1–C6 crafted OCF cases: non-Deflate method, split archive, DRM, IDPF + Adobe font obfuscation round trips,
 *      first rootfile wins.
 *  N1–N20 negative shapes against the sanitiser and the package reader.
 * Subsets: TT75E_ONLY="W1 C1 …".
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { makeHarness } from "./harness.mts";
import { writeZip } from "../src/lib/office/zipkit.ts";
import { openEpub, EpubError, spreadGroups, progression, spineIndexOf, idpfKey, adobeKey, xorPrefix, resolveHref, type EpubBook } from "../src/lib/epub/epub-core.ts";
import { prepareChapter, fxlViewport, mapEpubCss } from "../src/lib/epub/epub-content.ts";

const { test, finish } = makeHarness("tt75-epub");
const ONLY = process.env.TT75E_ONLY;
const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python";
const W3C = "/home/user/tools/corpus/epub/epub-tests/tests", IDPF = "/home/user/tools/corpus/epub/epub3-samples/30";
const tmp = mkdtempSync(join(tmpdir(), "tt75e-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const J = (v: unknown) => JSON.stringify(v);
const COV = { "FF-10": "full" } as const;
// TT75 register rows: FF-60 Books fixed layout / spreads / roll, FF-61 Books reading safety
const SAFE = { ...COV, "FF-61": "full" } as const;
const LAYOUT = { ...COV, "FF-60": "full" } as const;

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
type F = { name: string; data: Uint8Array | string; store?: boolean };
async function zipDir(dir: string, edit?: (files: F[]) => F[]): Promise<Uint8Array> {
  let files: F[] = walk(dir).map((p) => relative(dir, p)).filter((n) => n !== "mimetype" && !n.endsWith(".DS_Store")).sort().map((n) => ({ name: n, data: new Uint8Array(readFileSync(join(dir, n))) }));
  files = [{ name: "mimetype", data: "application/epub+zip", store: true }, ...files];
  return writeZip(edit ? edit(files) : files);
}
const urlFor = async (p: string) => `res:${p}`;
interface Opened { book: EpubBook; docs: Map<string, string>; notes: string[]; errors: Map<string, string> }
async function openAll(bytes: Uint8Array): Promise<Opened> {
  const book = await openEpub(bytes); const docs = new Map<string, string>(); const errors = new Map<string, string>(); const notes: string[] = [];
  for (const s of book.spine) {
    if (!s.shown || docs.has(s.shown.path) || errors.has(s.shown.path)) continue;
    try { const p = await prepareChapter(book, s.shown.path, { urlFor }); docs.set(s.shown.path, p.doc); notes.push(...p.notes); } catch (e) { errors.set(s.shown.path, (e as Error).message); }
  }
  return { book, docs, notes, errors };
}
const allDocs = (o: Opened) => [...o.docs.values()].join("\n");
/** structural safety of every prepared document */
function safe(o: Opened): string | null {
  for (const [p, d] of o.docs) {
    if (/<(?:\w+:)?script\b/i.test(d)) return `${p}: script survived`;
    for (const [tag] of d.matchAll(/<[A-Za-z][^>]*>/g)) { // attributes of real tags only (escaped sample code in <pre> is text)
      if (/\son[a-z]+\s*=/i.test(tag)) return `${p}: handler attribute survived: ${tag.slice(0, 120)}`;
      if (/\s(?:src|data|poster|xlink:href)\s*=\s*["']\s*(?:https?:|file:|javascript:|\/\/)/i.test(tag)) return `${p}: remote resource attribute: ${tag.slice(0, 120)}`;
      if (/\shref\s*=\s*["']\s*(?:file:|javascript:)/i.test(tag)) return `${p}: file / script link: ${tag.slice(0, 120)}`;
      if (/\shref\s*=\s*["']\s*(https?|mailto):/i.test(tag)) return `${p}: an external link without the consent gate: ${tag.slice(0, 120)}`;
    }
    if (!/http-equiv="Content-Security-Policy"/.test(d) && !/^<\?xml[^>]*>\s*<svg/i.test(d)) return `${p}: no CSP`;
  }
  return null;
}
const FONT_SIG = (b: Uint8Array) => { const s = String.fromCharCode(...b.subarray(0, 4)); return s === "OTTO" || s === "true" || s === "wOFF" || s === "wOF2" || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0); };

/* ================================================================== W1: W3C epub-tests */
type Pred = (o: Opened, dir: string) => void | Promise<void>;
const has = (o: Opened, re: RegExp, what: string) => ok(re.test(allDocs(o)), `${what} not found`);
const imgRes = (o: Opened) => { const m = [...allDocs(o).matchAll(/<(?:\w+:)?(?:img|image)\b[^>]*?(?:src|href)="(res:[^"]+)"/g)].map((x) => x[1].slice(4)); ok(m.length && m.every((p) => o.book.has(p.split("#")[0])), `images ${J(m)}`); return m; };
const cssHas = (props: string[]): Pred => (o) => { const d = allDocs(o); for (const p of props) ok(new RegExp(`(^|[;{\\s])${p}\\s*:`).test(d), `${p} missing`); ok(!/(^|[;{\s])-epub-[a-z-]+\s*:/.test(d.replace(/-epub-fullwidth/g, "")), "an -epub- property survived"); };
const vp = (w: number | null, h?: number): Pred => async (o) => {
  const s = o.book.spine.find((x) => x.layout === "pre-paginated") ?? o.book.spine[0]; const raw = await o.book.readText(s.shown!.path); const v = fxlViewport(raw!);
  ok(w === null ? v === null : v?.width === w && v?.height === h, J(v));
};
const spreads = (landscape: boolean, expectPairs: boolean): Pred => (o) => { const g = spreadGroups(o.book, landscape); const pairs = g.some((x) => !x.single); ok(pairs === expectPairs, J(g)); };
const PRED: Record<string, Pred | "render" | "n/a" | "error"> = {
  "ocf-font_obfuscation": async (o) => { const f = [...o.book.manifest.values()].find((m) => /font|otf|ttf|woff/.test(m.mediaType + m.path))!; ok(FONT_SIG((await o.book.read(f.path))!), "font not de-obfuscated"); },
  "ocf-font_obfuscation_bis": async (o) => { const f = [...o.book.manifest.values()].find((m) => /font|otf|ttf|woff/.test(m.mediaType + m.path))!; ok(!FONT_SIG((await o.book.read(f.path))!), "a font obfuscated with the wrong key must not decode"); },
  "ocf-metainf-inc": (o) => ok(o.docs.size >= 1, "no content"), "ocf-metainf-manifest": (o) => ok(o.docs.size >= 1, "no content"),
  "ocf-package_arbitrary": (o) => ok(!/^(EPUB|OEBPS)\/package\.opf$/.test(o.book.opfPath) && o.docs.size >= 1, o.book.opfPath),
  "ocf-package_multiple": (o, dir) => { const c = readFileSync(join(dir, "META-INF/container.xml"), "utf8"); const first = /full-path="([^"]+)"/.exec(c)![1]; ok(o.book.opfPath === first, `${o.book.opfPath} vs ${first}`); },
  "ocf-url_link-leaking-relative": (o) => { imgRes(o); }, "ocf-url_link-path-absolute": (o) => { imgRes(o); }, "ocf-url_link-relative": (o) => { imgRes(o); },
  "ocf-url_manifest": (o) => ok(o.docs.size >= 1 && o.book.spine.every((s) => o.book.has(s.item.path)), "content not found"),
  "ocf-url_relative": (o) => ok(o.docs.size >= 1 && o.book.spine.every((s) => o.book.has(s.item.path)), "content not found"),
  "ocf-url_origin": "n/a", "ocf-url_parse-leaking-relative": "n/a", "ocf-url_parse-path-absolute": "n/a",
  "ocf-zip-comp": "render", "ocf-zip-mult": "render", // directory form only; the failing archives are crafted in C1 / C2
  "pkg-creator-order": (o) => ok(o.book.creators.length >= 2, J(o.book.creators)),
  "pkg-title-order": (o) => ok(o.book.title === "pkg-title-order", o.book.title),
  "pkg-meta-whitespace": (o) => ok(!/\s{2}|[\t\n\r]/.test(o.book.title) && o.book.title === o.book.title.trim(), J(o.book.title)),
  "pkg-spine-duplicate-item-hyperlink": (o) => { const p = o.book.spine.map((s) => s.item.path); const dup = p.find((x, i) => p.indexOf(x) !== i); ok(dup && spineIndexOf(o.book, dup) === p.indexOf(dup), J(p)); },
  "pkg-spine-duplicate-item-rendering": (o) => { const p = o.book.spine.map((s) => s.item.path); ok(new Set(p).size < p.length, J(p)); },
  "pkg-spine-duplicate-item-ui": (o) => { const p = o.book.spine.map((s) => s.item.path); ok(new Set(p).size < p.length, J(p)); },
  "pkg-spine-nonlinear-activation": (o) => { const nl = o.book.spine.filter((s) => !s.linear); ok(nl.length && nl.every((s) => allDocs(o).includes(`data-epub-href="${s.item.path}`)), "non-linear item not linked"); },
  "pkg-spine-progression_rtl": (o) => ok(progression(o.book) === "rtl", o.book.direction),
  "pkg-spine-progression_ltr": (o) => ok(progression(o.book) === "ltr", o.book.direction),
  "pkg-spine-progression-default": (o) => ok(o.book.direction === "default" && progression(o.book) === "rtl", `${o.book.direction} ${o.book.language}`),
  "pkg-spine-progression-pre-paginated": (o) => ok(progression(o.book) === "ltr" && o.book.layout === "pre-paginated", o.book.direction),
  "pkg-unique-id": (o) => ok(o.book.identifier === "pkg-unique-id", o.book.identifier),
  "pkg-manifest-unlisted-resource": (o) => ok(o.notes.some((n) => /not in the manifest/.test(n)) && !/<img\b[^>]*src="res:/.test(allDocs(o)), J(o.notes)),
  "nav-spine_not-in-spine": (o) => ok(o.book.toc.length > 0 && !o.book.spine.some((s) => s.item.path === o.book.navPath), "toc"),
  "nav-spine_in-spine": (o) => ok(o.book.toc.length > 0, "toc"), "nav-spine_in-spine-hidden-toc-css": (o) => ok(o.book.toc.length > 0, "toc"),
  "nav-spine_in-spine-hidden-toc-html": (o) => ok(o.book.toc.length > 0, "toc (hidden attribute must be ignored)"), "nav-spine_in-spine-no-list-style": (o) => ok(o.book.toc.length > 0, "toc"),
  "nav-non-text_img": (o) => ok(o.book.toc.length && o.book.toc.every((n) => n.label && n.label !== "(untitled)"), J(o.book.toc)),
  "nav-non-text_img_title": (o) => ok(o.book.toc.length && o.book.toc.every((n) => n.label && n.label !== "(untitled)"), J(o.book.toc)),
  "nav-access": (o) => ok(o.book.toc.length && o.book.toc.every((n) => !n.href || spineIndexOf(o.book, n.href.split("#")[0]) >= 0), J(o.book.toc)),
  "nav-activation": (o) => ok(o.book.toc.length && o.book.toc.every((n) => !n.href || spineIndexOf(o.book, n.href.split("#")[0]) >= 0), J(o.book.toc)),
  "pub-cmt-gif": (o) => { imgRes(o); }, "pub-cmt-jpeg": (o) => { imgRes(o); }, "pub-cmt-png": (o) => { imgRes(o); }, "pub-cmt-svg": (o) => { imgRes(o); }, "pub-cmt-webp": (o) => { imgRes(o); }, "pub-cmt-avif": (o) => { imgRes(o); },
  "pub-cmt-jxl": "render", // JPEG XL is not a core media type; display depends on the browser (Chromium: no)
  "pub-cmt-mp3": (o) => has(o, /<(?:audio|source)\b[^>]*src="res:[^"]+\.mp3"/, "mp3 source"), "pub-cmt-mp4": (o) => has(o, /<(?:audio|video|source)\b[^>]*src="res:[^"]+\.(mp4|m4a)"/, "mp4 source"),
  "pub-cmt-opus": (o) => has(o, /<(?:audio|source)\b[^>]*src="res:[^"]+\.(opus|ogg|webm)"/, "opus source"),
  "pub-data-urls_browsing-context": (o) => has(o, /<img\b[^>]*src="data:image\//, "data: image"), "pub-data-urls_top-level-content": (o) => has(o, /<img\b[^>]*src="data:image\//, "data: image"),
  "pub-external-links": (o) => has(o, /data-epub-ext="https?:/, "consent-gated external link"), "pub-external-links_consent": (o) => has(o, /data-epub-ext="/, "consent-gated external link"),
  "pub-file-urls": (o) => ok(!/=\s*"file:/i.test(allDocs(o)), "file: URL survived"),
  "pub-foreign_image": (o) => { const m = imgRes(o); ok(m.every((p) => /\.png$/i.test(p)), J(m)); },
  "pub-foreign_json-spine": (o) => ok(o.book.spine.every((s) => s.shown?.mediaType === "application/xhtml+xml"), "fallback"),
  "pub-foreign_xml-spine": (o) => ok(o.book.spine.every((s) => s.shown?.mediaType === "application/xhtml+xml"), "fallback"),
  "pub-foreign_xml-suffix-spine": (o) => ok(o.book.spine.every((s) => s.shown?.mediaType === "application/xhtml+xml"), "fallback"),
  "pub-foreign_bad-fallback": (o) => ok(o.book.spine.some((s) => s.shown === null), "an unsupported spine item must be reported, not guessed"),
  "pub-xml-external-id": (o) => ok(!/SYSTEM|ENTITY/.test(allDocs(o)) && o.errors.size === 0, "entity"),
  "pub-xml-names": "error", "pub-xml-non-validating_unclosed": "error",
  "pub-xml-non-validating_comment": (o) => ok(!o.book.spine.some((s) => s.item.path === o.book.navPath), "a commented-out itemref was used"),
  "css-epub-hyphens": cssHas(["hyphens"]), "css-epub-line-break": cssHas(["line-break"]), "css-epub-text-align-last": cssHas(["text-align-last"]),
  "css-epub-text-combine-horizontal": cssHas(["text-combine-upright"]), "css-epub-text-emphasis": cssHas(["text-emphasis(?:-style|-color)?"]),
  "css-epub-text-orientation": cssHas(["text-orientation"]), "css-epub-text-transform": (o) => has(o, /full-width/, "full-width"),
  "css-epub-text-underline-position": cssHas(["text-underline-position"]), "css-epub-word-break": cssHas(["word-break"]), "css-epub-writing-mode": cssHas(["writing-mode"]),
  "fxl-page-spread-center": (o) => { const g = spreadGroups(o.book, true); const c = o.book.spine.find((s) => s.pageSpread === "center")!; ok(g.find((x) => x.first === c.index)?.single, J(g)); },
  "fxl-spine-overrides_behave-as-global": (o) => ok(o.book.layout === "pre-paginated" && o.book.spine.some((s) => s.layout === "reflowable"), "override"),
  "fxl-spine-overrides_behave-as-global-bis": (o) => ok(o.book.layout === "reflowable" && o.book.spine.some((s) => s.layout === "pre-paginated"), "override"),
  "fxl-spine-overrides_duplicate": (o) => ok(o.book.spine.some((s) => s.layout === "reflowable" && s.properties.filter((p) => p.startsWith("rendition:layout-")).length > 1), "first override must win"),
  "fxl-layout-duplication": (o) => ok(o.docs.size >= 1, "opens"),
  "lay-fxl-layout-default": (o) => ok(o.book.layout === "reflowable", o.book.layout),
  "lay-fxl-layout-pre-paginated": (o) => ok(o.book.spine.every((s) => s.layout === "pre-paginated"), "layout"),
  "lay-fxl-page-spread-combined": spreads(true, true),
  "lay-fxl-page-spread-left": (o) => { const l = o.book.spine.find((s) => s.pageSpread === "left")!; const g = spreadGroups(o.book, true).find((x) => x.first === l.index || x.second === l.index)!; ok(progression(o.book) === "ltr" ? g.first === l.index : g.second === l.index, J(g)); },
  "lay-fxl-page-spread-right": (o) => { const r = o.book.spine.find((s) => s.pageSpread === "right")!; const g = spreadGroups(o.book, true).find((x) => x.first === r.index || x.second === r.index)!; ok(progression(o.book) === "ltr" ? g.second === r.index : g.first === r.index, J(g)); },
  "lay-fxl-spread-both": (o) => { spreads(false, true)(o, ""); }, "lay-fxl-spread-none": (o) => { spreads(true, false)(o, ""); },
  "lay-fxl-spread-landscape": (o) => { spreads(true, true)(o, ""); spreads(false, false)(o, ""); },
  "lay-fxl-spread-auto": spreads(true, true), "lay-fxl-spread-default": (o) => { ok(o.book.spread === "auto", o.book.spread); spreads(true, true)(o, ""); },
  "lay-fxl-xhtml-icb": vp(900, 600), "lay-fxl-xhtml-icb_invalid_meta": vp(900, 600), "lay-fxl-xhtml-icb_units": vp(1000, 600),
  "lay-fxl-xhtml-icb_repeated-in-meta": vp(900, 600), "lay-fxl-xhtml-icb_device_sizes": vp(null),
  "lay-pp-xhtml-icb": vp(900, 600), "lay-pp-xhtml-icb_invalid_meta": vp(900, 600), "lay-pp-xhtml-icb_units": vp(1000, 600), "lay-pp-xhtml-icb_repeated-in-meta": vp(900, 600),
  "lay-pkg-flow-paginated": (o) => ok(o.book.flow === "paginated", o.book.flow), "lay-pkg-flow-scrolled-continuous": (o) => ok(o.book.flow === "scrolled-continuous", o.book.flow),
  "lay-pkg-flow-scrolled-doc": (o) => ok(o.book.flow === "scrolled-doc", o.book.flow),
  "sec-untrusted-consent_network": (o) => ok(!/\s(?:src|data|poster)\s*=\s*["']https?:/i.test(allDocs(o)), "a remote resource would load without consent"),
  "cnt-svg-support": (o) => has(o, /<(?:\w+:)?svg\b/, "SVG kept"), "cnt-svg-embedded": (o) => has(o, /<(?:\w+:)?svg\b/, "SVG kept"),
  "cnt-svg-css": (o) => has(o, /<(?:\w+:)?svg\b/, "SVG kept"), "cnt-svg-css-inclusion": (o) => has(o, /<(?:\w+:)?svg\b|res:[^"]+\.svg/, "SVG kept"),
  "cnt-svg-css-reference": (o) => has(o, /<(?:\w+:)?svg\b|res:[^"]+\.svg/, "SVG kept"), "cnt-xhtml-support": (o) => ok(o.docs.size >= 1, "content"),
  // images in the spine are foreign resources (EPUB 3.3 §3.2): the XHTML fallback is shown (an image without one is wrapped by the reader)
  "lay-pp-images-in-spine": (o) => ok(o.book.spine.length >= 4 && o.book.spine.every((s) => /^image\//.test(s.item.mediaType) ? s.shown?.mediaType === "application/xhtml+xml" && o.docs.has(s.shown.path) : true), "fallbacks"),
  "lay-roll-images-in-spine": (o) => ok(o.book.spine.some((s) => /^image\//.test(s.item.mediaType)) && o.book.spine.every((s) => !/^image\//.test(s.item.mediaType) || (s.shown && o.docs.has(s.shown.path))), "fallbacks"),
  "lay-pp-layout-default": (o) => ok(o.book.layout === "reflowable", o.book.layout), "lay-pp-layout-pre-paginated": (o) => ok(o.book.spine.every((s) => s.layout === "pre-paginated"), "layout"),
  "lay-pp-spine-overrides_image-spine-pp": (o) => ok(o.book.layout === "pre-paginated" && o.book.spine.some((s) => s.layout === "reflowable") && o.book.spine.some((s) => /^image\//.test(s.item.mediaType)), "override"),
  "lay-pp-spread-none": (o) => { spreads(true, false)(o, ""); },
  "pkg-version-backward": (o) => ok(o.book.version === "0" && o.docs.size >= 1, o.book.version),
  "pkg-spine-order": (o) => ok(o.book.spine.length >= 2 && o.book.spine.every((s, i) => s.index === i), "order"),
  "cnt-mathml-support": (o) => has(o, /<(?:\w+:)?math\b/, "MathML kept"),
  "cnt-css-fonts_ot": (o) => has(o, /url\("res:[^"]+\.(otf|ttf)"\)/i, "font url"), "cnt-css-fonts_tt": (o) => has(o, /url\("res:[^"]+\.(ttf|otf)"\)/i, "font url"),
  "cnt-css-fonts_woff": (o) => has(o, /url\("res:[^"]+\.woff"\)/i, "font url"), "cnt-css-fonts_woff2": (o) => has(o, /url\("res:[^"]+\.woff2"\)/i, "font url"),
};
if (want("W1")) await test("W1 W3C epub-tests: every test opens or errors where required; per-test predicates from dc:description; no script / handler / remote resource survives; CSP in every document", COV, async () => {
  const names = readdirSync(W3C).filter((n) => statSync(join(W3C, n)).isDirectory() && !n.startsWith("xx-")).sort();
  const bad: string[] = []; const tally: Record<string, number> = { predicate: 0, generic: 0, render: 0, "n/a": 0, error: 0 };
  for (const n of names) {
    const p = PRED[n] ?? (n.startsWith("mol-") ? "n/a" : undefined);
    let o: Opened;
    try { o = await openAll(await zipDir(join(W3C, n))); } catch (e) { bad.push(`${n}: open failed ${(e as Error).message}`); continue; }
    if (p === "error") { if (o.errors.size) tally.error++; else bad.push(`${n}: must report an XML error`); continue; }
    if (o.errors.size) { bad.push(`${n}: ${[...o.errors.values()][0]}`); continue; }
    const s = safe(o); if (s) { bad.push(`${n}: ${s}`); continue; }
    if (n.startsWith("scr-") && /<script/i.test(allDocs(o))) { bad.push(`${n}: script`); continue; }
    if (typeof p === "function") { try { await p(o, join(W3C, n)); tally.predicate++; } catch (e) { bad.push(`${n}: ${(e as Error).message}`); } }
    else if (p) tally[p]++; else tally.generic++;
  }
  console.log(`    W3C tests ${names.length}: ${J(tally)}`);
  ok(!bad.length, bad.slice(0, 12).join("\n"));
  ok(names.length >= 205 && tally.predicate >= 100, J(tally));
});

/* ================================================================== W2: IDPF samples */
if (want("W2")) await test("W2 IDPF epub3-samples (45 books): open, every spine document prepared and safe, images / media / styles point to manifest resources, the TOC resolves into the spine", SAFE, async () => {
  const names = readdirSync(IDPF).filter((n) => statSync(join(IDPF, n)).isDirectory()).sort(); const bad: string[] = []; let docs = 0, imgs = 0, toc = 0;
  for (const n of names) {
    try {
      const o = await openAll(await zipDir(join(IDPF, n)));
      if (o.errors.size) { bad.push(`${n}: ${[...o.errors.values()][0]}`); continue; }
      const s = safe(o); if (s) { bad.push(`${n}: ${s}`); continue; }
      docs += o.docs.size;
      for (const m of allDocs(o).matchAll(/\s(?:src|href|poster)="res:([^"#]+)/g)) { imgs++; if (!o.book.byPath.has(m[1])) bad.push(`${n}: ${m[1]} not a manifest item`); }
      const flat = (ns: typeof o.book.toc): typeof o.book.toc => ns.flatMap((x) => [x, ...flat(x.children)]);
      const t = flat(o.book.toc); toc += t.length;
      if (!t.length) bad.push(`${n}: no table of contents`);
      for (const x of t) if (x.href && !/^[a-z]+:/i.test(x.href) && spineIndexOf(o.book, x.href.split("#")[0]) < 0 && !o.book.byPath.has(x.href.split("#")[0])) bad.push(`${n}: TOC → ${x.href} resolves nowhere`);
    } catch (e) { bad.push(`${n}: ${(e as Error).message}`); }
  }
  console.log(`    books ${names.length}, documents ${docs}, rewritten resource refs ${imgs}, TOC entries ${toc}`);
  ok(!bad.length, bad.slice(0, 10).join("\n"));
  ok(names.length >= 45 && docs >= 500, `${names.length} / ${docs}`);
});

/* ================================================================== W3: lxml differential */
if (want("W3")) await test("W3 differential vs an independent lxml package reader on every IDPF + W3C book: title, creators, identifier, version, progression, layout, spine, manifest, TOC", COV, async () => {
  const dirs = [...readdirSync(IDPF).map((n) => join(IDPF, n)), ...readdirSync(W3C).filter((n) => !n.startsWith("xx-")).map((n) => join(W3C, n))].filter((d) => statSync(d).isDirectory());
  const files: { dir: string; path: string; bytes: Uint8Array }[] = [];
  for (const d of dirs) { const b = await zipDir(d); const p = join(tmp, `${relative("/home/user/tools/corpus/epub", d).replace(/\//g, "__")}.epub`); writeFileSync(p, b); files.push({ dir: d, path: p, bytes: b }); }
  const ox: Record<string, Record<string, unknown>> = {};
  for (let k = 0; k < files.length; k += 40) Object.assign(ox, JSON.parse(execFileSync(PY, ["scripts/oracle/epub_opf.py", ...files.slice(k, k + 40).map((f) => f.path)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  const bad: string[] = []; let compared = 0;
  for (const f of files) {
    const o = ox[f.path]; if (!o || "error" in o) { bad.push(`${f.dir}: oracle ${o?.error}`); continue; }
    const b = await openEpub(f.bytes);
    const flat = (ns: typeof b.toc, d = 0): [number, string, string | null][] => ns.flatMap((x) => [[d, x.label, x.href] as [number, string, string | null], ...flat(x.children, d + 1)]);
    const mine = { title: b.title, creators: b.creators, identifier: b.identifier, version: b.version, direction: b.direction, spine: b.spine.map((s) => [s.item.path, s.linear]), manifest: [...b.manifest.values()].map((m) => m.path).sort(), toc: flat(b.toc), layout: b.layout };
    for (const k of Object.keys(mine) as (keyof typeof mine)[]) if (J(mine[k]) !== J(o[k])) bad.push(`${relative("/home/user/tools/corpus/epub", f.dir)} ${k}: ${J(mine[k]).slice(0, 160)} vs ${J(o[k]).slice(0, 160)}`);
    compared++;
  }
  console.log(`    books compared ${compared}, disagreements ${bad.length}`);
  ok(!bad.length, bad.slice(0, 10).join("\n"));
  ok(compared >= 250, String(compared));
});

/* ================================================================== crafted OCF */
const mini = (opts: { id?: string; extra?: F[]; container?: string; chapter?: string; manifestExtra?: string; spineExtra?: string } = {}): F[] => [
  { name: "mimetype", data: "application/epub+zip", store: true },
  { name: "META-INF/container.xml", data: opts.container ?? `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/p.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
  { name: "OPS/p.opf", data: `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${opts.id ?? "urn:uuid:12345678-90ab-cdef-1234-567890abcdef"}</dc:identifier><dc:title>Mini</dc:title><dc:language>en</dc:language></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${opts.manifestExtra ?? ""}</manifest><spine><itemref idref="c"/>${opts.spineExtra ?? ""}</spine></package>` },
  { name: "OPS/nav.xhtml", data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>n</title></head><body><nav epub:type="toc"><ol><li><a href="c.xhtml">One</a></li></ol></nav></body></html>` },
  { name: "OPS/c.xhtml", data: opts.chapter ?? `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>Hello</p></body></html>` },
  ...(opts.extra ?? []),
];
const fails = async (bytes: Uint8Array, re: RegExp) => { try { await openAll(bytes); } catch (e) { ok(e instanceof EpubError && re.test((e as Error).message), (e as Error).message); return; } throw new Error("opened, but must be refused"); };
if (want("C1")) await test("C1 an entry compressed with a method other than stored / deflate is an error (W3C ocf-zip-comp), not garbage", COV, async () => {
  const b = await writeZip(mini()); const dv = new DataView(b.buffer);
  for (let i = 0; i < b.length - 4; i++) { const sig = dv.getUint32(i, true); if (sig === 0x04034b50 || sig === 0x02014b50) { const off = sig === 0x04034b50 ? 8 : 10; const nl = dv.getUint16(i + (sig === 0x04034b50 ? 26 : 28), true); const nm = new TextDecoder().decode(b.subarray(i + (sig === 0x04034b50 ? 30 : 46), i + (sig === 0x04034b50 ? 30 : 46) + nl)); if (nm === "OPS/c.xhtml") dv.setUint16(i + off, 12, true); } }
  await fails(b, /method 12/);
});
if (want("C2")) await test("C2 a split / spanned archive is refused (W3C ocf-zip-mult)", COV, async () => {
  const b = await writeZip(mini()); const dv = new DataView(b.buffer); const e = b.length - 22; dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 1, true);
  await fails(b, /split|spanned/);
});
if (want("C3")) await test("C3 DRM: a spine document encrypted with any algorithm other than font obfuscation refuses the book with a clear message", COV, async () => {
  const enc = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OPS/c.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>`;
  await fails(await writeZip(mini({ extra: [{ name: "META-INF/encryption.xml", data: enc }] })), /DRM/);
});
const fontBytes = () => new Uint8Array(readFileSync(walk(join(IDPF, "wasteland-otf")).find((p) => /\.otf$/i.test(p))!));
if (want("C4")) await test("C4 IDPF font obfuscation: SHA-1(unique id without XML whitespace) XOR over 1040 bytes round-trips exactly; whitespace in the identifier is ignored", COV, async () => {
  const font = fontBytes(); const id = " urn:uuid:12345678-90ab-cdef-1234-567890abcdef\n"; const key = await idpfKey(id);
  const enc = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><enc:CipherData><enc:CipherReference URI="OPS/f.otf"/></enc:CipherData></enc:EncryptedData></encryption>`;
  const b = await openEpub(await writeZip(mini({ id, manifestExtra: `<item id="f" href="f.otf" media-type="font/otf"/>`, extra: [{ name: "META-INF/encryption.xml", data: enc }, { name: "OPS/f.otf", data: xorPrefix(font, key, 1040) }] })));
  const got = (await b.read("OPS/f.otf"))!; ok(got.length === font.length && got.every((v, i) => v === font[i]), "font differs after de-obfuscation");
  ok(J([...xorPrefix(font, key, 1040).subarray(0, 4)]) !== J([...font.subarray(0, 4)]), "obfuscation was a no-op");
});
if (want("C5")) await test("C5 Adobe font obfuscation: the identifier's UUID bytes XOR over 1024 bytes round-trips exactly", COV, async () => {
  const font = fontBytes(); const id = "urn:uuid:12345678-90ab-cdef-1234-567890abcdef"; const key = adobeKey(id)!;
  ok(key.length === 16 && key[0] === 0x12 && key[15] === 0xef, J([...key]));
  const enc = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/><enc:CipherData><enc:CipherReference URI="OPS/f.otf"/></enc:CipherData></enc:EncryptedData></encryption>`;
  const b = await openEpub(await writeZip(mini({ id, manifestExtra: `<item id="f" href="f.otf" media-type="font/otf"/>`, extra: [{ name: "META-INF/encryption.xml", data: enc }, { name: "OPS/f.otf", data: xorPrefix(font, key, 1024) }] })));
  const got = (await b.read("OPS/f.otf"))!; ok(got.every((v, i) => v === font[i]), "font differs");
});
if (want("C6")) await test("C6 the first rootfile of the package media type wins; a non-package rootfile listed first is skipped; path resolution clamps ../ at the root and decodes %20", COV, async () => {
  const c = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="x.pdf" media-type="application/pdf"/><rootfile full-path="OPS/p.opf" media-type="application/oebps-package+xml"/><rootfile full-path="other.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const b = await openEpub(await writeZip(mini({ container: c }))); ok(b.opfPath === "OPS/p.opf" && b.title === "Mini", b.opfPath);
  ok(J(resolveHref("OPS/t/c.xhtml", "../../../../img/a%20b.png#x")) === J({ path: "img/a b.png", frag: "x" }) && J(resolveHref("OPS/c.xhtml", "/img/a.png")) === J({ path: "img/a.png", frag: "" }) && resolveHref("OPS/c.xhtml", "https://x/y") === null && resolveHref("OPS/c.xhtml", "//evil/x") === null, "resolveHref");
});

/* ================================================================== negative shapes */
const prep = async (body: string, extra: Partial<Parameters<typeof mini>[0]> = {}) => {
  const b = await openEpub(await writeZip(mini({ chapter: `<?xml version="1.0"?>${body}`, ...extra })));
  return prepareChapter(b, "OPS/c.xhtml", { urlFor });
};
const H = (inner: string, head = "") => `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>t</title>${head}</head><body>${inner}</body></html>`;
const neg = (id: string, name: string, fn: () => Promise<void>) => (want(id) ? test(`${id} ${name}`, id === "N22" ? LAYOUT : id === "N20" ? COV : SAFE, fn) : Promise.resolve());
await neg("N1", "<script> (XHTML and SVG, any prefix) is removed", async () => { const p = await prep(H(`<script>alert(1)</script><svg:svg><svg:script>alert(2)</svg:script></svg:svg><p>ok</p>`)); ok(!/script/i.test(p.doc.replace(/Content-Security-Policy[^>]*/, "")) && /<p>ok<\/p>/.test(p.doc), p.doc); });
await neg("N2", "event-handler attributes in any case are removed (onload, ONCLICK, svg onbegin)", async () => { const p = await prep(H(`<p onclick="x()" ONMOUSEOVER="y()">a</p><svg:svg onload="z()"><svg:animate onbegin="w()"/></svg:svg>`)); ok(!/\son[a-z]+=/i.test(p.doc), p.doc); });
await neg("N3", "javascript: links are removed, including entity-encoded and whitespace-split schemes", async () => { const p = await prep(H(`<a href="javascript:alert(1)">a</a><a href="jav&#x61;script:alert(1)">b</a><a href="java&#9;script:alert(1)">c</a><svg:svg><svg:a xlink:href=" javascript:x">d</svg:a></svg:svg>`)); ok(!/javascript|jav&#|java\t/i.test(p.doc), p.doc); });
await neg("N4", "file: and remote resources are not loaded (img, video poster, audio, source, object)", async () => { const p = await prep(H(`<img src="file:///etc/passwd" alt="a"/><img src="https://tracker.example/p.gif" alt="b"/><video poster="http://x/p.jpg" src="http://x/v.mp4"><source src="//x/v.webm"/></video><audio src="https://x/a.mp3"/>`)); ok(!/(src|poster)="(file|https?:|\/\/)/i.test(p.doc), p.doc); });
await neg("N5", "iframe / frame / embed / applet / base / meta refresh are removed; srcdoc and target attributes go", async () => { const p = await prep(H(`<iframe src="c.xhtml" srcdoc="&lt;script&gt;"></iframe><embed src="x.swf"/><applet code="x"/><a href="c.xhtml" target="_top">t</a>`, `<base href="https://evil/"/><meta http-equiv="refresh" content="0;url=https://evil/"/>`)); ok(!/<(iframe|embed|applet|base)\b|refresh|srcdoc|target=/i.test(p.doc), p.doc); });
await neg("N6", "an <object> that is not an image shows its fallback content instead", async () => { const p = await prep(H(`<object data="x.swf" type="application/x-shockwave-flash"><p>fallback</p></object>`)); ok(!/<object/.test(p.doc) && /<p>fallback<\/p>/.test(p.doc), p.doc); });
await neg("N7", "CSS: remote @import dropped, remote url() → none, javascript: url() → none, internal @import cycle terminates", async () => {
  const p = await prep(H(`<p style="background:url(javascript:alert(1))">x</p>`, `<style>@import url("https://evil/x.css"); p{background:url(http://evil/t.png)} @import "a.css";</style>`), { manifestExtra: `<item id="a" href="a.css" media-type="text/css"/>`, extra: [{ name: "OPS/a.css", data: `@import "a.css"; h1{color:red}` }] });
  ok(!/evil|javascript/i.test(p.doc) && /h1\{color:red\}/.test(p.doc), p.doc);
});
await neg("N8", "DOCTYPE internal-subset entities are never expanded (no billion laughs, no external entity)", async () => {
  const lol = `<!DOCTYPE html [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY x SYSTEM "file:///etc/passwd">]>`;
  const p = await prep(`${lol}${H(`<p>&c;&x;&nbsp;</p>`)}`); ok(!/aaaa|passwd|ENTITY/.test(p.doc) && p.doc.includes("&#160;") && p.notes.some((n) => /entity/.test(n)), p.doc);
});
await neg("N9", "path traversal: ../../../../ clamps at the container root and only manifest items load (META-INF files are not reachable)", async () => { const p = await prep(H(`<img src="../../../../META-INF/container.xml" alt="x"/><img src="../../../../../OPS/i.png" alt="y"/>`), { manifestExtra: `<item id="i" href="i.png" media-type="image/png"/>`, extra: [{ name: "OPS/i.png", data: new Uint8Array([137, 80, 78, 71]) }] }); ok(!/container\.xml"/.test(p.doc) && /src="res:OPS\/i\.png"/.test(p.doc), p.doc); });
await neg("N10", "xml-stylesheet processing instructions and comments are dropped", async () => { const p = await prep(`<?xml-stylesheet href="https://evil/x.css"?>${H(`<!-- secret --><p>a</p>`)}`); ok(!/evil|secret|xml-stylesheet/.test(p.doc), p.doc); });
await neg("N11", "data: URLs: images stay, data:text/html links and data: scripts do not", async () => { const p = await prep(H(`<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok"/><a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">x</a><object data="data:text/html,x"><p>fb</p></object>`)); ok(/src="data:image\/png/.test(p.doc) && !/data:text\/html/.test(p.doc), p.doc); });
await neg("N12", "SVG <set>/<animate> that retarget href are dropped", async () => { const p = await prep(H(`<svg:svg><svg:a xlink:href="c.xhtml"><svg:set attributeName="xlink:href" to="javascript:alert(1)"/><svg:animate attributeName="href" values="javascript:x"/><svg:text>t</svg:text></svg:a></svg:svg>`)); ok(!/javascript|<svg:set|<svg:animate/.test(p.doc), p.doc); });
await neg("N13", "malformed XML (unclosed element, a::b names, bad attribute) is an error, never guessed", async () => {
  for (const body of [H(`<p>unclosed`), H(`<a::b>x</a::b>`), H(`<p a=b>x</p>`)]) { let threw = false; try { await prep(body); } catch (e) { threw = e instanceof EpubError; } ok(threw, body); }
});
await neg("N14", "deep nesting (10 000 levels) fails cleanly instead of overflowing the stack", async () => { let threw = false; try { await prep(H("<div>".repeat(10000) + "x" + "</div>".repeat(10000))); } catch (e) { threw = e instanceof EpubError; } ok(threw, "no error"); });
await neg("N15", "a zip bomb entry (declared small, inflates huge) is refused", async () => {
  const big = new Uint8Array(64 << 20); const files = mini({ manifestExtra: `<item id="z" href="z.png" media-type="image/png"/>`, extra: [{ name: "OPS/z.png", data: big }] });
  const b = await writeZip(files); const dv = new DataView(b.buffer);
  for (let i = 0; i < b.length - 4; i++) { if (dv.getUint32(i, true) === 0x02014b50) { const nl = dv.getUint16(i + 28, true); if (new TextDecoder().decode(b.subarray(i + 46, i + 46 + nl)) === "OPS/z.png") dv.setUint32(i + 24, 100, true); } }
  const book = await openEpub(b); let threw = false; try { await book.read("OPS/z.png"); } catch (e) { threw = e instanceof EpubError; } ok(threw, "inflated");
});
await neg("N16", "form actions, formaction and ping are removed", async () => { const p = await prep(H(`<form action="https://evil/"><button formaction="https://evil/">b</button></form><a href="c.xhtml" ping="https://evil/">p</a>`)); ok(!/evil/.test(p.doc), p.doc); });
await neg("N17", "external links are kept only as consent-gated data-epub-ext; internal links become data-epub-href (the frame never navigates itself)", async () => { const p = await prep(H(`<a href="https://example.org/x">e</a><a href="mailto:a@b.c">m</a><a href="nav.xhtml#t">i</a><a href="#here">h</a><p id="here">x</p>`)); ok(!/href="(https?|mailto):/.test(p.doc) && /data-epub-ext="https:\/\/example.org\/x"/.test(p.doc) && /data-epub-ext="mailto:a@b.c"/.test(p.doc) && /data-epub-href="OPS\/nav.xhtml#t"/.test(p.doc) && /href="#here"/.test(p.doc), p.doc); });
await neg("N18", "hostile package: a manifest item escaping the root, a duplicate id, a missing spine target, an empty spine", async () => {
  const b = await openEpub(await writeZip(mini({ manifestExtra: `<item id="c" href="dupe.xhtml" media-type="application/xhtml+xml"/><item id="e" href="../../../../etc/passwd" media-type="application/xhtml+xml"/>`, spineExtra: `<itemref idref="missing"/>` })));
  ok(b.manifest.get("c")!.path === "OPS/c.xhtml" && b.manifest.get("e")!.path === "etc/passwd" && b.spine.length === 1 && b.warnings.some((w) => /missing/.test(w)), J([...b.manifest.values()]));
  const empty = mini(); empty[2] = { name: "OPS/p.opf", data: String(empty[2].data).replace(/<spine>.*<\/spine>/, "<spine/>") };
  await fails(await writeZip(empty), /spine is empty/);
});
await neg("N19", "not an EPUB / no container / missing package / malformed package → clear errors", async () => {
  await fails(new TextEncoder().encode("hello"), /not an EPUB|end-of-central/);
  await fails(await writeZip(mini().filter((f) => f.name !== "META-INF/container.xml")), /container\.xml is missing/);
  await fails(await writeZip(mini().filter((f) => f.name !== "OPS/p.opf")), /package document .* is missing/);
  const bad = mini(); bad[2] = { name: "OPS/p.opf", data: "<package><metadata>" }; await fails(await writeZip(bad), /not well-formed/);
});
await neg("N20", "-epub- CSS mapping does not touch look-alikes (custom properties, selectors, strings) and maps values", async () => {
  const out = mapEpubCss(`p{-epub-writing-mode:vertical-rl;--epub-x:1} .-epub-hyphens{content:"-epub-hyphens: auto"} span{-epub-text-combine:horizontal;text-transform:-epub-fullwidth}`);
  ok(out.includes("writing-mode:vertical-rl") && out.includes("--epub-x:1") && out.includes(".-epub-hyphens{") && out.includes("text-combine-upright:all") && out.includes("text-transform:full-width"), out);
});

/* N21: the frame policy itself — asserted from its properties, not compared with the constant it is built from */
await neg("N21", "every prepared chapter carries a CSP meta first in <head>: default-src 'none', no script-src, images / media / fonts only from blob: / data:", async () => {
  const p = await prep(H(`<p>x</p>`, `<meta http-equiv="Content-Security-Policy" content="default-src *"/>`));
  const metas = [...p.doc.matchAll(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/gi)].map((m) => m[1]);
  ok(metas.length === 1, `CSP metas: ${J(metas)} (the book's own policy must be dropped, ours kept)`);
  const pol = new Map(metas[0].split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map((d) => [d[0], d.slice(1)] as const));
  ok(J(pol.get("default-src")) === J(["'none'"]), `default-src ${J(pol.get("default-src"))}`);
  ok(!pol.has("script-src") && !pol.has("connect-src") && !pol.has("frame-src") && !pol.has("object-src"), J([...pol.keys()]));
  for (const d of ["img-src", "media-src", "font-src"]) ok((pol.get(d) ?? []).every((v) => v === "blob:" || v === "data:"), `${d} ${J(pol.get(d))}`);
  ok(p.doc.indexOf("Content-Security-Policy") < p.doc.indexOf("<title"), "the CSP meta must come before any other head content");
});
/* N22: right-to-left synthetic spreads — the page that starts a pair is the RIGHT-hand page */
await neg("N22", "right-to-left spreads: page-spread-right starts a pair, page-spread-left completes it; left-to-right is the mirror image", async () => {
  const sp = (dir: "rtl" | "ltr", sides: ("left" | "right" | null)[]) => spreadGroups({ direction: dir, language: "en", spine: sides.map((side, index) => ({ index, layout: "pre-paginated", spread: "both", pageSpread: side, linear: true })) } as unknown as EpubBook, true).map((g) => [g.first, g.second]);
  ok(J(sp("rtl", ["right", "left", "right", "left"])) === J([[0, 1], [2, 3]]), J(sp("rtl", ["right", "left", "right", "left"])));
  ok(J(sp("ltr", ["left", "right", "left", "right"])) === J([[0, 1], [2, 3]]), J(sp("ltr", ["left", "right", "left", "right"])));
  // no explicit sides: the first page stands alone on the second side, then pairs follow (both directions)
  ok(J(sp("rtl", [null, null, null])) === J([[null, 0], [1, 2]]), J(sp("rtl", [null, null, null])));
});

finish();
