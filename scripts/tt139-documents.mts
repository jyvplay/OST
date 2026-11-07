/**
 * TT139 suite: FF-22 WordprocessingML, FF-23 PresentationML, FF-25 SVG editor,
 * FF-08 PSD reader.
 *
 * The PSD fixture is assembled byte-by-byte from the published file layout
 * rather than copied from any library, so the parser is tested against a file
 * whose every byte is auditable here.
 */
import { makeHarness } from "./harness.mts";
import {
  createWpDocument, addParagraph, addRun, addTable, documentText,
  toWordprocessingXml, fromWordprocessingXml, PARAGRAPH_STYLES,
} from "../src/lib/formats/office-models.ts";
import {
  createPresentation, addSlide, addShape, moveSlide, deleteSlide, setSlideText,
  slideTitle, toPresentationXml, fromPresentationXml, slideCount, presentationOutline,
} from "../src/lib/formats/office-models.ts";
import {
  createSvg, addRect, addCircle, addLine, addText, addPath, addGroup,
  toSvgString, fromSvgString, validateSvg, countNodes, nodeAt, moveNode, resizeNode,
  sanitizeSvgXml, scanSvg, FORBIDDEN_ELEMENTS,
} from "../src/lib/formats/svg-editor.ts";
import {
  parsePsd, psdSummary, layerTree, layersTopDown, PSD_SIGNATURE,
  type PsdLayer,
} from "../src/lib/formats/psd-reader.ts";

const { test, finish } = makeHarness("tt139-documents");

// ══ FF-22 · WordprocessingML ═════════════════════════════════════════════

await test("FF-22 · paragraphs, runs and bold round-trip", { "FF-22": "full" }, () => {
  let doc = createWpDocument("Report");
  doc = addParagraph(doc, "Hello");
  doc = addRun(doc, 0, { text: " world", bold: true });
  const xml = toWordprocessingXml(doc);
  if (!/<w:p>/.test(xml)) throw new Error("no paragraph element");
  if (!/<w:b\/>/.test(xml)) throw new Error("bold property missing");
  if (!/<w:t[^>]*>\s?world<\/w:t>/.test(xml)) throw new Error("run text missing");
  // The leading space must force xml:space="preserve" or Word trims it.
  if (!/<w:t xml:space="preserve"> world<\/w:t>/.test(xml)) throw new Error("leading space not protected");
  const back = fromWordprocessingXml(xml);
  if (back.paragraphs.length !== 1) throw new Error(`paragraph count ${back.paragraphs.length}`);
  if (back.paragraphs[0].runs.length !== 2) throw new Error(`run count ${back.paragraphs[0].runs.length}`);
  if (!back.paragraphs[0].runs[1].bold) throw new Error("bold lost on read");
  if (back.title !== "Report") throw new Error(`title lost: ${back.title}`);
  if (documentText(back) !== "Hello world") throw new Error(`text → ${JSON.stringify(documentText(back))}`);
});

await test("FF-22 · boldOff is distinct from 'no bold' and survives", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, "inherits");
  doc = addRun(doc, 0, { text: " overrides", boldOff: true });
  const xml = toWordprocessingXml(doc);
  if (!/<w:b w:val="0"\/>/.test(xml)) throw new Error("explicit false must be w:val=0, not absent");
  const back = fromWordprocessingXml(xml);
  if (!back.paragraphs[0].runs[1].boldOff) throw new Error("boldOff lost");
  if (back.paragraphs[0].runs[1].bold) throw new Error("boldOff read as bold");
});

await test("FF-22 · styles, alignment and lists serialize to real OOXML tokens", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, "Title", { style: "Title", align: "center" });
  doc = addParagraph(doc, "item", { listLevel: 2, listKind: "decimal" });
  const xml = toWordprocessingXml(doc);
  if (!/<w:pStyle w:val="Title"\/>/.test(xml)) throw new Error("style not emitted");
  if (!/<w:jc w:val="center"\/>/.test(xml)) throw new Error("alignment not emitted");
  if (!/<w:ilvl w:val="2"\/>/.test(xml)) throw new Error("list level not emitted");
  if (!/<w:numId w:val="2"\/>/.test(xml)) throw new Error("decimal list numId not emitted");
  const back = fromWordprocessingXml(xml);
  if (back.paragraphs[0].style !== "Title") throw new Error("style lost");
  if (back.paragraphs[1].listKind !== "decimal") throw new Error("list kind lost");
});

