import assert from 'node:assert/strict';
import {launchChromium} from './browser-launch.mts';
const BASE=process.env.BASE;if(!BASE||process.env.TT89_DISPOSABLE_DATABASE!=='1')throw Error('Disposable target required');
const api=async(m:string,p:string,b?:unknown)=>{const r=await fetch(BASE+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});assert.ok(r.ok);return r.json();};
await api('GET','/api/settings');const original=await api('GET','/api/state?id=default'),browser=await launchChromium();
try{
 await api('PUT','/api/state',{id:'default',revision:(original.row?.revision??0)+1,state:{...original.row?.state,windows:[{id:'spec106',module:'spec',title:'Specs',props:{},x:20,y:45,w:1360,h:950,z:20,workspace:1}],focus:'spec106',activeWorkspace:1,nextZ:21}});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(20000);await page.goto(BASE);
 await page.getByLabel('Family',{exact:true}).selectOption('Recall');
 assert.equal(await page.getByRole('button',{name:/RC-(0[1-9]|1[0-9]|2[0-6])\b/}).count(),26);
 await page.getByRole('button',{name:/RC-24\b/}).click();await page.getByText(/not authentication or an assertion about an older open preview/).waitFor();
 await page.screenshot({path:'docs/evidence/tt106-specs.png'});
 await page.getByRole('button',{name:/RC-25\b/}).click();await page.getByText(/Soft trash, not secure erasure/).waitFor();
 await page.getByRole('button',{name:/RC-26\b/}).click();await page.getByText(/not bit-identical to authored pixels/).waitFor();
 await page.getByRole('button',{name:/RC-22\b/}).click();await page.getByText(/Lost commit acknowledgements are unknown/).waitFor();
 const rows=(await api('GET','/api/features')).rows.filter((r:{code:string})=>/^RC-\d\d$/.test(r.code));
 assert.equal(rows.length,26);assert.ok(rows.every((r:{status:string})=>r.status==='partial'));
 console.log('PASS: actual Specs UI shows 26 partial Recall requirements including the three TT106 rows and their stated limits.');
}finally{await browser.close();const current=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(current.row?.revision??0)+1,state:original.row?.state??{}});}
