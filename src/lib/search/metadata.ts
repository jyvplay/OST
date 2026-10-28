/** TT101 original bounded value search. No speech recognition, remote extraction or decompression. */
import { delimitedMetadata } from './delimited';
import { readAudio } from '../meta/audio';
import { readImage } from '../meta/image';
import { readExif } from '../meta/exif';
import { readXmp } from '../meta/xmp';
import { isTextual } from '../mime';
export const META_LIMITS={files:32,contentChars:262144,fields:4096,depth:24,query:512,tokens:32};
export interface MetaNode {path:string;name:string;mime:string;encoding:string;content:string;contentSkipped?:boolean;[key:string]:unknown}
export interface MetaHit {source:'file';ref:string;title:string;snippet:string;rank:number;how:'metadata';matchedFields:{field:string;value:string}[]}
export interface MetaOptions {q:string;field:string;cursor:string}
export function metadataOptions(p:URLSearchParams):MetaOptions {
 if(p.get('source')&&p.get('source')!=='file')throw new Error('Live metadata mode supports file sources only');
 const q=(p.get('q')??'').trim(),field=(p.get('field')??'').trim(),cursor=p.get('cursor')??'';
 if(!q||q.length>META_LIMITS.query||q.split(/\s+/).length>META_LIMITS.tokens)throw new Error('Metadata query requires 1–512 characters and at most 32 terms');
 if(field.length>256||cursor.length>4096||/[\u0000-\u001f]/.test(field+cursor))throw new Error('Invalid metadata field or cursor');
 return {q,field,cursor};
}
const fold=(s:string)=>s.normalize('NFKC').toLowerCase();
export async function metadataValues(node:MetaNode){
 const fields:{field:string;value:string}[]=[],warnings:string[]=[];let truncated=false;
 const walk=(value:unknown,key:string,depth=0)=>{
  if(fields.length>=META_LIMITS.fields||depth>META_LIMITS.depth){truncated=true;return;}
  if(value===undefined)return;
  if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean'){fields.push({field:key,value:String(value)});return;}
  if(value instanceof Uint8Array)return; // cover bytes aren't textual metadata
  if(Array.isArray(value)){for(let i=0;i<value.length;i++){if(fields.length>=META_LIMITS.fields){truncated=true;break;}walk(value[i],`${key}[${i}]`,depth+1);}return;}
  if(typeof value==='object')for(const [k,v]of Object.entries(value)){if(fields.length>=META_LIMITS.fields){truncated=true;break;}walk(v,key?`${key}.${k}`:k,depth+1);}
 };
 const {content,contentSkipped,...record}=node;walk(record,'node');
 if(contentSkipped||content.length>META_LIMITS.contentChars){warnings.push('content budget exceeded; node fields only');return {fields,warnings,truncated:true};}
 let bytes:Uint8Array;
 try{bytes=node.encoding==='base64'?Uint8Array.from(atob(content),c=>c.charCodeAt(0)):new TextEncoder().encode(content);}catch{warnings.push('invalid content encoding');return{fields,warnings,truncated:true};}
 if(isTextual(node.mime)||/json/i.test(node.mime)||/\.(vtt|srt|lrc|json|jsonl|ndjson|csv|tsv|txt)$/i.test(node.name)){
  const text=node.encoding==='utf8'?content:new TextDecoder().decode(bytes);walk(text,'text');
  if(/\.(jsonl|ndjson)$/i.test(node.name)||/ndjson|jsonl/i.test(node.mime)){
   let bad=0;const lines=text.split(/\r?\n/);
   for(let i=0;i<lines.length;i++){if(fields.length>=META_LIMITS.fields){truncated=true;break;}if(!lines[i].trim())continue;try{walk(JSON.parse(lines[i]),`content.lines[${i}]`);}catch{bad++;}}
   if(bad){warnings.push(`${bad} invalid JSONL line(s); raw text remains searchable`);truncated=true;}
  }else if(/\.(csv|tsv)$/i.test(node.name)||/text\/(csv|tab-separated-values)/i.test(node.mime)){
   try{const parsed=delimitedMetadata(text,/\.tsv$/i.test(node.name)||/tab-separated-values/i.test(node.mime)?'\t':',');walk(parsed.rows,'content');truncated ||=parsed.truncated;}catch{warnings.push('invalid delimited text; raw text remains searchable');truncated=true;}
  }else if(/json/i.test(node.mime)||/\.json$/i.test(node.name)){try{walk(JSON.parse(text),'content');}catch{warnings.push('invalid JSON; raw text remains searchable');}}
 }else{
  const noInflate=async()=>{throw new Error('compressed metadata is outside the query-time budget');};
  try{
   const audio=await readAudio(bytes,node.name,noInflate);
   if(audio){const {pictures,...data}=audio;walk(data,'embedded');walk(pictures.map(p=>({mime:p.mime,description:p.description,type:p.type})),'embedded.pictures');warnings.push(...audio.warnings);}
   else{const image=await readImage(bytes,node.name,noInflate);if(image){const {exif,xmp,...data}=image;walk(data,'embedded');if(exif)walk(readExif(exif),'embedded.exif');if(xmp)walk(readXmp(xmp),'embedded.xmp');warnings.push(...image.warnings);}else warnings.push('no supported header metadata reader; node fields only');}
  }catch{warnings.push('metadata parser refused content');}
 }
 return {fields,warnings,truncated};
}
export async function metadataPage(nodes:MetaNode[],options:MetaOptions){
 const terms=fold(options.q).split(/\s+/);
 const hits:MetaHit[]=[],warnings:{ref:string;reasons:string[]}[]=[];let truncatedFiles=0;
 for(const node of nodes.slice(0,META_LIMITS.files)){
  const data=await metadataValues(node);if(data.truncated)truncatedFiles++;
  if(data.warnings.length)warnings.push({ref:node.path,reasons:data.warnings.slice(0,8)});
  const eligible=data.fields.filter(x=>!options.field||x.field===options.field||x.field.startsWith(options.field+'.')||x.field.startsWith(options.field+'[')||x.field.includes('.'+options.field+'.')||x.field.includes('.'+options.field+'[')||x.field.endsWith('.'+options.field));
  const normalized=eligible.map(x=>({...x,normalized:fold(x.value)})),matched=normalized.filter(x=>terms.some(t=>x.normalized.includes(t)));
  if(!terms.every(t=>matched.some(x=>x.normalized.includes(t))))continue;
  const first=matched[0],value=first.value,at=fold(value).indexOf(terms[0]);
  hits.push({source:'file',ref:node.path,title:node.name,snippet:`${first.field}: ${value.slice(Math.max(0,at-60),Math.max(0,at-60)+180)}`,rank:1,how:'metadata',matchedFields:matched.slice(0,16).map(x=>({field:x.field,value:x.value.slice(0,240)}))});
 }
 return {hits,scanned:Math.min(nodes.length,META_LIMITS.files),truncatedFiles,warnings,limits:META_LIMITS,semantics:'NFKC + lowercase literal terms; AND across scalar values; field is an exact path or leaf-name suffix. No inferred lyrics/transcripts.'};
}
