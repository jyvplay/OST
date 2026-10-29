/** Original atomic publication of Recall bytes and receipt; plaintext, not an encrypted archive. */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { safeTransaction } from './transaction';
import { conditionalWriteInTransaction, ConditionalWriteConflict } from './conditional-write';
import { recallMime, recallSource, RECALL_LIMIT } from '../recall-core';
import { verifyRecallReceipt, validDerivedFrom } from '../recall-memory';
import { normalize } from './vfs';
import { settings } from '@/db/schema';

/** A derived memory named a parent that is not saved, or that has changed since. */
export class RecallProvenanceError extends Error {}

/** TT108: methods whose name is a provenance claim must actually carry that provenance. */
const DERIVED_METHODS = new Set(['cropped-preview-region']);

/** The one method that asks the network for the bytes again; everything else saves what was already loaded. */
const REFETCH_METHOD = 'original-response';

/**
 * TT111 (RC-37): bytes this server itself delivered to the page earlier in the session and kept in
 * memory. Their provenance is neither of the other two: no request was made to publish them (so the
 * claim is not 'requested-url'), but they are also not a label a human typed over a re-encode — this
 * process read them off the wire and never decoded them. 'proxy-recorded-response' says exactly that,
 * and the binding below keeps each method pinned to the one claim it can support.
 */
const RETAINED_METHOD = 'session-retained-response';

/**
 * TT110 (RC-36): the methods that record a shared surface rather than something the page had
 * already handed to this app. A deployment can switch these off, and the switch is enforced here —
 * inside the publication transaction — so hiding the buttons is not what makes it true.
 */
const CAPTURE_METHODS = new Set(['authorized-display-frame', 'authorized-display-recording', 'fusion-element-frame']);
export const CAPTURE_POLICY_KEY = 'privacy.screenCapture';
export const CAPTURE_REFUSED = 'Screen and element capture is switched off for this installation (Settings → Privacy → Screen and element capture)';

/**
 * A refusal the operator configured, not a failure. It must not be reported as an uncertain
 * publication: nothing was written, there is no pair to inspect, and retrying will refuse again.
 */
export class RecallPolicyRefusal extends Error {}

/**
 * TT109 (RC-34): an archive of what you already saw should know when you have saved a thing before.
 * `onDuplicate:'skip'` asks for the existing memory instead of a second copy; the default still writes,
 * because a deliberate re-save (and the legacy refetch path, which exists to prove bytes are reachable
 * again) must keep its old meaning. The comparison is on DECODED bytes — the same domain the receipt
 * digests — and it runs inside the publishing transaction, so two concurrent saves of identical bytes
 * cannot both pass the check. Scope is the memory's own folder: the same picture filed under two
 * groupings is two deliberate memories, not an accident.
 */
export type RecallDuplicatePolicy = 'store' | 'skip';

