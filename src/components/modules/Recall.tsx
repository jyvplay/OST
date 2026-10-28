"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useShell, type ModuleProps } from '../shell-context';
import { Btn, Badge, Section } from '../ui';
import { displayMedia } from '@/lib/access-log';
import { commitRecall, recallWritable, enqueueRecall, cancelRecall, recallSnapshot, recallSubscribe, type RecallInput } from '@/lib/recall';
import { RECALL_LIMIT, recallFolder, type RecallGrouping } from '@/lib/recall-core';
import { registerDocGuard } from '@/lib/doc-lifecycle';
import BrowserModule from './Browser';
import RecallMemory from './RecallMemory';
import { fmtBytes } from '@/lib/api';
type Writable = {write:(data:Blob)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>};
type LocalHandle = {createWritable:()=>Promise<Writable>;name:string};
const empty: ReturnType<typeof recallSnapshot> = [];
export default function Recall({win}:ModuleProps){
 const shell=useShell();
 // TT110 (RC-36): the capture policy. The server refuses these methods when it is off; the
 // interface must not pretend the buttons would work, and must say where the switch lives.
 const captureAllowed=shell.settings['privacy.screenCapture']!=='off';const jobs=useSyncExternalStore(recallSubscribe,recallSnapshot,()=>empty);
 const [browserOpen,setBrowserOpen]=useState(false);
 const [url,setUrl]=useState(String(win.props.url??'https://github.com/'));
 const [title,setTitle]=useState(String(win.props.pageTitle??'')),[grouping,setGrouping]=useState<RecallGrouping>('host'),[custom,setCustom]=useState('');
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
  <p>Archive media you are authorized to save. No DRM bypass, hidden capture, or promise to capture every site. Server copies are unencrypted in /Downloads/Recall, not /Private.</p>
  <RecallMemory context={input}/>
  <p>“Save largest loaded visual” uses current decoded pixels, not a URL download or whole-page screenshot. The legacy “Save media URL” below explicitly refetches bytes and is a separate fallback.</p>
  <div className="fs-row"><Btn aria-expanded={browserOpen} onClick={()=>setBrowserOpen(v=>!v)}>{browserOpen?'Close browsing pane':'Browse inside Recall'}</Btn><span>Browser sessions restore; Auto Recall must be explicitly armed in each proxy document.</span></div>
  {browserOpen?<section aria-label="Recall browser" style={{height:540,minHeight:360,border:'1px solid var(--fs-border)',borderRadius:10,overflow:'hidden'}}><BrowserModule win={{...win,props:{...win.props,url,proxyAll:win.props.proxyAll??true}}} onPageChange={followPage} embeddedRecall/></section>:null}
  <label>Media or declared page URL<input className="fs-input" aria-label="Recall source URL" value={url} disabled={running} onChange={e=>setUrl(e.target.value)} style={{width:'100%'}}/></label>
  <div className="fs-row" style={{flexWrap:'wrap',gap:8}}>
   <label>Folders <select className="fs-input" aria-label="Recall folder grouping" value={grouping} disabled={running} onChange={e=>setGrouping(e.target.value as RecallGrouping)}><option value="host">URL host</option><option value="title">Page title</option><option value="custom">Custom</option></select></label>
   <input className="fs-input" aria-label="Recall page title" placeholder="Page title" value={title} disabled={running} onChange={e=>setTitle(e.target.value)}/>
   {grouping==='custom'?<input className="fs-input" aria-label="Recall custom folder" value={custom} disabled={running} onChange={e=>setCustom(e.target.value)}/>:null}
  </div>
  <Section title="1 · Original bytes — fastest, no re-encoding">
   <Btn disabled={running} onClick={()=>{try{enqueueRecall(input());setError('');}catch(e){setError(e instanceof Error?e.message:String(e));}}}>Save media URL</Btn>
   <p>HTTP(S) images, video or audio only, up to 8 MiB. Redirects, playlists, blob URLs and HTML are not complete media. The existing guarded proxy checks network destinations. Query tokens are excluded from receipts. Publisher MIME headers are not proof of a playable codec.</p>
  </Section>
  {captureAllowed?null:<div role="note" data-testid="capture-policy-off">Screen and element capture is switched off for this installation (Settings → Privacy → Screen and element capture). The buttons below stay disabled, and the server refuses these saves even if something else asks for them.</div>}
  <Section title="2 · Authorized live video / shared audio encoding">
   <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}><Btn disabled={running} onClick={scan}>Refresh Fusion sources</Btn><label>Capture source <select aria-label="Recall capture source" disabled={running} value={captureSource} onChange={e=>setCaptureSource(e.target.value)}><option value="display">Shared display / tab (permission required)</option>{sources.map((s,i)=><option key={i} value={String(i)}>{s.label}</option>)}</select></label></div>
   <p>Fusion element capture is limited to accessible, already-rendered canvas/video/audio elements in this document. It cannot reach opaque/cross-origin frames or protected media. Canvas has no audio; a microphone is never silently added.</p>
   <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}>
    <label><input type="checkbox" checked={withAudio} disabled={running} onChange={e=>setWithAudio(e.target.checked)}/> Request shared audio</label>
    <label><input type="checkbox" checked={audioOnly} disabled={running} onChange={e=>setAudioOnly(e.target.checked)}/> Audio-only output (requires shared audio)</label>
    <Btn disabled={running} onClick={()=>void chooseLocal()}>Choose local streaming file (experimental)</Btn>
    {local?<Btn disabled={running} onClick={()=>setLocal(null)}>Use bounded VFS instead</Btn>:null}
    <Btn variant="primary" disabled={running||!captureAllowed} onClick={()=>void start()}>Start authorized recording</Btn>
    <Btn disabled={phase!=='recording'} onClick={stop}>Stop and finalize</Btn>
   </div>
   <p>{local?`Streaming to ${local.name}; bounded pending writes, no full-recording RAM buffer.`:'VFS auto-stops near 6 MiB, hard limit 8 MiB. Choose a local file for long recordings.'} Bytes received: {fmtBytes(bytes)}. Permission is required each time; only audio tracks actually granted are encoded. Protected content may be blank or unavailable.</p>
  </Section>
  <Section title="3 · PNG raster snapshot of an authorized shared surface">
   <Btn disabled={running||!captureAllowed} onClick={()=>void start(true)}>Capture authorized image</Btn><p>Rasterizes a decoded video frame to PNG (16 MP / 8 MiB limits), not the original image bytes.</p>
  </Section>
  <video ref={preview} muted playsInline style={{maxWidth:'100%',maxHeight:180,background:'#000'}} aria-label="Recall capture preview"/>
  {error?<div role="alert">{error}</div>:null}
  {saved?<div role="status">Saved: {saved} {saved.startsWith('/')?<Btn onClick={()=>shell.open('files',{path:saved.slice(0,saved.lastIndexOf('/'))})}>Reveal recording</Btn>:null}</div>:null}
  <Section title="Automatic exposed-media archiving">
   <p>In a Fusion Browser private-proxy tab, explicitly enable “Auto Recall”. It discovers up to 200 current-document image/video/audio HTTP URLs, including mutations, and copies same-origin media only while armed. It cannot inspect unrelated cross-origin frames, DRM, MediaSource/blob segments, CSS backgrounds or every network request. Queue: 16 pending; one fetch at a time. Closing the proxy tab disarms its queue.</p>
   <Btn onClick={()=>cancelRecall()}>Cancel pending / fetching jobs</Btn>
   <p>Once a database commit starts it is not cancellable; an uncertain commit must be checked in Files, not blindly retried.</p>
   <ol>{[...jobs.filter(j=>!['saved','failed','cancelled'].includes(j.phase)),...jobs.filter(j=>['saved','failed','cancelled'].includes(j.phase)).slice(-24).reverse()].map(j=><li key={j.id} data-phase={j.phase}><strong>{j.phase}</strong> {j.source} {j.path?<Btn onClick={()=>shell.open('files',{path:j.path!.slice(0,j.path!.lastIndexOf('/'))})}>Reveal</Btn>:null}{j.error?<span role="status"> — {j.error}</span>:null}</li>)}</ol>
  </Section>
 </div>;
}
