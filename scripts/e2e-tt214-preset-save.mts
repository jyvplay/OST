import assert from 'node:assert/strict';
import {disposableShell} from './tt132-fixture.mts';
import {makeHarness} from './harness.mts';
const fx=await disposableShell(),{test,finish}=makeHarness('e2e-tt214-preset-save');
const suffix=Date.now().toString(36),names=[`tt214-ui-${suffix}`,`tt214-race-${suffix}`,`tt214-lost-${suffix}`], ids=names.map(n=>`preset:${n}`);
const read=async(id:string)=>(await fx.api<{row:{revision:number;state:unknown}|null}>('GET','/api/state?id='+encodeURIComponent(id))).row;
const send=async(name:string,state:unknown)=>fetch(fx.BASE+'/api/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'createPreset',name,state})});
const open=async()=>{await fx.windows('routines');const ctx=await fx.context(),page=await ctx.newPage();await fx.ready(page,'routines');await page.locator('[data-shell-ready="true"]').waitFor();return {ctx,page,root:page.locator('[data-win-id="w1"]')};};
const submit=async(page:import('playwright').Page,name:string)=>{await page.getByTestId('ask-dialog').waitFor();await page.getByTestId('ask-dialog').locator('input').first().fill(name);await page.getByTestId('ask-ok').click();};
try{
 for(const id of ids)assert.equal(await read(id),null,'fixture name must be absent');
 await test('save layout creates a real preset with a valid revision',{},async()=>{
  const {ctx,page,root}=await open();try{
   await root.getByRole('button',{name:'Save current layout'}).click();const response=page.waitForResponse(r=>r.url().endsWith('/api/state')&&['POST','PUT'].includes(r.request().method()) && (r.request().postDataJSON()?.op === 'createPreset' || r.request().postDataJSON()?.id === ids[0]));await submit(page,names[0]);const r=await response;assert.equal(r.status(),200,await r.text());
   await root.getByText(names[0]).waitFor();const row=await read(ids[0]);assert.ok(row);assert.equal(row.revision,1);assert.ok(Array.isArray((row.state as {windows:unknown[]}).windows));
  }finally{await ctx.close();}
 });
 await test('concurrent creates preserve the winner rather than overwrite',{},async()=>{
  const results=await Promise.all([send(names[1],{windows:[{title:'A'}]}),send(names[1],{windows:[{title:'B'}]})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const row=await read(ids[1]);assert.ok(row);assert.equal(row.revision,1);assert.ok(['A','B'].includes((row.state as {windows:{title:string}[]}).windows[0].title));
 });
 await test('duplicate name is refused in the UI without changing stored state',{},async()=>{
  const before=await read(ids[0]);const {ctx,page,root}=await open();try{
   await root.getByRole('button',{name:'Save current layout'}).click();await submit(page,names[0]);await page.getByRole('alert').filter({hasText:'already exists'}).waitFor();assert.deepEqual(await read(ids[0]),before);
  }finally{await ctx.close();}
 });
 await test('cancel does not create a preset',{},async()=>{
  const {ctx,page,root}=await open();let creates=0;page.on('request',r=>{if(r.url().endsWith('/api/state') && r.method()==='POST') creates++;});try{
   await root.getByRole('button',{name:'Save current layout'}).click();await page.getByTestId('ask-dialog').waitFor();await page.getByTestId('ask-dialog').getByRole('button',{name:/cancel/i}).click();await page.getByTestId('ask-dialog').waitFor({state:'hidden'});assert.equal(creates,0);
  }finally{await ctx.close();}
 });
 await test('lost create response warns and does not retry',{},async()=>{
  const {ctx,page,root}=await open();let count=0;try{
   await page.route('**/api/state',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON()?.op==='createPreset'){count++;const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed');}return route.continue();});
   await root.getByRole('button',{name:'Save current layout'}).click();await submit(page,names[2]);await page.getByText(/save not confirmed.*check/i).waitFor({timeout:12000});assert.equal(count,1);assert.ok(await read(ids[2]));
  }finally{await ctx.close();}
 });
}finally{for(const id of ids)await fx.api('DELETE','/api/state?id='+encodeURIComponent(id)).catch(()=>undefined);await fx.close();finish();}
