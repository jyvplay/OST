import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeHarness} from './harness.mts';
const {test,finish}=makeHarness('tt179-cancel-chromium');
await test('canceling a running suite terminates its actual detached Chromium',{},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'tt179-chromium-')),file=join(dir,'browser.json');let p:ReturnType<typeof spawn>|undefined;let browser:{pid:number;pgid:number;sid:number}|undefined;
 try{
  p=spawn('bash',['scripts/gate-child.sh','30',process.execPath,'--experimental-strip-types','--no-warnings','--import','./scripts/register-hook.mjs','scripts/tt179-chromium-child.mts',file],{stdio:'inherit'});
  const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>p!.once('exit',(code,signal)=>resolve({code,signal})));
  const deadline=Date.now()+15000;while(!existsSync(file)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,40));assert.ok(existsSync(file),'Chromium did not start');browser=JSON.parse(readFileSync(file,'utf8'));assert.ok(browser&&browser.pid>1);assert.equal(browser.pid,browser.pgid,'cleanup test requires an isolated browser process group');
  p.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined;const result=await Promise.race([ended,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('helper did not stop')),8000);})]).finally(()=>clearTimeout(timer));assert.equal(result.code,143);
  let state='gone';try{state=readFileSync(`/proc/${browser.pid}/stat`,'utf8').match(/^\d+ \(.*\) (\S)/)?.[1]??'unknown';}catch{}assert.ok(state==='gone'||state==='Z',`real Chromium pid ${browser.pid} still executing (${state}) after gate cancellation`);
 }finally{if(p?.exitCode===null)p.kill('SIGTERM');if(browser?.pid===browser?.pgid&&browser?.pid>1)try{process.kill(-browser.pgid,'SIGKILL')}catch{}rmSync(dir,{recursive:true,force:true});}
});
finish();
