"use client";
import { useEffect, useRef, useState } from 'react';
import { api, fmtBytes } from '@/lib/api';
import { commitRecallDetailed, recallWritable, type RecallInput } from '@/lib/recall';
import { cropRegion, loadedPngDimensions, oneResidentFile, type CropRect } from '@/lib/recall-memory';
import { RECALL_LIMIT, recallFolder, recallMime } from '@/lib/recall-core';
import type { RecallGuard } from '@/lib/server/recall-lifecycle';
import { Btn, Hint } from '../ui';
import { useShell } from '../shell-context';

/** Human-selected, already resident bytes. This module never fetches a media URL. */
const plural=(n:number,one:string,many=one+'s')=>`${n} ${n===1?one:many}`;

export default function RecallMemory({ context }: { context: () => RecallInput }) {
 const shell=useShell();
 const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[items,setItems]=useState<{path:string;name:string;mime:string}[]>([]),[view,setView]=useState<{url:string;mime:string;path:string;bytesSha:string;mediaGuard:RecallGuard['media']}|null>(null);
 const [next,setNext]=useState<string|null>(null),[folder,setFolder]=useState('');
 // TT109: default off — a save the person asked for always files a memory unless they say otherwise.
 const [keepOne,setKeepOne]=useState(false);
 const [confirmTrash,setConfirmTrash]=useState(false),[undo,setUndo]=useState<{path:string;guard:RecallGuard}|null>(null);
 const [method,setMethod]=useState(''),[host,setHost]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[auditScope,setAuditScope]=useState('folder');
 const [audit,setAudit]=useState<{scope:string;mediaFiles:number;receiptFiles:number;healthyPairs:number;orphanMedia:string[];orphanReceipts:string[];unreadableReceipts:string[];checksumMismatch:string[]}|null>(null);
 const previewMedia=useRef<HTMLImageElement|HTMLVideoElement|null>(null);
 // TT108: a region dragged over the already-decoded preview, in displayed pixels.
 const [drag,setDrag]=useState<{x:number;y:number;w:number;h:number}|null>(null),dragging=useRef<{x:number;y:number}|null>(null);
 const [timeline,setTimeline]=useState<{days:{day:string;memories:number;bytes:number;methods:string[]}[];scope:string;zone:string;undatedReceipts:number;unreadableReceipts:number;totalMemories:number}|null>(null);
 const mounted=useRef(true),objectUrl=useRef(''),active=useRef(false),epoch=useRef(0);
 useEffect(()=>{const lifecycle=epoch;mounted.current=true;return()=>{mounted.current=false;lifecycle.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};},[]);
 const run=async(fn:()=>Promise<void>)=>{if(active.current)return;active.current=true;setBusy(true);setNote('');try{await fn();}catch(e){if(mounted.current)setNote(e instanceof Error?e.message:String(e));}finally{active.current=false;if(mounted.current)setBusy(false);}};
 /**
  * TT109: a human save files a new memory by default — an explicit save is never silently refused.
  * Recognition of bytes this folder already holds is offered as a choice the person makes (keepOne),
  * because "you already have this" is useful information but a poor thing to assume.
  */
 const save=async(blob:Blob,method:string,derivedFrom?:{path:string;sha256:string;region:CropRect})=>{
  recallWritable();const input={...context()};recallFolder(input.page,input.title,input.grouping,input.custom);
  if(!blob.size||blob.size>RECALL_LIMIT)throw Error('Select nonempty media at most 8 MiB; no truncation.');
  const mime=recallMime(blob.type);const bytes=new Uint8Array(await blob.arrayBuffer());
  if(!mounted.current)throw Error('Recall closed before save');
  const r=await commitRecallDetailed(bytes,mime,input,method,{derivedFrom,onDuplicate:keepOne?'skip':'store'});
  const cut=derivedFrom?` · cut from ${derivedFrom.region.width}×${derivedFrom.region.height} pixels of ${derivedFrom.path}`:'';
  if(mounted.current)setNote(r.stored
   ? 'Saved memory → '+r.path+cut
   : `Already saved on ${new Date(r.firstSavedAt??Date.now()).toLocaleString()} → ${r.path} · identical bytes, so this folder keeps one copy instead of two.`);
 };
 /**
  * TT110 (RC-35): act on the memory that is open. Shaped after the incumbent's act-on-a-selection
  * surface, with the analysis left out on purpose: this app does not read what is IN the picture,
  * it only hands the picture itself to the clipboard or to another module by path. Nothing is
  * re-fetched and nothing is written to a temporary file on the way.
  */
 const copyMemory=async()=>{
  if(!view)throw Error('Open a memory first');
  if(typeof ClipboardItem==='undefined'||!navigator.clipboard?.write)throw Error('This browser cannot put files on the clipboard; use Export open memory instead.');
  const node=await api<{node?:{content?:string;encoding?:string}}>('/api/fs?'+new URLSearchParams({op:'read',path:view.path}));
  const raw=node.node?.content??'';
  if(!raw)throw Error('That memory has no stored bytes to copy');
  const bytes=Uint8Array.from(atob(raw),c=>c.charCodeAt(0));
  if(view.mime==='image/png'){
   await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);
   // Measured, not assumed: Chromium decodes and re-encodes images that pass through the system
   // clipboard, so the pasted file is a new PNG with the same pixels. Say exactly that.
   if(mounted.current)setNote(`Copied this ${fmtBytes(bytes.length)} PNG memory to the clipboard. The browser re-encodes images on the clipboard, so what you paste has the same pixels but not the same file bytes; the archived file is untouched.`);
   return;
  }
  if(view.mime.startsWith('image/')){
   // Chromium only accepts PNG image payloads on the clipboard, so anything else is re-encoded.
   // Say so: the clipboard copy is then a new rendering, not the archived bytes.
   const bitmap=await createImageBitmap(new Blob([bytes],{type:view.mime}));
   const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
   const ctx=canvas.getContext('2d');if(!ctx){bitmap.close();throw Error('Canvas unavailable for the clipboard re-encode');}
   ctx.drawImage(bitmap,0,0);bitmap.close();
   const png=await new Promise<Blob>((res,rej)=>canvas.toBlob(b=>b?res(b):rej(Error('PNG encoding failed')),'image/png'));
   await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
   if(mounted.current)setNote(`Copied a PNG re-encode of this ${view.mime} memory (${fmtBytes(png.size)}) — same pixels, different bytes; the archived file is unchanged.`);
   return;
  }
  await navigator.clipboard.writeText(view.path);
  if(mounted.current)setNote(`${view.mime} cannot be put on the clipboard as a file; copied the memory's path instead.`);
 };
 /** Hand the memory to another module by path. No copy is made and no temporary file is left behind. */
 const openMemoryWith=(moduleId:string)=>{
  if(!view)throw Error('Open a memory first');
  shell.open(moduleId,moduleId==='files'?{path:view.path.slice(0,view.path.lastIndexOf('/'))}:{path:view.path});
  setNote(`Opened ${view.path} in ${moduleId} — the archive still holds the only copy.`);
 };
 const list=async(older=false)=>{
  recallWritable();const c=context(),path=recallFolder(c.page,c.title,c.grouping,c.custom);
  if(older&&(path!==folder||!next))throw Error('Folder changed; refresh the timeline first');
  const r=await api<{nodes:{path:string;name:string;mime:string}[];next:string|null}>('/api/fs?'+new URLSearchParams({op:'recallPage',path,...(older&&next?{before:next}:{})}));
  if(mounted.current){setItems(old=>older?[...old,...r.nodes]:r.nodes);setNext(r.next);setFolder(path);setNote(path+' · Insertion order, newest first. Up to 100 metadata rows per page; no media bodies in the listing. Maximum 400 displayed; refresh to restart. Unusually long metadata is excluded (path >1024, name >512 or MIME >256 UTF-8 bytes).');}
 };
 const resident=(files:ArrayLike<File>,method:string)=>void run(async()=>{await save(oneResidentFile(files),method);});
 const pair=async(path:string,action:'inspect'|'trash'|'restore',expected?:RecallGuard)=>{
  recallWritable();return api<{state:string;guard:RecallGuard;verified:{method:string;capturedAt:string}}>('/api/fs',{method:'POST',body:JSON.stringify({op:'recallPair',action,path,expected})});
 };
 const verify=async()=>{if(!view)throw Error('Open a saved memory first');const r=await pair(view.path,'inspect');if(mounted.current)setNote('Receipt matches stored bytes: '+r.verified.method+' · '+r.verified.capturedAt+'. Single database snapshot; integrity only, not authenticated provenance or verification of the open preview.');};
 const trash=async()=>{
  if(!view)throw Error('Open a saved memory first');const path=view.path;
  const inspected=await pair(path,'inspect');if(inspected.guard.media.id!==view.mediaGuard.id||inspected.guard.media.version!==view.mediaGuard.version||inspected.guard.media.sha256!==view.mediaGuard.sha256)throw Error('Open memory changed; reopen it before trashing');const result=await pair(path,'trash',inspected.guard);
  if(mounted.current){setUndo({path,guard:result.guard});setConfirmTrash(false);setItems(old=>old.filter(n=>n.path!==path));epoch.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';setView(null);setNote('Media and receipt moved to Trash together. Undo restores only this unchanged pair; this is not secure erasure.');}
 };
 const restore=async()=>{if(!undo)return;await pair(undo.path,'restore',undo.guard);if(mounted.current){setUndo(null);setNote('Pair restored. Refresh the selected folder timeline to view it.');}};
 const search=async()=>{
  recallWritable();
  const params=new URLSearchParams({op:'recallSearch'});
  if(method)params.set('method',method);if(host)params.set('host',host);if(from)params.set('from',from);if(to)params.set('to',to);
  const r=await api<{nodes:{path:string;name:string;mime:string;method:string;host:string|null;capturedAt:string|null}[];scanned:number;unreadableReceipts:number}>('/api/fs?'+params);
  if(!mounted.current)return;
  setItems(r.nodes.map(n=>({path:n.path,name:n.name,mime:n.mime})));setNext(null);setFolder('');
  setNote(`${plural(r.nodes.length,'memory','memories')} match (at most 100 shown) from ${plural(r.scanned,'receipt')}${r.unreadableReceipts?`; ${plural(r.unreadableReceipts,'unreadable receipt')} skipped`:''}. Receipt facts were recorded when you saved; they are integrity data, not authenticated provenance.`);
 };
 const runAudit=async()=>{
  recallWritable();
  const c=context(),scoped=auditScope==='folder'?recallFolder(c.page,c.title,c.grouping,c.custom):'';
  const r=await api<{scope:string;mediaFiles:number;receiptFiles:number;healthyPairs:number;orphanMedia:string[];orphanReceipts:string[];unreadableReceipts:string[];checksumMismatch:string[]}>('/api/fs?'+new URLSearchParams(scoped?{op:'recallAudit',folder:scoped}:{op:'recallAudit'}));
  if(mounted.current){setAudit(r);setNote('Integrity report refreshed. Missing receipts are never regenerated; provenance cannot be reconstructed after the fact.');}
 };
 const trashOrphan=async(orphan:string)=>{
  recallWritable();
  const node=(await api<{node:{id:number;version:number;sha256:string}}>('/api/fs?'+new URLSearchParams({op:'stat',path:orphan}))).node;
  await api('/api/fs',{method:'POST',body:JSON.stringify({op:'recallOrphan',path:orphan,expected:{id:node.id,version:node.version,sha256:node.sha256}})});
  // Refresh first, then state the outcome: the refresh writes its own status, so
  // announcing the trash beforehand would wipe the confirmation off the screen.
  await runAudit();
  if(mounted.current)setNote('Unpaired file moved to Trash: '+orphan+'. Recoverable from Files; this is not secure erasure.');
 };
 const frame=async()=>{
  const media=previewMedia.current;if(!view||!media)throw Error('Open an image or video preview first');
  const version=epoch.current;const width=media instanceof HTMLVideoElement?media.videoWidth:media.naturalWidth,height=media instanceof HTMLVideoElement?media.videoHeight:media.naturalHeight;
  if(media instanceof HTMLVideoElement?media.readyState<2:!media.complete)throw Error('Preview has not decoded');
  if(!width||!height||width*height>16777216)throw Error('Preview frame must be nonempty and at most 16 MP');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');ctx.drawImage(media,0,0);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Frame encoding failed')),'image/png'));
  if(version!==epoch.current||!mounted.current)throw Error('Preview changed before frame save');await save(blob,'saved-preview-frame');
 };
 /**
  * TT108 (RC-33) — save the region a person dragged over the open preview. The crop is
  * cut from the bitmap the browser already decoded for that preview: no request is made
  * for the original, and the stored parent is left untouched. The receipt records which
  * saved pair it came from, at which checksum, so the derivation can be audited later.
  */
 const saveRegion=async()=>{
  const media=previewMedia.current;
  if(!view||!media)throw Error('Open an image or video preview first');
  if(!drag)throw Error('Drag a rectangle over the preview to choose a region');
  const version=epoch.current;
  const natural=media instanceof HTMLVideoElement?{width:media.videoWidth,height:media.videoHeight}:{width:media.naturalWidth,height:media.naturalHeight};
  if(media instanceof HTMLVideoElement?media.readyState<2:!media.complete)throw Error('Preview has not decoded');
  const box=media.getBoundingClientRect();
  const region=cropRegion({x:drag.x,y:drag.y,width:drag.w,height:drag.h},{width:box.width,height:box.height},natural);
  const canvas=document.createElement('canvas');canvas.width=region.width;canvas.height=region.height;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');
  ctx.drawImage(media,region.x,region.y,region.width,region.height,0,0,region.width,region.height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Region encoding failed')),'image/png'));
  if(version!==epoch.current||!mounted.current)throw Error('Preview changed before the region was saved');
  await save(blob,'cropped-preview-region',{path:view.path,sha256:view.bytesSha,region});
  if(mounted.current)setDrag(null);
 };
 /** TT108 (RC-32) — day-grouped view of saving activity, in this browser's own time zone. */
 const loadTimeline=async()=>{
  recallWritable();
  const c=context(),scoped=auditScope==='folder'?recallFolder(c.page,c.title,c.grouping,c.custom):'';
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
  const r=await api<{days:{day:string;memories:number;bytes:number;methods:string[]}[];scope:string;zone:string;undatedReceipts:number;unreadableReceipts:number;totalMemories:number}>(
    '/api/fs?'+new URLSearchParams(scoped?{op:'recallTimeline',folder:scoped,tz:zone}:{op:'recallTimeline',tz:zone}));
  if(mounted.current){setTimeline(r);setNote(`Saving timeline refreshed for ${r.scope} (${r.zone}). Pick a day below to list what was saved then.`);}
 };
 /** Select one day of the timeline: the day filter is applied server-side like any other search. */
 const openDay=async(day:string)=>{
  recallWritable();setFrom(day);setTo(day);
  const c=context(),scoped=auditScope==='folder'?recallFolder(c.page,c.title,c.grouping,c.custom):'';
  const params=new URLSearchParams({op:'recallSearch',from:day,to:day+'T23:59:59.999Z'});
  if(scoped)params.set('folder',scoped);
  if(method)params.set('method',method);if(host)params.set('host',host);
  const r=await api<{nodes:{path:string;name:string;mime:string}[];scanned:number}>('/api/fs?'+params);
  if(mounted.current){setItems(r.nodes.map(n=>({path:n.path,name:n.name,mime:n.mime})));setNext(null);setFolder('');
   setNote(`${plural(r.nodes.length,'memory','memories')} saved on ${day}${scoped?' in '+scoped:' across all Recall folders'} (at most 100 shown).`);}
 };
 const open=async(path:string)=>{
  recallWritable();setConfirmTrash(false);const version=++epoch.current;
  // A refused open must not leave the previous memory on screen: the preview and every
  // pair action below it would then describe a different file than the row just clicked.
  if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';setView(null);
  const r=await api<{node:{id:number;version:number;sha256:string;content:string;encoding:string;mime:string}}>('/api/fs?'+new URLSearchParams({op:'read',path}));
  if(!mounted.current||version!==epoch.current)return;
  if(r.node.encoding!=='base64'||r.node.content.length>Math.ceil(RECALL_LIMIT/3)*4)throw Error('Unsupported or oversized memory');
  const mime=recallMime(r.node.mime);const raw=atob(r.node.content),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(!bytes.length||bytes.length>RECALL_LIMIT)throw Error('Invalid memory size');
  // Never render SVG/HTML as an active document. Blob media previews have no HTML privileges.
  if(mime==='image/png')loadedPngDimensions(bytes);
  if(mime==='image/svg+xml')throw Error('Active SVG preview is not supported');
  // The receipt — and therefore a crop's provenance — digests the decoded bytes, not the stored text.
  const bytesSha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.buffer as ArrayBuffer)),b=>b.toString(16).padStart(2,'0')).join('');
  if(!mounted.current||version!==epoch.current)return;
  const url=URL.createObjectURL(new Blob([bytes],{type:mime}));if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=url;setDrag(null);setView({url,mime,path,bytesSha,mediaGuard:{id:r.node.id,version:r.node.version,sha256:r.node.sha256}});
 };
 return <section aria-label="Already-loaded memories" className="fs-panel" style={{padding:12,display:'grid',gap:8}}>
  <h3 style={{margin:0}}>Save what you already have</h3>
  <Hint label="No background surveillance">Choose a browser-resident file or paste a copied image. These paths preserve the selected bytes without requesting the media URL again. Server memories are unencrypted in /Downloads/Recall; there is no automatic sensitive-information filter.</Hint>
  <div role="region" aria-label="Paste or drop resident media" tabIndex={0} style={{padding:12,border:'1px dashed var(--fs-border)',borderRadius:8}}
   onPaste={e=>{if(!e.clipboardData.files.length){setNote('No resident media file in this paste; text and links are never fetched.');return;}e.preventDefault();resident(e.clipboardData.files,'human-paste-file');}}
   onDragOver={e=>{if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=busy?'none':'copy';}}}
   onDrop={e=>{e.preventDefault();resident(e.dataTransfer.files,'human-drop-file');}}>
   <span>Paste or drop one media file</span>
   <Hint label="Why a dragged link will not do">Focus here and paste a copied media file, or drop exactly one file. Dragged webpage links are not downloads; if the browser exposes only a URL, use the already-loaded visual button instead.</Hint>
  </div>
  <label style={{display:'grid',gap:4,justifyItems:'start'}}>Choose media from your device<input aria-label="Choose resident media" disabled={busy} type="file" accept="image/*,video/*,audio/*" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void run(()=>save(file,'human-selected-file'));}}/></label>
  <label className="fs-row" style={{gap:6,alignItems:'center'}}>
   <input type="checkbox" aria-label="Keep one copy of identical pictures" checked={keepOne} disabled={busy}
    onChange={e=>setKeepOne(e.currentTarget.checked)} />
   <span title={keepOne?'A repeat save will point at the memory already held':'Every save files a new memory'}>Keep one copy of identical pictures</span>
  </label>
  <div className="fs-toolgroups" role="group" aria-label="Memory actions">
   <div className="fs-toolgroup" data-group="Memories">
    <span className="fs-toolgroup-label" aria-hidden="true">Memories</span>
    <div className="fs-row" style={{gap:6,flexWrap:'wrap'}}>
     <Btn disabled={busy} onClick={()=>void run(async()=>{recallWritable();if(!navigator.clipboard?.read)throw Error('Clipboard image reading unavailable; use the file chooser.');const copied=await navigator.clipboard.read();for(const item of copied){const type=item.types.find(t=>/^image\/(png|jpeg|webp)$/.test(t));if(type){await save(await item.getType(type),'human-clipboard-image');return;}}throw Error('Clipboard contains no supported image; nothing saved.');})}>Save copied image</Btn>
     <Btn disabled={busy} onClick={()=>void run(()=>list())}>Refresh memory timeline</Btn>
     <Btn disabled={busy||!next||items.length>=400} onClick={()=>void run(()=>list(true))}>Load older memories</Btn>
     <Btn disabled={busy} onClick={()=>void run(loadTimeline)}>Show saving timeline</Btn>
    </div>
   </div>
   <div className="fs-toolgroup" data-group="Open memory">
    <span className="fs-toolgroup-label" aria-hidden="true">Open memory</span>
    <div className="fs-row" style={{gap:6,flexWrap:'wrap'}}>
     <Btn disabled={busy||!view} onClick={()=>void run(verify)}>Verify saved receipt</Btn>
     <Btn disabled={busy||!view||view.mime.startsWith('audio/')} onClick={()=>void run(frame)}>Save preview frame</Btn>
     <Btn disabled={busy||!view} onClick={()=>void run(copyMemory)}>Copy memory to clipboard</Btn>
     <Btn disabled={busy||!view||!view.mime.startsWith('image/')} onClick={()=>{try{openMemoryWith('photos');}catch(e){setNote(e instanceof Error?e.message:String(e));}}}>Open memory in Photos</Btn>
     <Btn disabled={busy||!view} onClick={()=>{try{openMemoryWith('files');}catch(e){setNote(e instanceof Error?e.message:String(e));}}}>Show memory in Files</Btn>
     <Btn disabled={busy||!view} onClick={()=>setConfirmTrash(true)}>Trash open memory pair</Btn>
     <Btn disabled={busy||!view} onClick={()=>{if(!view)return;const a=document.createElement('a');a.href=view.url;a.download=view.path.split('/').pop()||'memory';a.click();setNote('Local export requested from the open saved Blob; browser download policy may require confirmation.');}}>Export open memory</Btn>
     <Btn disabled={busy||!view} onClick={()=>{setConfirmTrash(false);epoch.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';setView(null);}}>Close memory preview</Btn>
    </div>
   </div>
   <div className="fs-toolgroup" data-group="Region">
    <span className="fs-toolgroup-label" aria-hidden="true">Region</span>
    <div className="fs-row" style={{gap:6,flexWrap:'wrap'}}>
     <Btn disabled={busy||!view||!drag||view.mime.startsWith('audio/')} onClick={()=>void run(saveRegion)}>Save selected region</Btn>
     <Btn disabled={busy||!drag} onClick={()=>setDrag(null)}>Clear region</Btn>
    </div>
   </div>
   <div className="fs-toolgroup" data-group="Undo">
    <span className="fs-toolgroup-label" aria-hidden="true">Undo</span>
    <div className="fs-row" style={{gap:6,flexWrap:'wrap'}}>
     <Btn disabled={busy||!undo} onClick={()=>void run(restore)}>Undo pair trash</Btn>
    </div>
   </div>
  </div>
  <div role="group" aria-label="Search saved memories" className="fs-row" style={{gap:8,flexWrap:'wrap',alignItems:'end'}}>
   <label style={{display:'grid'}}>Saved by<select aria-label="Filter by save method" value={method} onChange={e=>setMethod(e.target.value)}>
    <option value="">Any method</option><option value="human-selected-file">Chosen file</option><option value="human-paste-file">Pasted file</option>
    <option value="human-drop-file">Dropped file</option><option value="human-clipboard-image">Copied image</option>
    <option value="clicked-visual-png">Clicked visual</option><option value="saved-preview-frame">Preview frame</option>
    <option value="batch-loaded-visuals">Batch of loaded visuals</option><option value="cropped-preview-region">Selected region</option></select></label>
   <label style={{display:'grid'}}>Page host<input aria-label="Filter by page host" value={host} onChange={e=>setHost(e.target.value)} placeholder="example.com"/></label>
   <label style={{display:'grid'}}>From<input aria-label="Filter from date" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
   <label style={{display:'grid'}}>To<input aria-label="Filter to date" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
   <Btn disabled={busy} onClick={()=>void run(search)}>Search memories</Btn>
   <label style={{display:'grid'}}>Integrity scope<select aria-label="Integrity scope" value={auditScope} onChange={e=>setAuditScope(e.target.value)}>
    <option value="folder">This folder</option><option value="all">All Recall folders</option></select></label>
   <Btn disabled={busy} onClick={()=>void run(runAudit)}>Check pair integrity</Btn>
  </div>
  {timeline?<div aria-label="Saving timeline" style={{padding:8,border:'1px solid var(--fs-border)',borderRadius:8,display:'grid',gap:6}}>
   <p style={{margin:0}}>Saving timeline · {timeline.scope} · {timeline.zone} · {plural(timeline.totalMemories,'memory','memories')} across {plural(timeline.days.length,'day')}
    {timeline.undatedReceipts?` · ${plural(timeline.undatedReceipts,'receipt')} without a readable capture time`:''}
    {timeline.unreadableReceipts?` · ${plural(timeline.unreadableReceipts,'unreadable receipt')}`:''}.
    Only memories you chose to save appear here: Fusion takes no periodic background screenshots, so a missing day means nothing was saved that day.</p>
   {timeline.days.length?<ol aria-label="Saving days" style={{display:'flex',gap:6,flexWrap:'wrap',listStyle:'none',margin:0,padding:0,maxHeight:120,overflow:'auto'}}>
    {timeline.days.map(d=><li key={d.day}><Btn disabled={busy} onClick={()=>void run(()=>openDay(d.day))}>{d.day} · {plural(d.memories,'memory','memories')} · {fmtBytes(d.bytes)}</Btn></li>)}
   </ol>:<p style={{margin:0}}>No dated memories in this scope yet.</p>}
  </div>:null}
  {audit?<div aria-label="Pair integrity report" style={{padding:8,border:'1px solid var(--fs-border)',borderRadius:8}}>
   <p>Scope: {audit.scope} · {plural(audit.healthyPairs,'healthy pair')} · {audit.mediaFiles} media · {plural(audit.receiptFiles,'receipt')} · {plural(audit.orphanMedia.length,'media file','media files')} without receipt · {plural(audit.orphanReceipts.length,'receipt')} without media · {audit.unreadableReceipts.length} unreadable · {plural(audit.checksumMismatch.length,'checksum mismatch','checksum mismatches')}. Up to 50 samples per category; trashed files are out of scope.</p>
   {[...audit.orphanMedia,...audit.orphanReceipts].length?<ul aria-label="Unpaired Recall files">{[...audit.orphanMedia,...audit.orphanReceipts].map(o=>
    <li key={o}>{o} <Btn disabled={busy} onClick={()=>void run(()=>trashOrphan(o))}>Trash unpaired file</Btn></li>)}</ul>:null}
   {audit.checksumMismatch.length?<p role="alert">Checksum mismatch — the stored bytes no longer match their receipt. These are listed, never silently rewritten: {audit.checksumMismatch.join(', ')}</p>:null}
  </div>:null}
  {confirmTrash?<div role="group" aria-label="Confirm memory pair trash"><p>Move the open media and its verified receipt to Trash? Files remain server-readable and recoverable.</p><Btn disabled={busy} onClick={()=>void run(trash)}>Confirm trash pair</Btn><Btn disabled={busy} onClick={()=>setConfirmTrash(false)}>Cancel pair trash</Btn></div>:null}
  {note?<p role="status">{note}</p>:null}
  <ol aria-label="Memory timeline" style={{maxHeight:220,overflow:'auto'}}>{items.map(item=><li key={item.path}><Btn disabled={busy} onClick={()=>void run(()=>open(item.path))}>{item.name}</Btn></li>)}</ol>
  {view?<div aria-label="Saved memory preview"><p>{view.path}</p>
   <div style={{position:'relative',display:'inline-block',maxWidth:'100%'}}>
    {/* eslint-disable-next-line @next/next/no-img-element -- Native Blob preview must not use a remote image optimizer. */}
    {view.mime.startsWith('image/')?<img ref={el=>{previewMedia.current=el;}} onError={()=>setNote("Memory could not decode in this browser; saved bytes were not modified.")} src={view.url} alt="Saved memory" style={{maxWidth:'100%',maxHeight:320,display:'block'}}/>
     :view.mime.startsWith('video/')?<video ref={el=>{previewMedia.current=el;}} src={view.url} controls style={{maxWidth:'100%',maxHeight:320,display:'block'}}/>
     :<audio src={view.url} controls/>}
    {!view.mime.startsWith('audio/')?<div aria-label="Select a region of this memory" data-testid="region-surface" style={{position:'absolute',inset:0,cursor:'crosshair',touchAction:'none'}}
     onPointerDown={e=>{const b=e.currentTarget.getBoundingClientRect();dragging.current={x:e.clientX-b.left,y:e.clientY-b.top};setDrag({x:dragging.current.x,y:dragging.current.y,w:0,h:0});e.currentTarget.setPointerCapture(e.pointerId);}}
     onPointerMove={e=>{const o=dragging.current;if(!o)return;const b=e.currentTarget.getBoundingClientRect();setDrag({x:o.x,y:o.y,w:e.clientX-b.left-o.x,h:e.clientY-b.top-o.y});}}
     onPointerUp={e=>{dragging.current=null;try{e.currentTarget.releasePointerCapture(e.pointerId);}catch{/* pointer already released */}}}
     onPointerCancel={()=>{dragging.current=null;}}>
     {drag&&Math.abs(drag.w)>1&&Math.abs(drag.h)>1?<div style={{position:'absolute',left:Math.min(drag.x,drag.x+drag.w),top:Math.min(drag.y,drag.y+drag.h),width:Math.abs(drag.w),height:Math.abs(drag.h),border:'2px solid #4ea1ff',background:'rgba(78,161,255,0.18)',pointerEvents:'none'}}/>:null}
    </div>:null}
   </div>
   {drag&&Math.abs(drag.w)>1&&Math.abs(drag.h)>1?<p role="status" className="fs-dim" style={{margin:0}}>Region selected: {Math.round(Math.abs(drag.w))}×{Math.round(Math.abs(drag.h))} displayed pixels. “Save selected region” cuts it from the pixels already decoded for this preview and records which saved memory it came from. The original is never changed.</p>:<p>Drag across the preview to select a region, then save just that part.</p>}
  </div>:null}
 </section>;
}
