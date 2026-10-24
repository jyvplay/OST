/**
 * Narrator core (TT30, AX-14): the screen-reader logic of Fusion's built-in reader, written for this repository from
 * the W3C texts' rules (Accessible Name and Description Computation 1.2 step order, HTML-AAM implicit roles, WAI-ARIA
 * states and live regions). No screen-reader source was consulted or copied.
 *
 * Everything here runs on the small NNode interface, not on the DOM, so the algorithms can be unit-tested on
 * hand-built trees (scripts/tt30-unit.mts). src/lib/narrator-dom.ts adapts real DOM nodes to NNode, and the e2e suite
 * compares this code's names and roles against Chromium's own accessibility tree (the tree platform screen readers
 * consume) as an independent oracle.
 */

export interface NNode {
  kind: "el" | "text";
  /** lowercase tag name ("" for text nodes) */
  tag: string;
  /** text-node content ("" for elements) */
  text: string;
  attr(name: string): string | null;
  children(): NNode[];
  parent(): NNode | null;
  /** not rendered (display:none, visibility:hidden, hidden) or aria-hidden="true" on itself or an ancestor */
  hidden(): boolean;
  byId(id: string): NNode | null;
  /** native <label> elements associated with a form control */
  labels(): NNode[];
  /** current value of a form control ("" otherwise); for <select>, the selected options' text */
  value(): string;
  /** block-level box (adds word breaks around its content in names from content) */
  block(): boolean;
  /** CSS generated text (::before / ::after), already unquoted */
  before(): string;
  after(): string;
  focusable(): boolean;
  /** native checkedness of checkbox / radio inputs (null when not applicable) */
  checked(): boolean | null;
  disabled(): boolean;
  same(o: NNode): boolean;
}

/* ------------------------------------------------------------------------------------------------ roles */
export const ARIA_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "button", "cell", "checkbox", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "dialog", "document", "feed", "figure", "form", "generic", "grid",
  "gridcell", "group", "heading", "img", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math",
  "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none", "note", "option",
  "paragraph", "presentation", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader",
  "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "switch", "tab", "table",
  "tablist", "tabpanel", "term", "textbox", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);
const inSectioning = (n: NNode) => { for (let p = n.parent(); p; p = p.parent()) if (p.kind === "el" && SECTIONING.has(p.tag)) return true; return false; };
const hasAncestorRole = (n: NNode, roles: string[]) => { for (let p = n.parent(); p; p = p.parent()) if (p.kind === "el" && roles.includes(roleOf(p))) return true; return false; };

