import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx=await disposableShell(), {test,finish}=makeHarness("e2e-tt161-lazy-thumbnail");
const root=`/Documents/tt161-lazy-${Date.now()}`, target=`${root}/zzz-real.heic`;
const heic=JSON.parse(readFileSync("/tmp/tt148-heic.json","utf8")) as {bytes:string};
try {
 await test("a clipped HEIC stays lazy until the user scrolls to it",{},async()=>{
  await fx.api("POST","/api/fs",{op:"mkdir",path:root});
  for(let i=0;i<60;i++) await fx.api("POST","/api/fs",{op:"write",path:`${root}/file-${String(i).padStart(2,"0")}.txt`,content:"fixture",mime:"text/plain"});
  await fx.api("POST","/api/fs",{op:"write",path:target,content:heic.bytes,encoding:"base64",mime:"image/heic"});
  const cur=await fx.api<{row:{revision:number}}>("GET","/api/state?id=default");
  await fx.api("PUT","/api/state",{id:"default",revision:Number(cur.row.revision)+1000,state:{windows:[{id:"w1",module:"files",title:"Files",x:10,y:10,w:1100,h:720,z:10,workspace:1,props:{path:root}}],focus:"w1",workspaces:[{id:1,name:"Main"}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context({viewport:{width:1360,height:900}});
  try {
   const page=await ctx.newPage(); const errors:string[]=[]; page.on("pageerror",e=>errors.push(e.message));
   await fx.ready(page,"files"); const win=page.locator('[data-win-id="w1"]');
   await win.getByTitle("grid view").click();
   const tile=win.locator(`[data-path="${target}"]`), thumb=tile.locator('[data-thumb]'); await thumb.waitFor();
   const before=await thumb.evaluate(el=>{const box=el.getBoundingClientRect(), list=el.closest('[data-testid="files-listing"]')!.getBoundingClientRect();return {top:box.top,bottom:list.bottom,state:el.getAttribute('data-thumb')};});
   assert.ok(before.top>before.bottom,`fixture must be clipped: ${JSON.stringify(before)}`);
   assert.equal(before.state,"pending","offscreen tile should not have fabricated a result");
   await thumb.scrollIntoViewIfNeeded();
   await page.waitForFunction(p=>{const el=document.querySelector(`[data-path="${p}"] [data-thumb]`); return !!el && el.getAttribute('data-thumb') !== 'pending';},target,{timeout:30000});
   const engine=await page.evaluate(async b64=>{try{const raw=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const bmp=await createImageBitmap(new Blob([raw],{type:'image/heic'}));bmp.close();return true;}catch{return false;}},heic.bytes);
   const state=await thumb.getAttribute("data-thumb");
   if(engine) assert.equal(state,"ready"); else {assert.equal(state,"none"); assert.match((await thumb.getAttribute("title"))??"",/no HEIC \(HEVC image\) decoder/);}
   assert.deepEqual(errors,[]);
  }finally{await ctx.close();}
 });
}finally{await fx.api("POST","/api/fs",{op:"purge",path:root}); await fx.close(); finish();}
