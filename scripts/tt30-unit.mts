/**
 * Suite "tt30-unit" (TT30): Narrator core (AX-14) on hand-built trees — no browser, no DOM.
 * Expected values are written by hand from the W3C rules (accname 1.2 step order, HTML-AAM, WAI-ARIA live regions),
 * NOT captured from this implementation's output. The independent oracle (Chromium's accessibility tree) is in
 * e2e-tt30.mts.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt30-unit.mts
 */
import { makeHarness } from "./harness.mts";
import * as N from "../src/lib/narrator-core.ts";
import { BINDINGS, BROWSER_RESERVED, comboFor, conflicts } from "../src/lib/shortcuts.ts";

const { test, finish } = makeHarness("tt30-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };

/* ------------------------------------------------------------- a tiny fake tree */
type A = Record<string, string | boolean | undefined>;
interface F extends N.NNode { _attrs: A; _kids: F[]; _parent: F | null; _doc: { ids: Map<string, F>; labels: Map<F, F[]> } }
const doc = () => ({ ids: new Map<string, F>(), labels: new Map<F, F[]>() });
function h(tag: string, attrs: A = {}, ...kids: (F | string)[]): F {
  const node: F = {
    kind: "el", tag, text: "", _attrs: attrs, _kids: [], _parent: null, _doc: doc(),
    attr: (k) => { const v = attrs[k]; return v === undefined || typeof v === "boolean" ? (v === true ? "" : null) : v; },
    children: () => node._kids, parent: () => node._parent,
    hidden: () => { for (let p: F | null = node; p; p = p._parent) if (p._attrs.$hidden || p._attrs["aria-hidden"] === "true") return true; return false; },
    byId: (id) => node._doc.ids.get(id) ?? null,
    labels: () => node._doc.labels.get(node) ?? [],
    value: () => String(attrs.$value ?? ""), block: () => !!attrs.$block,
    before: () => String(attrs.$before ?? ""), after: () => String(attrs.$after ?? ""),
    focusable: () => !!attrs.$focusable || ["button", "a", "input", "select", "textarea"].includes(tag),
    checked: () => (attrs.$checked === undefined ? null : !!attrs.$checked), disabled: () => !!attrs.$disabled,
    same: (o) => o === node,
  };
  for (const k of kids) {
    const c: F = typeof k === "string" ? textNode(k) : k;
    c._parent = node; node._kids.push(c);
  }
  return node;
}
function textNode(t: string): F {
  const n: F = { kind: "text", tag: "", text: t, _attrs: {}, _kids: [], _parent: null, _doc: doc(),
    attr: () => null, children: () => [], parent: () => n._parent, hidden: () => !!n._parent?.hidden(), byId: () => null, labels: () => [],
    value: () => "", block: () => false, before: () => "", after: () => "", focusable: () => false, checked: () => null, disabled: () => false, same: (o) => o === n };
  return n;
}
/** wire ids and <label for>/wrapping labels across a tree */
function root(r: F): F {
  const d = doc(), all: F[] = [];
  const walk = (n: F) => { n._doc = d; all.push(n); n._kids.forEach(walk); };
  walk(r);
  for (const n of all) if (typeof n._attrs.id === "string") d.ids.set(n._attrs.id, n);
  for (const n of all) if (n.tag === "label") {
    const f = n._attrs.for;
    const target = typeof f === "string" ? d.ids.get(f) : undefined;
    const inner: F[] = []; const w2 = (x: F) => { for (const c of x._kids) { if (["input", "select", "textarea"].includes(c.tag)) inner.push(c); w2(c); } }; w2(n);
    for (const t of target ? [target] : inner.slice(0, 1)) d.labels.set(t, [...(d.labels.get(t) ?? []), n]);
  }
  return r;
}

await test("accessible names follow the accname step order: aria-labelledby (incl. hidden targets and self-reference) > aria-label > native label/alt/caption > content > title; placeholder only as the last native fallback", { "AX-14": "full" }, () => {
  eq(N.accName(root(h("button", {}, "Save"))), "Save", "content");
  eq(N.accName(root(h("button", { "aria-label": "Close" }, "×"))), "Close", "aria-label beats content");
  const t1 = root(h("div", {}, h("span", { id: "a" }, "Billing"), h("span", { id: "b", $hidden: true }, "Name"), h("input", { id: "i", "aria-labelledby": "a b", "aria-label": "ignored" })));
  eq(N.accName(t1._kids[2]), "Billing Name", "labelledby wins and includes a hidden referenced node");
  const t2 = root(h("div", {}, h("button", { id: "del", "aria-labelledby": "del file", "aria-label": "Delete" }), h("span", { id: "file" }, "file.pdf")));
  eq(N.accName(t2._kids[0]), "Delete file.pdf", "self-reference uses the node's aria-label (accname example)");
  const t3 = root(h("div", {}, h("label", { for: "e" }, "Email"), h("input", { id: "e", type: "email", placeholder: "you@example.com" })));
  eq(N.accName(t3._kids[1]), "Email", "label[for] beats placeholder");
  eq(N.accName(root(h("input", { placeholder: "Search" }))), "Search", "placeholder fallback");
  eq(N.accName(root(h("input", { placeholder: "Search", title: "Find files" }))), "Find files", "title beats placeholder");
  const t4 = root(h("label", {}, "Flash the screen ", h("input", { type: "checkbox", id: "c" }), " ", h("input", { type: "text", $value: "3" }), " times"));
  eq(N.accName(t4._kids[1]), "Flash the screen 3 times", "embedded textbox contributes its value");
  eq(N.accName(root(h("a", { href: "/" }, h("img", { alt: "Home" })))), "Home", "link named by its image's alt");
  eq(N.accName(root(h("h2", {}, h("span", {}, "Big"), h("span", {}, "News")))), "BigNews", "inline children join without a space");
  eq(N.accName(root(h("h2", {}, h("span", { $block: true }, "Big"), h("span", { $block: true }, "News")))), "Big News", "block children are separated");
  eq(N.accName(root(h("button", {}, "Save", h("span", { $hidden: true }, " (draft)")))), "Save", "hidden child skipped");
  eq(N.accName(root(h("button", {}, "Save", h("span", { "aria-hidden": "true" }, " ⌘S")))), "Save", "aria-hidden child skipped");
  eq(N.accName(root(h("button", { $before: "★ " }, "Star"))), "★ Star", "CSS ::before text counts");
  eq(N.accName(root(h("fieldset", {}, h("legend", {}, "Shipping"), h("input", {})))), "Shipping", "fieldset ← legend");
  eq(N.accName(root(h("table", {}, h("caption", {}, "Budget"), h("tr", {})))), "Budget", "table ← caption");
  eq(N.accName(root(h("div", {}, "not a name source"))), "", "generic div gets no name from content");
  eq(N.accName(root(h("div", { title: "Tip" }, "x"))), "Tip", "title as last resort");
  eq(N.accName(root(h("input", { type: "submit" }))), "Submit", "submit default");
  eq(N.accName(root(h("button", { "aria-label": "  " }, "Go"))), "Go", "blank aria-label ignored");
});

await test("roles: explicit first valid token, presentation ignored on focusable elements, HTML-AAM implicit mapping incl. scoping of header/footer and named sections", { "AX-14": "full" }, () => {
  eq(N.roleOf(root(h("button", { role: "switch" }))), "switch", "explicit");
  eq(N.roleOf(root(h("div", { role: "bogus tab" }))), "tab", "first VALID token");
  eq(N.roleOf(root(h("button", { role: "presentation" }))), "button", "presentation on focusable is ignored");
  eq(N.roleOf(root(h("img", { alt: "" }))), "none", "decorative image");
  eq(N.roleOf(root(h("body", {}, h("header", {})))._kids[0]), "banner", "top-level header");
  eq(N.roleOf(root(h("article", {}, h("header", {})))._kids[0]), "generic", "header inside article");
  eq(N.roleOf(root(h("section", { "aria-label": "News" }))), "region", "named section");
  eq(N.roleOf(root(h("section", {}))), "generic", "unnamed section");
  eq(N.roleOf(root(h("form", {}))), "generic", "unnamed form (HTML-AAM)");
  eq([N.roleOf(root(h("input", { type: "file" }))), N.roleOf(root(h("input", { type: "color" }))), N.roleOf(root(h("input", { type: "datetime-local" }))), N.roleOf(root(h("summary", {})))], ["button", "colorwell", "datetime", "button"], "browser widget roles (as Chromium exposes them)");
  const det = root(h("details", { open: true }, h("summary", {}, "Map layers")));
  eq(N.utterance(N.spoken(det._kids[0])), "Map layers, button, expanded", "summary: name from content + expanded from <details open>");
  eq(N.roleOf(root(h("form", { "aria-label": "Sign in" }))), "form", "named form");
  // cells are display:table-cell, which the DOM adapter (like Chromium) treats as a block → space-separated
  const cell = (t: string) => h("td", { $block: true }, t);
  const grid = root(h("table", { role: "grid" }, h("tr", {}, cell("A"), cell("B"))));
  const plain = root(h("table", {}, h("tr", {}, cell("A"), cell("B"))));
  eq([N.accName(grid._kids[0]), N.accName(plain._kids[0])], ["A B", ""], "rows named from content only in ARIA grids (Chromium behaviour)");
  eq(N.utterance(N.spoken(plain._kids[0])), "A B, row", "a nameless row is still read by its cells");
  eq(N.roleOf(root(h("select", { multiple: true }))), "listbox", "select multiple");
  eq(N.roleOf(root(h("select", {}))), "combobox", "select");
  eq(N.roleOf(root(h("input", { type: "search" }))), "searchbox", "search");
  eq(N.roleOf(root(h("input", { type: "range" }))), "slider", "range");
  eq(N.roleOf(root(h("a", {}, "x"))), "generic", "a without href");
  eq(N.roleOf(root(h("div", { role: "grid" }, h("td", {})))._kids[0]), "gridcell", "td in a grid");
});

await test("spoken output: name, role words, states, value, position, description — in that order", { "AX-14": "full" }, () => {
  const u = (n: F) => N.utterance(N.spoken(n));
  eq(u(root(h("input", { type: "checkbox", "aria-label": "Remember me", $checked: true }))), "Remember me, check box, checked", "checkbox");
  eq(u(root(h("button", { role: "switch", "aria-checked": "false" }, "Wi-Fi"))), "Wi-Fi, switch, off", "switch off");
  eq(u(root(h("button", { "aria-pressed": "true" }, "Bold"))), "Bold, toggle button, pressed", "toggle button");
  eq(u(root(h("h3", {}, "Recent"))), "Recent, heading level 3", "heading level");
  eq(u(root(h("input", { "aria-label": "Name" }))), "Name, edit, blank", "empty edit");
  eq(u(root(h("input", { "aria-label": "Name", $value: "Ann" }))), "Name, edit, Ann", "edit value");
  const list = root(h("ul", {}, h("li", {}, "Apple"), h("li", {}, "Pear"), h("li", {}, "Plum")));
  eq(u(list._kids[1]), "Pear, 2 of 3", "list position");
  eq(u(root(h("div", { role: "option", "aria-posinset": "4", "aria-setsize": "9", "aria-selected": "true" }, "Fig"))), "Fig, selected, 4 of 9", "explicit set position");
  const d = root(h("div", {}, h("button", { "aria-describedby": "hint" }, "Delete"), h("span", { id: "hint" }, "Moves the file to Trash")));
  eq(u(d._kids[0]), "Delete, button. Moves the file to Trash", "description after a pause");
  eq(u(root(h("button", { $disabled: true, "aria-expanded": "false", "aria-haspopup": "menu" }, "More"))), "More, button, collapsed, unavailable, has pop up", "states");
});

await test("live regions: nearest explicit aria-live wins; alert is assertive and atomic, status polite and atomic, log polite; busy suppresses; timer is off", { "AX-14": "full" }, () => {
  const t = root(h("div", {}, h("div", { role: "status" }, h("span", {}, "Saved")), h("div", { role: "alert" }, "Error"), h("div", { role: "status" }, h("div", { "aria-live": "off" }, h("span", {}, "tick"))), h("div", { "aria-live": "polite", "aria-busy": "true" }, h("b", {}, "x")), h("div", { role: "log" }, h("p", {}, "line")), h("div", { role: "timer" }, "0:01")));
  const [st, al, off, busy, log, timer] = t._kids;
  const s1 = N.liveOf(st._kids[0]); eq([s1.politeness, s1.atomic, s1.root === st], ["polite", true, true], "status");
  const s2 = N.liveOf(al); eq([s2.politeness, s2.atomic], ["assertive", true], "alert");
  eq(N.liveOf(off._kids[0]._kids[0]).politeness, "off", "explicit off inside status");
  eq(N.liveOf(busy._kids[0]).busy, true, "busy");
  const s5 = N.liveOf(log._kids[0]); eq([s5.politeness, s5.atomic, s5.relevant], ["polite", false, ["additions", "text"]], "log");
  eq(N.liveOf(timer).politeness, "off", "timer");
  eq(N.liveOf(root(h("p", {}, "x"))).root, null, "no region");
});

await test("context on focus moves: entering a dialog and a named form announces both (outermost first); moving within announces nothing; unnamed groups are skipped", { "AX-14": "full" }, () => {
  const t = root(h("body", {}, h("button", {}, "Open"), h("div", { role: "dialog", "aria-label": "Rename" }, h("form", { "aria-label": "New name" }, h("div", { role: "group" }, h("input", { "aria-label": "Name" }), h("button", {}, "OK"))))));
  const outside = t._kids[0], dlg = t._kids[1], input = dlg._kids[0]._kids[0]._kids[0], okb = dlg._kids[0]._kids[0]._kids[1];
  const c1 = N.contextChain(input);
  eq(N.entered(N.contextChain(outside), c1).map(N.contextWords), ["Rename, dialog", "New name, form"], "entered");
  eq(N.entered(c1, N.contextChain(okb)).length, 0, "same context");
});

await test("reading order: landmarks announced on arrival, atomic items read whole, text runs under their element, hidden skipped; jumps by heading / landmark / field / link without wrapping", { "AX-14": "full" }, () => {
  const t = root(h("body", {}, h("nav", { "aria-label": "Apps" }, h("a", { href: "#" }, "Files")), h("main", {}, h("h1", {}, "Inbox"), h("p", {}, "You have ", h("b", {}, "3"), " new messages"), h("p", { $hidden: true }, "secret"), h("input", { "aria-label": "Reply" }), h("img", { alt: "" }))));
  const items = N.readingItems(t);
  // browse mode reads a plain-text block as one line, inline children included
  eq(items.map(N.itemText), ["Apps, navigation landmark", "Files, link", "main landmark", "Inbox, heading level 1", "You have 3 new messages", "Reply, edit, blank"], "linear order");
  eq(N.nextIndex(items, -1, 1, "heading"), 3, "first heading");
  eq(N.nextIndex(items, 3, 1, "heading"), -1, "no wrap");
  eq(N.nextIndex(items, 5, -1, "landmark"), 2, "previous landmark");
  eq(N.nextIndex(items, 0, 1, "field"), 5, "next field");
  // own text beside a control is read once, not once per text node
  const mix = root(h("div", {}, h("p", {}, "Press ", h("button", {}, "OK"), " to continue")));
  eq(N.readingItems(mix).map(N.itemText), ["Press to continue", "OK, button"], "own text once, control separately");
  eq(N.nextIndex(items, -1, 1, "link"), 1, "first link");
});

await test("commands: unique Narrator-key chords; the toggle chord conflicts with no shell binding in any preset and is not browser-reserved; Caps Lock / Insert are used by no shell chord; speed steps clamp", { "AX-14": "full" }, () => {
  const seen = new Set<string>();
  for (const c of N.COMMANDS) { const k = `${c.key}${c.shift ? "+S" : ""}`; ok(!seen.has(k), `duplicate ${k}`); seen.add(k); }
  for (const p of ["hybrid", "windows", "mac"] as const) {
    eq(conflicts(p), [], `no conflicts in ${p}`);
    const b = BINDINGS.find((x) => x.id === "narrator")!;
    ok(!BROWSER_RESERVED.includes(comboFor(b, p)), `${p} toggle not browser-reserved`);
    for (const x of BINDINGS) ok(!/CapsLock|Insert/.test(comboFor(x, p)), `${x.id} uses a Narrator key`);
  }
  eq(N.commandFor("KeyH", true), "prevHeading", "shift variant");
  eq(N.commandFor("KeyQ", false), null, "unbound");
  eq([N.stepRate("2", 1), N.stepRate("0.75", -1), N.stepRate("1", 1), N.stepRate("junk", -1)], ["2", "0.75", "1.25", "0.75"], "rate steps");
});

finish();
