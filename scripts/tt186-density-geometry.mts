import assert from 'node:assert/strict';
import { disposableShell } from './tt132-fixture.mts';
import { makeHarness } from './harness.mts';

const fx=await disposableShell(), {test,finish}=makeHarness('tt186-density-geometry');
const dir=`/Documents/tt186-density-${Date.now()}-${process.pid}`;
try {
 await test('legacy density counts scroll-clipped rows; native intersection changes on scroll',{},async()=>{
  await fx.api('POST','/api/fs',{op:'mkdir',path:dir});
  for(let i=0;i<30;i++) await fx.api('POST','/api/fs',{op:'write',path:`${dir}/item-${String(i).padStart(2,'0')}.txt`,content:'test'});
  const cur=await fx.api<{row:{revision:number}}>('GET','/api/state?id=default');
  await fx.api('PUT','/api/state',{id:'default',revision:Number(cur.row.revision)+1000,state:{windows:[{id:'w1',module:'files',title:'files',x:20,y:16,w:1440,h:960,z:10,workspace:1,props:{path:dir}}],focus:'w1',workspaces:[{id:1,name:'Main'}],activeWorkspace:1,nextZ:30}});
  const ctx=await fx.context({viewport:{width:1500,height:1040}});
  try {
   const page=await ctx.newPage();await fx.ready(page,'files');
   const list=page.getByTestId('files-listing');await page.waitForFunction(()=>document.querySelectorAll('[data-win-id="w1"] [role="option"][data-path]').length===30);
   const snapshot=()=>list.evaluate(async el=>{
    const rows=[...el.querySelectorAll('[role="option"][data-path]')];
    const legacy=rows.map(row=>{let count=0;const w=document.createTreeWalker(row,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=w.nextNode())){const p=n.parentElement;if(!p)continue;const r=p.getBoundingClientRect(),s=getComputedStyle(p);if(r.width&&r.height&&s.display!=='none'&&s.visibility!=='hidden')count+=(n.textContent??'').trim().split(/\s+/).filter(Boolean).length;}return count;});
    const visible=await new Promise<boolean[]>((resolve,reject)=>{
     const found=new Map<Element,boolean>();const timer=setTimeout(()=>{observer.disconnect();reject(new Error('intersection observation timeout'));},5000);
     const observer=new IntersectionObserver(entries=>{for(const e of entries)found.set(e.target,e.isIntersecting&&e.intersectionRect.width>0&&e.intersectionRect.height>0);if(found.size===rows.length){clearTimeout(timer);observer.disconnect();resolve(rows.map(row=>found.get(row)!));}});
     rows.forEach(row=>observer.observe(row));
    });
    return {legacy,visible};
   });
   const top=await snapshot();assert.equal(top.visible[0],true);assert.equal(top.visible[29],false);assert.ok(top.legacy[29]>0,'legacy count includes clipped last row');
   await list.evaluate(el=>{el.scrollTop=el.scrollHeight;});
   const bottom=await snapshot();assert.equal(bottom.visible[0],false);assert.equal(bottom.visible[29],true);assert.ok(bottom.legacy[0]>0,'legacy count includes clipped first row');
   console.log(`    top visible rows=${top.visible.filter(Boolean).length}; bottom visible rows=${bottom.visible.filter(Boolean).length}; legacy row words=${top.legacy.reduce((a,b)=>a+b,0)}`);
  } finally {await ctx.close();}
 });
} finally {try{await fx.api('POST','/api/fs',{op:'purge',path:dir});}finally{await fx.close();finish();}}