/** Implicit role per HTML-AAM (subset covering every element Fusion renders); "" = no mapped role. */
export function implicitRole(n: NNode): string {
  if (n.kind !== "el") return "";
  const t = n.tag, a = (k: string) => n.attr(k);
  switch (t) {
    case "a": case "area": return a("href") !== null ? "link" : "generic";
    case "article": return "article";
    case "aside": return "complementary";
    case "button": return "button";
    case "datalist": return "listbox";
    case "details": return "group";
    case "dialog": return "dialog";
    case "fieldset": return "group";
    case "figure": return "figure";
    case "footer": return inSectioning(n) ? "generic" : "contentinfo";
    case "header": return inSectioning(n) ? "generic" : "banner";
    // HTML-AAM: form maps to the form landmark only when it has an accessible name
    case "form": return (a("aria-label") ?? "").trim() || a("aria-labelledby") || a("title") ? "form" : "generic";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
    case "hr": return "separator";
    case "img": return a("alt") === "" && !a("aria-label") && !a("aria-labelledby") && !a("title") ? "presentation" : "img";
    case "input": {
      const ty = (a("type") ?? "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "search") return a("list") ? "combobox" : "searchbox";
      if (["text", "email", "tel", "url", "password", ""].includes(ty)) return a("list") ? "combobox" : "textbox";
      if (ty === "file") return "button"; // Chromium exposes the file chooser as a button
      if (ty === "color") return "colorwell"; // no ARIA role (HTML-AAM); Chromium: ColorWell — spoken "colour picker"
      // date / time pickers: no ARIA role; Chromium exposes date, DateTime and InputTime
      if (["date", "month", "week"].includes(ty)) return "date";
      if (ty === "datetime-local") return "datetime";
      if (ty === "time") return "time";
      return ""; // hidden and unknown types
    }
    case "li": return "listitem";
    case "summary": return "button"; // the <details> disclosure control (Chromium: DisclosureTriangle)
    case "svg": return "img"; // SVG-AAM graphics-document; Chromium exposes an svg root as an image
    case "main": return "main";
    case "menu": case "ol": case "ul": return "list";
    case "nav": return "navigation";
    case "option": return "option";
    case "output": return "status";
    case "p": return "paragraph";
    case "progress": return "progressbar";
    case "meter": return "meter";
    case "search": return "search";
    case "section": return (a("aria-label") ?? "").trim() || a("aria-labelledby") || a("title") ? "region" : "generic";
    case "select": return a("multiple") !== null || Number(a("size") ?? 0) > 1 ? "listbox" : "combobox";
    case "table": return "table";
    case "tbody": case "thead": case "tfoot": return "rowgroup";
    case "tr": return "row";
    case "td": return hasAncestorRole(n, ["grid", "treegrid"]) ? "gridcell" : "cell";
    case "th": return a("scope") === "row" ? "rowheader" : "columnheader";
    case "textarea": return "textbox";
    case "div": case "span": case "b": case "i": case "small": case "strong": case "em": case "code": case "pre": case "label": case "kbd": return "generic";
    default: return "";
  }
}

/** Explicit role (first recognised token) or the implicit one; presentation/none on a focusable element is ignored. */
export function roleOf(n: NNode): string {
  if (n.kind !== "el") return "";
  const tokens = (n.attr("role") ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (!ARIA_ROLES.has(t)) continue;
    if ((t === "none" || t === "presentation") && (n.focusable() || n.attr("aria-label") || n.attr("aria-labelledby"))) break;
    return t === "presentation" ? "none" : t;
  }
  const r = implicitRole(n);
  return r === "presentation" ? "none" : r;
}

/** inside a <table role=grid|treegrid> (Chromium names those rows from content, plain data-table rows not) */
function inAriaGrid(n: NNode): boolean {
  for (let p = n.parent(); p; p = p.parent()) if (p.tag === "table") return /^(grid|treegrid)$/.test((p.attr("role") ?? "").trim());
  return false;
}
/* ------------------------------------------------------------------------------------------------ names */
/** roles whose accessible name may come from their content (WAI-ARIA "name from: contents") */
export const NAME_FROM_CONTENT = new Set([
  "button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab", "tooltip", "treeitem",
]);
const RANGE = new Set(["slider", "spinbutton", "progressbar", "scrollbar", "meter"]);
const TEXTLIKE = new Set(["textbox", "searchbox"]);
const norm = (s: string) => s.replace(/[\s\u00a0]+/g, " ").trim();

interface Ctx { inLabelledBy: boolean; inContent: boolean; visited: NNode[]; rootIsHiddenRef: boolean }

/** Accessible name of `n` (normalised). */
export function accName(n: NNode): string { return norm(nameOf(n, { inLabelledBy: false, inContent: false, visited: [], rootIsHiddenRef: false }, true)); }

function seen(ctx: Ctx, n: NNode) { return ctx.visited.some((v) => v.same(n)); }

function nameOf(n: NNode, ctx: Ctx, isRoot: boolean): string {
  if (n.kind === "text") return n.text;
  if (seen(ctx, n)) return "";
  ctx = { ...ctx, visited: [...ctx.visited, n] };
  const role = roleOf(n), a = (k: string) => n.attr(k);
  // 2A hidden: skipped, unless we are inside a labelledby/describedby traversal that started at a hidden node
  if (n.hidden() && !ctx.rootIsHiddenRef) return "";
  // 2B aria-labelledby (not followed again from inside a labelledby traversal)
  if (!ctx.inLabelledBy) {
    const ids = (a("aria-labelledby") ?? "").trim().split(/\s+/).filter(Boolean);
    const refs = ids.map((id) => n.byId(id)).filter((x): x is NNode => !!x);
    if (refs.length) {
      // fresh visited set: a node may label itself (accname example "Delete file.pdf"); loops are impossible because
      // aria-labelledby is not followed again inside the traversal
      const s = refs.map((r) => nameOf(r, { inLabelledBy: true, inContent: false, visited: [], rootIsHiddenRef: r.hidden() }, false)).map(norm).filter(Boolean).join(" ");
      if (s) return s;
    }
  }
  // 2C embedded control, while computing another node's name from content or a label
  if (!isRoot && (ctx.inContent || ctx.inLabelledBy)) {
    if (TEXTLIKE.has(role)) return n.value();
    if (role === "combobox" || role === "listbox") {
      if (n.tag === "select") return n.value();
      const sel = descendants(n).find((d) => d.kind === "el" && roleOf(d) === "option" && d.attr("aria-selected") === "true");
      return sel ? nameOf(sel, ctx, false) : n.tag === "input" ? n.value() : "";
    }
    if (RANGE.has(role)) return a("aria-valuetext") ?? a("aria-valuenow") ?? n.value();
  }
  // 2D aria-label
  const label = norm(a("aria-label") ?? "");
  if (label && !(role === "none")) return label;
  // 2E host language (HTML-AAM)
  const native = hostName(n, role, ctx);
  if (native) return native;
  // 2F/2G name from content: allowed roles, or anything reached in a recursion/labelledby traversal
  // Chromium (the oracle, and what platform readers receive) gives HTML <tr> rows no name from content although
  // ARIA lists row as name-from-contents; we match the browser. The reader still reads the row's cells (READ_CONTENT).
  const htmlRow = role === "row" && n.tag === "tr" && !n.attr("role") && !inAriaGrid(n);
  if ((NAME_FROM_CONTENT.has(role) && !(htmlRow && isRoot && !ctx.inContent && !ctx.inLabelledBy)) || ctx.inContent || ctx.inLabelledBy || (!isRoot && role === "") || (!isRoot && role === "generic") || (!isRoot && role === "none")) {
    const s = fromContent(n, { ...ctx, inContent: true });
    if (norm(s)) return s;
  }
  // 2I tooltip
  return a("title") ?? "";
}

function descendants(n: NNode): NNode[] { const out: NNode[] = []; const walk = (x: NNode) => { for (const c of x.children()) { out.push(c); if (c.kind === "el") walk(c); } }; walk(n); return out; }

function fromContent(n: NNode, ctx: Ctx): string {
  let s = n.before();
  for (const c of n.children()) {
    if (c.kind === "text") { s += c.text; continue; }
    if (c.hidden() && !ctx.rootIsHiddenRef) continue;
    const part = nameOf(c, ctx, false);
    s += c.block() ? ` ${part} ` : part;
  }
  return s + n.after();
}

function hostName(n: NNode, role: string, ctx: Ctx): string {
  const t = n.tag, a = (k: string) => n.attr(k);
  if (t === "input") {
    const ty = (a("type") ?? "text").toLowerCase();
    if (["button", "submit", "reset"].includes(ty)) return a("value") ?? (ty === "submit" ? "Submit" : ty === "reset" ? "Reset" : "");
    if (ty === "image") return a("alt") ?? a("value") ?? a("title") ?? "Submit";
  }
  if (t === "input" || t === "textarea" || t === "select" || t === "meter" || t === "progress" || t === "output") {
    const ls = n.labels().map((l) => norm(fromContent(l, { ...ctx, inContent: true }))).filter(Boolean).join(" ");
    if (ls) return ls;
    if (a("title")) return a("title")!;
    if ((t === "input" || t === "textarea") && a("placeholder")) return a("placeholder")!;
    return "";
  }
  if (t === "img" || t === "area") return a("alt") ?? "";
  if (t === "fieldset") { const lg = n.children().find((c) => c.kind === "el" && c.tag === "legend"); return lg ? fromContent(lg, { ...ctx, inContent: true }) : ""; }
  if (t === "figure") { const fc = n.children().find((c) => c.kind === "el" && c.tag === "figcaption"); return fc ? fromContent(fc, { ...ctx, inContent: true }) : ""; }
  if (t === "table") { const cp = n.children().find((c) => c.kind === "el" && c.tag === "caption"); return cp ? fromContent(cp, { ...ctx, inContent: true }) : ""; }
  if (t === "svg") { const ti = n.children().find((c) => c.kind === "el" && c.tag === "title"); return ti ? fromContent(ti, { ...ctx, inContent: true }) : ""; }
  if (t === "iframe") return a("title") ?? "";
  void role;
  return "";
}

/** Accessible description: aria-describedby, else aria-description, else a title not already used as the name. */
export function accDescription(n: NNode): string {
  if (n.kind !== "el") return "";
  const ids = (n.attr("aria-describedby") ?? "").trim().split(/\s+/).filter(Boolean);
  const refs = ids.map((id) => n.byId(id)).filter((x): x is NNode => !!x);
  if (refs.length) return norm(refs.map((r) => nameOf(r, { inLabelledBy: true, inContent: true, visited: [], rootIsHiddenRef: r.hidden() }, false)).join(" "));
  const d = norm(n.attr("aria-description") ?? "");
  if (d) return d;
  const title = norm(n.attr("title") ?? ""), name = accName(n);
  return title && title !== name ? title : "";
}

/* ------------------------------------------------------------------------------------------------ states → words */
export interface Spoken { name: string; role: string; states: string[]; value: string; position: string; description: string }

const ROLE_WORDS: Record<string, string> = {
  colorwell: "colour picker", date: "date edit", datetime: "date and time edit", time: "time edit",
  button: "button", link: "link", textbox: "edit", searchbox: "search edit", combobox: "combo box", checkbox: "check box",
  radio: "radio button", slider: "slider", spinbutton: "spin button", switch: "switch", tab: "tab", tablist: "tab list",
  tabpanel: "tab panel", menuitem: "menu item", menuitemcheckbox: "menu item", menuitemradio: "menu item", menu: "menu",
  menubar: "menu bar", listbox: "list box", option: "", list: "list", listitem: "", heading: "heading", dialog: "dialog",
  alertdialog: "alert dialog", navigation: "navigation landmark", main: "main landmark", banner: "banner landmark",
  contentinfo: "content info landmark", complementary: "complementary landmark", region: "region", form: "form",
  search: "search landmark", img: "graphic", progressbar: "progress bar", meter: "meter", table: "table", grid: "grid",
  row: "row", cell: "", gridcell: "", columnheader: "column header", rowheader: "row header", tree: "tree view",
  treeitem: "tree item", toolbar: "tool bar", group: "grouping", radiogroup: "radio group", separator: "separator",
  status: "status", alert: "alert", tooltip: "tool tip", article: "article", figure: "figure", document: "document",
  application: "application", log: "log", timer: "timer", paragraph: "", generic: "", none: "",
};
export const roleWords = (role: string, n?: NNode) =>
  role === "button" && n?.attr("aria-pressed") !== null && n?.attr("aria-pressed") !== undefined ? "toggle button" : ROLE_WORDS[role] ?? role;

const SET_ROLES: Record<string, string[]> = { listitem: ["listitem"], option: ["option"], menuitem: ["menuitem", "menuitemcheckbox", "menuitemradio"], menuitemcheckbox: ["menuitem", "menuitemcheckbox", "menuitemradio"], menuitemradio: ["menuitem", "menuitemcheckbox", "menuitemradio"], tab: ["tab"], treeitem: ["treeitem"], radio: ["radio"] };

/** "2 of 5" from aria-posinset/aria-setsize, else counted among visible siblings of the same kind in the same parent */
export function position(n: NNode, role: string): string {
  const ps = n.attr("aria-posinset"), ss = n.attr("aria-setsize");
  if (ps && ss && Number(ss) > 0) return `${Number(ps)} of ${Number(ss)}`;
  const kinds = SET_ROLES[role];
  const p = n.parent();
  if (!kinds || !p) return "";
  // radios group by name (native) or radiogroup parent
  const sibs = p.children().filter((c) => c.kind === "el" && !c.hidden() && kinds.includes(roleOf(c)));
  const i = sibs.findIndex((c) => c.same(n));
  return i >= 0 && sibs.length > 1 ? `${i + 1} of ${sibs.length}` : "";
}

/** visible text of a subtree (hidden parts skipped, blocks separated): what a reader says for nameless text roles */
export function contentText(n: NNode): string {
  if (n.kind === "text") return n.text;
  if (n.hidden()) return "";
  let s = n.before();
  for (const c of n.children()) { const t = contentText(c); s += c.kind === "el" && c.block() ? ` ${t} ` : t; }
  return norm(s + n.after());
}
/** roles a reader reads by their content when they have no name (ARIA gives them none) */
const READ_CONTENT = new Set(["row", "listitem", "paragraph", "note", "term", "definition", "status", "alert", "log", "generic", "", "tooltip", "cell", "gridcell"]);

export function spoken(n: NNode): Spoken {
  const role = roleOf(n), a = (k: string) => n.attr(k);
  const states: string[] = [];
  const nativeChecked = n.checked();
  const checked = a("aria-checked") ?? (nativeChecked === null ? null : String(nativeChecked));
  if (role === "switch") states.push(checked === "true" ? "on" : "off");
  else if (["checkbox", "radio", "menuitemcheckbox", "menuitemradio"].includes(role) && checked !== null) states.push(checked === "mixed" ? "half checked" : checked === "true" ? "checked" : "not checked");
  if (a("aria-pressed") === "true") states.push("pressed"); else if (a("aria-pressed") === "false") states.push("not pressed"); else if (a("aria-pressed") === "mixed") states.push("half pressed");
  if (a("aria-expanded") === "true") states.push("expanded"); else if (a("aria-expanded") === "false") states.push("collapsed");
  else if (n.tag === "summary" && !a("role")) { const d = n.parent(); if (d?.tag === "details") states.push(d.attr("open") !== null ? "expanded" : "collapsed"); }
  if (a("aria-selected") === "true" && ["option", "tab", "treeitem", "gridcell", "row"].includes(role)) states.push("selected");
  if (a("aria-current") && a("aria-current") !== "false") states.push(a("aria-current") === "page" ? "current page" : "current");
  if (n.disabled() || a("aria-disabled") === "true") states.push("unavailable");
  if (a("aria-required") === "true" || a("required") !== null) states.push("required");
  if (a("aria-invalid") && a("aria-invalid") !== "false") states.push("invalid entry");
  if (a("aria-readonly") === "true" || (a("readonly") !== null && (n.tag === "input" || n.tag === "textarea"))) states.push("read only");
  if (a("aria-haspopup") && a("aria-haspopup") !== "false" && role !== "combobox") states.push(a("aria-haspopup") === "dialog" ? "opens dialog" : "has pop up");
  let value = "";
  if (TEXTLIKE.has(role) || (role === "combobox" && n.tag !== "select")) value = n.value() || (a("aria-valuetext") ?? "") ;
  else if (role === "combobox" && n.tag === "select") value = n.value();
  else if (RANGE.has(role)) value = a("aria-valuetext") ?? a("aria-valuenow") ?? n.value();
  if (TEXTLIKE.has(role) && !value) value = "blank";
  const level = role === "heading" ? (a("aria-level") ?? (/^h[1-6]$/.test(n.tag) ? n.tag.slice(1) : "2")) : "";
  return {
    name: accName(n) || (READ_CONTENT.has(role) ? contentText(n) : ""),
    role: [roleWords(role, n), level ? `level ${level}` : ""].filter(Boolean).join(" "),
    states, value, position: position(n, role), description: accDescription(n),
  };
}

/** "Name, role, states, value, 2 of 5, description" — empty parts dropped, the description after a pause. */
export function utterance(s: Spoken): string {
  const head = [s.name, s.role, ...s.states, s.value && s.value !== s.name ? s.value : "", s.position].filter(Boolean).join(", ");
  return s.description ? `${head}. ${s.description}` : head;
}

/* ------------------------------------------------------------------------------------------------ context + live regions */
export const CONTEXT_ROLES = new Set(["dialog", "alertdialog", "navigation", "main", "banner", "contentinfo", "complementary", "region", "search", "menu", "menubar", "listbox", "tablist", "toolbar", "tree", "grid", "table", "radiogroup", "group", "form"]);
const NEEDS_NAME = new Set(["region", "group", "form", "toolbar", "table", "grid"]);

/** Ancestors (outermost first) a reader announces on entry: landmarks, dialogs, composite widgets; groups only when named. */
export function contextChain(n: NNode): NNode[] {
  const out: NNode[] = [];
  for (let p = n.parent(); p; p = p.parent()) {
    if (p.kind !== "el") continue;
    const r = roleOf(p);
    if (!CONTEXT_ROLES.has(r)) continue;
    if (NEEDS_NAME.has(r) && !accName(p)) continue;
    out.unshift(p);
  }
  return out;
}
/** The containers in `next` that `prev` was not inside (outermost first) */
export function entered(prev: NNode[], next: NNode[]): NNode[] { return next.filter((x) => !prev.some((p) => p.same(x))); }
export const contextWords = (n: NNode) => [accName(n), roleWords(roleOf(n), n)].filter(Boolean).join(", ");

export type Politeness = "off" | "polite" | "assertive";
/** Live-region settings that apply to `n`: nearest explicit aria-live wins, else implicit (alert assertive; status/log polite) */
export function liveOf(n: NNode): { politeness: Politeness; root: NNode | null; atomic: boolean; busy: boolean; relevant: string[] } {
  let atomic: boolean | null = null, busy = false;
  for (let p: NNode | null = n.kind === "el" ? n : n.parent(); p; p = p.parent()) {
    if (p.kind !== "el") continue;
    if (atomic === null && p.attr("aria-atomic") !== null) atomic = p.attr("aria-atomic") === "true";
    if (p.attr("aria-busy") === "true") busy = true;
    const live = p.attr("aria-live"), r = roleOf(p);
    const pol: Politeness | null = live === "off" || live === "polite" || live === "assertive" ? live
      : r === "alert" ? "assertive" : r === "status" || r === "log" ? "polite" : r === "timer" || r === "marquee" ? "off" : null;
    if (pol) {
      const implicitAtomic = r === "alert" || r === "status";
      return { politeness: pol, root: p, atomic: atomic ?? implicitAtomic, busy, relevant: (p.attr("aria-relevant") ?? "additions text").split(/\s+/) };
    }
  }
  return { politeness: "off", root: null, atomic: false, busy, relevant: [] };
}

/* ------------------------------------------------------------------------------------------------ reading order */
const ATOMIC_ITEM = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "heading", "img", "separator", "progressbar", "meter", "listbox"]);
export const LANDMARKS = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "region", "search", "form", "dialog", "alertdialog"]);
export const FORM_FIELDS = new Set(["textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "spinbutton", "switch", "listbox"]);

export type Item = { node: NNode; kind: "item" | "text" | "landmark"; whole?: boolean };
/**
 * Linear reading order of a subtree, as a scan/browse cursor visits it: landmarks and dialogs (announced on arrival),
 * then atomic items (controls, headings, images — read whole), and runs of plain text under their nearest element.
 */
export function readingItems(root: NNode): Item[] {
  const out: Item[] = [];
  const ownDone: NNode[] = [];
  // does the subtree hold anything the cursor must stop on separately (a control, heading, image, landmark)?
  const structured = (n: NNode): boolean => n.children().some((c) => c.kind === "el" && !c.hidden() && (ATOMIC_ITEM.has(roleOf(c)) || LANDMARKS.has(roleOf(c)) || structured(c)));
  const walk = (n: NNode) => {
    for (const c of n.children()) {
      if (c.kind === "text") {
        // text beside structured siblings: the element's own text, once (browse mode reads it as one line)
        if (norm(c.text) && !ownDone.some((d) => d.same(n))) { ownDone.push(n); out.push({ node: n, kind: "text" }); }
        continue;
      }
      if (c.hidden()) continue;
      const r = roleOf(c);
      if (r === "none" && c.tag === "img") continue;
      if (ATOMIC_ITEM.has(r)) { if (accName(c) || FORM_FIELDS.has(r) || r === "separator") out.push({ node: c, kind: "item" }); continue; }
      if (LANDMARKS.has(r)) { out.push({ node: c, kind: "landmark" }); walk(c); continue; }
      // a block of plain text (no controls inside): one item, read whole — "You have 3 new messages"
      if (!structured(c)) { if (contentText(c)) out.push({ node: c, kind: "text", whole: true }); continue; }
      walk(c);
    }
  };
  walk(root);
  return out;
}
export function itemText(it: Item): string {
  if (it.kind === "text") {
    if (it.whole) return contentText(it.node);
    // only the element's OWN text (its structured children are their own items)
    return norm(it.node.children().filter((c) => c.kind === "text").map((c) => c.text).join(" "));
  }
  if (it.kind === "landmark") return contextWords(it.node);
  return utterance(spoken(it.node));
}

export type Jump = "heading" | "landmark" | "field" | "link" | "item";
export function isJump(it: Item, j: Jump): boolean {
  if (j === "item") return true;
  if (it.kind === "text") return false;
  const r = roleOf(it.node);
  return j === "heading" ? r === "heading" : j === "landmark" ? it.kind === "landmark" : j === "field" ? FORM_FIELDS.has(r) : r === "link";
}
/** index of the next (dir 1) or previous (dir −1) item of kind j from index i; −1 when there is none (no wrap) */
export function nextIndex(items: Item[], i: number, dir: 1 | -1, j: Jump): number {
  for (let k = i + dir; k >= 0 && k < items.length; k += dir) if (isJump(items[k], j)) return k;
  return -1;
}

/* ------------------------------------------------------------------------------------------------ commands */
/** Narrator-key commands (hold Caps Lock or Insert, as in Windows Narrator / NVDA). `key` is KeyboardEvent.code. */
export const COMMANDS: { id: string; key: string; shift?: boolean; label: string }[] = [
  { id: "next", key: "ArrowRight", label: "Next item" },
  { id: "prev", key: "ArrowLeft", label: "Previous item" },
  { id: "nextHeading", key: "KeyH", label: "Next heading" },
  { id: "prevHeading", key: "KeyH", shift: true, label: "Previous heading" },
  { id: "nextLandmark", key: "KeyD", label: "Next landmark or dialog" },
  { id: "prevLandmark", key: "KeyD", shift: true, label: "Previous landmark or dialog" },
  { id: "nextField", key: "KeyF", label: "Next form field" },
  { id: "prevField", key: "KeyF", shift: true, label: "Previous form field" },
  { id: "nextLink", key: "KeyK", label: "Next link" },
  { id: "prevLink", key: "KeyK", shift: true, label: "Previous link" },
  { id: "readFocus", key: "Tab", label: "Read the focused item" },
  { id: "activate", key: "Enter", label: "Activate the item under the Narrator cursor" },
  { id: "readWindow", key: "KeyW", label: "Read the window title and where you are" },
  { id: "readAll", key: "KeyM", label: "Read everything from the cursor" },
  { id: "faster", key: "Equal", label: "Speak faster" },
  { id: "slower", key: "Minus", label: "Speak slower" },
  { id: "help", key: "F1", label: "List Narrator commands" },
];
export const NARRATOR_KEYS = ["CapsLock", "Insert"];
export function commandFor(code: string, shift: boolean): string | null {
  return COMMANDS.find((c) => c.key === code && !!c.shift === shift)?.id ?? null;
}
export const RATES = ["0.75", "1", "1.25", "1.5", "2"] as const;
export function stepRate(rate: string, dir: 1 | -1): string {
  const i = RATES.indexOf(rate as (typeof RATES)[number]);
  return RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 1 : i) + dir))];
}
