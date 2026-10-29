"use client";
import { api } from './api';
import { privacy } from './privacy/session';
import { toB64 } from './privacy/pcrypt';
import { readBrowserSave } from './browser-download';
import { RECALL_LIMIT, recallFolder, recallMime, recallExtension, recallSource, recallUrl, type RecallGrouping } from './recall-core';
import { validDerivedFrom, type DerivedFrom } from './recall-memory';
export interface RecallInput { url:string; page:string; title:string; grouping:RecallGrouping; custom:string; owner:string; sid?:string }
export interface RecallJob { id:string; source:string; phase:'queued'|'fetching'|'saving'|'saved'|'failed'|'cancelled'; path?:string; bytes?:number; error?:string }
let jobs: RecallJob[] = [];
const listeners = new Set<()=>void>();
const queue: {input:RecallInput;id:string}[]=[];
let active: {id:string;owner:string;controller:AbortController;committing:boolean}|null=null;
export const recallSnapshot=()=>jobs;
export const recallSubscribe=(fn:()=>void)=>{listeners.add(fn);return()=>{listeners.delete(fn);};};
const publish=(id:string, patch:Partial<RecallJob>)=>{jobs=jobs.map(j=>j.id===id?{...j,...patch}:j);listeners.forEach(f=>f());};
export function recallWritable(){if(!privacy.status().installed||privacy.status().amnesic)throw new Error('Recall server writes are unavailable in amnesic mode. Use a normal session, or save an authorized recording to a local file.');}
/** Atomic create-only media + receipt publication. Lost acknowledgements remain unknown, not success. */
/** TT108: `derivedFrom` records which already-saved memory a crop was cut from; the server re-checks it. */
/** TT109: what the server did with a save. `stored:false` means an identical memory was already in this folder. */
export interface RecallOutcome { path:string; stored:boolean; duplicateOf?:string; firstSavedAt?:string; replayed?:boolean }

/** The string-returning form every existing caller uses; unchanged semantics (a duplicate is stored again). */
export async function commitRecall(bytes:Uint8Array, mime:string, input:RecallInput, method:string, derivedFrom?:DerivedFrom):Promise<string>{
  return (await commitRecallDetailed(bytes,mime,input,method,{derivedFrom})).path;
}

/**
 * TT109: the same publication, reporting what happened. With onDuplicate:'skip' the server returns the memory
 * it already holds instead of writing a second copy — the behaviour an archive of what you already saw wants,
 * and the reason this is opt-in rather than the default: a deliberate re-save must still be possible.
 */