export async function atomicRecallCommit(value:Record<string,unknown>) {
 const {path,content,mime,receipt}=value;
 const onDuplicate=value.onDuplicate===undefined?'store':value.onDuplicate;
 if(onDuplicate!=='store'&&onDuplicate!=='skip')throw Error('onDuplicate must be "store" or "skip"');
 if(typeof path!=='string'||path!==normalize(path)||!/^\/Downloads\/Recall\/[^/]+\/[^/]+$/.test(path)||path.length>512||/[\u0000-\u001f\u007f]/.test(path)||path.endsWith('.recall.json'))throw Error('One canonical Recall media path is required');
 if(typeof content!=='string'||!content.length||content.length>Math.ceil(RECALL_LIMIT/3)*4||typeof mime!=='string'||recallMime(mime)!==mime||typeof receipt!=='string'||receipt.length>16384)throw Error('Invalid Recall content, MIME or receipt');
 const bytes=Buffer.from(content,'base64');
 if(bytes.toString('base64')!==content)throw Error('Canonical base64 required');
 const digest=createHash('sha256').update(bytes).digest('hex');
 await verifyRecallReceipt(new Uint8Array(bytes),mime,path,receipt);
 const r=JSON.parse(receipt) as Record<string,unknown>;
 if(typeof r.method!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(r.method)||r.queryRedacted!==true||typeof r.source!=='string'||typeof r.page!=='string'||recallSource(r.source)!==r.source||recallSource(r.page)!==r.page)throw Error('Receipt needs bounded method and query-redacted HTTP(S) labels');
 // TT109 (RC-14): only the refetch path may claim the bytes came from the URL it names. Every other
 // method saves what the browser had already decoded, and its source line is a label the human
 // declared — not evidence of what the server at that URL would serve. Without this binding a
 // re-encoded screenshot could be filed as if it were the publisher's original response.
 // A receipt that makes no attribution claim is read the conservative way ("a label the human declared"),
 // which is why an omitted field cannot launder a refetch either.
 const claimed=r.sourceAttribution===undefined?'user-declared-label':r.sourceAttribution;
 const honest=r.method===REFETCH_METHOD?'requested-url':r.method===RETAINED_METHOD?'proxy-recorded-response':'user-declared-label';
 if(claimed!==honest)throw Error(`Receipt attribution must be "${honest}" for method ${r.method}`);
 // TT108 (RC-33): a crop claims to come from a specific saved memory. The claim is
 // checked for shape here and against the stored parent inside the transaction, so a
 // receipt can never record a derivation from something this archive does not hold.
 const derived=r.derivedFrom===undefined?null:validDerivedFrom(r.derivedFrom,path);
 if(DERIVED_METHODS.has(r.method)&&!derived)throw Error(`Method ${r.method} must record the memory it was derived from`);
 if(derived&&!DERIVED_METHODS.has(r.method))throw Error('Only a derived-region save may record derivedFrom');
 try{return await safeTransaction(async tx=>{
  if(CAPTURE_METHODS.has(r.method as string)){
   // Read the policy in the same transaction that would do the writing: a switch flipped a
   // microsecond before this commit is honoured, and a client cannot talk past it.
   const policy=await tx.select({value:settings.value}).from(settings).where(eq(settings.key,CAPTURE_POLICY_KEY)).limit(1);
   if(policy[0]?.value==='off')throw new RecallPolicyRefusal(CAPTURE_REFUSED);
  }
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
  if(onDuplicate==='skip'){
   // One indexed scan of this folder only. The CASE guard keeps decode() away from any row whose text is
   // not canonical base64 (PostgreSQL may reorder a plain AND, so the guard has to be a CASE — see
   // postgresql.org/docs/18 §4.2.14); such a row simply yields NULL and never equals the digest.
   const folder=path.slice(0,path.lastIndexOf('/'));
   const dup=(await tx.execute(sql`
     SELECT path, created_at
       FROM vfs_nodes
      WHERE parent = ${folder} AND kind = 'file' AND trashed = false AND encoding = 'base64'
        AND path NOT LIKE '%.recall.json'
        AND CASE WHEN content ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'
                 THEN encode(sha256(decode(content, 'base64')), 'hex') END = ${digest}
      ORDER BY created_at, path
      LIMIT 1`)).rows[0] as {path:string;created_at:Date|string}|undefined;
   if(dup)return {ok:true,path:dup.path,atomic:true,stored:false,duplicateOf:dup.path,
     firstSavedAt:(dup.created_at instanceof Date?dup.created_at:new Date(dup.created_at)).toISOString(),digest};
  }
  await conditionalWriteInTransaction(tx,path,content,null,'base64',mime);
  await conditionalWriteInTransaction(tx,path+'.recall.json',receipt,null,'utf8','application/json');
  return {ok:true,path,atomic:true,stored:true,digest,...(derived?{derivedFrom:derived.path}:{})};
 });}catch(error){
  if(error instanceof ConditionalWriteConflict||error instanceof RecallProvenanceError||error instanceof RecallPolicyRefusal)throw error;
  // Do not reflect driver SQL/parameters, which can contain all saved bytes and labels.
  throw Error('Recall publication was not acknowledged. Inspect the saved pair before retrying.');
 }
}
