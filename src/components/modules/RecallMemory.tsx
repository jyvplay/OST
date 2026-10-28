"use client";
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { commitRecall, recallWritable, type RecallInput } from '@/lib/recall';
import { loadedPngDimensions, oneResidentFile, verifyRecallReceipt } from '@/lib/recall-memory';
import { RECALL_LIMIT, recallFolder, recallMime } from '@/lib/recall-core';
import { Btn } from '../ui';

/** Human-selected, already resident bytes. This module never fetches a media URL. */
export default function RecallMemory({ context }: { context: () => RecallInput }) {
 const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[items,setItems]=useState<{path:string;name:string;mime:string}[]>([]),[view,setView]=useState<{url:string;mime:string;path:string}|null>(null);
 const [next,setNext]=useState<string|null>(null),[folder,setFolder]=useState('');
 const mounted=useRef(true),objectUrl=useRef(''),active=useRef(false),epoch=useRef(0);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};},[]);
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
 const verify=async()=>{
  recallWritable();if(!view)throw Error('Open a saved memory first');
  const [media,receipt]=await Promise.all([
   api<{node:{content:string;encoding:string;mime:string}}>('/api/fs?'+new URLSearchParams({op:'read',path:view.path})),
   api<{node:{content:string;encoding:string}}>('/api/fs?'+new URLSearchParams({op:'read',path:view.path+'.recall.json'}))]);
  if(media.node.encoding!=='base64'||media.node.content.length>Math.ceil(RECALL_LIMIT/3)*4||receipt.node.encoding!=='utf8')throw Error('Unsupported memory or receipt encoding');
  const raw=atob(media.node.content),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(!bytes.length||bytes.length>RECALL_LIMIT)throw Error('Invalid memory size');
  const result=await verifyRecallReceipt(bytes,media.node.mime,view.path,receipt.node.content);
  if(mounted.current)setNote('Receipt matches stored bytes: '+result.method+' · '+result.capturedAt+'. Integrity only, not authenticated provenance or verification of the open preview.');
 };
 const open=async(path:string)=>{
  recallWritable();const version=++epoch.current;
  const r=await api<{node:{content:string;encoding:string;mime:string}}>('/api/fs?'+new URLSearchParams({op:'read',path}));
  if(!mounted.current||version!==epoch.current)return;
  if(r.node.encoding!=='base64'||r.node.content.length>Math.ceil(RECALL_LIMIT/3)*4)throw Error('Unsupported or oversized memory');
  const mime=recallMime(r.node.mime);const raw=atob(r.node.content),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(!bytes.length||bytes.length>RECALL_LIMIT)throw Error('Invalid memory size');
  // Never render SVG/HTML as an active document. Blob media previews have no HTML privileges.
  if(mime==='image/png')loadedPngDimensions(bytes);
  if(mime==='image/svg+xml')throw Error('Active SVG preview is not supported');
  const url=URL.createObjectURL(new Blob([bytes],{type:mime}));if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=url;setView({url,mime,path});
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
   <Btn disabled={busy||!view} onClick={()=>{if(!view)return;const a=document.createElement('a');a.href=view.url;a.download=view.path.split('/').pop()||'memory';a.click();setNote('Local export requested from the open saved Blob; browser download policy may require confirmation.');}}>Export open memory</Btn>
   <Btn disabled={busy||!view} onClick={()=>{epoch.current++;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';setView(null);}}>Close memory preview</Btn>
  </div>
  {note?<p role="status">{note}</p>:null}
  <ol aria-label="Memory timeline" style={{maxHeight:220,overflow:'auto'}}>{items.map(item=><li key={item.path}><Btn disabled={busy} onClick={()=>void run(()=>open(item.path))}>{item.name}</Btn></li>)}</ol>
  {view?<div aria-label="Saved memory preview"><p>{view.path}</p>{view.mime.startsWith('image/')?<img onError={()=>setNote("Memory could not decode in this browser; saved bytes were not modified.")} src={view.url} alt="Saved memory" style={{maxWidth:'100%',maxHeight:320}}/>:view.mime.startsWith('video/')?<video src={view.url} controls style={{maxWidth:'100%',maxHeight:320}}/>:<audio src={view.url} controls/>}</div>:null}
 </section>;
}