export async function commitRecallDetailed(bytes:Uint8Array, mime:string, input:RecallInput, method:string,
  opts:{derivedFrom?:DerivedFrom;onDuplicate?:'store'|'skip'}={}):Promise<RecallOutcome>{
  const derivedFrom=opts.derivedFrom;
  recallWritable(); if(!bytes.length||bytes.length>RECALL_LIMIT)throw new Error('Recall files must be nonempty and at most 8 MiB; no truncation is permitted');
  const type=recallMime(mime), folder=recallFolder(input.page,input.title,input.grouping,input.custom);
  for(const path of ['/Downloads','/Downloads/Recall',folder])await api('/api/fs',{method:'POST',body:JSON.stringify({op:'mkdir',path})});
  const path=`${folder}/${Date.now()}-${crypto.randomUUID()}.${recallExtension(type)}`;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('');
  if(derivedFrom)validDerivedFrom(derivedFrom,path);
  // TT112: `refetched` is written explicitly rather than left to be inferred from the method name.
  // Only the original-byte pathway asks the publisher again; every other method saves bytes this
  // browser already had, and a receipt that says so can be checked without knowing the method table.
  const commitToken=crypto.randomUUID();
  const receipt=JSON.stringify({version:1,path,bytes:bytes.length,sha256:digest,mime:type,method,commitToken,sourceAttribution:method==='original-response'?'requested-url':'user-declared-label',source:recallSource(input.url),page:recallSource(input.page),capturedAt:new Date().toISOString(),queryRedacted:true,refetched:method==='original-response',...(derivedFrom?{derivedFrom}:{})},null,2);
  type Ack={path?:string;stored?:boolean;duplicateOf?:string;firstSavedAt?:string;replayed?:boolean};
  const body=JSON.stringify({op:'recallCommit',path,content:toB64(bytes),mime:type,receipt,...(opts.onDuplicate?{onDuplicate:opts.onDuplicate}:{})});
  let answer:Ack;
  try{answer=await api<Ack>('/api/fs',{method:'POST',body});}
  catch(first){
    // TT114 (RC-39): the receipt carries a publication token, and the server claims that token in
    // the same transaction as the pair. So this retry is decidable rather than dangerous: if the
    // first attempt did commit, the server answers from the token with the path it wrote and
    // writes nothing further; if it did not, this attempt publishes normally. Exactly one memory
    // exists either way, which is what the lost acknowledgement could not previously promise.
    try{answer=await api<Ack>('/api/fs',{method:'POST',body});}
    catch(second){
      throw new Error(`Recall commit not acknowledged for ${path}, and the retry also failed. The publication token means a later retry is still safe: it will return the saved memory rather than write a second one. ${first instanceof Error?first.message:String(first)} / ${second instanceof Error?second.message:String(second)}`);
    }
  }
  // The server decides the final path: a skipped duplicate answers with the memory already held.
  return {path:answer.path??path,stored:answer.stored!==false,
    ...(answer.duplicateOf?{duplicateOf:answer.duplicateOf}:{}),...(answer.firstSavedAt?{firstSavedAt:answer.firstSavedAt}:{}),
    ...(answer.replayed?{replayed:true}:{})};
}
export function cancelRecall(owner?:string){
  for(let i=queue.length-1;i>=0;i--)if(!owner||queue[i].input.owner===owner){publish(queue[i].id,{phase:'cancelled'});queue.splice(i,1);}
  if(active&&(!owner||active.owner===owner)&&!active.committing)active.controller.abort();
}
export function enqueueRecall(input:RecallInput):string{
  recallWritable();recallUrl(input.url);recallFolder(input.page,input.title,input.grouping,input.custom);
  if(queue.length>=16)throw new Error('Recall queue full (16 pending); stop or wait before adding more');
  const id=crypto.randomUUID();jobs=[...jobs.filter(j=>!['saved','failed','cancelled'].includes(j.phase)).concat(jobs.filter(j=>['saved','failed','cancelled'].includes(j.phase)).slice(-32)),{id,source:recallSource(input.url),phase:'queued'}];
  queue.push({input:{...input},id});listeners.forEach(f=>f());void drain();return id;
}
async function drain(){
  if(active)return;const task=queue.shift();if(!task)return;
  const {input,id}=task, controller=new AbortController();active={id,owner:input.owner,controller,committing:false};let minted:string|undefined;
  publish(id,{phase:'fetching'});const deadline=setTimeout(()=>controller.abort(new Error('Recall fetch deadline exceeded (30 seconds)')),30000);
  try{
    recallWritable();let sid=input.sid;
    if(!sid){const r=await api<{sid:string}>('/api/wp-session',{method:'POST',body:'{}',signal:controller.signal});sid=r.sid;minted=sid;}
    const r=await fetch(`/api/wp/s/${encodeURIComponent(sid)}/__raw?u=${encodeURIComponent(input.url)}`,{signal:controller.signal});
    let mime:string;try{mime=recallMime(r.headers.get('x-fusion-wp-type')??'');}catch(e){await r.body?.cancel();throw e;}
    const bytes=await readBrowserSave(r,controller.signal);if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    clearTimeout(deadline);active.committing=true;publish(id,{phase:'saving',bytes:bytes.length});
    const path=await commitRecall(bytes,mime,input,'original-response');publish(id,{phase:'saved',path,bytes:bytes.length});
  }catch(e){publish(id,{phase:controller.signal.aborted?'cancelled':'failed',error:e instanceof Error?e.message:String(e)});}
  finally{clearTimeout(deadline);if(minted)await fetch(`/api/wp-session?sid=${encodeURIComponent(minted)}`,{method:'DELETE'}).catch(()=>undefined);active=null;void drain();}
}
