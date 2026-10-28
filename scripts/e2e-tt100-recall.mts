/** Exclusive real HTTP publisher + PostgreSQL + Chromium. No routed/fabricated API responses or media API replacement. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { launchChromium } from './browser-launch.mts';
import { MODULES } from '../src/lib/registry.ts';
import { makeHarness } from './harness.mts';
import { recallUrl,recallLabel,recallFolder,recallSource,recallMime,sameRecallOrigin } from '../src/lib/recall-core.ts';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('Exclusive disposable server/database and BASE required');
const BASE=process.env.BASE, UP='http://127.0.0.1:4001',tag=`tt100-${Date.now()}`;
const {test,finish}=makeHarness('e2e-tt100-recall');
async function api(method:string,path:string,body?:unknown){const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json();}
async function poll(fn:()=>Promise<boolean>,name:string,ms=18000){const end=Date.now()+ms;do{if(await fn())return;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);throw new Error(`Timeout: ${name}`);}
const listing=async(path:string)=>(await api('GET',`/api/fs?op=list&path=${encodeURIComponent(path)}`)).nodes??[];
await api('GET','/api/bootstrap');await api('PUT','/api/settings',{key:'appearance.desktopView',value:'classic'});
// TT108: pin the text scale before the first window opens. This suite inherited whatever scale an earlier suite —
// or an earlier run of this one, whose Undo restores only the last of its two steps — had left in the database.
// At 300% the browser tab's frame collapsed and the fixture heading was invisible; one step below the maximum the
// second A+ was correctly disabled and no second notification was ever posted. Both looked like product failures.
await api('PUT','/api/settings',{key:'appearance.textScale',value:'125'});
await test('pure boundary: only absolute credential-free HTTP URLs are admitted',{},()=>{for(const u of ['blob:x','file:///etc/passwd','javascript:alert(1)','https://a:b@example.com/','/relative'])assert.throws(()=>recallUrl(u));assert.equal(recallUrl('https://example.com/a#x').href,'https://example.com/a');});
await test('pure boundary: grouping cannot escape /Downloads/Recall and secret query tokens are omitted',{},()=>{assert.equal(recallSource('https://example.com/a?secret=x#z'),'https://example.com/a');assert.ok(!recallLabel('../../x/\u202etest').includes('/'));assert.equal(recallFolder('https://example.com/a','x','custom','../x'),'/Downloads/Recall/_x');assert.throws(()=>recallFolder('https://example.com','x','custom',''));});
await test('pure boundary: playlists and HTML cannot masquerade as complete media',{},()=>{for(const m of ['text/html','application/vnd.apple.mpegurl','audio/x-mpegurl','application/dash+xml'])assert.throws(()=>recallMime(m));assert.equal(recallMime('video/webm;codecs=vp8'),'video/webm');assert.equal(sameRecallOrigin('http://127.0.0.2:4001/a',UP),false);});
const browser=await launchChromium();const errors:string[]=[];
async function desktop(modules:{id:string;module:string;props?:object}[]){const old=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(old.row?.revision??1)+1000,state:{windows:modules.map((m,i)=>({...m,title:MODULES.find(entry=>entry.id===m.module)?.title??m.module,props:m.props??{},x:40+i*40,y:55+i*30,w:1100,h:750,z:11+i,minimized:false,maximized:false,workspace:1,host:'tab'})),focus:modules.at(-1)?.id,workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:20,viewport:{w:1440,h:1000},icons:[],focusMode:false}});}
async function open(){const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',e=>errors.push(e.message));await page.goto(BASE);await page.locator('html[data-focus-mode]').waitFor({timeout:60000});return{context,page};}
await desktop([{id:'r1',module:'recall'}]);const a=await open(),r=a.page.getByTestId('recall'),folder=`/Downloads/Recall/${tag}`;
await r.getByLabel('Recall folder grouping').selectOption('custom');await r.getByLabel('Recall custom folder').fill(tag);
async function direct(path:string){await r.getByLabel('Recall source URL').fill(UP+path);await r.getByRole('button',{name:'Save media URL',exact:true}).click();}
await test('Recall original-byte method saves exact publisher bytes and a SHA-256 provenance receipt',{},async()=>{
 await direct('/image.png?token=secret');await poll(async()=>(await listing(folder)).length===2,'image plus receipt');
 const nodes=await listing(folder),media=nodes.find((n:{path:string})=>n.path.endsWith('.png')),receipt=nodes.find((n:{path:string})=>n.path.endsWith('.json'));
 const file=(await api('GET',`/api/fs?op=read&path=${encodeURIComponent(media.path)}`)).node;
 const original=Buffer.from(await (await fetch(UP+'/image.png')).arrayBuffer());assert.deepEqual(Buffer.from(file.content,'base64'),original);
 const proof=JSON.parse((await api('GET',`/api/fs?op=read&path=${encodeURIComponent(receipt.path)}`)).node.content);
 assert.equal(proof.sha256,createHash('sha256').update(original).digest('hex'));assert.equal(proof.source,UP+'/image.png');assert.equal(proof.bytes,original.length);
});
await test('a repeated download creates a fresh asset without overwriting the first one',{},async()=>{const before=(await listing(folder)).map((n:{path:string})=>n.path);await direct('/image.png?token=secret');await poll(async()=>(await listing(folder)).length===4,'second image receipt');for(const p of before)assert.ok((await listing(folder)).some((n:{path:string})=>n.path===p));});
for(const path of ['/partial','/large','/redirect','/playlist','/'])await test(`original-byte rejection: ${path} creates no successful archive`,{},async()=>{const before=await r.locator('li[data-phase=failed]').count(),n=(await listing(folder)).length;await direct(path);await poll(async()=>await r.locator('li[data-phase=failed]').count()>before,'failed job');assert.equal((await listing(folder)).length,n);});
await test('an active slow HTTP fetch is cancellable without a VFS commit',{},async()=>{const before=await r.locator('li[data-phase=cancelled]').count(),n=(await listing(folder)).length;await direct('/slow');await r.locator('li[data-phase=fetching]').first().waitFor();await r.getByRole('button',{name:'Cancel pending / fetching jobs'}).click();await poll(async()=>await r.locator('li[data-phase=cancelled]').count()>before,'cancelled fetch');assert.equal((await listing(folder)).length,n);});
await a.context.close();
await desktop([{id:'paint',module:'imageedit'},{id:'r2',module:'recall'}]);const c=await open(),rec=c.page.getByTestId('recall');
await c.page.getByTestId('studio-canvas').waitFor();await rec.getByLabel('Recall folder grouping').selectOption('custom');await rec.getByLabel('Recall custom folder').fill(tag+'-record');await rec.getByRole('button',{name:'Refresh Fusion sources'}).click();
const index=await c.page.evaluate(()=>[...document.querySelectorAll('canvas,video,audio')].filter(e=>!e.closest('[data-testid=recall]')).findIndex(e=>e.getAttribute('data-testid')==='studio-canvas'));
assert.ok(index>=0);await rec.getByLabel('Recall capture source').selectOption(String(index));
const recordedFolder=`/Downloads/Recall/${tag}-record`;
await test('PNG raster method captures a real Fusion canvas into a decodable image',{},async()=>{
 const originalPixel=await c.page.getByTestId('studio-canvas').evaluate(e=>[...e.getContext('2d')!.getImageData(50,50,1,1).data]);assert.ok(originalPixel[0]>240&&originalPixel[3]===255,'real Image Editor white background is populated');
 await rec.getByRole('button',{name:'Capture authorized image'}).click();await poll(async()=>(await listing(recordedFolder)).length===2,'PNG receipt');
 const n=(await listing(recordedFolder)).find((n:{path:string})=>n.path.endsWith('.png'));const file=(await api('GET',`/api/fs?op=read&path=${encodeURIComponent(n.path)}`)).node;
 const dims=await c.page.evaluate(async({content})=>{const bytes=Uint8Array.from(atob(content),x=>x.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d')!;ctx.drawImage(bitmap,0,0);const d=[bitmap.width,bitmap.height,...ctx.getImageData(50,50,1,1).data];bitmap.close();return d;},{content:file.content});assert.ok(dims[0]>10&&dims[1]>10);assert.deepEqual(dims.slice(2),originalPixel,'snapshot must contain the real source pixels, not just a decodable black frame');
});
await test('MediaRecorder encodes actual canvas tracks; closing invokes a real discard/save guard',{},async()=>{
 await rec.getByRole('button',{name:'Start authorized recording'}).click();await rec.getByText('recording',{exact:true}).waitFor();
 await c.page.locator('.fs-window[data-win-id=r2]').getByRole('button',{name:'Close window',exact:true}).click();await c.page.getByTestId('close-confirm').waitFor();await c.page.getByTestId('close-confirm-cancel').click();
 await c.page.waitForTimeout(1300);await rec.getByRole('button',{name:'Stop and finalize'}).click();await poll(async()=>(await listing(recordedFolder)).length===4,'WebM receipt');
 const n=(await listing(recordedFolder)).find((n:{path:string})=>n.path.endsWith('.webm'));const file=(await api('GET',`/api/fs?op=read&path=${encodeURIComponent(n.path)}`)).node;
 assert.deepEqual([...Buffer.from(file.content,'base64').subarray(0,4)],[0x1a,0x45,0xdf,0xa3]);assert.ok(file.size>100);
 const width=await c.page.evaluate(async(content)=>{const video=document.createElement('video');const u=URL.createObjectURL(new Blob([Uint8Array.from(atob(content),x=>x.charCodeAt(0))],{type:'video/webm'}));try{await new Promise<void>((resolve,reject)=>{video.onloadedmetadata=()=>resolve();video.onerror=()=>reject(new Error('WebM decode failed'));video.src=u;});return video.videoWidth;}finally{URL.revokeObjectURL(u);}},file.content);assert.ok(width>10);await c.page.screenshot({path:'docs/evidence/tt100-recall.png'});
});
await test('audio-only capture refuses a real canvas with no audio instead of inventing a soundtrack',{},async()=>{await rec.getByLabel('Audio-only output (requires shared audio)').check();await rec.getByRole('button',{name:'Start authorized recording'}).click();await rec.getByRole('alert').filter({hasText:'No shared audio track'}).waitFor();assert.equal((await listing(recordedFolder)).length,4);});
await test('after a refused no-audio attempt the same Recall window can capture again without leaked busy state',{},async()=>{
 await rec.getByLabel('Audio-only output (requires shared audio)').uncheck();await rec.getByRole('button',{name:'Capture authorized image'}).click();await poll(async()=>(await listing(recordedFolder)).length===6,'snapshot after error');
});
await test('closing the source application invalidates a selected capture element without wedging Recall',{},async()=>{
 await c.page.locator('.fs-window[data-win-id=paint]').getByRole('button',{name:'Close window',exact:true}).click();await c.page.locator('.fs-window[data-win-id=paint]').waitFor({state:'detached'});
 await rec.getByRole('button',{name:'Capture authorized image'}).click();await rec.getByRole('alert').filter({hasText:'surface is gone'}).waitFor();assert.equal(await rec.getByRole('button',{name:'Start authorized recording'}).isEnabled(),true);assert.equal((await listing(recordedFolder)).length,6);
});
await c.page.screenshot({path:'docs/evidence/tt100-recall-stale-source.png'});await c.context.close();
const wave=Buffer.alloc(44+48000*2);wave.write('RIFF',0);wave.writeUInt32LE(wave.length-8,4);wave.write('WAVEfmt ',8);wave.writeUInt32LE(16,16);wave.writeUInt16LE(1,20);wave.writeUInt16LE(1,22);wave.writeUInt32LE(48000,24);wave.writeUInt32LE(96000,28);wave.writeUInt16LE(2,32);wave.writeUInt16LE(16,34);wave.write('data',36);wave.writeUInt32LE(wave.length-44,40);for(let i=0;i<48000;i++)wave.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/48000)*12000),44+i*2);
const wavePath=`/Documents/${tag}.wav`;await api('POST','/api/fs',{op:'upload',path:wavePath,content:wave.toString('base64'),mime:'audio/wav'});
await desktop([{id:'media',module:'media',props:{path:wavePath}},{id:'audio-recall',module:'recall'}]);const audio=await open(),ar=audio.page.getByTestId('recall');
await test('audio-only method captures real playing PCM through a media element and encodes non-silent decodable audio',{},async()=>{
 const player=audio.page.locator('.fs-window[data-win-id=media] video');await player.waitFor();await audio.page.waitForFunction(()=>{const v=document.querySelector<HTMLVideoElement>('.fs-window[data-win-id=media] video');return !!v&&v.readyState>=2;});
 await player.evaluate(async e=>{e.loop=true;e.muted=true;await e.play();});
 await ar.getByLabel('Recall folder grouping').selectOption('custom');await ar.getByLabel('Recall custom folder').fill(tag+'-audio');await ar.getByRole('button',{name:'Refresh Fusion sources'}).click();
 const index=await audio.page.evaluate(()=>[...document.querySelectorAll('canvas,video,audio')].filter(e=>!e.closest('[data-testid=recall]')).findIndex(e=>!!e.closest('.fs-window[data-win-id=media]')));
 await ar.getByLabel('Recall capture source').selectOption(String(index));await ar.getByLabel('Audio-only output (requires shared audio)').check();await ar.getByRole('button',{name:'Start authorized recording'}).click();await ar.getByText('recording',{exact:true}).waitFor();await audio.page.waitForTimeout(1500);await ar.getByRole('button',{name:'Stop and finalize'}).click();
 const dir=`/Downloads/Recall/${tag}-audio`;await poll(async()=>(await listing(dir)).length===2,'audio receipt');const n=(await listing(dir)).find((x:{path:string})=>x.path.endsWith('.webm'));const file=(await api('GET',`/api/fs?op=read&path=${encodeURIComponent(n.path)}`)).node;
 const rms=await audio.page.evaluate(async(content)=>{const bytes=Uint8Array.from(atob(content),x=>x.charCodeAt(0));const ctx=new OfflineAudioContext(1,48000,48000);const decoded=await ctx.decodeAudioData(bytes.buffer);const data=decoded.getChannelData(0);return Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length);},file.content);assert.ok(rms>.01,`audio RMS ${rms}`);
});await audio.context.close();
await desktop([{id:'b1',module:'browser',props:{tabs:[{id:'t1',url:UP+'/',title:'Recall publisher',pinned:false,asleep:false,group:''}],active:'t1',proxyAll:true}}]);const b=await open();
const proxy=b.page.getByTestId('wp-tab'),iframe=b.page.frameLocator('[data-testid=wp-frame]'),autoFolder=`/Downloads/Recall/${tag}-auto`;await iframe.getByRole('heading',{name:'Recall fixture'}).waitFor();
await test('exposed-media discovery is off before explicit opt-in',{},async()=>{await b.page.waitForTimeout(700);assert.equal((await listing(autoFolder)).length,0);});
await test('armed proxy discovery archives real DOM media once and reacts to actual DOM mutations',{},async()=>{
 await proxy.getByLabel('Auto Recall folders').selectOption('custom');await proxy.getByLabel('Auto Recall custom folder').fill(tag+'-auto');await proxy.getByTestId('recall-auto').click();await poll(async()=>(await listing(autoFolder)).length===2,'first exposed image');
 await iframe.getByRole('button',{name:'Add real media'}).click();await poll(async()=>(await listing(autoFolder)).length===4,'new DOM image');
 await b.page.waitForTimeout(3400);assert.equal((await listing(autoFolder)).length,4);
});
await test('automatic discovery rejects actual cross-origin media and drains a batch larger than its pending queue',{},async()=>{
 await iframe.locator('body').evaluate((el)=>{const other=document.createElement('img');other.src='http://127.0.0.2:4001/image.png?outside=1';el.append(other);for(let i=0;i<22;i++){const img=document.createElement('img');img.src='/image.png?burst='+i;el.append(img);}});
 await poll(async()=>(await listing(autoFolder)).length===48,'22 additional same-origin images and receipts',30000);
});
await test('forged top-level discovery messages cannot request media copies',{},async()=>{await b.page.evaluate(()=>window.postMessage({fusionWp:'recall-media',urls:['http://127.0.0.1:4001/image.png?forged=1']},'*'));await b.page.waitForTimeout(500);assert.equal((await listing(autoFolder)).length,48);});
await test('disarming stops subsequent page mutations from writing new media',{},async()=>{await proxy.getByTestId('recall-auto').click();await iframe.locator('body').evaluate(el=>{const img=document.createElement('img');img.src='/image.png?third=3';el.append(img);});await b.page.waitForTimeout(3400);assert.equal((await listing(autoFolder)).length,48);});
await b.context.close();
await test('amnesic mode refuses Recall server writes without creating a shadow success',{},async()=>{
 const context=await browser.newContext();const page=await context.newPage();try{await page.goto(BASE+'/?amnesia=1&open=recall');const root=page.getByTestId('recall');await root.getByLabel('Recall source URL').fill(UP+'/image.png');await root.getByRole('button',{name:'Save media URL',exact:true}).click();await root.getByRole('alert').filter({hasText:'amnesic'}).waitFor();assert.equal(await root.locator('li[data-phase=saved]').count(),0);}finally{await context.close();}
});
// Visual / interaction regression: shared menu, Files view controls and real setting Undo.
await desktop([{id:'n',module:'notes'}]);const note=(await api('POST','/api/notes',{title:tag+' long note title with several words',body:'visual fixture'})).row;
const v=await open();
await test('Orbit context is a compact content-sized menu, not a viewport-wide panel',{},async()=>{await v.page.locator(`[data-orbit-target="Note: ${note.title}"]`).locator('button').first().click({button:'right'});const m=v.page.getByRole('menu',{name:'Orbit actions'});const box=await m.boundingBox();assert.ok(box&&box.width<=321&&box.width>=150&&box.x>=0&&box.x+box.width<=1440);await v.page.screenshot({path:'docs/evidence/tt100-menu.png'});await v.page.keyboard.press('Escape');});
await test('bottom-right notifications form a bounded stack and the real setting Undo stays reachable',{},async()=>{
 await v.page.getByRole('button',{name:'Quick panel',exact:true}).click();const quick=v.page.getByRole('dialog',{name:'Quick panel',exact:true});
 const before=(await api('GET','/api/settings')).rows.find((x:{key:string})=>x.key==='appearance.textScale')?.value;
 await quick.getByRole('button',{name:'A+ larger text',exact:true}).click();await v.page.getByTestId('toasts').waitFor();await quick.getByRole('button',{name:'A+ larger text',exact:true}).click();
 const stack=v.page.getByTestId('toasts'),box=await stack.boundingBox();assert.ok(box&&box.width<=361&&box.x>1000&&box.y>500);await poll(async()=>await stack.locator('.fs-toast-back').count()>0,'a second notification stacks behind the newest',4000);
 await v.page.getByRole('button',{name:'Quick panel',exact:true}).click();await v.page.screenshot({path:'docs/evidence/tt100-toasts.png'});
 await stack.getByRole('button',{name:/earlier notification/}).click();await stack.getByRole('button',{name:'Undo',exact:true}).last().click();
 await poll(async()=>(await api('GET','/api/settings')).rows.find((x:{key:string;value:string})=>x.key==='appearance.textScale')?.value===before,'original setting restored');
 await v.page.screenshot({path:'docs/evidence/tt100-toasts-expanded.png'});
});await v.context.close();
await desktop([{id:'f',module:'files'}]);const f=await open();
await test('Files uses distinct original SVG view glyphs while all three view buttons still work',{},async()=>{const win=f.page.locator('.fs-window[data-win-id=f]');for(const [title,glyph]of [['list view','list'],['grid view','grid'],['column view','column']]){const button=win.getByTitle(title,{exact:true});await button.waitFor();assert.equal(await button.locator(`svg[data-view-glyph=${glyph}]`).count(),1);await button.click();assert.equal(await button.getAttribute('aria-pressed'),'true');const colors=await button.evaluate(el=>{const probe=document.createElement('span');probe.style.cssText='display:none;background:var(--fs-accent)';document.body.append(probe);const pair=[getComputedStyle(el).backgroundColor,getComputedStyle(probe).backgroundColor];probe.remove();return pair;});assert.equal(colors[0],colors[1],'selected text/background must swap together, without a low-contrast transition');}await f.page.screenshot({path:'docs/evidence/tt100-views.png'});});await f.context.close();
await test('no uncaught page exceptions in Recall and visual interaction tests',{},()=>assert.deepEqual(errors,[]));
await browser.close();finish();
