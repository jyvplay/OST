/**
 * Real-browser suite "e2e-contacts" (TT24): the Contacts module in headless Chromium against the production build.
 * Every test works on its own /Contacts/e2e-<run>-<n>.vcf (passed as the window's path prop), so the user's
 * /Contacts/contacts.vcf is never touched, and the files are moved to the Trash at the end.
 * Checked through the UI AND through the file the UI wrote (read back over /api/fs and parsed by the engine).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-contacts.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import * as C from "../src/lib/contacts-core.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-contacts");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const RUN = Date.now().toString(36);
const made: string[] = [];
const bookPath = (n: number) => { const p = `/Contacts/e2e-${RUN}-${n}.vcf`; made.push(p); return p; };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const readBook = async (p: string) => { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(p)}`); return r.status === 200 ? String(r.json.node.content) : null; };
const writeBook = (p: string, content: string) => api("POST", "/api/fs", { op: "write", path: p, content, mime: "text/vcard" });
const cwin = (id: string, props: Record<string, unknown>) => ({ id, module: "contacts", title: "Contacts", x: 20, y: 10, w: 1380, h: 820, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`timed out: ${what}`); }
const browser: Browser = await launchChromium();
async function open(path: string): Promise<{ page: Page; w: Locator; close: () => Promise<void> }> {
  await desktop([cwin("ct1", { path })]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const w = page.locator('.fs-window[aria-label="Contacts"]');
  await w.getByTestId("contacts").waitFor({ timeout: 30_000 });
  await poll(async () => !(await w.getByTestId("ct-list").innerText()).includes("Loading"), "book loaded");
  return { page, w, close: () => ctx.close() };
}
const items = (w: Locator) => w.getByTestId("ct-item");
const saved = (w: Locator) => poll(async () => (await w.getByTestId("ct-status").innerText()).trim() === "saved", "status saved");
const fill = async (w: Locator, id: string, v: string) => w.getByTestId(`ct-field-${id}`).fill(v);

const RFC6350_8 = ["BEGIN:VCARD", "VERSION:4.0", "UID:simon", "FN:Simon Perreault", "N:Perreault;Simon;;;ing. jr,M.Sc.", "BDAY:--0203", "ANNIVERSARY:20090808T1430-0500", "GENDER:M",
  "LANG;PREF=1:fr", "LANG;PREF=2:en", "ORG;TYPE=work:Viagenie", "ADR;TYPE=work:;Suite D2-630;2875 Laurier;", " Quebec;QC;G1V 2M2;Canada",
  'TEL;VALUE=uri;TYPE="work,voice";PREF=1:tel:+1-418-656-9254;ext=102', 'TEL;VALUE=uri;TYPE="work,cell,voice,video,text":tel:+1-418-262-6501',
  "EMAIL;TYPE=work:simon.perreault@viagenie.ca", "GEO;TYPE=work:geo:46.772673,-71.282945", "KEY;TYPE=work;VALUE=uri:", " http://www.viagenie.ca/simon.perreault/simon.asc",
  "TZ:-0500", "URL;TYPE=home:http://nomis80.org", "END:VCARD"].join("\r\n");
const RFC2426_7 = ["BEGIN:vCard", "VERSION:3.0", "UID:frank", "FN:Frank Dawson", "ORG:Lotus Development Corporation", "ADR;TYPE=WORK,POSTAL,PARCEL:;;6544 Battleford Drive", " ;Raleigh;NC;27613-3502;U.S.A.",
  "TEL;TYPE=VOICE,MSG,WORK:+1-919-676-9515", "TEL;TYPE=FAX,WORK:+1-919-676-9564", "EMAIL;TYPE=INTERNET,PREF:Frank_Dawson@Lotus.com", "EMAIL;TYPE=INTERNET:fdawson@earthlink.net",
  "URL:http://home.earthlink.net/~fdawson", "END:vCard"].join("\r\n");
const V21 = ["BEGIN:VCARD", "VERSION:2.1", "UID:juergen", "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=BCrgen;;;", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller", "TEL;CELL:+49 170 1234567", "END:VCARD"].join("\r\n");

await test("create: empty book → New → fill name, e-mail, phone, birthday, two groups → Save; card links and the .vcf on disk are right", { "CN-02": "full", "PR-05": "partial" }, async () => {
  const P = bookPath(1);
  const { page, w, close } = await open(P);
  ok((await w.getByTestId("ct-list").innerText()).includes("No contacts yet"), "empty state");
  ok(await w.getByTestId("ct-picker").isDisabled() === !(await page.evaluate(() => "contacts" in navigator && "ContactsManager" in window)), "picker button follows feature detection");
  ok(/Android/.test((await w.getByTestId("ct-picker").getAttribute("title")) ?? "") || !(await w.getByTestId("ct-picker").isDisabled()), "disabled picker says why");
  await w.getByTestId("ct-new").click();
  await fill(w, "given", "Ada"); await fill(w, "family", "Lovelace"); await fill(w, "org", "Analytical Engines");
  await fill(w, "bday", "1815-12-10");
  await w.getByTestId("ct-emails-add").click(); await w.getByTestId("ct-emails-0").fill("ada@engines.example");
  await w.getByTestId("ct-tels-add").click(); await w.getByTestId("ct-tels-0").fill("+44 20 7946 0001");
  await w.getByTestId("ct-field-categories").pressSequentially("math, poetry");   // typed key by key: the comma must survive
  ok(await w.getByTestId("ct-field-categories").inputValue() === "math, poetry", `groups box kept the typed text: ${await w.getByTestId("ct-field-categories").inputValue()}`);
  await w.getByTestId("ct-save").click();
  await w.getByTestId("ct-card").waitFor();
  ok(await w.getByTestId("ct-card-name").innerText() === "Ada Lovelace", "display name derived from first + last");
  ok(await w.locator('a[href="mailto:ada@engines.example"]').count() === 1, "mailto link");
  ok(await w.locator('a[href="tel:+442079460001"]').count() === 1, "tel link with digits only");
  ok(await items(w).count() === 1, "one list item");
  await saved(w);
  const disk = (await readBook(P))!;
  ok(disk.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n"), "4.0 with CRLF");
  for (const want of ["FN:Ada Lovelace\r\n", "N:Lovelace;Ada;;;\r\n", "ORG:Analytical Engines\r\n", "BDAY:18151210\r\n", "EMAIL;TYPE=home:ada@engines.example\r\n", "TEL;TYPE=cell:+44 20 7946 0001\r\n", "CATEGORIES:math,poetry\r\n"]) ok(disk.includes(want), `file has ${JSON.stringify(want)}:\n${disk}`);
  ok(/\r\nREV:\d{8}T\d{6}Z\r\n/.test(disk), "REV timestamp");
  await close();
});

await test("validation and cancel: no name + bad e-mail → two errors announced (role=alert), nothing saved; Esc closes the editor", { "CN-02": "partial" }, async () => {
  const P = bookPath(2);
  const { w, close } = await open(P);
  await w.getByTestId("ct-new").click();
  await w.getByTestId("ct-emails-add").click(); await w.getByTestId("ct-emails-0").fill("not-an-address");
  await w.getByTestId("ct-save").click();
  const errs = w.getByTestId("ct-errors");
  await errs.waitFor();
  ok(await errs.getAttribute("role") === "alert", "errors are an alert");
  ok(await errs.locator("li").count() === 2, `2 errors, got ${await errs.innerText()}`);
  await w.getByTestId("ct-emails-0").press("Escape");
  ok(await w.getByTestId("ct-editor").count() === 0, "Esc cancelled");
  ok(await items(w).count() === 0, "nothing added");
  ok(await readBook(P) === null, "no file written");
  await close();
});

await test("import + search + persistence: RFC 6350 §8, RFC 2426 §7 and a 2.1 quoted-printable card load; search folds accents and matches phone digits; .vcf import skips a repeated UID; survives reload", { "CN-04": "full", "CN-02": "partial", "CN-01": "partial" }, async () => {
  const P = bookPath(3);
  await writeBook(P, [RFC6350_8, RFC2426_7, V21].join("\r\n"));
  const { page, w, close } = await open(P);
  ok(await items(w).count() === 3, `3 contacts, got ${await items(w).count()}`);
  ok(JSON.stringify(await items(w).evaluateAll((els) => els.map((e) => e.getAttribute("data-uid")))) === JSON.stringify(["frank", "juergen", "simon"]), "sorted by family name (Dawson, Müller, Perreault)");
  const search = w.getByTestId("ct-search");
  await search.fill("muller"); await poll(async () => (await items(w).count()) === 1, "accent fold");
  ok(await items(w).first().getAttribute("data-uid") === "juergen", "muller → Müller");
  await search.fill("919 676"); await poll(async () => (await items(w).count()) === 1 && (await items(w).first().getAttribute("data-uid")) === "frank", "phone digits");
  await search.fill("quebec viagenie"); await poll(async () => (await items(w).count()) === 1 && (await items(w).first().getAttribute("data-uid")) === "simon", "multi-token over address + e-mail");
  await search.fill("zzz"); await poll(async () => (await w.getByTestId("ct-list").innerText()).includes("No contact matches"), "no match");
  await search.fill("");
  // import a file through the real file input: one new contact, one repeat of an existing UID
  const extra = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:grace\r\nFN:Grace Hopper\r\nEMAIL:grace@navy.example\r\nEND:VCARD\r\n" + RFC2426_7;
  await w.getByTestId("ct-import-file").setInputFiles({ name: "more.vcf", mimeType: "text/vcard", buffer: Buffer.from(extra) });
  await poll(async () => (await items(w).count()) === 4, "4 after import");
  ok(await page.getByText(/Imported 1 contact\(s\) from more\.vcf, 1 already present/).count() >= 1, "toast reports the skipped UID");
  await saved(w);
  await page.reload({ waitUntil: "domcontentloaded" });
  await w.getByTestId("contacts").waitFor();
  await poll(async () => (await items(w).count()) === 4, "4 after reload");
  const parsed = C.parseVcf((await readBook(P))!);
  ok(parsed.contacts.length === 4 && parsed.warnings.length === 0, "file re-parses cleanly");
  const simon = parsed.contacts.find((c) => c.uid === "simon")!;
  ok(simon.extra.includes("GEO;TYPE=work:geo:46.772673,-71.282945") && simon.tels[0].value === "+1-418-656-9254;ext=102" && simon.tels[0].uri, "unmodelled GEO and the tel: URI survived the UI save");
  await close();
});

await test("keyboard edit, delete and undo: E opens the editor, Enter saves, Delete removes, Undo restores; unknown fields survive the edit", { "CN-02": "full" }, async () => {
  const P = bookPath(4);
  await writeBook(P, [RFC6350_8, RFC2426_7].join("\r\n"));
  const { page, w, close } = await open(P);
  const simon = w.locator('[data-testid="ct-item"][data-uid="simon"]');
  await simon.focus(); await page.keyboard.press("e");
  await w.getByTestId("ct-editor").waitFor();
  await fill(w, "title", "Researcher");
  await w.getByTestId("ct-field-title").press("Enter");
  await w.getByTestId("ct-card").waitFor();
  ok((await w.getByTestId("ct-card").innerText()).includes("Researcher at Viagenie"), "title shown");
  await saved(w);
  let disk = (await readBook(P))!;
  ok(disk.includes("TITLE:Researcher") && disk.includes("GEO;TYPE=work:geo:46.772673,-71.282945") && disk.includes("tel:+1-418-656-9254;ext=102") && disk.includes("KEY;TYPE=work;VALUE=uri:http://www.viagenie.ca/simon.perre"), `edit kept the unknown fields:\n${disk}`);
  await w.locator('[data-testid="ct-item"][data-uid="frank"]').focus(); await page.keyboard.press("Delete");
  await poll(async () => (await items(w).count()) === 1, "deleted");
  ok(await page.getByText("Deleted Frank Dawson").count() >= 1, "toast");
  await w.getByTestId("ct-undo").click();
  await poll(async () => (await items(w).count()) === 2, "undo restored");
  await saved(w);
  disk = (await readBook(P))!;
  ok(disk.includes("FN:Frank Dawson") && disk.includes("TITLE:Researcher"), "undo restored Frank only (the title edit stays)");
  await close();
});

await test("duplicates and merge, birthdays: two cards sharing an e-mail (different case) are grouped and merged without losing a phone; a birthday in 3 days is listed", { "CN-03": "full" }, async () => {
  const P = bookPath(5);
  const d = new Date(Date.now() + 3 * 864e5); const md = `--${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  await writeBook(P, [
    `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:a1\r\nFN:Ana Lima\r\nEMAIL:ana@x.example\r\nTEL:+1 919 555 0100\r\nBDAY:${md}\r\nEND:VCARD`,
    "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:a2\r\nFN:A. Lima\r\nEMAIL:ANA@X.EXAMPLE\r\nTEL:+1 919 555 0199\r\nNOTE:met in Lisbon\r\nEND:VCARD",
    "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:b1\r\nFN:Bo Chen\r\nEND:VCARD"].join("\r\n"));
  const { page, w, close } = await open(P);
  ok((await w.getByTestId("ct-birthdays").innerText()).includes("Ana Lima · in 3 days"), `birthday strip: ${await w.getByTestId("ct-birthdays").innerText()}`);
  ok((await w.getByTestId("ct-dupes").innerText()).includes("(1)"), "toolbar counts 1 group");
  await w.getByTestId("ct-dupes").click();
  const g = w.getByTestId("ct-dupe-group");
  ok(await g.count() === 1 && (await g.innerText()).includes("same e-mail ana@x.example"), `group: ${await g.innerText()}`);
  await w.getByTestId("ct-merge").click();
  await w.getByTestId("ct-card").waitFor();
  ok(await items(w).count() === 2, "3 → 2");
  const card = await w.getByTestId("ct-card").innerText();
  ok(card.includes("+1 919 555 0100") && card.includes("+1 919 555 0199") && card.includes("met in Lisbon"), `merged card keeps both phones + note: ${card}`);
  ok(await page.getByText("Merged 2 contacts into Ana Lima").count() >= 1, "toast");
  await saved(w);
  const c = C.parseVcf((await readBook(P))!).contacts.find((x) => x.uid === "a1")!;
  ok(c.emails.length === 1 && c.tels.length === 2 && !C.parseVcf((await readBook(P))!).contacts.some((x) => x.uid === "a2"), "file: a1 merged, a2 gone");
  await close();
});

await test("export: CSV to Files (injection-guarded) and as a download; .vcf download re-imports to the same contacts", { "CN-04": "full" }, async () => {
  const P = bookPath(6);
  await writeBook(P, ["BEGIN:VCARD\r\nVERSION:4.0\r\nUID:e1\r\nFN:=HYPERLINK(\"http://evil\")\r\nTEL:+1 919 555 0100\r\nEND:VCARD", RFC6350_8].join("\r\n"));
  const { page, w, close } = await open(P);
  const [csvDl] = await Promise.all([page.waitForEvent("download"), w.getByTestId("ct-export-csv").click()]);
  ok(csvDl.suggestedFilename() === "contacts.csv", "csv download name");
  const csvPath = P.replace(/[^/]+$/, "contacts-export.csv");
  await poll(async () => (await readBook(csvPath)) !== null, "csv in Files");
  const csv = (await readBook(csvPath))!;
  ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`) && csv.includes(",+1 919 555 0100,"), `CSV guarded, phone untouched:\n${csv}`);
  ok(readFileSync((await csvDl.path())!, "utf8") === csv, "download = file in Files");
  const [vcfDl] = await Promise.all([page.waitForEvent("download"), w.getByTestId("ct-download-vcf").click()]);
  const back = C.parseVcf(readFileSync((await vcfDl.path())!, "utf8"));
  ok(vcfDl.suggestedFilename() === "contacts.vcf" && back.contacts.length === 2 && back.contacts.some((c) => c.uid === "urn:uuid:simon" || c.uid === "simon"), ".vcf download re-imports");
  await close();
});

await test("Files integration and launcher: a .vcf reached in Files with the keyboard alone (arrows, Space, Enter) opens in Contacts; Contacts is in the launcher", { "CN-04": "partial", "PR-05": "partial", "FM-01": "partial" }, async () => {
  const P = bookPath(7);
  await writeBook(P, RFC2426_7);
  await desktop([{ id: "f1", module: "files", title: "Files", x: 20, y: 10, w: 900, h: 600, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { path: "/Contacts" } }]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const files = page.locator('.fs-window[aria-label="Files"]');
  const row = files.locator(".fs-list-item", { hasText: P.split("/").pop()! });
  await row.waitFor({ timeout: 30_000 });
  // keyboard only (WCAG 2.1.1; Files rows were mouse-only before TT24): one tab stop, arrows move, Enter opens
  const stops = files.locator('[role="listbox"] [role="option"][tabindex="0"]');
  ok(await stops.count() === 1, `exactly one tab stop in the listing, got ${await stops.count()}`);
  await stops.focus();
  for (let i = 0; i < 200 && !(await row.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
  ok(await row.evaluate((e) => e === document.activeElement), "arrow keys reached the .vcf row");
  await page.keyboard.press("Space");
  ok(await row.getAttribute("aria-selected") === "true", "Space selects");
  await page.keyboard.press("Enter");
  const w = page.locator(".fs-window", { has: page.getByTestId("contacts") });
  await w.getByTestId("contacts").waitFor();
  await poll(async () => (await items(w).count()) === 1, "opened the file");
  ok((await w.innerText()).includes(P), "status bar shows the file path");
  await page.getByTestId("launcher-button").click();
  ok(await page.getByRole("button", { name: /Contacts/ }).count() >= 1, "Contacts in the launcher");
  await ctx.close();
});

await test("axe-core: list, card, editor (with errors) and duplicates view — no serious/critical WCAG 2.2 AA violations", { "CN-02": "partial", "AX-08": "partial" }, async () => {
  const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
  const P = bookPath(8);
  await writeBook(P, [RFC6350_8, RFC2426_7, RFC2426_7.replace("UID:frank", "UID:frank2")].join("\r\n"));
  const { page, w, close } = await open(P);
  const bad: string[] = [];
  const scan = async (where: string) => {
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
    const vs = await page.evaluate(async () => {
      const ax = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const r = await ax.run({ include: ['.fs-window[aria-label="Contacts"]'] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes[0]?.target.join(" ")}`);
    });
    for (const v of vs) bad.push(`${where}: ${v}`);
  };
  await scan("list");
  await w.locator('[data-testid="ct-item"][data-uid="simon"]').click(); await w.getByTestId("ct-card").waitFor(); await scan("card");
  await w.getByTestId("ct-edit").click(); await fill(w, "fn", ""); await fill(w, "given", ""); await fill(w, "family", ""); await w.getByTestId("ct-save").click(); await w.getByTestId("ct-errors").waitFor(); await scan("editor with errors");
  await w.getByTestId("ct-cancel").click(); await w.getByTestId("ct-dupes").click(); await w.getByTestId("ct-dupe-group").waitFor(); await scan("duplicates");
  await close();
  ok(bad.length === 0, bad.join("\n      "));
});

await desktop([]);
for (const p of [...made, "/Contacts/contacts-export.csv"]) await api("POST", "/api/fs", { op: "trash", path: p });
await browser.close();
finish();
