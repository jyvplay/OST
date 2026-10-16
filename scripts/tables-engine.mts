/**
 * Unit suite "tables-engine" (TT22): the pure Tables engine (src/lib/tables-core.ts) — typed cells and validation,
 * two-way links, lookups/rollups/count, formulas (incl. cycles and errors), type conversion, views (filter / sort /
 * group / search / kanban), CSV round-trip with the formula-injection guard, and structural integrity on deletes.
 * Expected values are worked out by hand in the comments, not read back from the engine.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tables-engine.mts
 */
import { makeHarness } from "./harness.mts";
import * as T from "../src/lib/tables-core.ts";

const { test, finish } = makeHarness("tables-engine");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const must = <X,>(r: { ok: true; base: T.Base } | { ok: false; error: string }, m = "setCell"): T.Base => { if (!r.ok) throw new Error(`${m}: ${r.error}`); return r.base; };

/** Two tables: Projects ↔ People, with a link both ways. */
function fixture() {
  let b = T.blankBase("Test");
  b = T.renameTable(b, b.tables[0].id, "Projects");
  const proj = b.tables[0].id; const pName = b.tables[0].fields[0].id;
  let r = T.addTable(b, "People"); b = r.base; const ppl = r.id; const nName = T.tableById(b, ppl)!.fields[0].id;
  let f = T.addField(b, ppl, { name: "Rate", type: "number", precision: 2 }); b = f.base; const rate = f.id;
  f = T.addField(b, proj, { name: "Team", type: "link", linkTable: ppl }); b = f.base; const team = f.id;
  const inv = T.fieldById(T.tableById(b, proj)!, team)!.inverseField!;
  const people: string[] = [];
  for (const [n, rt] of [["Ana", 80], ["Bo", 65.5], ["Cy", 95]] as const) { const a = T.addRecord(b, ppl, { [nName]: n, [rate]: rt }); b = a.base; people.push(a.id); }
  return { b, proj, ppl, pName, nName, rate, team, inv, people };
}

await test("typed cells: coercion and refusals per field type (number precision, dates, email, url schemes, checkbox words, rating bounds)", { "TB-01": "full" }, () => {
  const n: T.Field = { id: "f", name: "N", type: "number", precision: 2 };
  eq(T.coerce(n, "1,234.567"), { ok: true, value: 1234.57 }, "thousands + rounding to 2 dp");
  eq(T.coerce(n, "$5"), { ok: true, value: 5 }, "currency sign");
  ok(!T.coerce(n, "12abc").ok && !T.coerce(n, "Infinity").ok, "non-numbers refused");
  const d: T.Field = { id: "d", name: "D", type: "date" };
  eq(T.coerce(d, "2026-02-28"), { ok: true, value: "2026-02-28" }, "iso date");
  eq(T.coerce(d, "3/7/2026"), { ok: true, value: "2026-03-07" }, "US m/d/yyyy");
  ok(!T.coerce(d, "2026-02-30").ok && !T.coerce(d, "2/30/2026").ok && !T.coerce(d, "tomorrow").ok, "impossible dates refused (Feb 30)");
  const e: T.Field = { id: "e", name: "E", type: "email" };
  ok(T.coerce(e, "a@b.co").ok && !T.coerce(e, "a@b").ok && !T.coerce(e, "a b@c.d").ok, "email");
  const u: T.Field = { id: "u", name: "U", type: "url" };
  eq(T.coerce(u, "example.com/x"), { ok: true, value: "https://example.com/x" }, "scheme added");
  ok(!T.coerce(u, "javascript:alert(1)").ok && !T.coerce(u, "file:///etc/passwd").ok, "dangerous schemes refused");
  const c: T.Field = { id: "c", name: "C", type: "checkbox" };
  eq([T.coerce(c, "Yes"), T.coerce(c, "0"), T.coerce(c, "")].map((x) => (x as { value: unknown }).value), [true, false, false], "checkbox words");
  ok(!T.coerce(c, "maybe").ok, "checkbox refuses maybe");
  const r: T.Field = { id: "r", name: "R", type: "rating", max: 5 };
  ok(T.coerce(r, 5).ok && !T.coerce(r, 6).ok && !T.coerce(r, -1).ok, "rating 0..5");
  eq(T.coerce({ id: "t", name: "T", type: "text" }, "a\nb"), { ok: true, value: "a b" }, "single-line text flattens newlines");
  ok(!T.coerce({ id: "x", name: "X", type: "formula" }, "1").ok, "computed fields are not editable");
});

