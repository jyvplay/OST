/** Untrusted producer PNG admission; validate dimensions before asking a native decoder to allocate. */
export function loadedPngDimensions(bytes:Uint8Array):{width:number;height:number}{
 if(bytes.length<33||bytes.length>8388608||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))throw Error('Invalid loaded PNG');
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(v.getUint32(8)!==13||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')throw Error('Invalid PNG header');
 const width=v.getUint32(16),height=v.getUint32(20);
 if(!width||!height||width*height>16777216)throw Error('Loaded PNG exceeds 16 MP or has empty dimensions');
 return {width,height};
}