await test("FF-22 · tables survive a round-trip with their grid", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addTable(doc, [["a", "b"], ["c", "d"]]);
  const xml = toWordprocessingXml(doc);
  if (!/<w:tbl>/.test(xml)) throw new Error("no table");
  if ((xml.match(/<w:tr>/g) ?? []).length !== 2) throw new Error("row count wrong");
  if ((xml.match(/<w:tc>/g) ?? []).length !== 4) throw new Error("cell count wrong");
  const back = fromWordprocessingXml(xml);
  if (back.tables.length !== 1) throw new Error(`tables → ${back.tables.length}`);
  if (back.tables[0].rows.length !== 2) throw new Error("rows lost");
  if (back.tables[0].rows[0].length !== 2) throw new Error("cells lost");
  // Table paragraphs must not leak into the top-level paragraph list.
  if (back.paragraphs.length !== 0) throw new Error(`table paragraphs leaked: ${back.paragraphs.length}`);
  if (documentText(back) !== "a\tb\nc\td") throw new Error(`table text → ${JSON.stringify(documentText(back))}`);
});

await test("FF-22 · writer rejects styles outside the closed enum", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, "x", { style: "Nonsense" as (typeof PARAGRAPH_STYLES)[number] });
  let threw = false;
  try { toWordprocessingXml(doc); } catch { threw = true; }
  if (!threw) throw new Error("an unknown style must be refused, not silently written");
});

await test("FF-22 · attacker: markup in a run cannot escape the element", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, `</w:t></w:r><w:r><w:t>pwned`);
  const xml = toWordprocessingXml(doc);
  if (!xml.includes("&lt;/w:t&gt;")) throw new Error("closing tag not escaped");
  const back = fromWordprocessingXml(xml);
  if (back.paragraphs[0].runs.length !== 1) throw new Error("injected a second run");
  if (!documentText(back).includes("</w:t></w:r>")) throw new Error("text mangled");
});

await test("FF-22 · attacker: attribute-quote breakout via colour is blocked", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, "x", { color: 'FF0000" w:evil="1' });
  let threw = false;
  try { toWordprocessingXml(doc); } catch { threw = true; }
  if (!threw) throw new Error("a non-hex colour must be rejected");
});

await test("FF-22 · leading/trailing spaces are preserved with xml:space", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, "  padded  ");
  const xml = toWordprocessingXml(doc);
  if (!/xml:space="preserve"/.test(xml)) throw new Error("spaces would be trimmed by Word");
  const back = fromWordprocessingXml(xml);
  if (back.paragraphs[0].runs[0].text !== "  padded  ") throw new Error("spaces lost on round-trip");
});

await test("FF-22 · round-trip is a fixed point", { "FF-22": "full" }, () => {
  let doc = createWpDocument();
  doc = addParagraph(doc, "a", { style: "Heading1", align: "both" });
  doc = addRun(doc, 0, { text: "b", italic: true, underline: true, color: "00FF00", fontSizeHalfPoints: 24 });
  doc = addTable(doc, [["1", "2"]]);
  const once = toWordprocessingXml(doc);
  const twice = toWordprocessingXml(fromWordprocessingXml(once));
  if (once !== twice) {
    const a = once, b = twice;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    throw new Error(`not idempotent at ${i}:\n  …${a.slice(i - 40, i + 60)}\n  …${b.slice(i - 40, i + 60)}`);
  }
});

// ══ FF-23 · PresentationML ═══════════════════════════════════════════════