await test("select fields: unknown options are added once with a colour, matching is case-insensitive, multi-select de-duplicates", { "TB-01": "partial" }, () => {
  let b = T.blankBase(); const t = b.tables[0].id;
  const f = T.addField(b, t, { name: "Tags", type: "multiSelect", options: [{ name: "Red", color: "#f00" }] }); b = f.base;
  const a = T.addRecord(b, t); b = a.base;
  b = must(T.setCell(b, t, a.id, f.id, "red, Blue, blue,  Green "));
  eq(T.tableById(b, t)!.records[0].cells[f.id], ["Red", "Blue", "Green"], "canonical names, deduped");
  eq(T.fieldById(T.tableById(b, t)!, f.id)!.options!.map((o) => o.name), ["Red", "Blue", "Green"], "options added once");
});

await test("two-way links: linking updates the inverse field, unlinking removes it, unknown ids are refused, deleting a record scrubs every reference", { "TB-02": "full" }, () => {
  let { b, proj, ppl, pName, team, inv, people } = fixture();
  const p1 = T.addRecord(b, proj, { [pName]: "Site" }); b = p1.base;
  const p2 = T.addRecord(b, proj, { [pName]: "App" }); b = p2.base;
  b = must(T.setCell(b, proj, p1.id, team, [people[0], people[1]]));
  b = must(T.setCell(b, proj, p2.id, team, [people[1]]));
  const invOf = (id: string) => T.tableById(b, ppl)!.records.find((r) => r.id === id)!.cells[inv];
  eq(invOf(people[0]), [p1.id], "Ana ← Site"); eq(invOf(people[1]), [p1.id, p2.id], "Bo ← Site, App"); eq(invOf(people[2]) ?? null, null, "Cy unlinked");
  b = must(T.setCell(b, proj, p1.id, team, [people[1]])); // drop Ana
  eq(invOf(people[0]), null, "unlink clears the inverse");
  const bad = T.setCell(b, proj, p1.id, team, ["recNOPE"]); ok(!bad.ok && /unknown linked/.test(bad.error), "unknown ids refused");
  b = T.deleteRecords(b, ppl, [people[1]]);
  eq(T.tableById(b, proj)!.records.map((r) => r.cells[team] ?? null), [null, null], "deleting Bo scrubs both projects' links");
  eq(T.primaryText(b, ppl, "recNOPE"), "(deleted)", "dangling text");
});

await test("lookup / rollup / count follow the link and recompute; deleting the link field removes its inverse and breaks dependants visibly", { "TB-02": "full", "TB-03": "partial" }, () => {
  let { b, proj, ppl, pName, rate, team, inv, people } = fixture();
  const p1 = T.addRecord(b, proj, { [pName]: "Site", [team]: [people[0], people[1]] }); b = p1.base;
  let f = T.addField(b, proj, { name: "Rates", type: "lookup", viaField: team, targetField: rate }); b = f.base; const look = f.id;
  f = T.addField(b, proj, { name: "Total rate", type: "rollup", viaField: team, targetField: rate, rollup: "sum" }); b = f.base; const roll = f.id;
  f = T.addField(b, proj, { name: "Avg rate", type: "rollup", viaField: team, targetField: rate, rollup: "avg" }); b = f.base; const avg = f.id;
  f = T.addField(b, proj, { name: "Headcount", type: "count", viaField: team }); b = f.base; const cnt = f.id;
  let row = T.computeTable(b, proj).get(p1.id)!;
  eq(row[look], [80, 65.5], "lookup lists both rates"); eq(row[roll], 145.5, "80 + 65.5"); eq(row[avg], 72.75, "(80+65.5)/2"); eq(row[cnt], 2, "count");
  b = must(T.setCell(b, ppl, people[1], rate, 70)); // Bo's rate changes → rollup follows
  row = T.computeTable(b, proj).get(p1.id)!; eq(row[roll], 150, "80 + 70 after the edit");
  // the reverse direction: a rollup over the inverse link sees projects
  f = T.addField(b, ppl, { name: "Projects", type: "count", viaField: inv }); b = f.base;
  eq(T.computeTable(b, ppl).get(people[0])![f.id], 1, "Ana is on one project");
  b = T.deleteField(b, proj, team);
  ok(!T.tableById(b, ppl)!.fields.some((x) => x.id === inv), "inverse field removed with the link");
  row = T.computeTable(b, proj).get(p1.id)!;
  ok(T.isErr(row[roll]) && T.isErr(row[cnt]), "dependants show an error instead of a stale number");
  let threw = false; try { T.deleteField(b, proj, pName); } catch { threw = true; } ok(threw, "primary field cannot be deleted");
});

