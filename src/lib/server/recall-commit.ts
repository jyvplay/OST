/** Original atomic publication of Recall bytes and receipt; plaintext, not an encrypted archive. */
import { safeTransaction } from './transaction';
import { conditionalWriteInTransaction, ConditionalWriteConflict } from './conditional-write';
import { recallMime, recallSource, RECALL_LIMIT } from '../recall-core';
import { verifyRecallReceipt } from '../recall-memory';
import { normalize } from './vfs';

export async function atomicRecallCommit(value:Record<string,unknown>) {
 const {path,content,mime,receipt}=value;
 if(typeof path!=='string'||path!==normalize(path)||!/^\/Downloads\/Recall\/[^/]+\/[^/]+$/.test(path)||path.length>512||/[\u0000-\u001f\u007f]/.test(path)||path.endsWith('.recall.json'))throw Error('One canonical Recall media path is required');
 if(typeof content!=='string'||!content.length||content.length>Math.ceil(RECALL_LIMIT/3)*4||typeof mime!=='string'||recallMime(mime)!==mime||typeof receipt!=='string'||receipt.length>16384)throw Error('Invalid Recall content, MIME or receipt');
 const bytes=Buffer.from(content,'base64');
 if(bytes.toString('base64')!==content)throw Error('Canonical base64 required');
 await verifyRecallReceipt(new Uint8Array(bytes),mime,path,receipt);
 const r=JSON.parse(receipt) as Record<string,unknown>;
 if(typeof r.method!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(r.method)||r.queryRedacted!==true||typeof r.source!=='string'||typeof r.page!=='string'||recallSource(r.source)!==r.source||recallSource(r.page)!==r.page)throw Error('Receipt needs bounded method and query-redacted HTTP(S) labels');
 try{return await safeTransaction(async tx=>{
  await conditionalWriteInTransaction(tx,path,content,null,'base64',mime);
  await conditionalWriteInTransaction(tx,path+'.recall.json',receipt,null,'utf8','application/json');
  return {ok:true,path,atomic:true};
 });}catch(error){
  if(error instanceof ConditionalWriteConflict)throw error;
  // Do not reflect driver SQL/parameters, which can contain all saved bytes and labels.
  throw Error('Recall publication was not acknowledged. Inspect the saved pair before retrying.');
 }
}
