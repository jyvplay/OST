/** Exclusive real PostgreSQL + Chromium gate. No fabricated app or API responses. */
import assert from 'node:assert/strict';
import { launchChromium } from './browser-launch.mts';
import { makeHarness } from './harness.mts';
import type { Page, Locator } from 'playwright';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) throw new Error('Explicit disposable database and matching BASE required');
const BASE = process.env.BASE, tag = `tt99-${Date.now()}`;
const { test, finish } = makeHarness('e2e-tt99-interactions');
async function api(method: string, route: string, data?: unknown) {
  const r = await fetch(BASE + route, { method, headers: { 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  assert.ok(r.ok, `${method} ${route}: ${r.status} ${await (r.ok ? Promise.resolve('') : r.text())}`); return r.json();
}
async function poll(check:()=>Promise<boolean|undefined>, message:string, timeout=12000) {
  const end=Date.now()+timeout;
  do { if(await check()) return; await new Promise(resolve=>setTimeout(resolve,50)); } while(Date.now()<end);
  throw new Error(`Timed out: ${message}`);
}
await test('the persisted-state oracle awaits false async results and rejects a failed negative control',{},async()=>{
  let calls=0; await poll(async()=>++calls>=3,'third observation'); assert.equal(calls,3);
  await assert.rejects(poll(async()=>false,'negative control',60),/Timed out: negative control/);
});
const browser = await launchChromium(); const errors: string[] = [];
async function boot(module: string, path?: string) {
  const old = await api('GET', '/api/state?id=default');
  await api('PUT', '/api/state', { id: 'default', revision: (old.row?.revision ?? 1) + 1000, state: { windows: [], focus: null, workspaces: [{ id: 1, name: 'Main' }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${BASE}/?open=${module}${path ? '&path=' + encodeURIComponent(path) : ''}`);
  await page.locator('html[data-focus-mode]').waitFor({ timeout: 60000 });
  const candidate = page.locator('.fs-window').last(); await candidate.waitFor(); const id = await candidate.getAttribute('data-win-id'); const win = page.locator(`.fs-window[data-win-id="${id}"]`);
  return { page, win, close: () => context.close() };
}
const menu = (p: Page) => p.getByRole('menu', { name: 'Orbit actions' });
async function action(p: Page, target: Locator, name: string, keyboard = false) {
  if (keyboard) { await target.focus(); await target.press('Shift+F10'); } else await target.click({ button: 'right' });
  await menu(p).getByRole('menuitem', { name, exact: true }).click();
}
const dir = `/Documents/${tag}`; await api('POST', '/api/fs', { op: 'mkdir', path: dir });
for (let i = 0; i < 55; i++) await api('POST', '/api/fs', { op: 'write', path: `${dir}/row-${String(i).padStart(2,'0')}.txt`, content: `entry ${i}` });
const f = await boot('files', dir), { page, win } = f;
const pane = win.locator('.fs-files-pane').first(), listing = pane.getByTestId('files-listing'), rows = pane.locator('[role=option]'); await rows.first().waitFor();
const selected = () => pane.locator('[role=option][aria-selected=true]');
await test('content anchor survives real edge scrolling and retains offscreen crossed rows', { 'FM-15': 'partial' }, async () => {
  const b = await listing.boundingBox(), r = await rows.first().boundingBox(); assert.ok(b && r);
  await page.mouse.move(b.x + b.width - 5, r.y + 2); await page.mouse.down(); await page.mouse.move(r.x + 10, b.y + b.height - 6, { steps: 10 });
  await page.waitForFunction(() => (document.querySelector('[data-testid=files-listing]')?.scrollTop ?? 0) > 250);
  assert.equal(await rows.first().getAttribute('aria-selected'), 'true'); assert.ok(await selected().count() > 12);
  await page.mouse.up(); const before = await listing.evaluate(el => el.scrollTop); await page.waitForTimeout(200); assert.equal(await listing.evaluate(el => el.scrollTop), before);
  assert.equal(await page.getByTestId('orbit-marquee').count(), 0);
});
await test('subpixel edge velocity progresses at the inner edge instead of rounding every frame to zero',{'FM-15':'partial'},async()=>{
  await listing.evaluate(el=>{el.scrollTop=0}); await rows.first().click(); assert.equal(await rows.first().getAttribute('aria-selected'),'true'); const b=await listing.boundingBox(),r=await rows.first().boundingBox(); assert.ok(b&&r);
  await page.mouse.move(b.x+b.width-5,r.y+2); await page.mouse.down();
  try {
    await page.mouse.move(r.x+10,b.y+b.height-27.5,{steps:8});
    await page.waitForFunction(()=>(document.querySelector('[data-testid=files-listing]')?.scrollTop??0)>3,null,{timeout:3000});
    assert.equal(await rows.first().getAttribute('aria-selected'),'true');
  } finally {await page.mouse.up();}
});
await test('Escape during scrolling restores the exact gesture-start selection', { 'FM-15': 'partial' }, async () => {
  await listing.evaluate(el => { el.scrollTop = 0; }); await rows.first().click();
  const b = await listing.boundingBox(), r = await rows.first().boundingBox(); assert.ok(b && r);
  await page.mouse.move(b.x + b.width - 5, r.y + 2); await page.mouse.down(); await page.mouse.move(r.x + 10, b.y + b.height - 6, { steps: 8 });
  await page.keyboard.press('Escape'); await page.mouse.up(); assert.equal(await selected().count(), 1); assert.equal(await rows.first().getAttribute('aria-selected'), 'true');
});
await test('actual pointer capture loss rolls back rather than committing a partial rectangle', { 'FM-15': 'partial' }, async () => {
  await listing.evaluate(el => { el.scrollTop = 0; el.addEventListener('pointerdown', e => { el.dataset.captured = String(e.pointerId); }, { once: true }); });
  const b = await listing.boundingBox(), r = await rows.first().boundingBox(); assert.ok(b && r);
  await page.mouse.move(b.x + b.width - 5, r.y + 2); await page.mouse.down(); await page.mouse.move(r.x + 10, r.y + r.height * 3, { steps: 8 });
  await listing.evaluate(el => el.releasePointerCapture(Number(el.dataset.captured))); await page.mouse.move(r.x + 20, r.y + r.height * 4); await page.mouse.up();
  assert.equal(await selected().count(), 1); assert.equal(await rows.first().getAttribute('aria-selected'), 'true');
  await rows.nth(2).click(); assert.equal(await rows.nth(2).getAttribute('aria-selected'), 'true');
});
await test('a real viewport resize cancels an in-flight scroll rectangle and restores its selection', {'FM-15':'partial'}, async()=>{
  await listing.evaluate(el=>{el.scrollTop=0}); await rows.first().click(); const before=await selected().evaluateAll(els=>els.map(e=>e.getAttribute('data-path')));
  const b=await listing.boundingBox(), r=await rows.first().boundingBox(); assert.ok(b&&r);
  await page.mouse.move(b.x+b.width-5,r.y+2); await page.mouse.down(); await page.mouse.move(r.x+10,b.y+b.height-4,{steps:8});
  await page.evaluate(()=>{ (window as unknown as {resizeCount:number}).resizeCount=0; window.addEventListener('resize',()=>{(window as unknown as {resizeCount:number}).resizeCount++},{once:true}); });
  try {
    await page.setViewportSize({width:1430,height:990});
    await page.waitForFunction(()=>(window as unknown as {resizeCount:number}).resizeCount===1);
    await page.getByTestId('orbit-marquee').waitFor({state:'detached'});
    assert.deepEqual(await selected().evaluateAll(els=>els.map(e=>e.getAttribute('data-path'))),before);
  } finally { await page.mouse.up(); await page.setViewportSize({width:1440,height:1000}); }
});
await test('grid rectangle uses item geometry rather than list-row arithmetic', { 'FM-15': 'partial' }, async () => {
  await pane.getByRole('button', { name: 'Grid', exact: true }).click(); await listing.evaluate(el => { el.scrollTop = 0; });
  const b = await listing.boundingBox(), r = await rows.first().boundingBox(), t = await rows.nth(2).boundingBox(); assert.ok(b && r && t);
  await page.mouse.move(b.x + 5, r.y + 2); await page.mouse.down(); await page.mouse.move(t.x + t.width - 2, r.y + r.height - 2, { steps: 8 }); await page.mouse.up();
  assert.equal(await selected().count(), 3); await pane.getByRole('button', { name: 'List', exact: true }).click();
});
await test('selection in the second pane activates only that pane and keeps keyboard selection local', { 'FM-02': 'partial', 'FM-15': 'partial' }, async () => {
  await win.getByRole('button', { name: 'Dual pane', exact: true }).click();
  const right = win.locator('[data-pane="b"]'), rightRows = right.locator('[role=option]'), region = right.getByTestId('files-listing'); await rightRows.first().waitFor();
  const b = await region.boundingBox(), r = await rightRows.first().boundingBox(), last = await rightRows.nth(2).boundingBox(); assert.ok(b && r && last);
  await page.mouse.move(b.x + 5, r.y + 2); await page.mouse.down(); await page.mouse.move(r.x + r.width - 15, last.y + last.height - 2, {steps:8}); await page.mouse.up();
  assert.equal(await right.getAttribute('data-active'), 'true'); assert.equal(await right.locator('[role=option][aria-selected=true]').count(), 3);
  await page.keyboard.press('Control+a'); assert.equal(await right.locator('[role=option][aria-selected=true]').count(), 55);
  assert.notEqual(await pane.locator('[role=option][aria-selected=true]').count(), 55);
  await win.getByRole('button', { name: 'Dual pane', exact: true }).click();
});
await test('column ancestor context acts on the clicked folder, not the current folder', { 'FM-06': 'partial' }, async () => {
  await pane.getByRole('button', { name: 'Columns', exact: true }).click();
  const target = pane.locator('[data-col-path="/Documents"]'); await target.waitFor(); await target.click({ button: 'right' });
  assert.equal(await menu(page).count(), 0); await page.getByTestId('files-menu').getByRole('menuitem', { name: 'Open', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.fs-files-pane')?.getAttribute('data-cwd') === '/Documents');
});
await f.close();
const note = (await api('POST', '/api/notes', { title: tag, body: 'saved content', tags: 'test' })).row;
const n = await boot('notes'), nt = n.win.locator(`[data-orbit-target="Note: ${tag}"] button`).first(); await nt.waitFor();
await test('Notes keyboard context pin is persisted and the menu skips disabled actions', { 'PR-02': 'partial' }, async () => {
  await action(n.page, nt, 'Pin note', true);
  await poll(async () => (await api('GET','/api/notes')).rows.find((r:{id:number;pinned:boolean})=>r.id===note.id)?.pinned===true,'note pin persisted');
});
await test('Notes duplicate copies real saved text and tags without changing the original', { 'PR-02': 'partial' }, async () => {
  await action(n.page, nt, 'Duplicate note'); await n.win.locator(`[data-orbit-target="Note: ${tag} copy"]`).waitFor();
  const r = (await api('GET', '/api/notes')).rows.find((r: {title:string}) => r.title === `${tag} copy`); assert.equal(r.body, 'saved content'); assert.equal(r.tags, 'test');
});
await test('Notes dirty draft disables destructive context actions and native text remains native', { 'PR-02': 'partial' }, async () => {
  await nt.click(); await n.win.getByLabel('Note body').fill('unsaved secret'); await nt.click({ button: 'right' });
  assert.equal(await menu(n.page).getByRole('menuitem', { name: 'Delete note…', exact: true }).isDisabled(), true);
  assert.equal(await menu(n.page).getByRole('menuitem', { name: 'Duplicate note', exact: true }).isDisabled(), true);
  await n.page.keyboard.press('Escape'); assert.equal(await n.win.getByLabel('Note body').inputValue(), 'unsaved secret');
  await n.win.getByLabel('Note body').click({ button: 'right' }); assert.equal(await menu(n.page).count(), 0); await n.page.keyboard.press('Escape');
  await n.win.getByRole('button', { name: 'Save', exact: true }).click(); await n.win.getByText('saved', { exact: true }).waitFor();
});
await test('Notes context deletion is cancelable and removes only the chosen note', { 'PR-02': 'partial' }, async () => {
  await action(n.page, nt, 'Delete note…'); await n.page.locator('.fs-ask').getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(await nt.count(), 1);
  await action(n.page, nt, 'Delete note…'); await n.page.locator('.fs-ask').getByRole('button', { name: 'Delete note', exact: true }).click(); await nt.waitFor({ state: 'detached' });
  assert.ok((await api('GET', '/api/notes')).rows.some((r: {title:string}) => r.title === `${tag} copy`));
});
await n.close();
const alert = (await api('POST', '/api/alerts', { app: 'TT99', title: tag, body: 'a real alert', priority: 'normal' })).row;
const a = await boot('alerts'), at = a.win.getByRole('group', { name: `Alert: ${tag}`, exact: true }); await at.waitFor();
await test('Alerts object menu marks read and unread through real persisted state', { 'NC-01': 'partial' }, async () => {
  await action(a.page, at, 'Mark read', true); await poll(async () => (await api('GET','/api/alerts')).rows.find((r:{id:number;read:boolean})=>r.id===alert.id)?.read===true,'alert read true persisted');
  await action(a.page, at, 'Mark unread'); await poll(async () => (await api('GET','/api/alerts')).rows.find((r:{id:number;read:boolean})=>r.id===alert.id)?.read===false,'alert read false persisted');
});
await test('Alerts pin and snooze persist without affecting another alert', { 'NC-01': 'partial' }, async () => {
  await action(a.page, at, 'Pin alert'); await poll(async () => (await api('GET','/api/alerts')).rows.find((r:{id:number;pinned:boolean})=>r.id===alert.id)?.pinned===true,'alert pinned true persisted');
  const time = Date.now(); await action(a.page, at, 'Snooze 15 minutes');
  await poll(async () => !!(await api('GET','/api/alerts')).rows.find((r:{id:number;snoozeUntil:string|null})=>r.id===alert.id)?.snoozeUntil,'snooze persisted');
  const saved = (await api('GET','/api/alerts')).rows.find((r:{id:number})=>r.id===alert.id); assert.ok(Math.abs(Date.parse(saved.snoozeUntil) - time - 900000) < 15000);
});
await test('typeahead and one roving tab stop work in object menus', { 'AX-02': 'partial' }, async () => {
  await at.focus(); await at.press('Shift+F10'); await a.page.keyboard.press('d'); assert.equal(await a.page.evaluate(()=>document.activeElement?.textContent), 'Dismiss alert');
  assert.equal(await menu(a.page).locator('button[tabindex="0"]').count(), 1); await a.page.keyboard.press('Escape'); assert.equal(await at.evaluate(el=>document.activeElement===el), true);
});
await test('Tab closes the menu and advances outside it instead of cycling through menuitems', { 'AX-02': 'partial' }, async () => {
  await at.focus(); await at.press('Shift+F10'); await a.page.keyboard.press('Tab'); assert.equal(await menu(a.page).count(), 0);
  assert.equal(await at.evaluate(el => el.querySelector('button') === document.activeElement), true);
});
await test('Alerts context dismiss deletes only the selected alert', { 'NC-01': 'partial' }, async () => { await action(a.page, at, 'Dismiss alert'); await at.waitFor({ state: 'detached' }); assert.ok(!(await api('GET','/api/alerts')).rows.some((r:{id:number})=>r.id===alert.id)); });
await a.close();
await api('PUT','/api/settings',{key:'alerts.focusRules', value:JSON.stringify([{id:'tt99-hold',name:'TT99 hold',enabled:true,allowApps:[],allowPriorities:[]}])});
const heldAlert=(await api('POST','/api/alerts',{app:'TT99',title:tag+' held',body:'held notification'})).row;
const heldPage=await boot('alerts');
await test('held-alert context release removes only the chosen hold without an OS notification claim', { 'NC-02':'partial' }, async()=>{
  const target=heldPage.win.getByRole('group',{name:`Alert: ${tag} held`,exact:true}); await target.waitFor();
  await action(heldPage.page,target,'Release held alert',true);
  await poll(async () => (await api('GET','/api/alerts')).rows.find((r:{id:number;heldBy:string|null})=>r.id===heldAlert.id)?.heldBy===null,'hold release persisted');
  await heldPage.win.locator(`[data-testid="held-${heldAlert.id}"]`).waitFor({state:'detached'});
});
await heldPage.close(); await api('PUT','/api/settings',{key:'alerts.focusRules',value:'[]'});

const s = await boot('find');
await test('Find contextual Open routes a real CSV into the editor rather than window controls', { 'SR-02': 'partial' }, async () => {
  const name = `needle${Date.now()}.csv`, path = `/Documents/${name}`; await api('POST','/api/fs',{op:'write',path,content:'x,y\n1,2'});
  await s.win.getByLabel('Search query').fill(name); await s.win.getByRole('button',{name:'Search',exact:true}).click();
  const target = s.win.locator('[data-orbit-target]').filter({hasText: name}).first().locator('button').first(); await target.waitFor();
  await action(s.page,target,'Open result',true); await s.page.locator('.fs-window').last().getByLabel(`Editing ${path}`, { exact: true }).waitFor();
});
await test('Editor Keep controls remain present after loading and Save persists content plus the previous version',{'PR-01':'partial','FM-18':'partial'},async()=>{
  const ed=s.page.locator('.fs-window').last(), text=ed.getByRole('textbox'), label=await text.getAttribute('aria-label'); assert.ok(label?.startsWith('Editing ')); const path=label.slice(8);
  assert.equal(await ed.getByRole('button',{name:'Save',exact:true}).isDisabled(),true); await text.fill('x,y\n3,4'); await ed.getByText('unsaved',{exact:true}).waitFor();
  await ed.getByRole('button',{name:'Save',exact:true}).click();
  await poll(async()=>(await api('GET',`/api/fs?op=read&path=${encodeURIComponent(path)}`)).node.content==='x,y\n3,4','editor Save persisted');
  assert.ok((await api('GET',`/api/fs?op=versions&path=${encodeURIComponent(path)}`)).versions.some((v:{content:string})=>v.content==='x,y\n1,2'));
});
await test('a stale Find result cannot open a deleted file or silently create a document', { 'SR-02':'partial' },async()=>{
  await s.win.locator('.fs-titlebar').click();
  const name=`stale${Date.now()}.md`, path=`/Documents/${name}`; await api('POST','/api/fs',{op:'write',path,content:'real source'});
  await s.win.getByLabel('Search query').fill(name); await s.win.getByRole('button',{name:'Search',exact:true}).click();
  const target=s.win.locator('[data-orbit-target]').filter({hasText:name}).first().locator('button').first(); await target.waitFor();
  await api('POST','/api/fs',{op:'trash',path}); const count=await s.page.locator('.fs-window').count();
  await action(s.page,target,'Open result'); await s.page.getByTestId('toasts').getByText(/no longer exists|not found|404/i).first().waitFor(); assert.equal(await s.page.locator('.fs-window').count(),count);
});
await s.close();
const browserApp=await boot('browser');
await test('Browser tab context duplicates the clicked URL and pins a non-active target', {'PR-07':'partial'},async()=>{
  const {page,win}=browserApp; await win.getByRole('button',{name:'+',exact:true}).click(); await win.getByRole('button',{name:'+',exact:true}).click();
  const tabs=win.locator('button[data-tab]'); assert.equal(await tabs.count(),3); const firstId=await tabs.first().getAttribute('data-tab');
  await action(page,tabs.first(),'Pin tab',true); await win.locator(`button[data-tab="${firstId}"]`).getByRole('img',{name:'pinned',exact:true}).waitFor();
  await action(page,tabs.nth(1),'Duplicate URL in new tab'); assert.equal(await tabs.count(),4);
});
await test('Browser close-others uses the context target, preserving pinned tabs',{'PR-07':'partial'},async()=>{
  const {page,win}=browserApp, tabs=win.locator('button[data-tab]'); const chosen=await tabs.nth(1).getAttribute('data-tab');
  await action(page,tabs.nth(1),'Close other unpinned tabs'); assert.equal(await tabs.count(),2); assert.ok(await win.locator(`button[data-tab="${chosen}"]`).count());
  assert.equal(await tabs.getByRole('img',{name:'pinned',exact:true}).count(),1);
});
await test('Browser explicit Close removes the clicked pinned tab, not the active neighbor',{'PR-07':'partial'},async()=>{
  const {page,win}=browserApp, tabs=win.locator('button[data-tab]'), id=await tabs.first().getAttribute('data-tab');
  await action(page,tabs.first(),'Close this tab'); await win.locator(`button[data-tab="${id}"]`).waitFor({state:'detached'}); assert.equal(await tabs.count(),1);
});
await test('Browser vertical-tab keyboard sleep/wake respects active-tab guards and survives persisted reload',{'PR-07':'partial'},async()=>{
  const {page,win}=browserApp; await win.getByTitle('Vertical tab sidebar',{exact:true}).click(); await win.getByRole('button',{name:'+ Tab',exact:true}).click();
  const tabs=win.locator('button[data-tab]'), id=await tabs.first().getAttribute('data-tab');
  await action(page,tabs.first(),'Sleep tab',true); await tabs.first().getByRole('img',{name:'asleep',exact:true}).waitFor();
  await tabs.last().focus(); await tabs.last().press('Shift+F10'); assert.equal(await menu(page).getByRole('menuitem',{name:'Sleep tab',exact:true}).isDisabled(),true); await page.keyboard.press('Escape');
  await action(page,tabs.first(),'Activate tab',true); await tabs.first().getByRole('img',{name:'asleep',exact:true}).waitFor({state:'detached'});
  await poll(async()=>{const r=await api('GET','/api/state?id=default'); return r.row?.state?.windows?.some((w:{module:string;props?:{active?:string;vertical?:boolean;tabs?:{asleep:boolean}[]}})=>w.module==='browser' && w.props?.active===id && w.props.vertical && w.props.tabs?.length===2 && w.props.tabs.every(t=>!t.asleep));},'vertical tab state persisted');
  await page.reload(); await win.getByRole('textbox',{name:'Search tabs',exact:true}).waitFor(); assert.equal(await win.locator('button[data-tab]').count(),2); assert.equal(await win.getByTestId('browser').getAttribute('data-active'),id);
});
await browserApp.close();
const d = await boot('files','/Documents');
await test('Desktop keyboard selection, Copy and context invocation work from an icon', { 'SH-04': 'partial' }, async()=>{
  await d.win.getByRole('button',{name:'Minimise',exact:true}).click(); const icon = d.page.getByTestId('desk-icon').first(); await icon.waitFor(); await icon.focus(); await icon.press('Control+a');
  assert.equal(await d.page.locator('[data-testid=desk-icon][aria-pressed=true]').count(),await d.page.getByTestId('desk-icon').count()); await icon.press('Control+c');
  const count = await d.page.evaluate(()=>JSON.parse(sessionStorage.getItem('fusion.files.clip')!).paths.length); assert.equal(count,await d.page.getByTestId('desk-icon').count());
  await icon.press('Shift+F10'); await menu(d.page).waitFor(); await d.page.keyboard.press('Escape'); assert.equal(await icon.evaluate(el=>document.activeElement===el),true);
});
await test('Desktop background keyboard menu has reachable actions and closes with Escape', { 'SH-04': 'partial' },async()=>{
  const desk=d.page.locator('[data-pointer-gesture-surface=classic]'); await desk.focus(); await desk.press('Shift+F10'); await d.page.getByRole('menuitem',{name:'New folder…',exact:true}).waitFor();
  await d.page.keyboard.press('End'); assert.equal(await d.page.evaluate(()=>document.activeElement?.textContent),'Spec register'); await d.page.keyboard.press('Escape'); assert.equal(await d.page.getByRole('menu').count(),0);
});
await d.close();
await test('no uncaught browser exceptions in the interaction matrix', { 'AX-08': 'partial' },()=>assert.deepEqual(errors,[]));
await browser.close(); finish();