await test("formulas: precedence, functions, field refs incl. lookups, text & dates, errors (div/0, unknown field/function) and #CYCLE", { "TB-03": "full" }, () => {
  let b = T.blankBase(); const t = b.tables[0].id; const name = b.tables[0].fields[0].id;
  let f = T.addField(b, t, { name: "Price", type: "number", precision: 2 }); b = f.base; const price = f.id;
  f = T.addField(b, t, { name: "Qty", type: "number" }); b = f.base; const qty = f.id;
  f = T.addField(b, t, { name: "Due", type: "date" }); b = f.base; const due = f.id;
  const add = (n: string, src: string) => { const r = T.addField(b, t, { name: n, type: "formula", formula: src }); b = r.base; return r.id; };
  const total = add("Total", "{Price} * {Qty} + 1 * 2 - 6 / 3");          // p*q + 2 - 2
  const label = add("Label", 'UPPER({Name}) & " x" & {Qty}');
  const big = add("Big", 'IF({Total} >= 100, "big", IF({Total} = 0, "zero", "small"))');
  const days = add("Days", 'DATETIME_DIFF({Due}, "2026-10-01", "days")');
  const next = add("Next", 'DATEADD({Due}, 1, "month")');
  const div = add("Div", "{Price} / ({Qty} - {Qty})");
  const unk = add("Unknown", "{Nope} + 1");
  const a1 = add("A", "{B} + 1"); const b1 = add("B", "{A} + 1");
  const r = T.addRecord(b, t, { [name]: "gizmo", [price]: 12.5, [qty]: 8, [due]: "2026-10-31" }); b = r.base;
  const row = T.computeTable(b, t).get(r.id)!;
  eq(row[total], 100, "12.5×8 + 2 − 2 = 100");
  eq(row[label], "GIZMO x8", "concat"); eq(row[big], "big", "nested IF on a formula");
  eq(row[days], 30, "Oct 31 − Oct 1 = 30 days"); eq(row[next], "2026-12-01", "Oct 31 + 1 month rolls to Dec 1 (JS Date semantics)");
  ok(String(row[div]).includes("division by zero"), `div/0: ${String(row[div])}`);
  ok(String(row[unk]).includes("unknown field"), "unknown field");
  eq([row[a1], row[b1]], ["#CYCLE", "#CYCLE"], "A↔B cycle");
  let threw = false; try { T.parseFormula("FOO(1)"); } catch { threw = true; } ok(threw, "unknown function is a parse error");
  threw = false; try { T.parseFormula("(1 + 2"); } catch { threw = true; } ok(threw, "unbalanced parens");
  eq(T.FORMULA_FUNCTIONS.includes("ROUND") && T.FORMULA_FUNCTIONS.includes("ARRAYJOIN"), true, "function table");
  // rename keeps formulas pointing at the field
  b = T.renameField(b, t, price, "Unit price");
  eq(T.fieldById(T.tableById(b, t)!, total)!.formula, "{Unit price} * {Qty} + 1 * 2 - 6 / 3", "rename rewrites refs");
  eq(T.computeTable(b, t).get(r.id)![total], 100, "still computes after rename");
});

