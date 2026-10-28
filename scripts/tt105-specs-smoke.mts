import assert from 'node:assert/strict';
import {launchChromium} from './browser-launch.mts';
const BASE=process.env.BASE;if(!BASE||process.env.TT89_DISPOSABLE_DATABASE!=='1')throw Error('Disposable target required');
const api=async(method:string,path:string,body?:unknown)=>{const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});assert.ok(r.ok);return r.json();};
await api('GET','/api/settings');const original=await api('GET','/api/state?id=default'),b=await launchChromium();
try{
 await api('PUT','/api/state',{id:'default',revision:(original.row?.revision??0)+1,state:{...original.row?.state,windows:[{id:'spec105',module:'spec',title:'Specs',props:{},x:20,y:45,w:1360,h:950,z:20,workspace:1}],focus:'spec105',activeWorkspace:1,nextZ:21}});
 const page=await b.newPage({viewport:{width:1440,height:1100}});await page.goto(BASE);await page.getByLabel('Family',{exact:true}).selectOption('Recall');assert.equal(await page.getByRole('button',{name:/RC-(0[1-9]|1[0-9]|2[0-3])\b/}).count(),23);
 await page.getByRole('button',{name:/RC-22\b/}).click();await page.getByText(/Lost commit acknowledgements are unknown/).waitFor();await page.screenshot({path:'docs/evidence/tt105-specs.png'});
 await page.getByRole('button',{name:/RC-23\b/}).click();await page.getByText(/Real pointer selection of current connected/).waitFor();await page.getByRole('button',{name:/RC-12\b/}).click();await page.getByText(/archive pipeline remains explicit plaintext/).waitFor();
 console.log('PASS: actual Specs UI has all 23 partial Recall requirements; atomic acknowledgement, clicked-selection and plaintext archive limits visible.');
}finally{await b.close();const current=await api('GET','/api/state?id=default');await api('PUT','/api/state',{id:'default',revision:(current.row?.revision??0)+1,state:original.row?.state??{}});}
