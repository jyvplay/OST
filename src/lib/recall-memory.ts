/** Untrusted producer PNG admission; validate dimensions before asking a native decoder to allocate. */
export function loadedPngDimensions(bytes:Uint8Array):{width:number;height:number}{
 if(bytes.length<33||bytes.length>8388608||![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))throw Error('Invalid loaded PNG');
 const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 if(v.getUint32(8)!==13||String.fromCharCode(...bytes.slice(12,16))!=='IHDR')throw Error('Invalid PNG header');
 const width=v.getUint32(16),height=v.getUint32(20);
 if(!width||!height||width*height>16777216)throw Error('Loaded PNG exceeds 16 MP or has empty dimensions');
 return {width,height};
}

/* ------------------------------------------------- TT108: derived-region saving */

export interface CropRect { x: number; y: number; width: number; height: number }
export const MIN_CROP = 8;

/**
 * TT108 (RC-33) — map a rectangle a person dragged over a *displayed* preview onto
 * the source's own pixel grid, so the crop is cut from pixels the browser already
 * decoded. Nothing is refetched and the original is never modified.
 *
 * A drag may run in any direction, may start or end outside the element, and the
 * element is usually scaled by CSS, so the selection is normalised, scaled, rounded
 * to whole source pixels and clamped to the source before anything is encoded.
 * Rejects rather than silently shrinking when the result is unusably small.
 */
export function cropRegion(
  selection: { x: number; y: number; width: number; height: number },
  displayed: { width: number; height: number },
  natural: { width: number; height: number },
): CropRect {
  for (const [v, label] of [[displayed.width, 'displayed width'], [displayed.height, 'displayed height'],
    [natural.width, 'source width'], [natural.height, 'source height']] as const)
    if (!Number.isFinite(v) || v <= 0) throw Error(`The preview has no ${label} yet; let it finish decoding`);
  for (const v of [selection.x, selection.y, selection.width, selection.height])
    if (!Number.isFinite(v)) throw Error('Selection coordinates must be finite numbers');
  if (natural.width * natural.height > 16777216) throw Error('Source exceeds the 16-megapixel budget');

  // normalise a backwards drag, then scale display pixels to source pixels
  const left = Math.min(selection.x, selection.x + selection.width);
  const top = Math.min(selection.y, selection.y + selection.height);
  const sx = natural.width / displayed.width, sy = natural.height / displayed.height;
  let x = Math.round(left * sx), y = Math.round(top * sy);
  let width = Math.round(Math.abs(selection.width) * sx), height = Math.round(Math.abs(selection.height) * sy);

  // clamp into the source: a drag released past the edge keeps the part that exists
  if (x < 0) { width += x; x = 0; }
  if (y < 0) { height += y; y = 0; }
  width = Math.min(width, natural.width - x);
  height = Math.min(height, natural.height - y);
  if (x >= natural.width || y >= natural.height || width <= 0 || height <= 0)
    throw Error('That selection lies outside the picture; drag a region over it');
  if (width < MIN_CROP || height < MIN_CROP)
    throw Error(`Select at least ${MIN_CROP}×${MIN_CROP} source pixels; nothing was saved`);
  return { x, y, width, height };
}

/** The provenance a derived memory carries: which saved pair it was cut from, and where. */
export interface DerivedFrom { path: string; sha256: string; region: CropRect }

/** Shape gate shared by the browser and the server, so both refuse the same malformed provenance. */
export function validDerivedFrom(value: unknown, selfPath: string): DerivedFrom {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Derived memories need a derivedFrom record');
  const d = value as Record<string, unknown>;
  const extra = Object.keys(d).filter((k) => !['path', 'sha256', 'region'].includes(k));
  if (extra.length) throw Error('Unexpected derivedFrom fields: ' + extra.slice(0, 4).join(', '));
  if (typeof d.path !== 'string' || !/^\/Downloads\/Recall\/[^/]+\/[^/]+$/.test(d.path) || d.path.length > 512
    || d.path.endsWith('.recall.json') || /[\u0000-\u001f\u007f]/.test(d.path))
    throw Error('derivedFrom.path must be one canonical saved Recall media path');
  if (d.path === selfPath) throw Error('A memory cannot be derived from itself');
  if (typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(d.sha256)) throw Error('derivedFrom.sha256 must be a SHA-256 digest');
  const r = d.region as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw Error('derivedFrom.region is required');
  const keys = Object.keys(r);
  if (keys.length !== 4 || !['x', 'y', 'width', 'height'].every((k) => keys.includes(k))) throw Error('derivedFrom.region needs exactly x, y, width and height');
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw Error(`derivedFrom.region.${k} must be a non-negative whole number`);
  }
  const region = r as unknown as CropRect;
  if (region.width < 1 || region.height < 1) throw Error('derivedFrom.region must be at least one pixel');
  if (region.width * region.height > 16777216) throw Error('derivedFrom.region exceeds 16 megapixels');
  return { path: d.path, sha256: d.sha256, region };
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
