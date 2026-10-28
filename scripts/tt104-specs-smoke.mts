import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {launchChromium} from './browser-launch.mts';
const BASE=process.env.BASE;if(!BASE||process.env.TT89_DISPOSABLE_DATABASE!=='1')throw Error('Disposable target required');
const api=async(method:string,path:string,body?:unknown)=>{const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok);return r.json();};
await api('GET','/api/settings');const original=await api('GET','/api/state?id=default'),browser=await launchChromium();
try{
 await api('PUT','/api/state',{id:'default',revision:(original.row?.revision??0)+1,state:{...original.row?.state,windows:[{id:'spec104',module:'spec',title:'Specs',props:{},x:20,y:45,w:1360,h:950,z:20,workspace:1}],focus:'spec104',activeWorkspace:1,nextZ:21}});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});await page.goto(BASE);await page.getByLabel('Family',{exact:true}).selectOption('Recall');assert.equal(await page.getByRole('button',{name:/RC-(0[1-9]|1[0-9]|2[01])\b/}).count(),21);
 await page.getByRole('button',{name:/RC-18\b/}).click();await page.getByText(/Excludes metadata exceeding path\/name\/MIME/).waitFor();await page.screenshot({path:'docs/evidence/tt104-specs.png'});
 await page.getByRole('button',{name:/RC-12\b/}).click();await page.getByText(/archive pipeline remains explicit plaintext/).waitFor();
 writeFileSync('docs/evidence/tt104-runtime.json',JSON.stringify({node:process.version,chromium:browser.version(),agents:1,theoremProverUsed:false,independentReviewer:false,physicalChooserClipboardDragAudioVerified:false,newTestsUseSyntheticClipboardEvents:false,newTestsOverrideClipboardPermissions:false,newTestsInterceptNetwork:false,graphics:'headless Chromium / software graphics',playwrightDefaultKeychainMockFlag:true,playwrightDefaultMutedAudio:true,downloadChecksAcceptDownloads:true},null,2)+'\n');
 console.log('PASS: actual Specs UI has 21 partial Recall requirements; bounded metadata and plaintext archive gaps exposed.');
}finally{await browser.close();const current=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(current.row?.revision??0)+1,state:original.row?.state??{}});}