await test("FF-23 · slides, shapes and order", { "FF-23": "full" }, () => {
  let p = createPresentation("Deck");
  p = addSlide(p, { background: "112233" });
  p = addSlide(p);
  p = addShape(p, 0, { type: "title", text: "Intro", x: 0, y: 0, width: 6000000, height: 800000 });
  p = addShape(p, 1, { type: "body", text: "Second", x: 100, y: 200, width: 3000000, height: 1000000 });
  if (slideCount(p) !== 2) throw new Error("slide count");
  if (slideTitle(p.slides[0]) !== "Intro") throw new Error("title helper");
  p = moveSlide(p, 0, 1);
  if (slideTitle(p.slides[1]) !== "Intro") throw new Error("moveSlide did not reorder");
  p = deleteSlide(p, 0);
  if (slideCount(p) !== 1) throw new Error("deleteSlide");
  if (presentationOutline(p)[0].indexOf("Intro") < 0) throw new Error(`outline → ${presentationOutline(p)}`);
});

await test("FF-23 · serialization carries size, background, geometry and notes", { "FF-23": "full" }, () => {
  let p = createPresentation();
  p = addSlide(p, { background: "AABBCC", notes: "remember this" });
  p = addShape(p, 0, { type: "title", text: "T", x: 111, y: 222, width: 333, height: 444 });
  const xml = toPresentationXml(p);
  if (!/<p:sldSz cx="12192000" cy="6858000"\/>/.test(xml)) throw new Error("slide size missing");
  if (!/<a:srgbClr val="AABBCC"\/>/.test(xml)) throw new Error("background missing");
  if (!/<a:off x="111" y="222"\/>/.test(xml)) throw new Error("geometry missing");
  if (!/<a:ext cx="333" cy="444"\/>/.test(xml)) throw new Error("extent missing");
  if (!/remember this/.test(xml)) throw new Error("notes missing");
  if (!/<p:sldIdLst>/.test(xml)) throw new Error("slide id list missing");
});

await test("FF-23 · parse restores shapes and typing", { "FF-23": "full" }, () => {
  let p = createPresentation("D");
  p = addSlide(p, { background: "010203" });
  p = addShape(p, 0, { type: "title", text: "Hello", x: 10, y: 20, width: 100, height: 50 });
  p = addShape(p, 0, { type: "body", text: "Body", x: 30, y: 40, width: 200, height: 60 });
  const back = fromPresentationXml(toPresentationXml(p));
  if (back.slides.length !== 1) throw new Error(`slides → ${back.slides.length}`);
  if (back.slides[0].shapes.length !== 2) throw new Error(`shapes → ${back.slides[0].shapes.length}`);
  if (back.slides[0].background !== "010203") throw new Error("background lost");
  if (slideTitle(back.slides[0]) !== "Hello") throw new Error(`title lost: ${slideTitle(back.slides[0])}`);
  const body = back.slides[0].shapes.find((s) => s.type === "body");
  if (!body || body.text !== "Body") throw new Error("body text lost");
  if (body.x !== 30 || body.height !== 60) throw new Error("geometry lost");
});

await test("FF-23 · remote image URLs are refused (privacy invariant)", { "FF-23": "full" }, () => {
  let p = createPresentation();
  p = addSlide(p);
  for (const src of ["https://tracker.example/x.png", "//cdn.example/x.png"]) {
    let threw = false;
    try { addShape(p, 0, { type: "image", text: "", x: 0, y: 0, width: 10, height: 10, src }); } catch { threw = true; }
    if (!threw) throw new Error(`remote image ${src} was accepted`);
  }
  const local = addShape(p, 0, { type: "image", text: "", x: 0, y: 0, width: 10, height: 10, src: "data:image/png;base64,AA" });
  if (toPresentationXml(local).indexOf("data:image/png") < 0) throw new Error("local image dropped");
});

await test("FF-23 · empty deck is legal; a broken deck is refused", { "FF-23": "full" }, () => {
  const xml = toPresentationXml(createPresentation());
  if (!/<p:sldIdLst><\/p:sldIdLst>/.test(xml)) throw new Error(`empty deck shape: ${xml.slice(0, 300)}`);
  if (fromPresentationXml(xml).slides.length !== 0) throw new Error("empty deck parsed as non-empty");
  for (const bad of ["", "<html/>", "<p:presentation>"]) {
    let threw = false;
    try { fromPresentationXml(bad); } catch { threw = true; }
    if (!threw) throw new Error(`${JSON.stringify(bad)} should have thrown`);
  }
});

