import assert from 'node:assert/strict';
import pg from 'pg';
import {makeHarness} from './harness.mts';
const BASE=process.env.BASE,dsn=process.env.DATABASE_URL;
if(!BASE||!dsn||process.env.TT89_DISPOSABLE_DATABASE!=='1'||!new URL(dsn).pathname.endsWith('_test'))throw Error('Explicit disposable _test database required');
const {test,finish}=makeHarness('tt104-page');
const pool=new pg.Pool({connectionString:dsn}),folder='/Downloads/Recall/page104-'+Date.now();
const request=async(path=folder,before?:string)=>fetch(BASE+'/api/fs?'+new URLSearchParams({op:'recallPage',path,...(before!==undefined?{before}:{})}));
const data=async(before?:string)=>(await request(folder,before)).json();
try{
 await fetch(BASE+'/api/settings');
 await pool.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime) VALUES($1,'/Downloads/Recall','page104','dir','inode/directory')",[folder]);
 await pool.query(`INSERT INTO vfs_nodes(path,parent,name,kind,mime,content) SELECT $1||'/'||i||'.png',$1,i||'.png','file','image/png','SENSITIVE_CONTENT_SENTINEL' FROM generate_series(1,235) i`,[folder]);
 let first:any,second:any;
 await test('one page returns exactly 100 metadata rows',{'RC-18':'partial'},async()=>{first=await data();assert.equal(first.nodes.length,100);assert.ok(first.next);});
 await test('no bodies or encoding returned',{},()=>{const s=JSON.stringify(first);assert.ok(!s.includes('SENSITIVE_CONTENT_SENTINEL'));assert.ok(first.nodes.every((n:any)=>!('content'in n)&&!('encoding'in n)));});
 await test('strict insertion-ID descending ordering',{},()=>assert.ok(first.nodes.every((n:any,i:number)=>i===0||n.id<first.nodes[i-1].id)));
 await test('cursor advances without overlap',{},async()=>{second=await data(first.next);assert.equal(second.nodes.length,100);assert.ok(second.nodes.every((n:any)=>n.id<Number(first.next)));});
 await test('terminal page returns remaining 35 and no cursor',{},async()=>{const last=await data(second.next);assert.equal(last.nodes.length,35);assert.equal(last.next,null);});
 await test('new concurrent insert does not shift an older cursor page',{},async()=>{await pool.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime) VALUES($1,$2,'new.png','file','image/png')",[folder+'/new.png',folder]);assert.deepEqual((await data(first.next)).nodes,second.nodes);});
 await test('oversized metadata is excluded before transfer, not silently truncated',{},async()=>{await pool.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime) VALUES($1,$4,'longpath','file','image/png'),($2,$4,$5,'file','image/png'),($3,$4,'longmime','file',$6)",[folder+'/'+'x'.repeat(1100),folder+'/longname',folder+'/longmime',folder,'x'.repeat(513),'image/'+'x'.repeat(251)]);const rows=(await data()).nodes;assert.equal(rows[0].name,'new.png');assert.ok(rows.every((n:any)=>Buffer.byteLength(n.path)<=1024&&Buffer.byteLength(n.name)<=512&&Buffer.byteLength(n.mime)<=256));});
 await test('trash and non-media are excluded',{},async()=>{await pool.query("INSERT INTO vfs_nodes(path,parent,name,kind,mime,trashed) VALUES($1,$3,'trash.png','file','image/png',true),($2,$3,'receipt','file','application/json',false)",[folder+'/trash.png',folder+'/receipt',folder]);assert.equal((await data()).nodes[0].name,'new.png');});
 for(const before of ['0','-1','1.5','1e3','2147483648','NaN',' 1','01','1 OR 1=1'])await test('invalid cursor '+before,{},async()=>assert.equal((await request(folder,before)).status,400));
 for(const path of ['/','/Private/a','/Downloads/Recall','/Downloads/Recall/a/../b','/Downloads/Recall/a/b','/Downloads/Recall/a\u0000'])await test('invalid folder '+JSON.stringify(path),{},async()=>assert.equal((await request(path)).status,400));
 await test('missing folder returns empty page',{},async()=>assert.deepEqual((await (await request(folder+'-missing')).json()).nodes,[]));
 await test('trashed grouping folder rejected',{},async()=>{await pool.query('UPDATE vfs_nodes SET trashed=true WHERE path=$1',[folder]);assert.equal((await request()).status,409);});
}finally{await pool.query('DELETE FROM vfs_nodes WHERE path=$1 OR parent=$1',[folder]);await pool.end();}
finish();
