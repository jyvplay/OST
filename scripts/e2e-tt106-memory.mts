import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import type {Locator} from 'playwright';
import {launchChromium} from './browser-launch.mts';
import {makeHarness} from './harness.mts';
const BASE=process.env.BASE;if(!BASE||process.env.TT89_DISPOSABLE_DATABASE!=='1')throw Error('Disposable target required');
const {test,finish}=makeHarness('e2e-tt106-memory');
const api=async(method:string,path:string,body?:unknown)=>{const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j;};
const savedPath=async(scope:Locator)=>{const text=await scope.getByRole('status').filter({hasText:'Saved memory →'}).first().innerText();const m=/Saved memory → (\S+)/.exec(text);if(!m)throw Error('No saved path in status: '+text);return m[1];};
const browser=await launchChromium(),page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);
try{
 await api('GET','/api/settings');const original=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(original.row?.revision??0)+100,state:{...original.row?.state,windows:[{id:'m106',module:'recall',title:'Recall',props:{},x:15,y:45,w:1380,h:970,z:20,workspace:1}],focus:'m106',activeWorkspace:1,nextZ:21}});await page.goto(BASE);
 const recall=page.getByTestId('recall'),tag='ui106-'+Date.now(),folder='/Downloads/Recall/'+tag;await recall.getByLabel('Recall folder grouping',{exact:true}).selectOption('custom');await recall.getByLabel('Recall custom folder',{exact:true}).fill(tag);
 const png=Buffer.from(await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=16;c.height=16;const ctx=c.getContext('2d')!;ctx.fillStyle='lime';ctx.fillRect(0,0,16,16);return Array.from(new Uint8Array(await(await new Promise<Blob>(r=>c.toBlob(b=>r(b!)))).arrayBuffer()));}));
 const listing=async()=>(await api('GET','/api/fs?'+new URLSearchParams({op:'recallPage',path:folder}))).nodes as {path:string}[];
 await recall.getByLabel('Choose resident media').setInputFiles({name:'green.png',mimeType:'image/png',buffer:png});await recall.getByRole('status').filter({hasText:'Saved memory →'}).waitFor();const greenName=(await savedPath(recall)).split('/').pop()!;await recall.getByRole('button',{name:'Refresh memory timeline',exact:true}).click();await recall.getByRole('list',{name:'Memory timeline'}).getByRole('button',{name:greenName,exact:true}).click();await recall.getByRole('img',{name:'Saved memory',exact:true}).evaluate(async(i:HTMLImageElement)=>i.decode());
 await test('single-snapshot receipt inspection works in actual UI',{'RC-24':'partial'},async()=>{await recall.getByRole('button',{name:'Verify saved receipt'}).click();await recall.getByRole('status').filter({hasText:'Single database snapshot'}).waitFor();});
 await test('save already-open frame creates native green PNG without upstream HTTP',{'RC-26':'partial'},async()=>{const count=(await listing()).length;const requests:string[]=[];const listener=(r:{url:()=>string})=>{const url=r.url();if(!url.startsWith(BASE)&&!url.startsWith('blob:'))requests.push(url);};page.on('request',listener);await recall.getByRole('button',{name:'Save preview frame',exact:true}).click();await recall.getByRole('status').filter({hasText:'Saved memory →'}).waitFor();page.off('request',listener);const rows=await listing();assert.equal(rows.length,count+1);assert.deepEqual(requests,[]);const m=await api('GET','/api/fs?'+new URLSearchParams({op:'read',path:rows[0].path}));const r=await api('GET','/api/fs?'+new URLSearchParams({op:'read',path:rows[0].path+'.recall.json'}));assert.equal(JSON.parse(r.node.content).method,'saved-preview-frame');assert.equal(await page.evaluate(async(s:string)=>{const b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));const img=await createImageBitmap(new Blob([b],{type:'image/png'}));const c=document.createElement('canvas');c.width=1;c.height=1;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);img.close();return Array.from(ctx.getImageData(0,0,1,1).data).join(',');},m.node.content),'0,255,0,255');});
 await test('cancelled trash confirmation changes nothing',{'RC-25':'partial'},async()=>{const count=(await listing()).length;await recall.getByRole('button',{name:'Trash open memory pair'}).click();await recall.getByRole('button',{name:'Cancel pair trash'}).click();assert.equal((await listing()).length,count);});
 await test('confirmed paired trash closes/revokes preview and undo restores both files',{},async()=>{const count=(await listing()).length;await recall.getByRole('button',{name:'Trash open memory pair'}).click();await recall.getByRole('button',{name:'Confirm trash pair'}).click();await recall.getByRole('status').filter({hasText:'moved to Trash together'}).waitFor();assert.equal((await listing()).length,count-1);assert.equal(await recall.getByRole('img',{name:'Saved memory',exact:true}).count(),0);await recall.getByRole('button',{name:'Undo pair trash'}).click();await recall.getByRole('status').filter({hasText:'Pair restored'}).waitFor();assert.equal((await listing()).length,count);});
 await test('open-preview identity guard refuses later media edit',{},async()=>{await recall.getByRole('button',{name:'Refresh memory timeline',exact:true}).click();await recall.getByRole('list',{name:'Memory timeline'}).getByRole('button').first().click();const path=(await listing())[0].path;const current=await api('GET','/api/fs?'+new URLSearchParams({op:'read',path}));await api('POST','/api/fs',{op:'write',path,encoding:'base64',mime:'image/png',content:current.node.content});await recall.getByRole('button',{name:'Trash open memory pair'}).click();await recall.getByRole('button',{name:'Confirm trash pair'}).click();await recall.getByRole('status').filter({hasText:'Open memory changed; reopen'}).waitFor();assert.equal((await listing()).length,2);await recall.getByRole('button',{name:'Cancel pair trash'}).click();});
 await test('real decoded WebM video preview saves its exact current frame, no media refetch',{'RC-26':'partial'},async()=>{
  const bytes=await page.evaluate(async()=>{
   const c=document.createElement('canvas');c.width=64;c.height=32;c.style.position='fixed';c.style.left='0';c.style.top='0';document.body.append(c);
   const ctx=c.getContext('2d')!,stream=c.captureStream(10),rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks:Blob[]=[];
   rec.ondataavailable=e=>chunks.push(e.data);const stopped=new Promise<void>(r=>{rec.onstop=()=>r();});
   rec.start();for(let i=0;i<12;i++){ctx.fillStyle='#0000ff';ctx.fillRect(0,0,64,32);stream.getVideoTracks().forEach(t=>t.requestFrame?.());await new Promise(r=>setTimeout(r,50));}
   rec.stop();await Promise.race([stopped,new Promise((_,x)=>setTimeout(()=>x(Error('MediaRecorder never stopped')),8000))]);
   c.remove();stream.getTracks().forEach(t=>t.stop());const blob=new Blob(chunks,{type:'video/webm'});
   if(blob.size<400)throw Error('Headless encoder produced no real frames: '+blob.size+' bytes');
   return Array.from(new Uint8Array(await blob.arrayBuffer()));});
  await recall.getByLabel('Choose resident media').setInputFiles({name:'native.webm',mimeType:'video/webm',buffer:Buffer.from(bytes)});
  await recall.getByRole('status').filter({hasText:'Saved memory →'}).waitFor();
  const webmName=(await savedPath(recall)).split('/').pop()!;
  await recall.getByRole('button',{name:'Refresh memory timeline',exact:true}).click();
  await recall.getByRole('list',{name:'Memory timeline'}).getByRole('button',{name:webmName,exact:true}).click();
  const video=recall.getByLabel('Saved memory preview').locator('video');await video.waitFor();
  await video.evaluate((v:HTMLVideoElement)=>v.readyState>=2?undefined:new Promise<void>((res,rej)=>{v.addEventListener('loadeddata',()=>res(),{once:true});v.addEventListener('error',()=>rej(Error('Saved WebM did not decode')),{once:true});setTimeout(()=>rej(Error('Saved WebM decode timed out')),10000);}));
  const count=(await listing()).length,requests:string[]=[];const listener=(r:{url:()=>string})=>{const url=r.url();if(!url.startsWith(BASE)&&!url.startsWith('blob:'))requests.push(url);};page.on('request',listener);
  await recall.getByRole('button',{name:'Save preview frame',exact:true}).click();
  await recall.getByRole('status').filter({hasText:'Saved memory →'}).waitFor();page.off('request',listener);
  const rows=await listing();assert.equal(rows.length,count+1);assert.deepEqual(requests,[]);
  const receipt=await api('GET','/api/fs?'+new URLSearchParams({op:'read',path:rows[0].path+'.recall.json'}));
  const parsed=JSON.parse(receipt.node.content);assert.equal(parsed.method,'saved-preview-frame');assert.equal(parsed.mime,'image/png');
  const saved=await api('GET','/api/fs?'+new URLSearchParams({op:'read',path:rows[0].path}));
  // A decoded video frame is the browser's YUV 4:2:0 -> RGB result, so exact authored-pixel
  // equality is the wrong predicate: VP8 is lossy. Require the real decoded blue within a
  // tight tolerance, which still fails for a black/empty/placeholder frame.
  const pixel=await page.evaluate(async(s:string)=>{const b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));const img=await createImageBitmap(new Blob([b],{type:'image/png'}));const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);const px=ctx.getImageData(1,1,1,1).data;img.close();return {w:c.width,h:c.height,r:px[0],g:px[1],b:px[2],a:px[3]};},saved.node.content);
  assert.deepEqual([pixel.w,pixel.h,pixel.a],[64,32,255]);
  assert.ok(pixel.r<=6&&pixel.g<=6&&pixel.b>=249,'decoded frame should be blue, got '+JSON.stringify(pixel));});
 await test('memory above the 16 MP decode bound is refused and clears the stale preview',{'RC-26':'partial'},async()=>{
  const bytes=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=4097;c.height=4097;const ctx=c.getContext('2d')!;ctx.fillStyle='#ff00ff';ctx.fillRect(0,0,4097,4097);return Array.from(new Uint8Array(await(await new Promise<Blob>(r=>c.toBlob(b=>r(b!)))).arrayBuffer()));});
  await recall.getByLabel('Choose resident media').setInputFiles({name:'huge.png',mimeType:'image/png',buffer:Buffer.from(bytes)});
  await recall.getByRole('status').filter({hasText:'Saved memory →'}).waitFor();
  const hugeName=(await savedPath(recall)).split('/').pop()!;
  await recall.getByRole('button',{name:'Refresh memory timeline',exact:true}).click();
  const rows=await listing();
  await recall.getByRole('list',{name:'Memory timeline'}).getByRole('button',{name:hugeName,exact:true}).click();
  await recall.getByRole('status').filter({hasText:'exceeds 16 MP'}).waitFor();
  assert.equal(await recall.getByLabel('Saved memory preview').count(),0);
  assert.ok(await recall.getByRole('button',{name:'Save preview frame',exact:true}).isDisabled());
  assert.ok(await recall.getByRole('button',{name:'Trash open memory pair'}).isDisabled());
  assert.equal((await listing()).length,rows.length);});
 await test('Specs adds all three truthful requirements without completion promotion',{},async()=>{const rows=(await api('GET','/api/features')).rows.filter((r:{code:string})=>/^RC-\d\d$/.test(r.code));assert.equal(rows.length,34);assert.ok(rows.every((r:{status:string})=>r.status==='partial'));});
 await page.screenshot({path:'docs/evidence/tt106-memory.png'});writeFileSync('docs/evidence/tt106-runtime.json',JSON.stringify({node:process.version,chromium:browser.version(),agents:1,independentReviewer:false,theoremProver:false,physicalClipboardAudioDisplay:false,newTestsInterceptNetwork:false,newTestsSyntheticEvents:false,graphics:'real headless Chromium/software graphics'},null,2));
}finally{await browser.close();}
finish();
