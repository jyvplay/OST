// Counterexample, not an acceptance gate: an intervening replacement can be
// deleted by a repeated unguarded request. Requires an exclusive disposable DB.
import assert from 'node:assert/strict';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.DATABASE_URL||!process.env.BASE)throw new Error('exclusive disposable database and BASE required');
const base=process.env.BASE,name=`tt217-aba-${process.pid}-${Date.now()}`,id=`preset:${name}`,path='/api/state?id='+encodeURIComponent(id);
async function call(method:string,url:string,body?:unknown){const r=await fetch(base+url,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.ok(r.ok,`${method} ${url} returned ${r.status}`);return r.json();}
try{
 assert.equal((await call('GET',path)).row,null);
 await call('POST','/api/state',{op:'createPreset',name,state:{windows:[{title:'original'}]}});
 await call('DELETE',path);
 await call('POST','/api/state',{op:'createPreset',name,state:{windows:[{title:'replacement'}]}});
 assert.equal((await call('GET',path)).row.state.windows[0].title,'replacement');
 await call('DELETE',path);
 assert.equal((await call('GET',path)).row,null);
 console.log('Counterexample observed: the repeated unguarded DELETE removed the replacement.');
}finally{await call('DELETE',path).catch(()=>undefined);}