await test("type conversion: number→text→number round-trips, text→select collects options, failures are counted and cleared (never mangled), links refuse", { "TB-01": "partial" }, () => {
  let b = T.blankBase(); const t = b.tables[0].id;
  let f = T.addField(b, t, { name: "V", type: "text" }); b = f.base; const v = f.id;
  for (const x of ["12", "7.5", "n/a", "high"]) { const a = T.addRecord(b, t, { [v]: x }); b = a.base; }
  let c = T.changeFieldType(b, t, v, "number", { precision: 1 }); 
  eq(c.lost, 2, "'n/a' and 'high' cannot become numbers");
  eq(T.tableById(c.base, t)!.records.map((r) => r.cells[v] ?? null), [12, 7.5, null, null], "converted + cleared");
  c = T.changeFieldType(c.base, t, v, "text"); eq(T.tableById(c.base, t)!.records.map((r) => r.cells[v] ?? null), ["12.0", "7.5", null, null], "number→text uses the display format");
  b = c.base; for (const x of ["Low", "High", "low"]) { const a = T.addRecord(b, t, { [v]: x }); b = a.base; }
  c = T.changeFieldType(b, t, v, "singleSelect");
  const opts = T.fieldById(T.tableById(c.base, t)!, v)!.options!.map((o) => o.name);
  ok(opts.includes("Low") && opts.includes("High") && opts.includes("12.0"), `options ${opts}`);
  eq(T.tableById(c.base, t)!.records.at(-1)!.cells[v], "Low", "case-insensitive match onto the first spelling");
  const fx = fixture(); let threw = false; try { T.changeFieldType(fx.b, fx.proj, fx.team, "text"); } catch { threw = true; } ok(threw, "link conversion refused");
});

await test("views: AND/OR filters, multi-sort with empties last in both directions, select sorts by option order, grouping, search over visible fields", { "TB-04": "full" }, () => {
  let b = T.blankBase(); const t = b.tables[0].id; const name = b.tables[0].fields[0].id;
  let f = T.addField(b, t, { name: "Status", type: "singleSelect", options: [{ name: "Todo", color: "" }, { name: "Doing", color: "" }, { name: "Done", color: "" }] }); b = f.base; const st = f.id;
  f = T.addField(b, t, { name: "Pts", type: "number" }); b = f.base; const pts = f.id;
  f = T.addField(b, t, { name: "Secret", type: "text" }); b = f.base; const sec = f.id;
  const data: [string, string | null, number | null][] = [["a", "Done", 3], ["b", "Todo", null], ["c", "Doing", 8], ["d", "Todo", 5], ["e", null, 1]];
  for (const [n, s, p] of data) { const a = T.addRecord(b, t, { [name]: n, [st]: s, [pts]: p, [sec]: n === "e" ? "needle" : "" }); b = a.base; }
  const view = T.tableById(b, t)!.views[0];
  const names = (v: T.View, q = "") => T.runView(b, t, v, q).rows.map((id) => T.tableById(b, t)!.records.find((r) => r.id === id)!.cells[name]);
  eq(names({ ...view, sorts: [{ field: pts, dir: "asc" }] }), ["e", "a", "d", "c", "b"], "asc, empty last");
  eq(names({ ...view, sorts: [{ field: pts, dir: "desc" }] }), ["c", "d", "a", "e", "b"], "desc, empty STILL last");
  eq(names({ ...view, sorts: [{ field: st, dir: "asc" }, { field: pts, dir: "desc" }] }), ["d", "b", "c", "a", "e"], "option order Todo<Doing<Done, then pts desc, empty status last");
  eq(names({ ...view, filters: [{ field: pts, op: "gte", value: "3" }, { field: st, op: "is", value: "todo" }], conjunction: "and" }), ["d"], "AND");
  eq(names({ ...view, filters: [{ field: pts, op: "gt", value: "6" }, { field: st, op: "isEmpty" }], conjunction: "or" }), ["c", "e"], "OR");
  eq(names({ ...view, filters: [{ field: pts, op: "lt", value: "5" }] }), ["a", "e"], "lt skips empties");
  const g = T.runView(b, t, { ...view, groupBy: st }).groups!;
  eq(g.map((x) => [x.key, x.rows.length]), [["Todo", 2], ["Doing", 1], ["Done", 1], ["(empty)", 1]], "groups in option order");
  eq(names(view, "needle"), ["e"], "search sees a visible field");
  eq(names({ ...view, hidden: [sec] }, "needle"), [], "…but not a hidden one");
  const cols = T.kanbanColumns(b, t, { ...view, kind: "kanban", stackBy: st });
  eq(cols.map((c) => [c.label, c.rows.length]), [["Uncategorized", 1], ["Todo", 2], ["Doing", 1], ["Done", 1]], "kanban columns");
  eq(T.summarize(T.fieldById(T.tableById(b, t)!, pts)!, T.runView(b, t, view).rows, T.computeTable(b, t)), "Sum 17", "footer sum 3+8+5+1");
});

