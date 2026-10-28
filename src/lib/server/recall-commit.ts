/** Original atomic publication of Recall bytes and receipt; plaintext, not an encrypted archive. */
import { sql } from 'drizzle-orm';
import { safeTransaction } from './transaction';
import { conditionalWriteInTransaction, ConditionalWriteConflict } from './conditional-write';
import { recallMime, recallSource, RECALL_LIMIT } from '../recall-core';
import { verifyRecallReceipt, validDerivedFrom } from '../recall-memory';
import { normalize } from './vfs';

/** A derived memory named a parent that is not saved, or that has changed since. */
export class RecallProvenanceError extends Error {}

/** TT108: methods whose name is a provenance claim must actually carry that provenance. */
const DERIVED_METHODS = new Set(['cropped-preview-region']);

export async function atomicRecallCommit(value:Record<string,unknown>) {
 const {path,content,mime,receipt}=value;
 if(typeof path!=='string'||path!==normalize(path)||!/^\/Downloads\/Recall\/[^/]+\/[^/]+$/.test(path)||path.length>512||/[\u0000-\u001f\u007f]/.test(path)||path.endsWith('.recall.json'))throw Error('One canonical Recall media path is required');
 if(typeof content!=='string'||!content.length||content.length>Math.ceil(RECALL_LIMIT/3)*4||typeof mime!=='string'||recallMime(mime)!==mime||typeof receipt!=='string'||receipt.length>16384)throw Error('Invalid Recall content, MIME or receipt');
 const bytes=Buffer.from(content,'base64');
 if(bytes.toString('base64')!==content)throw Error('Canonical base64 required');
 await verifyRecallReceipt(new Uint8Array(bytes),mime,path,receipt);
 const r=JSON.parse(receipt) as Record<string,unknown>;
 if(typeof r.method!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(r.method)||r.queryRedacted!==true||typeof r.source!=='string'||typeof r.page!=='string'||recallSource(r.source)!==r.source||recallSource(r.page)!==r.page)throw Error('Receipt needs bounded method and query-redacted HTTP(S) labels');
 // TT108 (RC-33): a crop claims to come from a specific saved memory. The claim is
 // checked for shape here and against the stored parent inside the transaction, so a
 // receipt can never record a derivation from something this archive does not hold.
 const derived=r.derivedFrom===undefined?null:validDerivedFrom(r.derivedFrom,path);
 if(DERIVED_METHODS.has(r.method)&&!derived)throw Error(`Method ${r.method} must record the memory it was derived from`);
 if(derived&&!DERIVED_METHODS.has(r.method))throw Error('Only a derived-region save may record derivedFrom');
 try{return await safeTransaction(async tx=>{
  if(derived){
   // vfs_nodes.sha256 digests the stored *text*; a receipt digests the decoded bytes.
   // Provenance is compared in the receipt's own terms, so the two can be cross-checked
   // later by the integrity audit. decode() raises on malformed input, so the base64
   // shape is tested first and an unverifiable parent is refused rather than crashing.
   const parent=(await tx.execute(sql`
     SELECT CASE WHEN encoding = 'base64'
                  AND content ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
                 THEN encode(sha256(decode(content, 'base64')), 'hex') END AS media_sha
       FROM vfs_nodes
      WHERE path = ${derived.path} AND kind = 'file' AND trashed = false
      LIMIT 1`)).rows[0] as {media_sha:string|null}|undefined;
   if(!parent)throw new RecallProvenanceError('The memory this region came from is no longer saved here, so the crop was not published.');
   if(parent.media_sha===null)throw new RecallProvenanceError('The memory this region came from cannot be checksummed, so its crop was not published.');
   if(parent.media_sha!==derived.sha256)throw new RecallProvenanceError('The memory this region came from has changed since you selected it; reopen it and select again.');
  }
  await conditionalWriteInTransaction(tx,path,content,null,'base64',mime);
  await conditionalWriteInTransaction(tx,path+'.recall.json',receipt,null,'utf8','application/json');
  return {ok:true,path,atomic:true,...(derived?{derivedFrom:derived.path}:{})};
 });}catch(error){
  if(error instanceof ConditionalWriteConflict||error instanceof RecallProvenanceError)throw error;
  // Do not reflect driver SQL/parameters, which can contain all saved bytes and labels.
  throw Error('Recall publication was not acknowledged. Inspect the saved pair before retrying.');
 }
}
