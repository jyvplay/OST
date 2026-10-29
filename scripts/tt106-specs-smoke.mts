import assert from 'node:assert/strict';
import {launchChromium} from './browser-launch.mts';
const BASE=process.env.BASE;if(!BASE||process.env.TT89_DISPOSABLE_DATABASE!=='1')throw Error('Disposable target required');
const api=async(m:string,p:string,b?:unknown)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});assert.ok(r.ok);return r.json();};
await api('GET','/api/settings');const original=await api('GET','/api/state?id=default'),browser=await launchChromium();
try{
 await api('PUT','/api/state',{id:'default',revision:(original.row?.revision??0)+1,state:{...original.row?.state,windows:[{id:'spec106',module:'spec',title:'Specs',props:{},x:20,y:45,w:1360,h:950,z:20,workspace:1}],focus:'spec106',activeWorkspace:1,nextZ:21}});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(20000);await page.goto(BASE);
 await page.getByLabel('Family',{exact:true}).selectOption('Recall');
 assert.ok(await page.getByRole('button',{name:/RC-(0[1-9]|1[0-9]|2[0-6])\b/}).count()>=26,'the first 26 Recall rows are all on screen');
 await page.getByRole('button',{name:/RC-24\b/}).click();await page.getByText(/not authentication or an assertion about an older open preview/).waitFor();
 await page.screenshot({path:'docs/evidence/tt106-specs.png'});
 await page.getByRole('button',{name:/RC-25\b/}).click();await page.getByText(/Soft trash, not secure erasure/).waitFor();
 await page.getByRole('button',{name:/RC-26\b/}).click();await page.getByText(/not bit-identical to authored pixels/).waitFor();
 await page.getByRole('button',{name:/RC-22\b/}).click();await page.getByText(/Lost commit acknowledgements are unknown/).waitFor();
 const rows=(await api('GET','/api/features')).rows.filter((r:{code:string})=>/^RC-\d\d$/.test(r.code));
 // TT111: this smoke test rotted the moment Recall rows were honestly finished (TT110 onwards) and the
 // family kept growing. It now states the invariant it was always written for: the family only grows,
 // no row falls below partial, and nothing may say 'built' without naming the test that proves it.
 assert.ok(rows.length>=26,`the Recall family only grows (${rows.length})`);
 assert.ok(rows.every((r:{status:string})=>r.status==='partial'||r.status==='built'),'a Recall row regressed below partial');
 const unproven=rows.filter((r:{status:string;test:string})=>r.status==='built'&&!r.test);
 assert.deepEqual(unproven.map((r:{code:string})=>r.code),[],'a row claims built without naming a test');
 console.log(`PASS: Specs shows ${rows.length} Recall requirements with their stated limits; ${rows.filter((r:{status:string})=>r.status==='built').length} finished, each naming its test.`);
}finally{await browser.close();const current=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(current.row?.revision??0)+1,state:original.row?.state??{}});}
