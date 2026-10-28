/** Real 5,001 encrypted-file boundary witness; no list or response substitution. */
import assert from 'node:assert/strict';
import pg from 'pg';
import {PrivacyLayer} from '../src/lib/privacy/layer.ts';
import {createVolume,encryptPath} from '../src/lib/privacy/pcrypt.ts';
import {makeHarness} from './harness.mts';
if(process.env.TT89_DISPOSABLE_DATABASE!=='1'||!process.env.BASE||!process.env.DATABASE_URL)throw new Error('Exclusive disposable server required');
const BASE=process.env.BASE,dir='/Private/tt102-bound-'+Date.now(),requests:string[]=[];
const layer=new PrivacyLayer(async(input,init)=>{requests.push(String(input));return fetch(new URL(String(input),BASE),init);});
const {keys}=await createVolume('tt102 encrypted boundary witness');layer.keys=keys;
const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
const {test,finish}=makeHarness('tt102-private-bound');
try{
 await test('actual 5001 encrypted writes exist independently in PostgreSQL',{},async()=>{let next=0;await Promise.all(Array.from({length:8},async()=>{while(next<5001){const i=next++;const r=await layer.handle('/api/fs',{method:'POST',body:JSON.stringify({op:'write',path:dir+'/'+String(i).padStart(4,'0')+'.json',content:JSON.stringify({lyrics:i===5000?'heldoutprivatecap':'ordinary'}),mime:'application/json'})});assert.ok(r.ok,await r.clone().text());}}));const parent=await encryptPath(keys,dir);assert.equal((await db.query('select count(*)::int n from vfs_nodes where parent=$1',[parent])).rows[0].n,5001);});
 await test('real encrypted directory lists all 5001 files before query cap',{},async()=>{const r=await layer.fsList(dir);assert.equal((r.nodes as unknown[]).length,5001);});
 await test('5000 cap is observable at cursor 4999, not merely a claimed counter',{},async()=>{requests.length=0;const r=await layer.handle('/api/search?'+new URLSearchParams({mode:'metadata',q:'heldoutprivatecap',scope:dir,cursor:dir+'/4999.json'}));const j=await r.json();assert.ok(r.ok,JSON.stringify(j));assert.equal(j.scanned,0);assert.equal(j.hits.length,0);assert.equal(j.enumerationTruncated,true);assert.equal(j.hasMore,false);assert.ok(!requests.some(x=>x.includes('heldoutprivatecap')||x.includes('/api/search')));});
 await test('first page still parses at most 32 files under a 5001-file directory',{},async()=>{const r=await layer.handle('/api/search?'+new URLSearchParams({mode:'metadata',q:'ordinary',scope:dir}));const j=await r.json();assert.equal(j.scanned,32);assert.equal(j.hits.length,32);assert.equal(j.enumerationTruncated,true);});
 await test('5001-file witness leaves no lyric plaintext in host content',{},async()=>{assert.equal((await db.query("select count(*)::int n from vfs_nodes where content like '%heldoutprivatecap%'")).rows[0].n,0);});
}finally{const r=await layer.handle('/api/fs',{method:'POST',body:JSON.stringify({op:'purge',path:dir})});assert.ok(r.ok,await r.text());await db.end();}
finish();
