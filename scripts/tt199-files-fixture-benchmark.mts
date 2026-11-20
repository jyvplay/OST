// TT199: opt-in, exclusive disposable database only. Compare the exact 41
// unique Files writes used by TT193; verify every resulting name and content.
// This measures fixture-write wall time, not server CPU or the entire suite.
import assert from 'node:assert/strict';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('exclusive disposable BASE and DATABASE_URL required');
const base=process.env.BASE,n=41;
async function api(method:string,path:string,body?:unknown){
 const r=await fetch(base+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 const text=await r.text();if(!r.ok)throw new Error(`${method} ${path}: ${r.status} ${text}`);return JSON.parse(text);
}
for(let round=0;round<9;round++){
 const limit=round%2?2:1,dir=`/Documents/tt199-bench-${Date.now()}-${process.pid}-${round}`;
 await api('POST','/api/fs',{op:'mkdir',path:dir});
 try {
  const start=performance.now();
  for(let i=0;i<n;i+=limit){
   const results=await Promise.allSettled(Array.from({length:Math.min(limit,n-i)},(_,k)=>{
    const j=i+k;return api('POST','/api/fs',{op:'write',path:`${dir}/item-${String(j).padStart(2,'0')}.txt`,content:`file ${j}`});
   }));
   for(const result of results)if(result.status==='rejected')throw result.reason;
  }
  const elapsed=Math.round(performance.now()-start);
  const {nodes}=await api('GET',`/api/fs?op=list&path=${encodeURIComponent(dir)}`);
  assert.deepEqual(nodes.map((node:{name:string})=>node.name).sort(),Array.from({length:n},(_,j)=>`item-${String(j).padStart(2,'0')}.txt`));
  for(let j=0;j<n;j++){
   const {node}=await api('GET',`/api/fs?op=read&path=${encodeURIComponent(`${dir}/item-${String(j).padStart(2,'0')}.txt`)}`);
   assert.equal(node.content,`file ${j}`);
  }
  console.log(JSON.stringify({round,limit,fixtureWriteWallMs:elapsed,verifiedFiles:n}));
 }finally{await api('POST','/api/fs',{op:'purge',path:dir});}
}