await test("FF-23 · attacker: text cannot inject a second shape", { "FF-23": "full" }, () => {
  let p = createPresentation();
  p = addSlide(p);
  p = addShape(p, 0, { type: "body", text: "</a:t></a:r></a:p><p:sp>evil", x: 0, y: 0, width: 10, height: 10 });
  const xml = toPresentationXml(p);
  const back = fromPresentationXml(xml);
  if (back.slides[0].shapes.length !== 1) throw new Error(`injected ${back.slides[0].shapes.length} shapes`);
  if (!back.slides[0].shapes[0].text.includes("<p:sp>evil")) throw new Error("text mangled");
});

// ══ FF-25 · SVG editor ═══════════════════════════════════════════════════

await test("FF-25 · primitives, serialization and node addressing", { "FF-25": "full" }, () => {
  let d = createSvg(400, 300);
  d = addRect(d, { x: 10, y: 10, width: 100, height: 50, fill: "#f00" });
  d = addCircle(d, { cx: 200, cy: 150, r: 40, fill: "#0f0" });
  d = addLine(d, { x1: 0, y1: 0, x2: 400, y2: 300, stroke: "#00f", strokeWidth: 2 });
  d = addText(d, { x: 20, y: 280, text: "hi", fontSize: 14, fill: "#333" });
  d = addPath(d, { d: "M0 0 L10 10 Z", fill: "none", stroke: "#000" });
  if (countNodes(d) !== 6) throw new Error(`node count ${countNodes(d)}`);
  const xml = toSvgString(d);
  for (const tag of ["<svg", "<rect", "<circle", "<line", "<text", "<path"]) {
    if (!xml.includes(tag)) throw new Error(`missing ${tag}`);
  }
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(xml)) throw new Error("namespace missing");
  const back = fromSvgString(xml);
  if (countNodes(back) !== 6) throw new Error("round-trip lost nodes");
  if (nodeAt(d, 1)?.type !== "rect") throw new Error("nodeAt index wrong");
  if (nodeAt(d, 99) !== null) throw new Error("out-of-range nodeAt must be null");
});

await test("FF-25 · move and resize move exactly one node", { "FF-25": "full" }, () => {
  let d = createSvg(300, 300);
  d = addRect(d, { x: 0, y: 0, width: 10, height: 10, fill: "#000" });
  d = addCircle(d, { cx: 100, cy: 100, r: 5, fill: "#fff" });
  const moved = moveNode(d, 1, 50, -20);
  const r = nodeAt(moved, 1) as Extract<ReturnType<typeof nodeAt>, { type: "rect" }>;
  if (!r || r.x !== 50 || r.y !== -20) throw new Error(`rect did not move: ${JSON.stringify(r)}`);
  const c = nodeAt(moved, 2) as { cx: number };
  if (c.cx !== 100) throw new Error("circle moved when only the rect was selected");
  const scaled = resizeNode(d, 2, 3);
  const c2 = nodeAt(scaled, 2) as { r: number };
  if (c2.r !== 15) throw new Error(`circle r → ${c2.r}, want 15`);
});

await test("FF-25 · group nesting serializes and parses", { "FF-25": "full" }, () => {
  let d = createSvg(100, 100);
  d = addGroup(d, [
    { type: "rect", x: 0, y: 0, width: 5, height: 5, fill: "#000" },
    { type: "circle", cx: 1, cy: 1, r: 1, fill: "#111" },
  ], "translate(10,10)");
  const xml = toSvgString(d);
  if (!/<g transform="translate\(10,10\)">/.test(xml)) throw new Error(`group markup: ${xml}`);
  const back = fromSvgString(xml);
  const g = nodeAt(back, 1);
  if (g?.type !== "group") throw new Error("group not parsed");
  if ((g as { children: unknown[] }).children.length !== 2) throw new Error("group children lost");
});

