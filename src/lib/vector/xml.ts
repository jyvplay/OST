/**
 * Minimal, safe XML reader for SVG import (TT16, first-party; pure, Node + browser).
 * - Quoted attribute values may contain '>' (the competitor's indexOf('>') parser split such tags).
 * - Entities: the 5 predefined + numeric (&#…; / &#x…;). DOCTYPE internal subsets and custom entity declarations are
 *   SKIPPED, never expanded (no "billion laughs"); unknown named entities are left verbatim.
 * - Comments, processing instructions and CDATA handled; namespace prefixes kept in the tag name.
 * Not a validating parser: mismatched close tags pop to the nearest matching ancestor.
 */
export interface XNode { tag: string; attrs: Record<string, string>; children: (XNode | string)[] }

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}
export const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

export function parseXml(src: string, limits = { maxNodes: 200_000, maxDepth: 256 }): XNode {
  const root: XNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XNode[] = [root];
  let i = 0, nodes = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt + 9); top().children.push(src.slice(lt + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith("<?", lt)) { const e = src.indexOf("?>", lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src.startsWith("<!", lt)) { i = skipDecl(lt); continue; }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt); const name = src.slice(lt + 2, e < 0 ? n : e).trim();
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { stack.length = k; break; }
      i = e < 0 ? n : e + 1; continue;
    }
    // start tag: scan respecting quotes
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const tag = src.slice(lt + 1, j);
    const attrs: Record<string, string> = {};
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === ">") { j++; break; }
      if (src[j] === "/" && src[j + 1] === ">") { selfClose = true; j += 2; break; }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const name = src.slice(j, k);
      j = k;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === "=") {
        j++;
        while (j < n && /\s/.test(src[j])) j++;
        const q = src[j];
        if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); attrs[name] = decodeEntities(src.slice(j + 1, e < 0 ? n : e)); j = e < 0 ? n : e + 1; }
        else { let e = j; while (e < n && !/[\s>]/.test(src[e])) e++; attrs[name] = decodeEntities(src.slice(j, e)); j = e; }
      } else if (name) attrs[name] = "";
      else j++;
    }
    if (++nodes > limits.maxNodes) throw new Error(`XML has more than ${limits.maxNodes} elements`);
    const node: XNode = { tag, attrs, children: [] };
    top().children.push(node);
    if (!selfClose) { if (stack.length > limits.maxDepth) throw new Error("XML nesting too deep"); stack.push(node); }
    i = j;
  }
  const first = root.children.find((c): c is XNode => typeof c !== "string");
  if (!first) throw new Error("no root element");
  return first;

  function top() { return stack[stack.length - 1]; }
  function pushText(t: string) { if (t) top().children.push(decodeEntities(t)); }
  function skipDecl(at: number): number {
    // <!DOCTYPE … [ internal subset ] > — skip balanced brackets; entity declarations are ignored
    let depth = 0;
    for (let k = at + 2; k < n; k++) {
      const c = src[k];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) return k + 1;
      else if (c === '"' || c === "'") { const e = src.indexOf(c, k + 1); if (e < 0) return n; k = e; }
    }
    return n;
  }
}

export const childEls = (n: XNode) => n.children.filter((c): c is XNode => typeof c !== "string");
export const localName = (tag: string) => (tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag);
export const textContent = (n: XNode): string => n.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
