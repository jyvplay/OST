import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt178-gate-child');
const helper='scripts/gate-child.sh';
await test('real helper preserves success, failure and timeout exit statuses',{},()=>{
 for(const [seconds,command,expected] of [['5','exit 0',0],['5','exit 7',7],['0.2','sleep 20',124]] as const){
  const p=spawnSync('bash',[helper,seconds,'bash','-c',command],{encoding:'utf8',timeout:8000});assert.equal(p.status,expected,`${command}: ${p.stderr}`);
 }
});
for (const [signal,code,command] of [['SIGTERM',143,'sleep 30 & printf "%s %s\\n" "$$" "$!" > "$1"; wait'],['SIGINT',130,'trap "" TERM; sleep 30 & printf "%s %s\\n" "$$" "$!" > "$1"; wait']] as const) await test(`${signal} stops an actual active process group`,{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt178-')),file=join(dir,'pids');let p:ReturnType<typeof spawn>|undefined,ids:number[]=[];
 try{
  p=spawn('bash',[helper,'30','bash','-c',command,'_',file],{stdio:'ignore'});
  const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>p!.once('exit',(code,signal)=>resolve({code,signal})));
  const deadline=Date.now()+8000;while(!existsSync(file)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(existsSync(file),'real process did not start');ids=readFileSync(file,'utf8').trim().split(/\s+/).map(Number);assert.equal(ids.length,2);assert.ok(ids.every(n=>n>1));
  p.kill(signal);let timer:ReturnType<typeof setTimeout>|undefined;const result=await Promise.race([ended,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('helper did not stop')),6000);})]).finally(()=>clearTimeout(timer));assert.equal(result.code,code);
  for(const id of ids){let state='gone';try{state=readFileSync(`/proc/${id}/stat`,'utf8').match(/^\d+ \(.*\) (\S)/)?.[1]??'unknown';}catch{}assert.ok(state==='gone'||state==='Z',`pid ${id} still executing (state ${state})`);}
 }finally{if(p?.exitCode===null)p.kill('SIGKILL');for(const id of ids)try{process.kill(id,'SIGKILL')}catch{}rmSync(dir,{recursive:true,force:true});}
});
await test('isolated concurrent helper survives cancellation of its neighbor',{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt178-pair-')),files=[join(dir,'a'),join(dir,'b')];const children:ReturnType<typeof spawn>[]=[];
 try{
  for(const file of files)children.push(spawn('bash',[helper,'20','bash','-c','printf "%s\\n" "$$" > "$1"; exec sleep 20','_',file],{stdio:'ignore'}));
  const ended=children.map(p=>new Promise<number|null>(resolve=>p.once('exit',resolve)));const deadline=Date.now()+8000;while(!files.every(existsSync)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(files.every(existsSync));
  const other=Number(readFileSync(files[1],'utf8'));children[0].kill('SIGTERM');assert.equal(await ended[0],143);assert.equal(children[1].exitCode,null);assert.doesNotThrow(()=>process.kill(other,0));children[1].kill('SIGTERM');assert.equal(await ended[1],143);
 }finally{for(const p of children)if(p.exitCode===null)p.kill('SIGTERM');rmSync(dir,{recursive:true,force:true});}
});
finish();