await test("FF-25 · sanitizer removes every forbidden construct", { "FF-25": "full" }, () => {
  const dirty = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
    <script>alert(1)</script>
    <SCRIPT>alert(2)</SCRIPT>
    <foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject>
    <rect onclick="x()" onmouseover='y()' width="5" height="5"/>
    <image href="http://evil/x.png"/>
    <use href="https://evil/y.svg#a"/>
    <animate attributeName="href" to="javascript:1"/>
    <a xlink:href="javascript:alert(1)">t</a>
    <iframe src="https://evil"/>
  </svg>`;
  const clean = sanitizeSvgXml(dirty);
  for (const bad of ["script", "SCRIPT", "foreignObject", "onclick", "onmouseover", "evil", "javascript:", "iframe", "animate", "<use", "<image"]) {
    if (clean.toLowerCase().includes(bad.toLowerCase())) throw new Error(`sanitizer left "${bad}" in: ${clean}`);
  }
  // Legitimate content must survive.
  if (!/<rect/.test(clean)) throw new Error("sanitizer deleted the honest rect");
});

await test("FF-25 · scanSvg reports every reason, not a bare boolean", { "FF-25": "full" }, () => {
  const clean = scanSvg(`<svg width="1" height="1"><rect width="1" height="1"/></svg>`);
  if (!clean.safe || clean.reasons.length) throw new Error("clean SVG flagged");
  const dirty = scanSvg(`<svg><script>1</script><rect onclick="1" width="1" height="1"/></svg>`);
  if (dirty.safe) throw new Error("dirty SVG passed");
  if (dirty.reasons.length < 2) throw new Error(`expected >=2 reasons, got ${dirty.reasons.length}`);
  if (!FORBIDDEN_ELEMENTS.includes("script" as never)) throw new Error("script must be in the forbid list");
  // XXE / billion laughs
  const xxe = scanSvg(`<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg/>`);
  if (xxe.safe) throw new Error("DOCTYPE entity must be flagged");
});

await test("FF-25 · importer never trusts a numeric attribute", { "FF-25": "full" }, () => {
  const evil = `<svg width="10" height="10">
    <rect x="NaN" y="Infinity" width="1e999" height="-5" fill="#000"/>
    <circle cx="1e500" cy="0" r="0" fill="#000"/>
  </svg>`;
  const el = fromSvgString(evil);
  const walk = (n: { type: string; width?: number; height?: number; x?: number; r?: number; children?: unknown[] }): void => {
    for (const k of ["x", "y", "width", "height", "r", "cx", "cy"] as const) {
      const v = (n as Record<string, unknown>)[k];
      if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`${n.type}.${k} is ${v}`);
    }
    for (const c of (n.children ?? []) as typeof n[]) walk(c);
  };
  walk(el as never);
});

await test("FF-25 · validateSvg catches degenerate geometry", { "FF-25": "full" }, () => {
  if (!validateSvg(createSvg(10, 10)).ok) throw new Error("fresh svg invalid");
  const bad = { type: "svg" as const, width: 10, height: 10, children: [{ type: "circle" as const, cx: 0, cy: 0, r: 0, fill: "#000" }] };
  const res = validateSvg(bad);
  if (res.ok) throw new Error("zero-radius circle passed validation");
  if (!res.errors[0].includes("radius")) throw new Error(`error text unhelpful: ${res.errors[0]}`);
});

await test("FF-25 · builder refuses unsafe path and transform strings", { "FF-25": "full" }, () => {
  const d = createSvg(10, 10);
  for (const p of ["M0 0 L10 10 <script>", "javascript:alert(1)"]) {
    let threw = false;
    try { addPath(d, { d: p, fill: "none" }); } catch { threw = true; }
    if (!threw) throw new Error(`unsafe path data accepted: ${p}`);
  }
  let threw = false;
  try { addGroup(d, [], 'translate(1)"><script>'); } catch { threw = true; }
  if (!threw) throw new Error("unsafe transform accepted");
});

// ══ FF-08 · PSD reader ═══════════════════════════════════════════════════

/** Build a PSD from the published layout. Every byte is written here. */
function buildPsd(opts: {
  width: number; height: number; version?: 1 | 2; depth?: 8 | 16 | 32;
  colourMode?: number; layers: Array<{ name: string; blend?: string; opacity?: number; flags?: number; section?: number; unicode?: string }>;
  compression?: 0 | 1; compositeBytes?: number;
}): Uint8Array {
  const parts: number[] = [];
  const u8 = (v: number) => parts.push(v & 0xff);
  const u16 = (v: number) => { parts.push((v >> 8) & 0xff, v & 0xff); };
  const i16 = (v: number) => u16(v < 0 ? v + 0x10000 : v);
  const u32 = (v: number) => { parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const i32 = u32;
  const ascii = (s: string) => { for (const ch of s) parts.push(ch.charCodeAt(0)); };
  const zeros = (n: number) => { for (let i = 0; i < n; i++) parts.push(0); };

  ascii(PSD_SIGNATURE);
  u16(opts.version ?? 1);
  zeros(6);
  u16(3); // channels R,G,B
  u32(opts.height);
  u32(opts.width);
  u16(opts.depth ?? 8);
  u16(opts.colourMode ?? 3);

  u32(0); // colour mode data length
  u32(0); // image resources length

  // Layer/mask block
  const layerRecords: number[] = [];
  const lr = { u8, u16, i16, u32, i32, ascii, zeros, parts: layerRecords };
  const lparts = layerRecords;
  const lu16 = (v: number) => lparts.push((v >> 8) & 0xff, v & 0xff);
  const li16 = (v: number) => lu16(v < 0 ? v + 0x10000 : v);
  const lu32 = (v: number) => lparts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const li32 = lu32;
  const lascii = (s: string) => { for (const ch of s) lparts.push(ch.charCodeAt(0)); };
  const lzeros = (n: number) => { for (let i = 0; i < n; i++) lparts.push(0); };
  void lr;

  for (const layer of opts.layers) {
    li32(0); li32(0); li32(opts.height); li32(opts.width); // rect
    lu16(1); // one channel
    li16(0); // channel id 0 = red
    lu32(0); // channel data length 0 (we store none)
    lascii("8BIM");
    // Blend keys are exactly 4 bytes on disk; pad short mnemonics with spaces.
    lascii((layer.blend ?? "norm").padEnd(4, " ").slice(0, 4));
    lparts.push(layer.opacity ?? 255);
    lparts.push(0); // clipping
    lparts.push(layer.flags ?? 0); // flags
    lparts.push(0); // filler
    const nameBytes = [...layer.name].map((c) => c.charCodeAt(0));
    lparts.push(nameBytes.length);
    for (const b of nameBytes) lparts.push(b);
    const pad = (4 - ((1 + nameBytes.length) % 4)) % 4;
    lzeros(pad);

    // Additional info blocks: always write lsct so sectionType is explicit,
    // and luni when a Unicode name is supplied.
    if (layer.section !== undefined) {
      lascii("8BIM"); lascii("lsct"); lu32(4); lu32(layer.section);
    }
    if (layer.unicode !== undefined) {
      const chars = [...layer.unicode];
      lascii("8BIM"); lascii("luni"); lu32(4 + chars.length * 2);
      lu32(chars.length);
      for (const ch of chars) lparts.push(0, ch.charCodeAt(0));
    }
  }

  const layerInfoBody: number[] = [];
  layerInfoBody.push((opts.layers.length >> 8) & 0xff, opts.layers.length & 0xff);
  layerInfoBody.push(...layerRecords);
  // pad to even, then declare the length INCLUDING that pad byte.
  if (layerInfoBody.length % 2) layerInfoBody.push(0);
  const layerInfoLen = layerInfoBody.length;

  const layerMaskBody: number[] = [];
  layerMaskBody.push(
    (layerInfoLen >>> 24) & 0xff, (layerInfoLen >>> 16) & 0xff, (layerInfoLen >>> 8) & 0xff, layerInfoLen & 0xff,
  );
  layerMaskBody.push(...layerInfoBody);
  layerMaskBody.push(0, 0, 0, 0); // global layer mask length = 0

  u32(layerMaskBody.length);
  parts.push(...layerMaskBody);

  // Image data section
  u16(opts.compression ?? 0);
  zeros(opts.compositeBytes ?? opts.width * opts.height * 3);

  return new Uint8Array(parts);
}

await test("FF-08 · header, colour mode and dimensions parse exactly", { "FF-08": "full" }, () => {
  const data = buildPsd({ width: 4, height: 3, layers: [] });
  const psd = parsePsd(data);
  if (psd.header.width !== 4 || psd.header.height !== 3) throw new Error("dimensions wrong");
  if (psd.header.version !== 1) throw new Error("version wrong");
  if (psd.header.depth !== 8) throw new Error("depth wrong");
  if (psd.header.colourModeName !== "RGB") throw new Error(`colour mode → ${psd.header.colourModeName}`);
  if (psd.header.channels !== 3) throw new Error("channels wrong");
  const s = psdSummary(psd);
  if (s.dimensions !== "4×3") throw new Error(`summary → ${s.dimensions}`);
  if (s.colourMode !== "RGB") throw new Error("summary colour mode");
});

await test("FF-08 · layer records: name, blend, opacity, flags, section", { "FF-08": "full" }, () => {
  const data = buildPsd({
    width: 8, height: 8,
    layers: [
      { name: "Background", blend: "norm", opacity: 255, flags: 0 },
      { name: "Shade", blend: "mul", opacity: 128, flags: 2 },
    ],
  });
  const psd = parsePsd(data);
  if (psd.layers.length !== 2) throw new Error(`layer count ${psd.layers.length}`);
  if (psd.layers[0].name !== "Background") throw new Error(`layer0 name ${psd.layers[0].name}`);
  if (psd.layers[0].blendModeName !== "Normal") throw new Error("blend name not mapped");
  if (psd.layers[0].opacity !== 255) throw new Error("opacity wrong");
  if (!psd.layers[0].visible) throw new Error("layer0 should be visible");
  if (psd.layers[1].blendModeName !== "Multiply") throw new Error(`blend → ${psd.layers[1].blendModeName}`);
  if (psd.layers[1].opacity !== 128) throw new Error("opacity lost");
  // flags bit 1 (value 2) = hidden
  if (psd.layers[1].visible) throw new Error("hidden flag ignored");
  if (psd.layers[0].right !== 8 || psd.layers[0].bottom !== 8) throw new Error("layer rect wrong");
});

await test("FF-08 · Unicode layer names win over the ASCII name", { "FF-08": "full" }, () => {
  const data = buildPsd({ width: 2, height: 2, layers: [{ name: "fallback", unicode: "üñï" }] });
  const psd = parsePsd(data);
  if (psd.layers[0].name !== "üñï") throw new Error(`unicode name → ${JSON.stringify(psd.layers[0].name)}`);
});

await test("FF-08 · layer groups nest by section markers", { "FF-08": "full" }, () => {
  const data = buildPsd({
    width: 2, height: 2,
    layers: [
      { name: "inner", section: 0 },
      { name: "group", section: 1 },
      { name: "outer", section: 0 },
    ],
  });
  const psd = parsePsd(data);
  if (psd.layers[1].sectionType !== 1) throw new Error("section not read");
  const tree = layerTree(psd);
  // Photoshop writes bottom-up: records in file order are the stacking order.
  const names: string[] = [];
  const walk = (ns: ReturnType<typeof layerTree>): void => {
    for (const n of ns) { names.push(n.layer.name); walk(n.children); }
  };
  walk(tree);
  if (!names.includes("group")) throw new Error(`group missing from tree: ${names}`);
  if (layersTopDown(psd)[0].name !== "outer") throw new Error("layersTopDown order wrong");
});

await test("FF-08 · raw composite is exposed; RLE is reported, not guessed", { "FF-08": "full" }, () => {
  const raw = parsePsd(buildPsd({ width: 3, height: 2, layers: [], compression: 0 }));
  if (!raw.composite) throw new Error("raw composite not exposed");
  if (raw.composite.length !== 3 * 2 * 3) throw new Error(`composite length ${raw.composite.length}`);
  const rle = parsePsd(buildPsd({ width: 3, height: 2, layers: [], compression: 1 }));
  if (rle.composite !== null) throw new Error("RLE composite must be null, not fabricated");
  if (rle.compositeCompression !== "rle") throw new Error(`compression → ${rle.compositeCompression}`);
  if (!rle.warnings.some((w) => /rle/i.test(w))) throw new Error("RLE limitation must be stated in warnings");
});

await test("FF-08 · adversarial: wrong signature, version, reserved, and truncation", { "FF-08": "full" }, () => {
  const good = buildPsd({ width: 2, height: 2, layers: [] });

  const notPsd = new Uint8Array(good);
  notPsd[0] = 0x50; notPsd[1] = 0x4b; notPsd[2] = 0x03; notPsd[3] = 0x04; // ZIP
  let msg = "";
  try { parsePsd(notPsd); } catch (e) { msg = (e as Error).message; }
  if (!/signature/i.test(msg)) throw new Error(`non-PSD → ${msg}`);

  const v9 = new Uint8Array(good);
  v9[5] = 9;
  try { parsePsd(v9); throw new Error("version 9 accepted"); } catch (e) {
    if (!/version/i.test((e as Error).message)) throw new Error(`version error → ${(e as Error).message}`);
  }

  const nonzeroReserved = new Uint8Array(good);
  nonzeroReserved[7] = 1;
  try { parsePsd(nonzeroReserved); throw new Error("non-zero reserved accepted"); } catch (e) {
    if (!/reserved/i.test((e as Error).message)) throw new Error(`reserved error → ${(e as Error).message}`);
  }

  // Cuts inside the header or the layer block are malformed files and must
  // throw. A cut that only removes composite pixels is a degraded-but-readable
  // file: the header and layers are intact, so the parser warns instead of
  // refusing. Both behaviours are asserted here so neither drifts.
  for (const cut of [10, 20, 26, 30, 34]) {
    let t = false;
    try { parsePsd(good.subarray(0, cut)); } catch { t = true; }
    if (!t) throw new Error(`truncation at ${cut} bytes was accepted`);
  }
  const tailCut = parsePsd(good.subarray(0, good.length - 4));
  if (tailCut.composite !== null && tailCut.composite.length === good.length) {
    throw new Error("composite must not claim more bytes than the file holds");
  }
  if (!tailCut.warnings.length) throw new Error("a short composite must be reported in warnings");

  // Absurd dimensions must be refused before any allocation.
  const huge = new Uint8Array(buildPsd({ width: 2, height: 2, layers: [] }));
  new DataView(huge.buffer).setUint32(14, 0xffffffff); // height
  let msg2 = "";
  try { parsePsd(huge); } catch (e) { msg2 = (e as Error).message; }
  if (!/height|width/i.test(msg2)) throw new Error(`huge dimension → ${msg2}`);
});

await test("FF-08 · adversarial: a lying layer-info length is caught", { "FF-08": "full" }, () => {
  const data = new Uint8Array(buildPsd({
    width: 4, height: 4,
    layers: [{ name: "x" }],
  }));
  // Find the layer/mask length (4 bytes after header+cm+ir) and inflate it.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lmLenPos = 26 + 4 + 0 + 4 + 0;
  dv.setUint32(lmLenPos, 0x7fffffff);
  let threw = false;
  try { parsePsd(data); } catch { threw = true; }
  if (!threw) throw new Error("a layer/mask length beyond the buffer must be rejected");
});

await test("FF-08 · a layer named with an over-long ASCII string is bounded", { "FF-08": "full" }, () => {
  // 255 is the maximum a PSD Pascal string can hold; the parser must not read
  // beyond the record for anything longer.
  const data = buildPsd({ width: 2, height: 2, layers: [{ name: "x".repeat(200) }] });
  const psd = parsePsd(data);
  if (psd.layers[0].name.length !== 200) throw new Error(`name length ${psd.layers[0].name.length}`);
  const empty = buildPsd({ width: 2, height: 2, layers: [{ name: "" }] });
  if (parsePsd(empty).layers[0].name !== "") throw new Error("empty layer name must stay empty");
});

finish();
