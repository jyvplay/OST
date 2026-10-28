/** Small real-UI smoke on a separate disposable preview DB; never runs implicitly. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { launchChromium } from './browser-launch.mts';
if(process.env.TT99_PREVIEW_SMOKE!=='1'||!process.env.DATABASE_URL||new URL(process.env.DATABASE_URL).pathname!=='/tt99_preview'||!process.env.BASE) throw new Error('Explicit tt99_preview database, BASE and TT99_PREVIEW_SMOKE=1 required');
const BASE=process.env.BASE;
async function api(method:string,path:string,body?:unknown){const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,`${method} ${path}: ${r.status}`);return r.json();}
await api('GET','/api/bootstrap');
const title='Orbit field guide';
const found=(await api('GET','/api/notes')).rows.find((n:{title:string})=>n.title===title);
const note=found??(await api('POST','/api/notes',{title,body:'TT99 preview guide.\n\nRight-click this saved note, or focus its title and press Shift+F10, to open its real actions.\n\nFiles supports rectangular selection from blank space, including edge scrolling. Browser tabs have their own target-specific actions. These are bounded improvements, not an all-app Class A certification.',tags:'guide'})).row;
const old=await api('GET','/api/state?id=default');
await api('PUT','/api/state',{id:'default',revision:(old.row?.revision??1)+1000,state:{...old.row?.state,windows:[],focus:null}});
const browser=await launchChromium();
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${BASE}/?open=notes`);await page.locator('html[data-focus-mode]').waitFor();const win=page.locator('.fs-window').last();
 const row=win.locator(`[data-orbit-target="Note: ${title}"]`).locator('button').first();await row.click();
 assert.equal(await win.getByLabel('Note body').inputValue(),note.body);
 await row.focus();await row.press('Shift+F10');const menu=page.getByRole('menu',{name:'Orbit actions'});await menu.getByRole('menuitem',{name:'Duplicate note',exact:true}).waitFor();
 await page.screenshot({path:'docs/evidence/tt99-preview.png'});await page.keyboard.press('Escape');assert.equal(await row.evaluate(e=>document.activeElement===e),true);
 assert.deepEqual(errors,[]);writeFileSync('docs/evidence/tt99-preview-smoke.json',JSON.stringify({pass:true,noteId:note.id,checks:['real bootstrap and notes APIs','saved note text matches API','keyboard object context','Escape restores origin','no uncaught page errors'],screenshot:'tt99-preview.png'},null,2)+'\n');
 console.log('Preview smoke: 5 checks passed, no page errors.');
}finally{await browser.close();}
