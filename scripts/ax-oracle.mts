/**
 * Independent oracle for the Narrator (TT30, AX-14): compare OUR accessible names and roles (src/lib/narrator-core.ts
 * running on the live DOM, bundled from source by esbuild) with CHROMIUM's own accessibility tree, read over the
 * DevTools protocol (Accessibility.getPartialAXTree) — the tree Chromium exposes to platform screen readers
 * (NVDA/JAWS via IA2/UIA, Orca via ATK, VoiceOver via NSAccessibility). Used by e2e-tt30.mts.
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";

let bundle: string | null = null;
/** a source mutation for oracle-sensitivity tests: in `file`, replace `from` (must occur) with `to` */
export type Mutation = { file: string; from: string; to: string };
export async function narratorBundle(mutations: Mutation[] = []): Promise<string> {
  if (bundle && !mutations.length) return bundle;
  const r = await build({
    plugins: mutations.length ? [{ name: "mutate", setup(b) {
      b.onLoad({ filter: /narrator-(core|dom)\.ts$/ }, (args) => {
        let src = readFileSync(args.path, "utf8");
        for (const m of mutations) if (args.path.endsWith(m.file)) { if (!src.includes(m.from)) throw new Error(`mutation anchor missing in ${m.file}: ${m.from}`); src = src.replace(m.from, m.to); }
        return { contents: src, loader: "ts" };
      });
    } }] : [],
    stdin: { contents: `import * as C from "./src/lib/narrator-core.ts"; import { nn, el } from "./src/lib/narrator-dom.ts"; (window as any).__nx = { C, nn, el };`, resolveDir: process.cwd(), loader: "ts" },
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
  });
  if (mutations.length) return r.outputFiles[0].text;
  bundle = r.outputFiles[0].text;
  return bundle;
}

/** roles worth comparing: everything a reader stops on or announces as context */
export const COMPARE = ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "spinbutton", "switch", "tab", "tablist", "tabpanel", "menuitem", "menuitemcheckbox", "menuitemradio", "menu", "menubar", "listbox", "option", "heading", "dialog", "alertdialog", "navigation", "main", "banner", "contentinfo", "complementary", "region", "img", "progressbar", "meter", "toolbar", "radiogroup", "tree", "treeitem", "grid", "table", "status", "alert", "group", "form", "search", "separator", "list", "row", "cell", "gridcell", "columnheader", "rowheader"];
/** independent of OUR role computation: elements that are interactive or structural by markup, so a node we
 *  misclassify as generic is still compared (otherwise a mutant could escape by dropping out of the sample) */
export const MARKUP = "a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex],[role],[contenteditable=true],h1,h2,h3,h4,h5,h6,img,svg[aria-label],nav,main,header,footer,aside,section,form,dialog,table,tr,td,th,ul,ol,li,fieldset,progress,meter,hr,output";
/** Chromium role strings that differ from the ARIA spelling */
const CR: Record<string, string> = { image: "img", searchbox: "searchbox", ListMarker: "", LabelText: "", StaticText: "", none: "none", presentation: "none", generic: "generic", "DisclosureTriangle": "button", "PopUpButton": "combobox", ColorWell: "colorwell", date: "date", DateTime: "datetime", InputTime: "time" };
const normRole = (r: string) => (r in CR ? CR[r] : r);
const norm = (s: string) => s.replace(/[\s\u00a0]+/g, " ").trim();

export interface AxRow { i: number; tag: string; ours: { name: string; role: string }; chromium: { name: string; role: string; ignored: boolean }; where: string; html: string }
export interface AxReport { rows: AxRow[]; nameAgree: number; roleAgree: number; compared: number; nameMismatch: AxRow[]; roleMismatch: AxRow[] }

export async function compareWithChromium(page: Page, scope = "body", mutations: Mutation[] = []): Promise<AxReport> {
  if (mutations.length || !(await page.evaluate(() => "__nx" in window))) await page.addScriptTag({ content: await narratorBundle(mutations) });
  const ours = await page.evaluate(([sel, roles, markup]) => {
    const { C, nn } = (window as unknown as { __nx: { C: typeof import("../src/lib/narrator-core.ts"); nn: (n: Node) => import("../src/lib/narrator-core.ts").NNode } }).__nx;
    document.querySelectorAll("[data-nx]").forEach((e) => e.removeAttribute("data-nx"));
    const out: { i: number; tag: string; name: string; role: string; where: string; html: string }[] = [];
    const rootEl = document.querySelector(sel) ?? document.body;
    let i = 0;
    for (const e of Array.from(rootEl.querySelectorAll("*"))) {
      if (e.closest("[data-narrator-ui]")) continue;
      const n = nn(e);
      if (n.hidden()) continue;
      const role = C.roleOf(n);
      if (!roles.includes(role) && !e.matches(markup)) continue;
      e.setAttribute("data-nx", String(i));
      const win = e.closest("[data-win-id]")?.getAttribute("data-win-id") ?? "shell";
      out.push({ i, tag: e.tagName.toLowerCase(), name: C.accName(n), role, where: win, html: e.outerHTML.slice(0, 160) });
      i++;
    }
    return out;
  }, [scope, COMPARE, MARKUP] as const);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable"); await cdp.send("Accessibility.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-nx]" });
  const rows: AxRow[] = [];
  for (const nodeId of nodeIds) {
    const { attributes } = await cdp.send("DOM.getAttributes", { nodeId });
    const k = attributes.indexOf("data-nx");
    const idx = Number(attributes[k + 1]);
    const o = ours.find((x) => x.i === idx);
    if (!o) continue;
    const ax = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    const me = ax.nodes[0];
    rows.push({
      i: idx, tag: o.tag, where: o.where, html: o.html,
      ours: { name: norm(o.name), role: o.role },
      chromium: { name: norm(String(me?.name?.value ?? "")), role: normRole(String(me?.role?.value ?? "")), ignored: !!me?.ignored },
    });
  }
  await cdp.detach();
  await page.evaluate(() => document.querySelectorAll("[data-nx]").forEach((e) => e.removeAttribute("data-nx")));
  const live = rows.filter((r) => !r.chromium.ignored);
  const nameMismatch = live.filter((r) => r.ours.name !== r.chromium.name);
  const roleMismatch = live.filter((r) => r.ours.role !== r.chromium.role);
  return { rows, compared: live.length, nameAgree: live.length ? 1 - nameMismatch.length / live.length : 1, roleAgree: live.length ? 1 - roleMismatch.length / live.length : 1, nameMismatch, roleMismatch };
}
