import { readCentralDirectory, readEntryVerified, writeZip } from "../server/zip";

/**
 * Clean-room PresentationML subset, based on ECMA-376 / ISO/IEC 29500 Part 1
 * and Microsoft's fetched "Structure of a PresentationML document" reference:
 * a valid minimal package needs presentation, slide master, slide layout, theme,
 * and one or more slide parts, related through OPC .rels parts. This module
 * writes exactly that minimum structure, with editable title/body text boxes.
 *
 * Not implemented: animations, transitions, audio/video, charts, speaker-note
 * parts, master/layout editor, fonts/paragraph formatting, SmartArt, embedded
 * objects, image editing. Imported decks flatten each slide to title + body text;
 * re-export is a NEW package (grade C), not a round-trip of unsupported parts.
 */
export interface SlideModel { title: string; body: string[]; notes: string }
export interface DeckModel { title: string; slides: SlideModel[] }

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
/** TT72: XML 1.0 §3.1 attributes — '…' or "…", optional spaces around "=" */
const attr = (s: string) => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1], dec(m[2] ?? m[3])]));

function balanced(xml: string, tag: string) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}\\s*>`, "g");
  const out: string[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</")) continue;
    const start = re.lastIndex; let depth = 1; let end: RegExpExecArray | null = null;
    while (depth && (end = re.exec(xml))) { if (end[0].startsWith("</")) depth--; else if (!end[0].endsWith("/>")) depth++; }
    if (!end) break;
    out.push(xml.slice(start, end.index));
  }
  return out;
}

export function readPptx(buf: Buffer): DeckModel {
  const entries = readCentralDirectory(buf);
  const get = (name: string) => { const e = entries.find((x) => x.name === name); return e ? readEntryVerified(buf, e).toString("utf8") : null; };
  const pres = get("ppt/presentation.xml");
  if (!pres) throw new Error("not a PresentationML package: ppt/presentation.xml missing");
  const rels = get("ppt/_rels/presentation.xml.rels") ?? "";
  const relMap = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)) { const a = attr(m[1]); if (a.Id && a.Target) relMap.set(a.Id, a.Target.replace(/^\//, "")); }
  const slideRefs = [...pres.matchAll(/<p:sldId\b([^>]*)\/?\s*>/g)].map((m) => attr(m[1])["r:id"]).filter(Boolean) as string[];
  const slides: SlideModel[] = [];
  for (const rid of slideRefs) {
    const target = relMap.get(rid);
    if (!target) continue;
    const slidePath = target.startsWith("ppt/") ? target : `ppt/${target}`;
    const xml = get(slidePath);
    if (!xml) continue;
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => dec(m[1]));
    slides.push({ title: texts[0] ?? "", body: texts.slice(1), notes: "" });
  }
  return { title: "Imported presentation", slides };
}

const groupTree = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
function textShape(id: number, name: string, text: string, x: number, y: number, w: number, h: number, fontSize: number, bold = false): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720"/><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr lang="en-US" sz="${fontSize}"${bold ? " b=\"1\"" : ""}/><a:t xml:space="preserve">${esc(text)}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

export function writePptx(deck: DeckModel): Buffer {
  if (deck.slides.length > 200) throw new Error("this engine caps a deck at 200 slides");
  const relList = [
    `<Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/>`,
    ...deck.slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="${R}/slide" Target="slides/slide${i + 1}.xml"/>`),
  ];
  const pres = `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`;
  const slideMaster = `<?xml version="1.0" encoding="UTF-8"?><p:sldMaster xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
  const slideLayout = `<?xml version="1.0" encoding="UTF-8"?><p:sldLayout xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${groupTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const theme = `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="${A}" name="Fusion"><a:themeElements><a:clrScheme name="Fusion"><a:dk1><a:srgbClr val="111827"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="334155"/></a:dk2><a:lt2><a:srgbClr val="F1F5F9"/></a:lt2><a:accent1><a:srgbClr val="5B8CFF"/></a:accent1><a:accent2><a:srgbClr val="39D98A"/></a:accent2><a:accent3><a:srgbClr val="FFC453"/></a:accent3><a:accent4><a:srgbClr val="FF6B6B"/></a:accent4><a:accent5><a:srgbClr val="B14BFF"/></a:accent5><a:accent6><a:srgbClr val="06B6D4"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Fusion"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="Fusion"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`;
  const masterRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme1.xml"/></Relationships>`;
  const layoutRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  const presentationRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relList.join("")}</Relationships>`;
  const slideParts = deck.slides.map((s, i) => {
    const bodyText = s.body.map((t, j) => textShape(j + 3, `Body ${j + 1}`, t, 685800, 1752600 + j * 520000, 7772400, 450000, 2000, false)).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${groupTree}${textShape(2, "Title 1", s.title, 685800, 350000, 7772400, 950000, 3200, true)}${bodyText}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    const rel = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;
    return [
      { name: `ppt/slides/slide${i + 1}.xml`, data: Buffer.from(xml) },
      { name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: Buffer.from(rel) },
    ];
  }).flat();
  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes) },
    { name: "_rels/.rels", data: Buffer.from(rootRels) },
    { name: "ppt/presentation.xml", data: Buffer.from(pres) },
    { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from(presentationRels) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: Buffer.from(slideMaster) },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: Buffer.from(masterRels) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: Buffer.from(slideLayout) },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: Buffer.from(layoutRels) },
    { name: "ppt/theme/theme1.xml", data: Buffer.from(theme) },
    ...slideParts,
  ];
  return writeZip(entries);
}
