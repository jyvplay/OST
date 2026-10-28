"use client";
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { commitRecall, recallWritable, type RecallInput } from '@/lib/recall';
import { loadedPngDimensions, oneResidentFile } from '@/lib/recall-memory';
import { RECALL_LIMIT, recallFolder, recallMime } from '@/lib/recall-core';
import type { RecallGuard } from '@/lib/server/recall-lifecycle';
import { Btn } from '../ui';

/** Human-selected, already resident bytes. This module never fetches a media URL. */
export default function RecallMemory({ context }: { context: () => RecallInput }) {
 const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[items,setItems]=useState<{path:string;name:string;mime:string}[]>([]),[view,setView]=useState<{url:string;mime:string;path:string;mediaGuard:RecallGuard['media']}|null>(null);
 const [next,setNext]=useState<string|null>(null),[folder,setFolder]=useState('');
 const [confirmTrash,setConfirmTrash]=useState(false),[undo,setUndo]=useState<{path:string;guard:RecallGuard}|null>(null);
 const [method,setMethod]=useState(''),[host,setHost]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[auditScope,setAuditScope]=useState('folder');
 const [audit,setAudit]=useState<{scope:string;mediaFiles:number;receiptFiles:number;healthyPairs:number;orphanMedia:string[];orphanReceipts:string[];unreadableReceipts:string[];checksumMismatch:string[]}|null>(null);
 const previewMedia=useRef<HTMLImageElement|HTMLVideoElement|null>(null);
 const mounted=useRef(true),objectUrl=useRef(''),active=useRef(false),epoch=useRef(0);
 useEffect(()=>{const lifecycle=epoch;mounted.current=true;return()=>{mounted.current=false;lifecycle.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};},[]);
 const run=async(fn:()=>Promise<void>)=>{if(active.current)return;active.current=true;setBusy(true);setNote('');try{await fn();}catch(e){if(mounted.current)setNote(e instanceof Error?e.message:String(e));}finally{active.current=false;if(mounted.current)setBusy(false);}};
 const save=async(blob:Blob,method:string)=>{
  recallWritable();const input={...context()};recallFolder(input.page,input.title,input.grouping,input.custom);
  if(!blob.size||blob.size>RECALL_LIMIT)throw Error('Select nonempty media at most 8 MiB; no truncation.');
  const mime=recallMime(blob.type);const bytes=new Uint8Array(await blob.arrayBuffer());
  if(!mounted.current)throw Error('Recall closed before save');
  const path=await commitRecall(bytes,mime,input,method);if(mounted.current)setNote('Saved memory → '+path);
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
  setNote(`${r.nodes.length} memories match (at most 100 shown) from ${r.scanned} receipts${r.unreadableReceipts?`; ${r.unreadableReceipts} unreadable receipts were skipped`:''}. Receipt facts were recorded when you saved; they are integrity data, not authenticated provenance.`);
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
  const url=URL.createObjectURL(new Blob([bytes],{type:mime}));if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=url;setView({url,mime,path,mediaGuard:{id:r.node.id,version:r.node.version,sha256:r.node.sha256}});
 };
 return <section aria-label="Already-loaded memories" className="fs-panel" style={{padding:12,display:'grid',gap:8}}>
  <h3 style={{margin:0}}>Save what you already have</h3>
  <p>No background surveillance. Choose a browser-resident file or paste a copied image. These paths preserve the selected bytes without requesting the media URL again. Server memories are unencrypted in /Downloads/Recall; there is no automatic sensitive-information filter.</p>
  <div role="region" aria-label="Paste or drop resident media" tabIndex={0} style={{padding:12,border:'1px dashed var(--fs-border)',borderRadius:8}}
   onPaste={e=>{if(!e.clipboardData.files.length){setNote('No resident media file in this paste; text and links are never fetched.');return;}e.preventDefault();resident(e.clipboardData.files,'human-paste-file');}}
   onDragOver={e=>{if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=busy?'none':'copy';}}}
   onDrop={e=>{e.preventDefault();resident(e.dataTransfer.files,'human-drop-file');}}>
   Focus here and paste a copied media file, or drop exactly one file. Dragged webpage links are not downloads; if the browser exposes only a URL, use the already-loaded visual button instead.
  </div>
  <label>Choose media from your device <input aria-label="Choose resident media" disabled={busy} type="file" accept="image/*,video/*,audio/*" onChange={e=>{const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(file)void run(()=>save(file,'human-selected-file'));}}/></label>
  <div className="fs-row" style={{gap:8,flexWrap:'wrap'}}>
   <Btn disabled={busy} onClick={()=>void run(async()=>{recallWritable();if(!navigator.clipboard?.read)throw Error('Clipboard image reading unavailable; use the file chooser.');const copied=await navigator.clipboard.read();for(const item of copied){const type=item.types.find(t=>/^image\/(png|jpeg|webp)$/.test(t));if(type){await save(await item.getType(type),'human-clipboard-image');return;}}throw Error('Clipboard contains no supported image; nothing saved.');})}>Save copied image</Btn>
   <Btn disabled={busy} onClick={()=>void run(()=>list())}>Refresh memory timeline</Btn>
   <Btn disabled={busy||!next||items.length>=400} onClick={()=>void run(()=>list(true))}>Load older memories</Btn>
   <Btn disabled={busy||!view} onClick={()=>void run(verify)}>Verify saved receipt</Btn>
   <Btn disabled={busy||!view||view.mime.startsWith('audio/')} onClick={()=>void run(frame)}>Save preview frame</Btn>
   <Btn disabled={busy||!view} onClick={()=>setConfirmTrash(true)}>Trash open memory pair</Btn>
   <Btn disabled={busy||!undo} onClick={()=>void run(restore)}>Undo pair trash</Btn>
   <Btn disabled={busy||!view} onClick={()=>{if(!view)return;const a=document.createElement('a');a.href=view.url;a.download=view.path.split('/').pop()||'memory';a.click();setNote('Local export requested from the open saved Blob; browser download policy may require confirmation.');}}>Export open memory</Btn>
   <Btn disabled={busy||!view} onClick={()=>{setConfirmTrash(false);epoch.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';setView(null);}}>Close memory preview</Btn>
  </div>
  <div role="group" aria-label="Search saved memories" className="fs-row" style={{gap:8,flexWrap:'wrap',alignItems:'end'}}>
   <label style={{display:'grid'}}>Saved by<select aria-label="Filter by save method" value={method} onChange={e=>setMethod(e.target.value)}>
    <option value="">Any method</option><option value="human-selected-file">Chosen file</option><option value="human-paste-file">Pasted file</option>
    <option value="human-drop-file">Dropped file</option><option value="human-clipboard-image">Copied image</option>
    <option value="clicked-visual-png">Clicked visual</option><option value="saved-preview-frame">Preview frame</option></select></label>
   <label style={{display:'grid'}}>Page host<input aria-label="Filter by page host" value={host} onChange={e=>setHost(e.target.value)} placeholder="example.com"/></label>
   <label style={{display:'grid'}}>From<input aria-label="Filter from date" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
   <label style={{display:'grid'}}>To<input aria-label="Filter to date" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
   <Btn disabled={busy} onClick={()=>void run(search)}>Search memories</Btn>
   <label style={{display:'grid'}}>Integrity scope<select aria-label="Integrity scope" value={auditScope} onChange={e=>setAuditScope(e.target.value)}>
    <option value="folder">This folder</option><option value="all">All Recall folders</option></select></label>
   <Btn disabled={busy} onClick={()=>void run(runAudit)}>Check pair integrity</Btn>
  </div>
  {audit?<div aria-label="Pair integrity report" style={{padding:8,border:'1px solid var(--fs-border)',borderRadius:8}}>
   <p>Scope: {audit.scope} · {audit.healthyPairs} healthy pairs · {audit.mediaFiles} media · {audit.receiptFiles} receipts · {audit.orphanMedia.length} media without receipt · {audit.orphanReceipts.length} receipts without media · {audit.unreadableReceipts.length} unreadable · {audit.checksumMismatch.length} checksum mismatch. Up to 50 samples per category; trashed files are out of scope.</p>
   {[...audit.orphanMedia,...audit.orphanReceipts].length?<ul aria-label="Unpaired Recall files">{[...audit.orphanMedia,...audit.orphanReceipts].map(o=>
    <li key={o}>{o} <Btn disabled={busy} onClick={()=>void run(()=>trashOrphan(o))}>Trash unpaired file</Btn></li>)}</ul>:null}
   {audit.checksumMismatch.length?<p role="alert">Checksum mismatch — the stored bytes no longer match their receipt. These are listed, never silently rewritten: {audit.checksumMismatch.join(', ')}</p>:null}
  </div>:null}
  {confirmTrash?<div role="group" aria-label="Confirm memory pair trash"><p>Move the open media and its verified receipt to Trash? Files remain server-readable and recoverable.</p><Btn disabled={busy} onClick={()=>void run(trash)}>Confirm trash pair</Btn><Btn disabled={busy} onClick={()=>setConfirmTrash(false)}>Cancel pair trash</Btn></div>:null}
  {note?<p role="status">{note}</p>:null}
  <ol aria-label="Memory timeline" style={{maxHeight:220,overflow:'auto'}}>{items.map(item=><li key={item.path}><Btn disabled={busy} onClick={()=>void run(()=>open(item.path))}>{item.name}</Btn></li>)}</ol>
  {/* eslint-disable-next-line @next/next/no-img-element -- Native Blob preview must not use a remote image optimizer. */}
  {view?<div aria-label="Saved memory preview"><p>{view.path}</p>{view.mime.startsWith('image/')?<img ref={el=>{previewMedia.current=el;}} onError={()=>setNote("Memory could not decode in this browser; saved bytes were not modified.")} src={view.url} alt="Saved memory" style={{maxWidth:'100%',maxHeight:320}}/>:view.mime.startsWith('video/')?<video ref={el=>{previewMedia.current=el;}} src={view.url} controls style={{maxWidth:'100%',maxHeight:320}}/>:<audio src={view.url} controls/>}</div>:null}
 </section>;
}
