/** Untrusted producer PNG admission; validate dimensions before asking a native decoder to allocate. */
export function loadedPngDimensions(bytes:Uint8Array):{width:number;height:number}{
 if(bytes.length<33||bytes.length>8388608||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))throw Error('Invalid loaded PNG');
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(v.getUint32(8)!==13||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')throw Error('Invalid PNG header');
 const width=v.getUint32(16),height=v.getUint32(20);
 if(!width||!height||width*height>16777216)throw Error('Loaded PNG exceeds 16 MP or has empty dimensions');
 return {width,height};
}

/** Integrity, not authenticity: a writer who replaces both records can forge this check. */
export async function verifyRecallReceipt(bytes: Uint8Array, mime: string, path: string, text: string): Promise<{method:string;capturedAt:string}> {
 if(!bytes.length||bytes.length>8388608)throw Error('Invalid memory size');
 if(text.length>16384||new TextEncoder().encode(text).byteLength>16384)throw Error('Receipt exceeds 16 KiB UTF-8');
 const r:unknown=JSON.parse(text);
 if(!r||typeof r!=='object'||Array.isArray(r))throw Error('Invalid receipt');
 const v=r as Record<string,unknown>;
 if(v.version!==1||v.path!==path||v.bytes!==bytes.length||v.mime!==mime||typeof v.sha256!=='string'||!/^[0-9a-f]{64}$/.test(v.sha256)||typeof v.method!=='string'||!v.method||v.method.length>128||typeof v.capturedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.capturedAt)||!Number.isFinite(Date.parse(v.capturedAt))||new Date(v.capturedAt).toISOString()!==v.capturedAt)throw Error('Receipt fields do not match this memory');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer)),b=>b.toString(16).padStart(2,'0')).join('');
 if(digest!==v.sha256)throw Error('Memory checksum mismatch');
 return {method:v.method,capturedAt:v.capturedAt};
}

/** Only exposed File objects, never text/html, URI lists, src URLs or dataTransfer.getData. */
export function oneResidentFile(files: ArrayLike<File>): File {
 if(files.length!==1)throw Error('Choose exactly one resident media file; no partial batch is saved');
 const file=files[0];
 if(!file||!file.size||file.size>8388608)throw Error('Select nonempty media at most 8 MiB; no truncation.');
 if(!/^(image|video|audio)\/[a-z0-9.+-]+$/i.test(file.type)||/mpegurl|dash\+xml/i.test(file.type))throw Error('A resident image/audio/video file is required; links are never fetched');
 return file;
}
