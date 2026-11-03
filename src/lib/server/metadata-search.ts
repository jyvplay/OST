import {sql} from 'drizzle-orm';
import {db} from '@/db';
import {META_LIMITS,metadataOptions,metadataPage,type MetaNode} from '@/lib/search/metadata';
import {escapeLike,normalize} from './vfs';
import {resourceOptions} from '@/lib/search-resources';
import {nodeResourceFilter} from './search-resources';
import {searchOptions,validSearchText} from '@/lib/search-query';
export async function searchExclusions(source:Pick<typeof db,'execute'>=db){
 const result=await source.execute(sql`select value from settings where key='search.excludes'`);
 return String(result.rows[0]?.value??'/System/Cache').split(/[,;\n]/).map(p=>p.trim()).filter(Boolean).map(normalize);
}
export function visiblePath(alias:ReturnType<typeof sql.raw>,excludes:string[]){
 const restrictions=[sql`${alias} <> '/Private' and ${alias} not like '/Private/%'`];
 for(const p of excludes)restrictions.push(p==='/'?sql`false`:sql`${alias} <> ${p} and ${alias} not like ${escapeLike(p)+'/'} || '%'`);
 return sql.join(restrictions,sql` and `);
}
/** Validate outside the storage boundary: malformed requests are 400; a real
 * PostgreSQL failure is not a user-input error. */
export function metadataSearchRequest(p:URLSearchParams){
 const options=metadataOptions(p),{scope,extension}=searchOptions(p);
 if(!validSearchText(options.field)||!validSearchText(options.cursor))throw new Error('Metadata field and cursor require valid Unicode');
 return {options,scope,extension,resources:resourceOptions(p)};
}
export async function metadataSearch({options,scope,extension,resources}:ReturnType<typeof metadataSearchRequest>){
 const started=Date.now();
 const exclusions=await searchExclusions();
 const rows=await db.execute(sql`select jsonb_build_object('id',n.id,'path',n.path,'parent',n.parent,'name',n.name,'kind',n.kind,'mime',n.mime,'encoding',n.encoding,'size',n.size,'sha256',n.sha256,'tags',n.tags,'trashed',n.trashed,'trashed_from',n.trashed_from,'version',n.version,'created_at',n.created_at,'updated_at',n.updated_at) as record,
 case when length(content)<=${META_LIMITS.contentChars} then content else '' end as content,
 length(content)>${META_LIMITS.contentChars} as skipped
 from vfs_nodes n where not trashed and kind='file' and mime <> 'application/x-fusion-encrypted'
 and ${visiblePath(sql.raw('n.path'),exclusions)}
 and (${scope}='' or ${scope}='/' or path=${scope} or path like ${escapeLike(scope)+'/'} || '%')
 and ${nodeResourceFilter(resources)}
 and (${extension}='' or lower(path) like ${'%'+escapeLike(extension)})
 and path collate "C" > ${options.cursor} collate "C" order by path collate "C" limit ${META_LIMITS.files+1}`);
 const nodes=rows.rows.slice(0,META_LIMITS.files).map(r=>({...r.record as object,content:r.content,contentSkipped:r.skipped})) as MetaNode[];
 const page=await metadataPage(nodes,options);
 return {ok:true,...page,tookMs:Date.now()-started,local:true,mode:'metadata',hasMore:rows.rows.length>META_LIMITS.files,nextCursor:rows.rows.length>META_LIMITS.files?nodes.at(-1)?.path:null,exclusions,storage:'host plaintext files only; use /Private scope for in-tab search',coverageNotice:'A live bounded page, not a complete index. Continue pages; skipped or unsupported content is not certified searched.'};
}
