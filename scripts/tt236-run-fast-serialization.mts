import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { makeHarness } from './harness.mts';
const {test,finish}=makeHarness('tt236-run-fast-serialization');
const dir=mkdtempSync(join(tmpdir(),'tt236-fast-')), id=`tt236-fixture-${process.pid}-${Date.now()}`;
const names=[`${id}-a`,`${id}-b`], files=names.map(n=>resolve('scripts',`${n}.mts`));
const fixture=`import { mkdirSync, appendFileSync, rmSync } from 'node:fs';\nconst name=process.argv[1].split('/').at(-1); const p=process.env.TT236_ROOT+'/'+name;\ntry { mkdirSync(p); } catch { console.log('0 passed, 1 failed'); process.exit(1); }\nappendFileSync(process.env.TT236_TRACE, name+' start '+Date.now()+'\\n');\nawait new Promise(r=>setTimeout(r,400));\nappendFileSync(process.env.TT236_TRACE, name+' end '+Date.now()+'\\n'); rmSync(p,{recursive:true});\nconsole.log('1 passed, 0 failed');\n`;
for(const file of files)writeFileSync(file,fixture,{flag:'wx'});
function run(suites:string[],trace:string,extra:Record<string,string>={}){return spawnSync('bash',['scripts/run-fast.sh',...suites],{cwd:resolve('.'),env:{...process.env,JOBS:'2',TT236_ROOT:dir,TT236_TRACE:trace,...extra},encoding:'utf8',timeout:20000});}
try {
 await test('same suite runs twice without overlapping its own receipt',{},()=>{
  const trace=join(dir,'same'), result=run([names[0],names[0]],trace);assert.equal(result.status,0,result.stdout+result.stderr);
  const lines=readFileSync(trace,'utf8').trim().split('\n');assert.equal(lines.length,4);assert.match(lines[0],/ start /);assert.match(lines[1],/ end /);assert.match(lines[2],/ start /);assert.match(lines[3],/ end /);
  assert.equal((result.stdout.match(/1 passed, 0 failed/g)||[]).length,2);
 });
 await test('different suites remain able to run concurrently',{},()=>{
  const trace=join(dir,'different'),result=run(names,trace);assert.equal(result.status,0,result.stdout+result.stderr);
  const lines=readFileSync(trace,'utf8').trim().split('\n');assert.equal(lines.length,4);assert.match(lines[0],/ start /);assert.match(lines[1],/ start /);assert.match(lines[2],/ end /);assert.match(lines[3],/ end /);
 });
 await test('overlapping runner invocations serialize the same suite',{},async()=>{
  const trace=join(dir,'cross-runner'),env={...process.env,JOBS:'2',TT236_ROOT:dir,TT236_TRACE:trace};
  const start=()=>new Promise<{status:number|null;out:string}>(resolve=>{const p=spawn('bash',['scripts/run-fast.sh',names[0]],{cwd:process.cwd(),env});let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.on('exit',status=>resolve({status,out}));});
  const results=await Promise.all([start(),start()]);for(const r of results)assert.equal(r.status,0,r.out);
  const lines=readFileSync(trace,'utf8').trim().split('\n');assert.equal(lines.length,4);assert.match(lines[0],/ start /);assert.match(lines[1],/ end /);assert.match(lines[2],/ start /);assert.match(lines[3],/ end /);
 });
 await test('each duplicate retains full diagnostics in separate logs',{},()=>{
  const root=join(dir,'logs'),result=run([names[0],names[0]],join(dir,'logs-trace'),{FAST_LOG_DIR:root});assert.equal(result.status,0,result.stdout+result.stderr);
  const runs=readdirSync(root);assert.equal(runs.length,1);const logdir=join(root,runs[0]);const logs=readdirSync(logdir).filter(n=>n.startsWith(names[0]+'.')&&n!==names[0]+'.log');
  assert.equal(logs.length,2);for(const log of logs)assert.match(readFileSync(join(logdir,log),'utf8'),/1 passed, 0 failed/);
 });
 await test('a real held lock times out and fails closed',{},async()=>{
  const root=resolve('.cache/run-fast-locks');mkdirSync(root,{recursive:true});
  const child=spawn('flock',['-x',join(root,names[0]+'.lock'),'sh','-c','echo READY; exec sleep 20'],{detached:true});
  const closed=new Promise<void>(resolve=>child.on('close',()=>resolve()));
  try{
   await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('lock holder not ready')),5000);child.stdout.on('data',d=>{if(String(d).includes('READY')){clearTimeout(timer);resolve();}});child.on('error',reject);});
   const result=run([names[0]],join(dir,'held-lock'),{FAST_LOCK_WAIT_SECONDS:'0'});assert.notEqual(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/cannot acquire receipt lock/);
  }finally{if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}await closed;}
 });
 await test('worker lock failure must not be reported as a successful run',{},()=>{
  const fake=join(dir,'bin');mkdirSync(fake);const flock=join(fake,'flock');writeFileSync(flock,'#!/bin/sh\nexit 7\n');chmodSync(flock,0o755);
  const result=run([names[0]],join(dir,'lock-fail'),{PATH:`${fake}:${process.env.PATH}`});assert.notEqual(result.status,0,result.stdout+result.stderr);
 });
}finally{for(const file of files)rmSync(file,{force:true});rmSync(dir,{recursive:true,force:true});finish();}
