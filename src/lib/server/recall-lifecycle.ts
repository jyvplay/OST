/** Original guarded pair lifecycle. Soft trash only: no secure erasure or encryption claim. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {auditLog,fileOps,indexDocs,vfsNodes} from '@/db/schema';
import {safeTransaction} from './transaction';
import {lockVfsPurge} from './vfs-mutation-lock';
import {ConditionalWriteConflict} from './conditional-write';
import {normalize,parentOf,sha256,writableDirectories} from './vfs';
import {verifyRecallReceipt} from '../recall-memory';
import {recallMime,RECALL_LIMIT} from '../recall-core';
export interface RecallGuard {media:{id:number;version:number;sha256:string};receipt:{id:number;version:number;sha256:string}}
function parseGuard(value:unknown):RecallGuard {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Inspect the pair before changing it');
 const g=value as RecallGuard;
 for(const n of [g.media,g.receipt])if(!n||!Number.isSafeInteger(n.id)||n.id<=0||!Number.isSafeInteger(n.version)||n.version<=0||typeof n.sha256!=='string'||!/^[a-f0-9]{64}$/.test(n.sha256))throw Error('Invalid pair guard');
 return g;
}
export async function recallLifecycle(value:Record<string,unknown>){
 const {path,action}=value;
 if(typeof path!=='string'||path!==normalize(path)||!/^\/Downloads\/Recall\/[^/]+\/[^/]+$/.test(path)||path.length>512||/[\u0000-\u001f\u007f]/.test(path)||path.endsWith('.recall.json'))throw Error('One canonical Recall media path required');
 if(action!=='inspect'&&action!=='trash'&&action!=='restore')throw Error('Unknown pair action');
 const expected=action==='inspect'?null:parseGuard(value.expected),paths=[path,path+'.recall.json'];
 try{return await safeTransaction(async tx=>{
  if(action!=='inspect')await lockVfsPurge(tx);
  // One SELECT gives inspection one statement snapshot; mutation additionally locks both rows.
  const query=tx.select().from(vfsNodes).where(inArray(vfsNodes.path,paths));
  const nodes=action==='inspect'?await query:await query.for('update');
  const media=nodes.find(n=>n.path===path),receipt=nodes.find(n=>n.path===paths[1]);
  if(!media||!receipt||media.kind!=='file'||receipt.kind!=='file')throw new ConditionalWriteConflict('Complete media/receipt pair not found; nothing changed');
  if(media.trashed!==receipt.trashed)throw new ConditionalWriteConflict('Pair has mixed trash state; use Files to inspect it');
  if(media.encoding!=='base64'||receipt.encoding!=='utf8'||media.content.length>Math.ceil(RECALL_LIMIT/3)*4||sha256(media.content)!==media.sha256||sha256(receipt.content)!==receipt.sha256)throw new ConditionalWriteConflict('Pair content/encoding changed or is unsupported');
  const bytes=Buffer.from(media.content,'base64');
  if(bytes.toString('base64')!==media.content)throw Error('Invalid stored base64');
  let verified;try{verified=await verifyRecallReceipt(new Uint8Array(bytes),recallMime(media.mime),path,receipt.content);}catch{throw new ConditionalWriteConflict('Memory checksum mismatch or invalid receipt; inspect Files');}
  const guard=()=>({media:{id:media.id,version:media.version,sha256:media.sha256},receipt:{id:receipt.id,version:receipt.version,sha256:receipt.sha256}});
  if(action==='inspect')return {ok:true,path,state:media.trashed?'trashed':'active',guard:guard(),verified};
  for(const [node,want] of [[media,expected!.media],[receipt,expected!.receipt]] as const)if(node.id!==want.id||node.version!==want.version||node.sha256!==want.sha256)throw new ConditionalWriteConflict('Pair changed since inspection; inspect again');
  if(action==='trash'&&media.trashed)throw new ConditionalWriteConflict('Pair is already in Trash');
  if(action==='restore'&&(!media.trashed||media.trashedFrom!==path||receipt.trashedFrom!==path))throw new ConditionalWriteConflict('Pair was not trashed together by this action');
  if(action==='restore')await writableDirectories(tx,parentOf(path),false);
  const trashed=action==='trash';
  await tx.update(vfsNodes).set({trashed,trashedFrom:trashed?path:null,version:sql`${vfsNodes.version}+1`,updatedAt:new Date()}).where(inArray(vfsNodes.path,paths));
  if(trashed)await tx.delete(indexDocs).where(and(eq(indexDocs.source,'file'),inArray(indexDocs.ref,paths)));
  else for(const node of nodes)await tx.insert(indexDocs).values({source:'file',ref:node.path,title:node.name,body:node.encoding==='utf8'?node.content.slice(0,50000):'',updatedAt:new Date()}).onConflictDoUpdate({target:[indexDocs.source,indexDocs.ref],set:{title:node.name,body:node.encoding==='utf8'?node.content.slice(0,50000):'',updatedAt:new Date()}});
  for(const node of nodes)await tx.insert(fileOps).values({op:action,src:node.path,state:'COMPLETE',bytes:node.size});
  await tx.insert(auditLog).values({actor:'user',action:'fs.recall-'+action,detail:path});
  media.version++;receipt.version++;
  return {ok:true,path,state:trashed?'trashed':'active',guard:guard(),verified};
 });}catch(error){if(error instanceof ConditionalWriteConflict)throw error;throw Error('Pair action was not acknowledged. Inspect Files before retrying.');}
}
