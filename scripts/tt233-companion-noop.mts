import assert from 'node:assert/strict';
import { makeHarness } from './harness.mts';
if (process.env.TT89_DISPOSABLE_DATABASE !== '1' || !process.env.DATABASE_URL || !process.env.BASE) throw new Error('Exclusive disposable database and BASE required');
const BASE=process.env.BASE, {test,finish}=makeHarness('tt233-companion-noop');
const id=`tt233-${process.pid}-${Date.now()}`, photo=`/Documents/${id}.png`, side=`/Documents/.${id}.png.edit.json`;
async function request(method:string,path:string,body?:unknown){const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.ok(r.ok,`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);return data;}
const op=(op:string,path:string,extra:object={})=>request('POST','/api/fs',{op,path,...extra});
const node=async(path:string)=>(await request('GET','/api/fs?op=read&path='+encodeURIComponent(path))).node;
const write=(path:string)=>op('write',path,{content:'content-'+id});
const clean=async()=>{await op('purge',photo);await op('purge',side);};
try {
 await test('repeated trash must not trash a newly created companion',{},async()=>{try{await write(photo);await op('trash',photo);await write(side);await op('trash',photo);assert.equal((await node(photo)).trashed,true);assert.equal((await node(side)).trashed,false);}finally{await clean();}});
 await test('restore of live primary must not restore independently trashed companion',{},async()=>{try{await write(photo);await write(side);await op('trash',side);await op('restore',photo);assert.equal((await node(photo)).trashed,false);assert.equal((await node(side)).trashed,true);}finally{await clean();}});
 await test('restore of missing primary must not restore companion',{},async()=>{try{await write(side);await op('trash',side);await op('restore',photo);assert.equal((await node(side)).trashed,true);}finally{await clean();}});
 await test('purge of missing primary must not delete live companion',{},async()=>{try{await write(side);await op('purge',photo);assert.equal((await node(side)).content,'content-'+id);}finally{await clean();}});
 await test('failed guarded trash must not change its companion',{},async()=>{try{await write(photo);await write(side);const stale=await node(photo);await op('write',photo,{content:'changed'});const r=await fetch(BASE+'/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'trash',path:photo,expectedTrash:{id:stale.id,version:stale.version,sha256:stale.sha256}})});assert.equal(r.status,409);assert.equal((await node(photo)).trashed,false);assert.equal((await node(side)).trashed,false);}finally{await clean();}});
 await test('a direct companion request does not follow a nested companion',{},async()=>{const nested=`/Documents/..${id}.png.edit.json.edit.json`;try{await write(side);await write(nested);await op('trash',side);assert.equal((await node(side)).trashed,true);assert.equal((await node(nested)).trashed,false);await op('restore',side);assert.equal((await node(side)).trashed,false);assert.equal((await node(nested)).trashed,false);await op('purge',side);assert.equal((await node(nested)).trashed,false);}finally{await clean();await op('purge',nested);}});
 await test('a real primary trash and restore still follows its companion',{},async()=>{try{await write(photo);await write(side);await op('trash',photo);assert.equal((await node(side)).trashed,true);await op('restore',photo);assert.equal((await node(photo)).trashed,false);assert.equal((await node(side)).trashed,false);}finally{await clean();}});
 await test('a real primary purge still follows its companion',{},async()=>{try{await write(photo);await write(side);await op('purge',photo);const res=await fetch(BASE+'/api/fs?op=read&path='+encodeURIComponent(side));assert.equal(res.status,404);}finally{await clean();}});
} finally {finish();}
