import assert from 'node:assert/strict';
import {launchChromium} from './browser-launch.mts';
import {writeFileSync} from 'node:fs';
const BASE=process.env.BASE;if(!BASE||process.env.TT89_DISPOSABLE_DATABASE!=='1')throw Error('Disposable target only');
async function api(method:string,path:string,body?:unknown){const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok);return r.json();}
await api('GET','/api/settings');const original=await api('GET','/api/state?id=default');
const browser=await launchChromium();try{
 await api('PUT','/api/state',{id:'default',revision:original.row.revision+1,state:{...original.row.state,windows:[{id:'s103',module:'spec',title:'Specs',props:{},x:20,y:45,w:1360,h:850,z:20,workspace:1}],focus:'s103',activeWorkspace:1,nextZ:21}});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(BASE);await page.getByLabel('Family',{exact:true}).selectOption('Recall');
 const rows=page.getByRole('button',{name:/RC-(0[1-9]|1[0-5])\b/});assert.equal(await rows.count(),15);await page.getByRole('button',{name:/RC-12/}).click();await page.getByText(/archive pipeline remains explicit plaintext/).waitFor();await page.screenshot({path:'docs/evidence/tt103-specs.png'});
 writeFileSync('docs/evidence/tt103-runtime.json',JSON.stringify({node:process.version,chromium:browser.version(),agents:1,theoremProverUsed:false,physicalChooserAudioClipboardVerified:false,graphics:'real headless Chromium / software graphics',newMemoryTestsUseNetworkInterception:false,historicalFaultInjection:'browser offline/delayed or aborted real responses in existing regressions'},null,2)+'\n');console.log('PASS: actual Specs UI filters all 15 Recall requirements and exposes the unimplemented encrypted-archive gap.');
}finally{await browser.close();const current=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:current.row.revision+1,state:original.row.state});}
