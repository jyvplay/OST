import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt200-gate-cleanup');
for(const [name,seconds,command,expected] of [
 ['timeout after leader exits', '0.5', `trap 'exit 0' TERM; bash -c 'trap "" TERM; exec sleep 30' & printf '%s\n' "$!" > "$1"; wait`,124],
 ['failed leader exits', '10', `bash -c 'trap "" TERM; exec sleep 30' & printf '%s\n' "$!" > "$1"; exit 7`,7],
 ['successful leader exits', '10', `bash -c 'trap "" TERM; exec sleep 30' & printf '%s\n' "$!" > "$1"; exit 0`,0],
] as const) await test(name,{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt200-')),file=join(dir,'child');let child:number|undefined;
 const p=spawn('bash',['scripts/gate-child.sh',seconds,'bash','-c',command,'_',file],{stdio:'ignore'});
 try{
  const ended=await new Promise<{code:number|null,signal:NodeJS.Signals|null}>((resolve,reject)=>{p.once('error',reject);p.once('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(ended.code,expected);assert.ok(existsSync(file),'actual child did not start');child=Number(readFileSync(file,'utf8').trim());assert.ok(Number.isSafeInteger(child)&&child>1);
  let state='gone';try{state=readFileSync(`/proc/${child}/stat`,'utf8').match(/^\d+ \(.*\) (\S)/)?.[1]??'unknown';}catch{}
  assert.ok(state==='gone'||state==='Z',`child ${child} still running after helper exit (${state})`);
 }finally{if(child)try{process.kill(child,'SIGKILL')}catch{}if(p.exitCode===null)p.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
await test('cleanup of a completed suite leaves a separate active helper alone',{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt200-neighbor-')),file=join(dir,'pid');
 const neighbor=spawn('bash',['scripts/gate-child.sh','30','bash','-c',`printf '%s\n' "$$" > "$1"; exec sleep 30`,'_',file],{stdio:'ignore'});
 const ended=new Promise<number|null>(resolve=>neighbor.once('exit',resolve));let child:number|undefined;
 try{
  const deadline=Date.now()+8000;while(!existsSync(file)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(existsSync(file));child=Number(readFileSync(file,'utf8').trim());assert.ok(child>1);
  const other=spawn('bash',['scripts/gate-child.sh','10','bash','-c',`bash -c 'trap "" TERM; exec sleep 30' & exit 0`],{stdio:'ignore'});
  const code=await new Promise<number|null>(resolve=>other.once('exit',resolve));assert.equal(code,0);
  assert.equal(neighbor.exitCode,null);assert.doesNotThrow(()=>process.kill(child!,0));
 }finally{neighbor.kill('SIGTERM');await ended;if(child)try{process.kill(child,'SIGKILL')}catch{}rmSync(dir,{recursive:true,force:true});}
});
await test('inspection failure never reports successful cleanup',{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt200-inspect-')),file=join(dir,'child');let child:number|undefined;
 writeFileSync(join(dir,'ps'),'#!/bin/sh\nexit 1\n');chmodSync(join(dir,'ps'),0o755);
 const p=spawn('bash',['scripts/gate-child.sh','10','bash','-c',`bash -c 'trap "" TERM; exec sleep 30' & printf '%s\n' "$!" > "$1"; exit 0`,'_',file],{stdio:'ignore',env:{...process.env,PATH:`${dir}:${process.env.PATH}`}});
 try{
  const code=await new Promise<number|null>(resolve=>p.once('exit',resolve));
  if(existsSync(file))child=Number(readFileSync(file,'utf8').trim());assert.equal(code,1,'unverified cleanup must not look successful');
 }finally{if(child)try{process.kill(child,'SIGKILL')}catch{}rmSync(dir,{recursive:true,force:true});}
});
for(const [label,script] of [['empty','#!/bin/sh\nexit 0\n'],['malformed','#!/bin/sh\nprintf "not-a-process-table\\n"\nexit 0\n']] as const) await test(`successful but ${label} inspection is not proof of cleanup`,{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt201-inspect-'));
 writeFileSync(join(dir,'ps'),script);chmodSync(join(dir,'ps'),0o755);
 const p=spawn('bash',['scripts/gate-child.sh','10','bash','-c','exit 0'],{stdio:'ignore',env:{...process.env,PATH:`${dir}:${process.env.PATH}`}});
 try{const code=await new Promise<number|null>(resolve=>p.once('exit',resolve));assert.equal(code,1,'an unusable process table must not look successful');}
 finally{if(p.exitCode===null)p.kill('SIGKILL');rmSync(dir,{recursive:true,force:true});}
});
finish();
