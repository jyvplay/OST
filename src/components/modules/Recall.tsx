"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useShell, type ModuleProps } from '../shell-context';
import { Btn, Badge, Section, Hint } from '../ui';
import { displayMedia } from '@/lib/access-log';
import { commitRecall, recallWritable, enqueueRecall, cancelRecall, recallSnapshot, recallSubscribe, type RecallInput } from '@/lib/recall';
import { RECALL_LIMIT, recallFolder, type RecallGrouping } from '@/lib/recall-core';
import { registerDocGuard } from '@/lib/doc-lifecycle';
import BrowserModule from './Browser';
import RecallMemory from './RecallMemory';
import { fmtBytes } from '@/lib/api';
import { proxySessionsSnapshot, subscribeProxySessions, proxyWindowFor } from '@/lib/wp-session-registry';
type Writable = {write:(data:Blob)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
type LocalHandle = {createWritable:()=>Promise<Writable>;name:string};
const empty: ReturnType<typeof recallSnapshot> = [];
const noSessions: string[] = [];
type TapItem={sid:string;id:string;url:string;mime:string;size:number;at:number};
type ResidentItem={sid:string;id:string;tag:string;scheme:string;label:string;mime:string;bytesHint:number|null;w:number;h:number;page:string};
type ResidentRefusal={sid:string;label:string;reason:string};
/**
 * TT112 (RC-38): ask one proxied document about the objects it is holding itself.
 *
 * The document runs in an opaque-origin sandbox, so a message is the only channel, and a reply can
 * never be assumed: every request carries a fresh token, listens for exactly that token, and gives
 * up after a bounded wait so a page that has navigated away cannot leave the pane waiting forever.
 */
function askFrame<T extends {token:string}>(win:Window,message:Record<string,unknown>,token:string,ms=6000):Promise<T|null>{
 return new Promise<T|null>(resolve=>{
  let done=false;
  const finish=(v:T|null)=>{if(done)return;done=true;window.removeEventListener('message',onMsg);clearTimeout(timer);resolve(v);};
  const onMsg=(e:MessageEvent)=>{
   const d=e.data as T|undefined;
   if(e.source!==win||!d||typeof d!=='object'||d.token!==token)return;
   finish(d);
  };
  const timer=setTimeout(()=>finish(null),ms);
  window.addEventListener('message',onMsg);
  try{win.postMessage({...message,token},'*');}catch{finish(null);}
 });
}
/** Ask every live browsing session what media it still holds. A session that has closed contributes nothing. */
async function loadTap(sessions:readonly string[]):Promise<TapItem[]>{
 const all:TapItem[]=[];
 for(const sid of sessions){
  try{
   const r=await fetch(`/api/recall-tap?sid=${encodeURIComponent(sid)}`);
   if(!r.ok)continue;
   const j=await r.json() as {items?:Omit<TapItem,'sid'>[]};
   for(const it of j.items??[])all.push({...it,sid});
  }catch{/* a session that has just closed simply contributes nothing */}
 }
 return all.sort((a,b)=>b.at-a.at);
}
export default function Recall({win}:ModuleProps){
 const shell=useShell();
 // TT110 (RC-36): the capture policy. The server refuses these methods when it is off; the
 // interface must not pretend the buttons would work, and must say where the switch lives.
 const captureAllowed=shell.settings['privacy.screenCapture']!=='off';const jobs=useSyncExternalStore(recallSubscribe,recallSnapshot,()=>empty);
 // TT111 (RC-37): media the in-app browser has ALREADY loaded. The bytes are held in this server's
 // memory for the life of the browsing session, so saving one is a read of what the page already has —
 // no second request to the publisher, which is the whole point of the pathway.
 const tapOn=shell.settings['privacy.recallMediaTap']==='on';
 const sessions=useSyncExternalStore(subscribeProxySessions,proxySessionsSnapshot,()=>noSessions);
 const [tapItems,setTapItems]=useState<TapItem[]>([]);
 const [tapBusy,setTapBusy]=useState('');
 const tapAlive=useRef(true);
 const refreshTap=useCallback(()=>{
  // The listing is state owned by an external system (this server's memory), so it is read in a
  // callback and published when the answer arrives — never synchronously inside the effect.
  loadTap(tapOn?sessions:[]).then(items=>{ if(tapAlive.current) setTapItems(items); }).catch(()=>undefined);
 },[tapOn,sessions]);
 useEffect(()=>{tapAlive.current=true;refreshTap();const t=setInterval(refreshTap,4000);return()=>{tapAlive.current=false;clearInterval(t);};},[refreshTap]);
 const saveTapped=async(it:{sid:string;id:string})=>{
  setTapBusy(it.id);setError('');
  try{
   const r=await fetch('/api/recall-tap',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({cmd:'save',sid:it.sid,id:it.id,grouping,custom,title,page:url})});
   const j=await r.json() as {ok?:boolean;path?:string;error?:string;stored?:boolean;duplicateOf?:string};
   if(!r.ok||!j.ok)throw new Error(j.error??`HTTP ${r.status}`);
   setSaved(j.stored===false&&j.duplicateOf?j.duplicateOf:(j.path??''));
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setTapBusy('');refreshTap();}
 };
 // TT112 (RC-38) — objects the open page is holding itself (blob: / data:).
 const [resItems,setResItems]=useState<ResidentItem[]>([]);
 const [resRefused,setResRefused]=useState<ResidentRefusal[]>([]);
 const [resScanned,setResScanned]=useState(false);
 const [resBusy,setResBusy]=useState('');
 const scanResident=async()=>{
  setResBusy('scan');setError('');
  const items:ResidentItem[]=[],refused:ResidentRefusal[]=[];
  try{
   for(const sid of sessions){
    const win=proxyWindowFor(sid);
    if(!win)continue;
    const token=`rs-${crypto.randomUUID()}`;
    const reply=await askFrame<{token:string;page?:string;items?:Omit<ResidentItem,'sid'|'page'>[];refused?:{label:string;reason:string}[];error?:string|null}>(
      win,{fusionWp:'resident-scan'},token);
    if(!reply)continue;
    for(const it of reply.items??[])items.push({...it,sid,page:String(reply.page??'')});
    for(const r of reply.refused??[])refused.push({...r,sid});
   }
   setResItems(items);setResRefused(refused);setResScanned(true);
  }finally{setResBusy('');}
 };
 const saveResident=async(it:ResidentItem)=>{
  const key=`${it.sid}:${it.id}`;
  setResBusy(key);setError('');
  try{
   const win=proxyWindowFor(it.sid);
   if(!win)throw new Error('That page has closed, so the object it was holding is gone.');
   const token=`rr-${crypto.randomUUID()}`;
   const reply=await askFrame<{token:string;ok?:boolean;mime?:string;bytes?:ArrayBuffer;reason?:string}>(
     win,{fusionWp:'resident-read',id:it.id},token,15000);
   if(!reply)throw new Error('The page did not answer in time; scan again.');
   if(!reply.ok||!reply.bytes)throw new Error(reply.reason??'The page refused to hand over those bytes.');
   const mime=(reply.mime||it.mime||'').toLowerCase();
   if(!mime)throw new Error('The page does not say what kind of object this is, so it is not saved as media.');
   const bytes=new Uint8Array(reply.bytes);
   // The bytes are the object's own: no decode, no re-encode, and no request to the publisher.
   const base=input();
   // The address recorded is the page the object belongs to: a blob: handle is private to that
   // document and means nothing once it is gone, and no claim is made that this address would
   // serve these bytes — the receipt's attribution stays "a label the human declared".
   const page=it.page||base.page||base.url;
   const path=await commitRecall(bytes,mime,{...base,url:page,page,title:base.title||it.label},'resident-object-url');
   setSaved(path);
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{setResBusy('');}
 };
 const forgetTapped=async(sid:string,id?:string)=>{
  try{await fetch('/api/recall-tap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cmd:'forget',sid,...(id?{id}:{})})});}
  catch{/* already gone */}
  refreshTap();
 };
 const [browserOpen,setBrowserOpen]=useState(false);
 const [url,setUrl]=useState(String(win.props?.url??'https://github.com/'));
 const [title,setTitle]=useState(String(win.props?.pageTitle??'')),[grouping,setGrouping]=useState<RecallGrouping>('host'),[custom,setCustom]=useState('');
 const [phase,setPhase]=useState('idle'),[error,setError]=useState(''),[saved,setSaved]=useState(''),[audioOnly,setAudioOnly]=useState(false),[withAudio,setWithAudio]=useState(true);
 const [captureSource,setCaptureSource]=useState('display');
 const [sources,setSources]=useState<{element:HTMLCanvasElement|HTMLMediaElement;label:string}[]>([]);
 const scan=()=>setSources([...document.querySelectorAll<HTMLCanvasElement|HTMLMediaElement>('canvas,video,audio')].filter(e=>!e.closest('[data-testid=recall]')).slice(0,30).map((element,i)=>({element,label:`${element.closest('.fs-window')?.getAttribute('aria-label')??'Fusion'} · ${element.tagName.toLowerCase()} ${i+1}`})));
 const [local,setLocal]=useState<LocalHandle|null>(null),[bytes,setBytes]=useState(0);
 const rec=useRef<MediaRecorder|null>(null),source=useRef<MediaStream|null>(null),parts=useRef<Blob[]>([]),size=useRef(0),mounted=useRef(true),busy=useRef(false),stopFlag=useRef(false);
 const sampler=useRef<ReturnType<typeof setInterval>|null>(null);
 const completion=useRef<{promise:Promise<boolean>;resolve:(saved:boolean)=>void}|null>(null);
 const preview=useRef<HTMLVideoElement>(null);
 useEffect(()=>registerDocGuard({winId:win.id,kind:'recall',title:()=> 'Recall recording',dirty:()=>busy.current,recoverable:()=>false,flushDraft:async()=>{},save:async()=>{
   const r=rec.current,c=completion.current;if(!r||!c)return false;if(r.state!=='inactive')r.stop();source.current?.getTracks().forEach(t=>t.stop());return c.promise;
 }}),[win.id]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stopFlag.current=true;if(sampler.current)clearInterval(sampler.current);sampler.current=null;if(rec.current&&rec.current.state!=='inactive')rec.current.stop();source.current?.getTracks().forEach(t=>t.stop());cancelRecall(win.id);};},[win.id]);
 const input=():RecallInput=>({url,page:url,title,grouping,custom,owner:win.id});
 const release=()=>{if(sampler.current)clearInterval(sampler.current);sampler.current=null;source.current?.getTracks().forEach(t=>t.stop());source.current=null;if(preview.current)preview.current.srcObject=null;};
 const stop=()=>{if(rec.current&&rec.current.state!=='inactive'){setPhase('finalizing');rec.current.stop();}release();};
 const chooseLocal=async()=>{try{
   const picker=(window as unknown as {showSaveFilePicker?:(o:unknown)=>Promise<LocalHandle>}).showSaveFilePicker;
   if(!picker)throw new Error('This browser does not expose the local streaming file picker. VFS capture remains available up to 8 MiB.');
   setLocal(await picker({suggestedName:'recall.webm',types:[{description:'WebM recording',accept:{'video/webm':['.webm']}}]}));setError('');
 }catch(e){setError(e instanceof Error?e.message:String(e));}};
 const start=async(snapshot=false)=>{
  if(busy.current)return;busy.current=true;stopFlag.current=false;setError('');setSaved('');setBytes(0);size.current=0;parts.current=[];setPhase('requesting permission');
  let writer:Writable|undefined;
  try{
   // Permission request is directly in the click handler, before any await of storage/network.
   if(snapshot||!local){recallWritable();recallFolder(url,title,grouping,custom);}
   if(!snapshot&&typeof MediaRecorder==='undefined')throw new Error('MediaRecorder is unavailable in this browser; PNG snapshots and original-byte saving are separate methods.');
   let stream:MediaStream;
   if(captureSource==='display')stream=await displayMedia('Recall',{video:true,audio:snapshot?false:withAudio});
   else{
     const chosen=sources[Number(captureSource)]?.element;
     if(!chosen?.isConnected)throw new Error('Selected Fusion surface is gone. Refresh sources and choose again.');
     if(chosen instanceof HTMLMediaElement&&chosen.mediaKeys)throw new Error('Protected media elements are not eligible for Recall');
     const capturable=chosen as (HTMLCanvasElement|HTMLMediaElement)&{captureStream?:(fps?:number)=>MediaStream};
     if(!capturable.captureStream)throw new Error('This browser cannot capture this Fusion element');
     if(chosen instanceof HTMLCanvasElement){
       if(chosen.width*chosen.height>16777216)throw new Error('Fusion canvas exceeds the 16-megapixel budget');
       // Sample into an owned relay. A static or occluded application canvas may never repaint;
       // do not mutate the original document merely to make captureStream deliver frames.
       const relay=document.createElement('canvas');relay.width=chosen.width;relay.height=chosen.height;
       const ctx=relay.getContext('2d');if(!ctx)throw new Error('Canvas capture unavailable');
       stream=relay.captureStream(30);sampler.current=setInterval(()=>{try{ctx.drawImage(chosen,0,0);}catch{if(rec.current?.state==='recording')rec.current.stop();release();}},1000/30);
     }else stream=capturable.captureStream();
     if(!stream.getTracks().length)throw new Error('This element has no capturable tracks; play it first. Cross-origin media may be inaccessible.');
   }
   source.current=stream;
   if(!mounted.current){release();return;}
   const context=input();
   if(preview.current&&stream.getVideoTracks().length){preview.current.srcObject=stream;let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([preview.current.play(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('No decodable capture frame arrived within 8 seconds')),8000);})]);}finally{clearTimeout(timer);}if(preview.current.videoWidth*preview.current.videoHeight>16777216)throw new Error('Capture exceeds the 16-megapixel frame budget');}
   if(snapshot){
    const video=preview.current;if(!video||!video.videoWidth)throw new Error('Selected surface has no decodable video frame');
    if(video.videoWidth*video.videoHeight>16777216)throw new Error('Snapshot exceeds the 16-megapixel pixel budget');
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Canvas unavailable');ctx.drawImage(video,0,0);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('PNG encoding failed')),'image/png'));
    release();if(blob.size>RECALL_LIMIT)throw new Error('PNG exceeds 8 MiB; no file was truncated');
    const path=await commitRecall(new Uint8Array(await blob.arrayBuffer()),'image/png',context,captureSource==='display'?'authorized-display-frame':'fusion-element-frame');
    if(mounted.current){setSaved(path);setPhase('saved');shell.bumpRefresh();}return;
   }
   const audio=stream.getAudioTracks();if(audioOnly&&!audio.length)throw new Error('No shared audio track was granted. Choose a browser tab and enable its audio; microphone audio is not substituted.');
   const output=audioOnly?new MediaStream(audio):stream;
   const options=audioOnly?['audio/webm;codecs=opus','audio/webm','audio/ogg']:['video/webm;codecs=vp8,opus','video/webm','video/mp4'];
   const mime=options.find(t=>MediaRecorder.isTypeSupported(t));if(!mime)throw new Error('No supported MediaRecorder encoder for this capture mode');
   if(local&&!mime.includes('webm'))throw new Error('The local destination was chosen as WebM but this browser needs a different container. Use VFS instead.');
   if(local)writer=await local.createWritable();
   if(!mounted.current)throw new Error('Recall closed before recording started');
   const recorder=new MediaRecorder(output,{mimeType:mime,videoBitsPerSecond:2500000,audioBitsPerSecond:128000});rec.current=recorder;
   let resolveCompletion:(ok:boolean)=>void=()=>{};const promise=new Promise<boolean>(resolve=>{resolveCompletion=resolve;});completion.current={promise,resolve:resolveCompletion};
   let writes=Promise.resolve(),queued=0,failed:Error|null=null;
   recorder.ondataavailable=e=>{
    if(!e.data.size)return;size.current+=e.data.size;if(mounted.current)setBytes(size.current);
    if(writer){
      queued+=e.data.size;if(queued>16*1024*1024){failed=new Error('Local disk cannot keep up (16 MiB pending). Recording stopped; incomplete file aborted.');if(recorder.state!=='inactive')recorder.stop();release();return;}
      const sink=writer;writes=writes.then(()=>sink.write(e.data)).then(()=>{queued-=e.data.size;}).catch(err=>{failed=err instanceof Error?err:new Error(String(err));if(recorder.state!=='inactive')recorder.stop();release();});
    }else{
      if(size.current>RECALL_LIMIT){failed=new Error('Capture exceeded 8 MiB and was NOT saved or truncated. Choose local streaming for longer recordings.');parts.current=[];}
      else if(!failed)parts.current.push(e.data);
      if(size.current>=6*1024*1024&&recorder.state!=='inactive'){recorder.stop();release();}
    }
   };
   recorder.onerror=()=>{failed=new Error('MediaRecorder failed; output is not certified complete');if(recorder.state!=='inactive')recorder.stop();release();};
   recorder.onstop=()=>{void(async()=>{
    release();let success=false;try{
      await writes;if(failed)throw failed;if(!size.current)throw new Error('Recorder produced no encoded bytes; output was not committed');if(stopFlag.current||!mounted.current)throw new Error('Recall closed during recording; output not committed');
      if(writer){await writer.close();setSaved(`Local file: ${local?.name} (${fmtBytes(size.current)})`);}
      else{const blob=new Blob(parts.current,{type:recorder.mimeType});const path=await commitRecall(new Uint8Array(await blob.arrayBuffer()),recorder.mimeType,context,captureSource==='display'?'authorized-display-recording':'fusion-element-recording');setSaved(path);shell.bumpRefresh();}
      success=true;if(mounted.current)setPhase('saved');
    }catch(e){await writer?.abort().catch(()=>undefined);if(mounted.current){setError(e instanceof Error?e.message:String(e));setPhase('failed');}}
    finally{parts.current=[];rec.current=null;busy.current=false;completion.current?.resolve(success);completion.current=null;}
   })();};
   for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(recorder.state!=='inactive')recorder.stop();release();},{once:true});
   recorder.start(1000);setPhase('recording');
  }catch(e){release();rec.current=null;completion.current?.resolve(false);completion.current=null;busy.current=false;await writer?.abort().catch(()=>undefined);if(mounted.current){setError(e instanceof Error?e.message:String(e));setPhase('failed');}}
  finally{if(!rec.current)busy.current=false;}
 };
 const followPage=useCallback((page:string,pageTitle:string)=>{if(!busy.current){setUrl(page);setTitle(pageTitle);}},[]);
 const running=phase==='recording'||phase==='finalizing'||phase==='requesting permission';
 return <div className="fs-scroll" data-testid="recall" style={{height:'100%',padding:12,display:'grid',gap:12,alignContent:'start'}}>
  <h2 style={{margin:0}}>Recall <Badge>{phase}</Badge></h2>
  <Hint label="What Recall can and cannot do">Archive media you are authorized to save. No DRM bypass, hidden capture, or promise to capture every site. Server copies are unencrypted in /Downloads/Recall, not /Private.</Hint>
  <RecallMemory context={input}/>
  <Hint label="Pixels or bytes?">“Save largest loaded visual” uses current decoded pixels, not a URL download or whole-page screenshot. The legacy “Save media URL” below explicitly refetches bytes and is a separate fallback.</Hint>
  <div className="fs-row"><Btn aria-expanded={browserOpen} onClick={()=>setBrowserOpen(v=>!v)}>{browserOpen?'Close browsing pane':'Browse inside Recall'}</Btn><span className="fs-dim" title="Browser sessions restore; Auto Recall must be explicitly armed in each proxy document.">sessions restore · Auto Recall is armed per page</span></div>
  {browserOpen?<section aria-label="Recall browser" style={{height:540,minHeight:360,border:'1px solid var(--fs-border)',borderRadius:10,overflow:'hidden'}}><BrowserModule win={{...win,props:{...win.props,url,proxyAll:win.props.proxyAll??true}}} onPageChange={followPage} embeddedRecall/></section>:null}
  <label>Media or declared page URL<input className="fs-input" aria-label="Recall source URL" value={url} disabled={running} onChange={e=>setUrl(e.target.value)} style={{width:'100%'}}/></label>
  <div className="fs-row" style={{flexWrap:'wrap',gap:8}}>
   <label>Folders <select className="fs-input" aria-label="Recall folder grouping" value={grouping} disabled={running} onChange={e=>setGrouping(e.target.value as RecallGrouping)}><option value="host">URL host</option><option value="title">Page title</option><option value="custom">Custom</option></select></label>
   <input className="fs-input" aria-label="Recall page title" placeholder="Page title" value={title} disabled={running} onChange={e=>setTitle(e.target.value)}/>
   {grouping==='custom'?<input className="fs-input" aria-label="Recall custom folder" value={custom} disabled={running} onChange={e=>setCustom(e.target.value)}/>:null}
  </div>
  <Section title="1 · Original bytes" right={<Badge>refetch</Badge>}>
   <Btn disabled={running} onClick={()=>{try{enqueueRecall(input());setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}>Save media URL</Btn>
   <Hint label="Limits">HTTP(S) images, video or audio only, up to 8 MiB. Redirects, playlists, blob URLs and HTML are not complete media. The existing guarded proxy checks network destinations. Query tokens are excluded from receipts. Publisher MIME headers are not proof of a playable codec.</Hint>
  </Section>
  <Section title="1b · Loaded by this page" right={<Badge tone="ok">no new request</Badge>}>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}>
    <Btn onClick={refreshTap} disabled={!tapOn}>Refresh loaded media</Btn>
    <Btn onClick={()=>{for(const sid of sessions)void forgetTapped(sid);}} disabled={!tapOn||!tapItems.length}>Forget held media</Btn>
    <span data-testid="tap-count">{tapOn?`${tapItems.length} held`:'off'}</span>
   </div>
   {tapOn?null:<div role="note" data-testid="tap-policy-off">Switched off — Settings → Privacy → Remember media this page loads. Nothing is kept; other pathways are unaffected.</div>}
   {tapOn&&!sessions.length?<p className="fs-dim" style={{margin:0}}>Open a page above to list what it loaded.</p>:null}
   <ul data-testid="recall-tap-list" style={{listStyle:'none',margin:0,padding:0,display:'grid',gap:6}}>
    {tapItems.map(it=><li key={`${it.sid}:${it.id}`} data-testid={`tap-item-${it.id}`} className="fs-row" style={{gap:8,flexWrap:'wrap',alignItems:'center'}}>
     {/* eslint-disable-next-line @next/next/no-img-element -- held bytes come from this server's memory over a no-store endpoint; next/image would try to fetch and cache them */}
     {it.mime.startsWith('image/')?<img alt="" src={`/api/recall-tap?sid=${encodeURIComponent(it.sid)}&id=${encodeURIComponent(it.id)}&op=bytes`} style={{width:48,height:48,objectFit:'cover',borderRadius:6,background:'var(--fs-sunken)'}}/>:<span aria-hidden="true" style={{width:48,textAlign:'center'}}>{it.mime.startsWith('video/')?'▶':'♪'}</span>}
     <span className="fs-mono" style={{flex:'1 1 220px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={it.url}>{it.url}</span>
     <Badge>{it.mime}</Badge><span>{fmtBytes(it.size)}</span>
     <Btn variant="primary" disabled={tapBusy===it.id} onClick={()=>void saveTapped(it)} aria-label={`Save loaded media ${it.url}`}>{tapBusy===it.id?'Saving…':'Save'}</Btn>
     <Btn onClick={()=>void forgetTapped(it.sid,it.id)} aria-label={`Forget loaded media ${it.url}`}>Forget</Btn>
    </li>)}
   </ul>
   <Hint label="Where these bytes come from">These are the exact bytes the publisher sent while you were looking at the page, kept in this server&apos;s memory and never written to disk until you save one. Images, audio and video up to 8 MiB, 24 per browsing session; a part-loaded or range response is not kept. Closing the page, switching the setting off or pressing Forget drops them immediately. Saving makes no network request — a receipt records the method <span className="fs-mono">session-retained-response</span>.</Hint>
  </Section>
  <Section title="1c · Held by this page" right={<Badge tone="ok">byte-exact</Badge>}>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}>
    <Btn data-testid="resident-scan" disabled={!sessions.length||resBusy==='scan'} onClick={()=>void scanResident()}>{resBusy==='scan'?'Scanning…':'Scan the open page'}</Btn>
    <span data-testid="resident-count">{resScanned?`${resItems.length} found`:'not scanned'}</span>
   </div>
   {sessions.length?null:<p className="fs-dim" style={{margin:0}}>Open a page above to read what it is holding.</p>}
   <ul data-testid="resident-list" style={{listStyle:'none',margin:0,padding:0,display:'grid',gap:6}}>
    {resItems.map(it=><li key={`${it.sid}:${it.id}`} data-testid={`resident-item-${it.id}`} className="fs-row" style={{gap:8,flexWrap:'wrap',alignItems:'center'}}>
     <span className="fs-mono" style={{flex:'1 1 200px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={it.label}>{it.label}</span>
     <Badge>{it.scheme}:</Badge>{it.mime?<Badge>{it.mime}</Badge>:null}
     {it.w&&it.h?<span className="fs-dim">{it.w}×{it.h}</span>:null}
     <Btn variant="primary" disabled={resBusy===`${it.sid}:${it.id}`} onClick={()=>void saveResident(it)} aria-label={`Save object the page is holding ${it.label}`}>{resBusy===`${it.sid}:${it.id}`?'Saving…':'Save'}</Btn>
    </li>)}
   </ul>
   {resRefused.length?<ul data-testid="resident-refused" style={{listStyle:'none',margin:0,padding:0,display:'grid',gap:4}}>
    {resRefused.map((r,i)=><li key={i} className="fs-dim" style={{fontSize:'0.9em'}}>{r.label}: {r.reason}</li>)}
   </ul>:null}
   <Hint label="blob: and data: objects">A page can hold media it never downloaded twice — a picture it drew, a file you dropped on it, or bytes it assembled in memory — behind a <code>blob:</code> or <code>data:</code> address that only that page can read. Scanning asks the open page what it is holding; saving copies those exact bytes, with no decode and no second request. Live <code>MediaSource</code> streams and revoked objects have no complete file behind them and are listed as refusals instead. Up to 8 MiB per object.</Hint>
  </Section>
  {captureAllowed?null:<div role="note" data-testid="capture-policy-off">Switched off — Settings → Privacy → Screen and element capture. The buttons stay disabled and the server refuses these saves.</div>}
  <Section title="2 · Live recording" right={<Badge tone="warn">re-encode</Badge>}>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}><Btn disabled={running} onClick={scan}>Refresh Fusion sources</Btn><label>Capture source <select aria-label="Recall capture source" disabled={running} value={captureSource} onChange={e=>setCaptureSource(e.target.value)}><option value="display">Shared display / tab (permission required)</option>{sources.map((s,i)=><option key={i} value={String(i)}>{s.label}</option>)}</select></label></div>
   <Hint label="What can be captured">Fusion element capture is limited to accessible, already-rendered canvas/video/audio elements in this document. It cannot reach opaque/cross-origin frames or protected media. Canvas has no audio; a microphone is never silently added.</Hint>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}>
    <label><input type="checkbox" checked={withAudio} disabled={running} onChange={e=>setWithAudio(e.target.checked)}/> Request shared audio</label>
    <label><input type="checkbox" checked={audioOnly} disabled={running} onChange={e=>setAudioOnly(e.target.checked)}/> Audio-only output (requires shared audio)</label>
    <Btn disabled={running} onClick={()=>void chooseLocal()}>Choose local streaming file (experimental)</Btn>
    {local?<Btn disabled={running} onClick={()=>setLocal(null)}>Use bounded VFS instead</Btn>:null}
    <Btn variant="primary" disabled={running||!captureAllowed} onClick={()=>void start()}>Start authorized recording</Btn>
    <Btn disabled={phase!=='recording'} onClick={stop}>Stop and finalize</Btn>
   </div>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap',alignItems:'center'}}>
    <Badge>{fmtBytes(bytes)} received</Badge>
    <Hint label={local?`Streaming to ${local.name}`:'Bounded to the VFS'}>{local?`Streaming to ${local.name}; bounded pending writes, no full-recording RAM buffer.`:'VFS auto-stops near 6 MiB, hard limit 8 MiB. Choose a local file for long recordings.'} Permission is required each time; only audio tracks actually granted are encoded. Protected content may be blank or unavailable.</Hint>
   </div>
  </Section>
  <Section title="3 · Snapshot" right={<Badge tone="warn">pixels</Badge>}>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap',alignItems:'center'}}><Btn disabled={running||!captureAllowed} onClick={()=>void start(true)}>Capture authorized image</Btn><Hint label="Pixels, not original bytes">Rasterizes a decoded video frame to PNG (16 MP / 8 MiB limits), not the original image bytes.</Hint></div>
  </Section>
  <video ref={preview} muted playsInline style={{maxWidth:'100%',maxHeight:180,background:'#000'}} aria-label="Recall capture preview"/>
  {error?<div role="alert">{error}</div>:null}
  {saved?<div role="status">Saved: {saved} {saved.startsWith('/')?<Btn onClick={()=>shell.open('files',{path:saved.slice(0,saved.lastIndexOf('/'))})}>Reveal recording</Btn>:null}</div>:null}
  <Section title="Auto Recall queue">
   <Hint label="How Auto Recall behaves">In a Fusion Browser private-proxy tab, explicitly enable “Auto Recall”. It discovers up to 200 current-document image/video/audio HTTP URLs, including mutations, and copies same-origin media only while armed. It cannot inspect unrelated cross-origin frames, DRM, MediaSource/blob segments, CSS backgrounds or every network request. Queue: 16 pending; one fetch at a time. Closing the proxy tab disarms its queue.</Hint>
   <Btn onClick={()=>cancelRecall()}>Cancel pending / fetching jobs</Btn>
   <Hint label="Cancelling">Once a database commit starts it is not cancellable; an uncertain commit must be checked in Files, not blindly retried.</Hint>
   <ol>{[...jobs.filter(j=>!['saved','failed','cancelled'].includes(j.phase)),...jobs.filter(j=>['saved','failed','cancelled'].includes(j.phase)).slice(-24).reverse()].map(j=><li key={j.id} data-phase={j.phase}><strong>{j.phase}</strong> {j.source} {j.path?<Btn onClick={()=>shell.open('files',{path:j.path!.slice(0,j.path!.lastIndexOf('/'))})}>Reveal</Btn>:null}{j.error?<span role="status"> — {j.error}</span>:null}</li>)}</ol>
  </Section>
 </div>;
}
