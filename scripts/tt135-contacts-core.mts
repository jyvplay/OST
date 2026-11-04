import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { emptyContact, parseVcf, MAX_INPUT, MAX_CONTACTS, findDuplicates } from "../src/lib/contacts-core.ts";
import { bookProblem, contactImportProblem, planContactImport } from "../src/lib/contact-import.ts";
const { test, finish } = makeHarness("tt135-contacts-core");
const card = (id: string, name: string) => `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${id}\r\nFN:${name}\r\nEND:VCARD\r\n`;
await test("import keeps first new identity and skips both old and repeated incoming IDs", { "CN-04": "partial" }, () => {
  const existing = parseVcf(card("old", "Existing")).contacts;
  const incoming = parseVcf(card("old", "Overwrite") + card("new", "First") + card("new", "Second") + card("x", "Third")).contacts;
  const plan = planContactImport(existing, incoming);
  assert.deepEqual(plan.fresh.map(c => [c.uid, c.fn]), [["new", "First"], ["x", "Third"]]);
  assert.equal(plan.alreadyPresent, 1); assert.equal(plan.repeated, 1); assert.equal(existing[0].fn, "Existing");
});
await test("book refuses duplicate identities and non-card data, but permits an empty book", { "CN-02": "partial" }, () => {
  const duplicate = card("same", "First") + card("same", "Second");
  assert.match(bookProblem(duplicate, parseVcf(duplicate))!, /repeated UIDs/);
  assert.match(bookProblem("not a vcard", parseVcf("not a vcard"))!, /No vCards/);
  assert.equal(bookProblem("  ", parseVcf("  ")), null);
  const unique = card("A", "First") + card("a", "Second");
  assert.equal(bookProblem(unique, parseVcf(unique)), null);
});
await test("parse limits mark truncated results explicitly without treating exact limits as truncated", { "CN-01": "partial", "CN-02": "partial" }, () => {
  const tooLarge = "x".repeat(MAX_INPUT + 1); assert.equal(parseVcf(tooLarge).truncated, true);
  const one = card("x", "X");
  const exact = parseVcf(one.repeat(MAX_CONTACTS)); assert.equal(exact.contacts.length, MAX_CONTACTS); assert.equal(exact.truncated, false);
  const over = parseVcf(one.repeat(MAX_CONTACTS + 1)); assert.equal(over.contacts.length, MAX_CONTACTS); assert.equal(over.truncated, true);
  assert.match(bookProblem(one, over)!, /exceeds/);
});
await test("import capacity refuses an oversized combined book instead of producing an unreadable one", { "CN-04": "partial" }, () => {
  const c = emptyContact("id"); c.fn = "Example";
  assert.equal(contactImportProblem(Array(MAX_CONTACTS).fill(c), []), null);
  assert.match(contactImportProblem(Array(MAX_CONTACTS).fill(c), [c])!, /exceed 20000/);
  const large = {...c, note: "x".repeat(MAX_INPUT)};
  assert.match(contactImportProblem([], [large])!, /size limit/);
});
await test("duplicate graph joins transitive reasons and preserves input order", { "CN-03": "partial" }, () => {
  const a = emptyContact("a"), b = emptyContact("b"), c = emptyContact("c"), d = emptyContact("d");
  a.fn = "Alpha"; b.fn = "Beta"; c.fn = "Gamma"; d.fn = "Delta";
  a.emails = [{value: "ONE@example.com", types: []}]; b.emails = [{value: "one@example.com", types: []}];
  b.tels = [{value: "555-111-2345", types: []}]; c.tels = [{value: "+1 555 111 2345", types: []}];
  assert.deepEqual(findDuplicates([a,b,c,d]), [{uids:["a","b","c"], reasons:["same e-mail one@example.com", "same phone +1 555 111 2345"]}]);
});
finish();