await test("CSV: RFC 4180 parse (quotes, doubled quotes, CRLF, embedded newline), type inference, export guards formula injection and round-trips", { "TB-01": "full" }, () => {
  eq(T.parseCsv('a,"b,c","say ""hi"""\r\n1,"line1\nline2",3\n'), [["a", "b,c", 'say "hi"'], ["1", "line1\nline2", "3"]], "parse");
  let threw = false; try { T.parseCsv('a,"open'); } catch { threw = true; } ok(threw, "unterminated quote refused");
  const csv = "Name,Amount,Paid,When,Contact,Tier\nAcme,\"1,200.50\",yes,2026-01-05,a@acme.io,Gold\nBeta,99,no,2026-02-10,b@beta.io,Silver\nCo,5,yes,2026-03-15,c@co.io,Gold\nDelta,-3,no,2026-04-20,d@d.io,Gold\n=HYPERLINK(\"x\"),1,no,2026-05-01,e@e.io,Silver\n";
  const r = T.importCsv(T.blankBase(), "Deals", csv);
  const t = T.tableById(r.base, r.id)!;
  eq(t.fields.map((f) => f.type), ["text", "number", "checkbox", "date", "email", "singleSelect"], "inferred types");
  eq(r.rows, 5, "rows"); eq(r.rejected, 0, "nothing refused");
  eq(t.records[0].cells[t.fields[1].id], 1200.5, "1,200.50 → 1200.5 (2 dp)");
  const out = T.toCsv(r.base, r.id);
  ok(out.includes(`"'=HYPERLINK(""x"")"`), "exported =… is prefixed with ' (OWASP CSV injection)");
  ok(out.startsWith("Name,Amount,Paid,When,Contact,Tier\r\n") && out.includes("Acme,1200.50,true,2026-01-05,a@acme.io,Gold"), out.split("\r\n").slice(0, 2).join(" | "));
  const back = T.importCsv(T.blankBase(), "Again", out);
  const t2 = T.tableById(back.base, back.id)!;
  eq(t2.records[4].cells[t2.fields[0].id], '=HYPERLINK("x")', "re-import strips the guard prefix");
  eq(t2.fields.map((f) => f.type), t.fields.map((f) => f.type), "types survive the round trip");
});

await test("integrity: deleting a table drops links into it, deleting a field strips it from views, the last table/view cannot be deleted, loadBase rejects junk", { "TB-01": "partial", "TB-04": "partial" }, () => {
  let { b, proj, ppl, team, rate } = fixture();
  b = T.updateView(b, ppl, T.tableById(b, ppl)!.views[0].id, { sorts: [{ field: rate, dir: "desc" }], filters: [{ field: rate, op: "gt", value: "1" }], hidden: [rate] });
  b = T.deleteField(b, ppl, rate);
  const v = T.tableById(b, ppl)!.views[0]; eq([v.sorts.length, v.filters.length, v.hidden.length], [0, 0, 0], "view references removed");
  b = T.deleteTable(b, ppl);
  ok(!T.tableById(b, proj)!.fields.some((f) => f.id === team), "link into a deleted table is removed");
  let threw = false; try { T.deleteTable(b, proj); } catch { threw = true; } ok(threw, "last table protected");
  threw = false; try { T.deleteView(b, proj, T.tableById(b, proj)!.views[0].id); } catch { threw = true; } ok(threw, "last view protected");
  for (const junk of [null, {}, { format: "fusion-tables-1", tables: [] }, { format: "x", tables: [{}] }, { format: "fusion-tables-1", name: "", tables: [{ id: "t", name: "t", fields: [{ id: "f", name: "f", type: "evil" }], records: [], views: [] }] }]) {
    threw = false; try { T.loadBase(junk); } catch { threw = true; } ok(threw, `loadBase(${JSON.stringify(junk)})`);
  }
  const s = T.sampleBase(); const round = T.loadBase(JSON.parse(JSON.stringify(s)));
  eq(round.tables.length, 2, "sample base survives JSON");
  // sample sanity: Cost = Hours × owner's rate; 'Design poolside theme' = 6.5 h × Bo 65 = 422.5
  const tasks = round.tables[0]; const cost = T.fieldByName(tasks, "Cost")!.id; const nm = tasks.fields[0].id;
  const rec = tasks.records.find((r) => r.cells[nm] === "Design poolside theme")!;
  eq(T.computeTable(round, tasks.id).get(rec.id)![cost], 422.5, "sample cost");
});

finish();
