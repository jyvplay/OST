/**
 * TT54 (FF-13) — XMP packet reader (ISO 16684-1 RDF/XML subset), original code. A tolerant tokenizer builds
 * an element tree; namespace URIs (not the prefixes a file happens to use) decide the property names, which
 * are reported with canonical prefixes ("dc:title", "xmp:Rating", ...). Collected: every property of every
 * rdf:Description, written as an attribute or as a child element holding text, an rdf:Alt (x-default first),
 * an rdf:Seq or an rdf:Bag (items joined with "; "). Structs and qualifiers are skipped. Never resolves
 * entities beyond the five predefined ones and numeric references (no DTD, no external fetch: XXE-proof).
 */

export const XMP_NS: Record<string, string> = {
  "http://purl.org/dc/elements/1.1/": "dc",
  "http://ns.adobe.com/xap/1.0/": "xmp",
  "http://ns.adobe.com/xap/1.0/rights/": "xmpRights",
  "http://ns.adobe.com/xap/1.0/mm/": "xmpMM",
  "http://ns.adobe.com/photoshop/1.0/": "photoshop",
  "http://ns.adobe.com/exif/1.0/": "exif",
  "http://ns.adobe.com/tiff/1.0/": "tiff",
  "http://ns.adobe.com/lightroom/1.0/": "lr",
  "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/": "Iptc4xmpCore",
  "http://ns.adobe.com/pdf/1.3/": "pdf",
  "http://ns.adobe.com/camera-raw-settings/1.0/": "crs",
};
const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

interface El { name: string; attrs: [string, string][]; kids: El[]; text: string; ns: Map<string, string> }

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k[0] === "#") { const cp = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[k] ?? m;
  });
}

function parse(xml: string): El | null {
  const root: El = { name: "#root", attrs: [], kids: [], text: "", ns: new Map([["xml", XML_NS]]) };
  const stack: El[] = [root]; let i = 0; let guard = 0;
  while (i < xml.length && guard++ < 2_000_000) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].text += xml.slice(i, lt);
    if (xml.startsWith("<!--", lt)) { const e = xml.indexOf("-->", lt + 4); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml.startsWith("<![CDATA[", lt)) { const e = xml.indexOf("]]>", lt); const t = xml.slice(lt + 9, e < 0 ? xml.length : e); stack[stack.length - 1].text += t.replace(/&/g, "&amp;").replace(/</g, "&lt;"); i = e < 0 ? xml.length : e + 3; continue; }
    if (xml[lt + 1] === "?" || xml[lt + 1] === "!") { const e = xml.indexOf(">", lt); i = e < 0 ? xml.length : e + 1; continue; }
    const gt = findTagEnd(xml, lt); if (gt < 0) break;
    const raw = xml.slice(lt + 1, gt);
    if (raw[0] === "/") { if (stack.length > 1) stack.pop(); i = gt + 1; continue; }
    const selfClose = raw.endsWith("/");
    const body = selfClose ? raw.slice(0, -1) : raw;
    const nm = body.match(/^[^\s/>]+/)?.[0] ?? "";
    const parent = stack[stack.length - 1];
    const el: El = { name: nm, attrs: [], kids: [], text: "", ns: new Map(parent.ns) };
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g; let m: RegExpExecArray | null;
    const rest = body.slice(nm.length);
    while ((m = re.exec(rest))) {
      const k = m[1], v = unescapeXml(m[3] ?? m[4] ?? "");
      if (k === "xmlns") el.ns.set("", v); else if (k.startsWith("xmlns:")) el.ns.set(k.slice(6), v); else el.attrs.push([k, v]);
    }
    parent.kids.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
    if (stack.length > 256) return null;
  }
  return root;
}
function findTagEnd(s: string, from: number): number {
  let q = ""; for (let i = from + 1; i < s.length; i++) { const c = s[i]; if (q) { if (c === q) q = ""; } else if (c === "\"" || c === "'") q = c; else if (c === ">") return i; }
  return -1;
}

const qname = (name: string, ns: Map<string, string>): [string, string] => {
  const c = name.indexOf(":"); const pre = c < 0 ? "" : name.slice(0, c), local = c < 0 ? name : name.slice(c + 1);
  return [ns.get(pre) ?? "", local];
};
const canon = (uri: string, local: string) => { const p = XMP_NS[uri]; return p ? `${p}:${local}` : null; };

/** XMP packet -> { "dc:title": "...", "xmp:Rating": "5", ... } (known namespaces only) */
export function readXmp(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const root = parse(xml); if (!root) return out;
  const walk = (el: El) => {
    const [uri, local] = qname(el.name, el.ns);
    if (uri === RDF && local === "Description") {
      for (const [k, v] of el.attrs) { const [u, l] = qname(k, el.ns); const c = canon(u, l); if (c && !(c in out)) out[c] = v.trim(); }
      for (const p of el.kids) {
        const [u, l] = qname(p.name, p.ns); const c = canon(u, l); if (!c || c in out) continue;
        const v = propValue(p); if (v !== null) out[c] = v;
      }
    }
    for (const k of el.kids) walk(k);
  };
  walk(root);
  return out;
}

function propValue(p: El): string | null {
  const container = p.kids.find((k) => { const [u, l] = qname(k.name, k.ns); return u === RDF && (l === "Alt" || l === "Seq" || l === "Bag"); });
  if (container) {
    const [, kind] = qname(container.name, container.ns);
    const items = container.kids.filter((k) => { const [u, l] = qname(k.name, k.ns); return u === RDF && l === "li"; });
    if (kind === "Alt") {
      const lang = (k: El) => k.attrs.find(([a]) => { const [u, l] = qname(a, k.ns); return u === XML_NS && l === "lang"; })?.[1];
      const best = items.find((k) => lang(k) === "x-default") ?? items[0];
      return best ? unescapeXml(best.text).trim() : "";
    }
    return items.map((k) => unescapeXml(k.text).trim()).filter(Boolean).join("; ");
  }
  if (p.kids.length) return null; // struct / resource: not a simple property
  const res = p.attrs.find(([a]) => { const [u, l] = qname(a, p.ns); return u === RDF && l === "resource"; });
  if (res) return res[1];
  return unescapeXml(p.text).trim();
}
