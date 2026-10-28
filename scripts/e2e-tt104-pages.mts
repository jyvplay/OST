import assert from 'node:assert/strict';
import pg from 'pg';
import {launchChromium} from './browser-launch.mts';
import {makeHarness} from './harness.mts';
const BASE=process.env.BASE,dsn=process.env.DATABASE_URL;if(!BASE||!dsn||process.env.TT89_DISPOSABLE_DATABASE!=='1'||!new URL(dsn).pathname.endsWith('_test'))throw Error('Explicit disposable _test database required');
const {test,finish}=makeHarness('e2e-tt104-pages');
const api=async(method:string,path:string,body?:unknown)=>{const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok);return r.json();};
const pool=new pg.Pool({connectionString:dsn}),browser=await launchChromium(),page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);
const tag='pages104-'+Date.now(),folder='/Downloads/Recall/'+tag;
try{
 await api('GET','/api/settings');const state=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(state.row?.revision??0)+100,state:{...state.row?.state,windows:[{id:'pages104',module:'recall',title:'Recall',props:{},x:15,y:45,w:1380,h:970,z:20,workspace:1}],focus:'pages104',activeWorkspace:1,nextZ:21}});
 await pool.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime) VALUES($1,'/Downloads/Recall','pages104','dir','inode/directory')",[folder]);await pool.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime) SELECT $1||'/'||i||'.png',$1,i||'.png','file','image/png' FROM generate_series(1,405) i",[folder]);
 await page.goto(BASE);const recall=page.getByTestId('recall'),group=recall.getByLabel('Recall custom folder',{exact:true}),list=recall.getByRole('list',{name:'Memory timeline'}),older=recall.getByRole('button',{name:'Load older memories'});
 await recall.getByLabel('Recall folder grouping',{exact:true}).selectOption('custom');await group.fill(tag);
 const waitCount=async(n:number)=>{await page.waitForFunction(n=>document.querySelectorAll('[aria-label="Memory timeline"] button').length===n,n);assert.equal(await list.getByRole('button').count(),n);};
 await test('native UI loads first metadata page and refuses continuation after grouping changes',{'RC-18':'partial'},async()=>{await recall.getByRole('button',{name:'Refresh memory timeline',exact:true}).click();await waitCount(100);await group.fill(tag+'-changed');await older.click();await recall.getByRole('status').filter({hasText:'Folder changed; refresh'}).waitFor();assert.equal(await list.getByRole('button').count(),100);await group.fill(tag);});
 await test('native older-page control appends without duplicates and caps at 400',{},async()=>{for(const count of [200,300,400]){await older.click();await waitCount(count);}const names=await list.getByRole('button').allTextContents();assert.equal(new Set(names).size,400);assert.equal(await older.isDisabled(),true);});
 await test('refresh restarts pagination and closing preview has no side effect on listing',{},async()=>{await recall.getByRole('button',{name:'Refresh memory timeline',exact:true}).click();await waitCount(100);assert.equal(await older.isDisabled(),false);assert.equal(await recall.getByRole('button',{name:'Close memory preview'}).isDisabled(),true);});
 await recall.getByRole('region',{name:'Paste or drop resident media'}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/evidence/tt104-pages.png'});
}finally{await browser.close();await pool.query('DELETE FROM vfs_nodes WHERE path=$1 OR parent=$1',[folder]);await pool.end();}
finish();
