"use client";
import { useState } from 'react';
import { Btn, Badge } from './ui';
export interface StackedToast {id:number;message:string;tone:'info'|'ok'|'warn'|'bad';action?:{label:string;run:()=>void}}
/** Bounded corner stack; older actionable notifications stay reachable through an explicit expansion. */
export default function ToastStack({toasts,invoke}:{toasts:StackedToast[];invoke:(toast:StackedToast)=>Promise<void>}){
 const [expanded,setExpanded]=useState(false),[busy,setBusy]=useState<number|null>(null);
 if(!toasts.length)return null;
 const newest=[...toasts].reverse(),shown=expanded?newest:[newest[0]];
 return <aside data-testid="toasts" className="fs-toast-stack" aria-label="Action notifications">
  {!expanded?Array.from({length:Math.min(3,toasts.length-1)},(_,i)=><div key={i} aria-hidden="true" className="fs-panel fs-toast-back" style={{bottom:(i+1)*7,transform:`scale(${1-(i+1)*.035})`,opacity:.35-i*.07}}/>):null}
  <div className="fs-toast-deck">
   {toasts.length>1?<button className="fs-btn" data-variant="ghost" onClick={()=>setExpanded(x=>!x)} aria-expanded={expanded}>{expanded?'Collapse notifications':`${toasts.length-1} earlier notification${toasts.length>2?'s':''}`}</button>:null}
   <div className="fs-toast-list" role="log" aria-live="polite" aria-relevant="additions text">
    {shown.map(t=><div key={t.id} className="fs-panel fs-toast-card">
     <Badge tone={t.tone}>{t.tone}</Badge><span>{t.message}</span>
     {t.action?<Btn disabled={busy===t.id} onClick={()=>{if(busy!==null)return;setBusy(t.id);void invoke(t).finally(()=>setBusy(null));}}>{t.action.label}</Btn>:null}
    </div>)}
   </div>
  </div>
 </aside>;
}
