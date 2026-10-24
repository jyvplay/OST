/**
 * Lossless WebM / Matroska trimming (RFC 8794 EBML, RFC 9559 Matroska), written from the RFCs.
 *
 * Reads files with known or unknown element sizes (MediaRecorder writes an unknown-size Segment and Clusters, no
 * Duration and no Cues). Blocks (SimpleBlock / BlockGroup) are copied byte-for-byte; only their 16-bit cluster-relative
 * timestamps are rewritten. Matroska has no widely honoured edit list, so a lossless cut starts at the last video key
 * frame at or before the requested start — the report says where it actually starts. Output: EBML header (copied),
 * Segment with SeekHead, Info (new Duration), Tracks (copied), Clusters (new, one per key frame / int16 range) and Cues
 * (new — the trimmed file is seekable even when the source was a live recording).
 * Dropped: Chapters and Tags (their times would be wrong), Void / CRC-32. Refused: encrypted tracks.
 */
export type Bytes = Uint8Array;
export class MediaError extends Error {}

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab, SeekPosition: 0x53ac, Info: 0x1549a966,
  TimestampScale: 0x2ad7b1, Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86,
  ContentEncodings: 0x6d80, ContentEncoding: 0x6240, ContentEncryption: 0x5035, Cluster: 0x1f43b675, Timestamp: 0xe7, SimpleBlock: 0xa3,
  BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb, Cues: 0x1c53bb6b, CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7,
  CueTrack: 0xf7, CueClusterPosition: 0xf1, Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469, Void: 0xec, CRC32: 0xbf,
} as const;
const SEGMENT_LEVEL = new Set<number>([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);

interface El { id: number; start: number; data: number; end: number; unknown: boolean }
function readId(b: Bytes, p: number): [number, number] {
  const f = b[p]; if (f === undefined) throw new MediaError("truncated file");
  const len = f >= 0x80 ? 1 : f >= 0x40 ? 2 : f >= 0x20 ? 3 : f >= 0x10 ? 4 : 0; if (!len || p + len > b.length) throw new MediaError(`invalid element id at byte ${p}`);
  let v = 0; for (let i = 0; i < len; i++) v = v * 256 + b[p + i]; return [v, len];
}
/** [value, length, unknown] */
function readSize(b: Bytes, p: number): [number, number, boolean] {
  const f = b[p]; if (f === undefined) throw new MediaError("truncated file");
  let len = 1; while (len <= 8 && !(f & (0x80 >> (len - 1)))) len++; if (len > 8 || p + len > b.length) throw new MediaError(`invalid element size at byte ${p}`);
  let v = f & (0xff >> len); let ones = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) ones = false; }
  if (ones) return [v, len, true]; // all value bits set = unknown size (live recordings); checked before the range test
  if (v > Number.MAX_SAFE_INTEGER) throw new MediaError("element size too large");
  return [v, len, false];
}
function readEl(b: Bytes, p: number, limit: number): El {
  const [id, il] = readId(b, p); const [size, sl, unknown] = readSize(b, p + il); const data = p + il + sl;
  if (unknown) return { id, start: p, data, end: limit, unknown: true };
  if (data + size > limit) { if (id === ID.Cluster || id === ID.Segment) return { id, start: p, data, end: limit, unknown: false }; throw new MediaError(`element 0x${id.toString(16)} at byte ${p} runs past its parent`); }
  return { id, start: p, data, end: data + size, unknown: false };
}
function children(b: Bytes, parent: El): El[] { const out: El[] = []; let p = parent.data; while (p < parent.end) { const e = readEl(b, p, parent.end); out.push(e); p = e.end; if (out.length > 5_000_000) throw new MediaError("too many elements"); } return out; }
const uint = (b: Bytes, e: El) => { let v = 0; for (let p = e.data; p < e.end; p++) v = v * 256 + b[p]; return v; };
const float = (b: Bytes, e: El) => { const v = new DataView(b.buffer, b.byteOffset + e.data, e.end - e.data); return e.end - e.data === 4 ? v.getFloat32(0) : e.end - e.data === 8 ? v.getFloat64(0) : 0; };

export interface MkBlock { track: number; time: number; key: boolean; start: number; end: number; tsAt: number; invisible: boolean }
export interface MkTrack { number: number; type: number; codec: string }
export interface MkFile { b: Bytes; ebml: El; segment: El; info: El | null; tracks: El | null; attachments: El | null; scale: number; duration: number | null; trackList: MkTrack[]; blocks: MkBlock[] }

export function parseMatroska(b: Bytes): MkFile {
  const ebml = readEl(b, 0, b.length); if (ebml.id !== ID.EBML) throw new MediaError("not a WebM/Matroska file (no EBML header)");
  let p = ebml.end; let segment: El | null = null;
  while (p < b.length) { const e = readEl(b, p, b.length); if (e.id === ID.Segment) { segment = e; break; } p = e.end; }
  if (!segment) throw new MediaError("no Segment element");
  let info: El | null = null, tracks: El | null = null, attachments: El | null = null; const blocks: MkBlock[] = [];
  let scale = 1_000_000; let duration: number | null = null; const trackList: MkTrack[] = [];
  p = segment.data; const end = segment.end;
  while (p < end) {
    let e: El; try { e = readEl(b, p, end); } catch (err) { if (blocks.length) break; throw err; } // trailing garbage after a recording: keep what was read
    if (e.id === ID.Info) { info = e; for (const c of children(b, e)) { if (c.id === ID.TimestampScale) scale = uint(b, c) || 1_000_000; if (c.id === ID.Duration) duration = float(b, c); } }
    else if (e.id === ID.Tracks) {
      tracks = e;
      for (const te of children(b, e)) if (te.id === ID.TrackEntry) {
        const t: MkTrack = { number: 0, type: 0, codec: "" };
        for (const c of children(b, te)) {
          if (c.id === ID.TrackNumber) t.number = uint(b, c); else if (c.id === ID.TrackType) t.type = uint(b, c); else if (c.id === ID.CodecID) t.codec = String.fromCharCode(...b.subarray(c.data, c.end));
          else if (c.id === ID.ContentEncodings) for (const ce of children(b, c)) if (ce.id === ID.ContentEncoding && children(b, ce).some((x) => x.id === ID.ContentEncryption)) throw new MediaError("encrypted tracks cannot be trimmed");
        }
        trackList.push(t);
      }
    } else if (e.id === ID.Attachments) attachments = e;
    else if (e.id === ID.Cluster) {
      let q = e.data; let ct = 0; let clusterEnd = e.end;
      while (q < clusterEnd) {
        let c: El; try { c = readEl(b, q, clusterEnd); } catch { clusterEnd = q; break; } // truncated recording
        if (e.unknown && (SEGMENT_LEVEL.has(c.id) || c.id === ID.EBML)) { clusterEnd = q; break; } // unknown-size cluster ends at the next segment-level element
        if (c.id === ID.Timestamp) ct = uint(b, c);
        else if (c.id === ID.SimpleBlock) blocks.push(block(b, c.data, c, ct, true));
        else if (c.id === ID.BlockGroup) {
          const kidsG = children(b, c); const blk = kidsG.find((x) => x.id === ID.Block);
          if (blk) { const bl = block(b, blk.data, c, ct, false); bl.key = !kidsG.some((x) => x.id === ID.ReferenceBlock); blocks.push(bl); }
        }
        q = c.end;
      }
      p = clusterEnd; continue;
    }
    p = e.end;
  }
  if (!tracks) throw new MediaError("no Tracks element");
  return { b, ebml, segment, info, tracks, attachments, scale, duration, trackList, blocks };
}
function block(b: Bytes, payload: number, el: El, clusterTime: number, simple: boolean): MkBlock {
  const [, tl] = readSize(b, payload); const track = (() => { let v = b[payload] & (0xff >> tl); for (let i = 1; i < tl; i++) v = v * 256 + b[payload + i]; return v; })();
  const tsAt = payload + tl; if (tsAt + 3 > el.end) throw new MediaError("damaged block");
  const rel = (b[tsAt] << 24 >> 16) | b[tsAt + 1]; const flags = b[tsAt + 2];
  return { track, time: clusterTime + rel, key: simple ? !!(flags & 0x80) : true, start: el.start, end: el.end, tsAt, invisible: !!(flags & 0x08) };
}

/* ------------------------------------------------------------------------------------------------ writer */
function idBytes(id: number): Bytes { const out: number[] = []; let v = id; while (v > 0) { out.unshift(v & 255); v = Math.floor(v / 256); } return Uint8Array.from(out); }
function sizeBytes(n: number, width = 0): Bytes {
  let len = width || 1; if (!width) while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const o = new Uint8Array(len); let v = n; for (let i = len - 1; i >= 0; i--) { o[i] = v & 255; v = Math.floor(v / 256); } o[0] |= 0x80 >> (len - 1); return o;
}
function cat(parts: Bytes[]): Bytes { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let q = 0; for (const p of parts) { o.set(p, q); q += p.length; } return o; }
const el = (id: number, ...parts: Bytes[]) => { const body = cat(parts); return cat([idBytes(id), sizeBytes(body.length), body]); };
const elW = (id: number, body: Bytes) => cat([idBytes(id), sizeBytes(body.length, 8), body]); // fixed 8-byte size: positions are stable
function uintBytes(v: number): Bytes { const out: number[] = []; let x = v; do { out.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return Uint8Array.from(out); }
const uEl = (id: number, v: number) => el(id, uintBytes(v));
function f64(v: number) { const o = new Uint8Array(8); new DataView(o.buffer).setFloat64(0, v); return o; }

export interface WebmTrimReport { bytes: Bytes; start: number; end: number; requestedStart: number; blocks: number; clusters: number; cues: number }

/** times in seconds */
export function trimWebm(input: Bytes, from: number, to: number): WebmTrimReport {
  const f = parseMatroska(input); const b = input; const sc = f.scale / 1e9; // seconds per tick
  if (!(to > from)) throw new MediaError("the end must be after the start");
  if (!f.blocks.length) throw new MediaError("the file has no media blocks");
  const lastTime = Math.max(...f.blocks.map((x) => x.time)) * sc;
  from = Math.max(0, from); if (from >= lastTime) throw new MediaError(`the start is after the last frame (${lastTime.toFixed(3)} s)`);
  const video = f.trackList.find((t) => t.type === 1)?.number ?? null;
  const fromT = from / sc, toT = to / sc; const eps = 0.5;
  const order = f.blocks; // file order = decode order
  let startIdx = 0, keyTime = order[0].time;
  if (video !== null) {
    let k = -1; order.forEach((x, i) => { if (x.track === video && x.key && x.time <= fromT + eps) k = i; });
    if (k < 0) k = order.findIndex((x) => x.track === video && x.key); if (k < 0) throw new MediaError("no video key frame");
    startIdx = k; keyTime = order[k].time;
  } else { keyTime = Math.max(0, ...order.filter((x) => x.time <= fromT + eps).map((x) => x.time)); startIdx = order.findIndex((x) => x.time >= keyTime - eps); }
  let lastVideo = -1; if (video !== null) order.forEach((x, i) => { if (i >= startIdx && x.track === video && x.time < toT - eps) lastVideo = i; });
  // B-frames: the prefix may hold a reference frame shown after the end; then every frame shown before it must come too,
  // or the display would have a gap (the extension can pull in further references, so repeat until stable)
  for (let guard = 0; video !== null && lastVideo >= 0 && guard < 64; guard++) {
    let maxT = -Infinity; for (let i = startIdx; i <= lastVideo; i++) if (order[i].track === video) maxT = Math.max(maxT, order[i].time);
    let ext = lastVideo; for (let i = lastVideo + 1; i < order.length; i++) if (order[i].track === video && order[i].time < maxT - eps) ext = i;
    if (ext === lastVideo) break; lastVideo = ext;
  }
  // Video: the decode-order prefix through the last frame shown before the end. With B-frames that prefix can hold a
  // reference frame shown after the end; Matroska cannot hide it (no edit list), so it stays and the reported end moves.
  const vKeep = video === null ? [] : order.filter((x, i) => x.track === video && i >= startIdx && i <= lastVideo && x.time >= keyTime - eps);
  const vTimes = vKeep.map((x) => x.time).sort((p, q) => p - q);
  const vStep = vTimes.length > 1 ? (vTimes[vTimes.length - 1] - vTimes[0]) / (vTimes.length - 1) : 0;
  // end of the cut: the requested end, or later if B-frame references had to stay — but never past the next real frame
  // (recorders stamp frames irregularly, so "last frame + average step" alone can overshoot)
  let otherEnd = toT;
  if (vTimes.length) {
    const last = vTimes[vTimes.length - 1]; let next = Infinity;
    for (const x of order) if (x.track === video && x.time > last + eps && x.time < next) next = x.time;
    otherEnd = Math.max(Math.min(toT, Number.isFinite(next) ? next : Infinity, f.duration ?? Infinity), Math.min(next, last + vStep));
  }
  const keep: MkBlock[] = [];
  for (let i = startIdx; i < order.length; i++) {
    const x = order[i];
    if (x.track === video) { if (i > lastVideo) continue; if (x.time < keyTime - eps) continue; keep.push(x); } // open-GOP leading pictures dropped
    else if (x.time >= keyTime - eps && x.time < otherEnd - eps) keep.push(x);
  }
  if (!keep.length) throw new MediaError("no media in that range");
  // clusters: new one at each video key frame, or when a relative timestamp would leave int16
  const clusters: { time: number; blocks: MkBlock[]; key: boolean }[] = [];
  for (const x of keep) {
    const t = Math.round(x.time - keyTime); const cur = clusters[clusters.length - 1];
    const startNew = !cur || (x.track === video && x.key && cur.blocks.some((y) => y.track === video)) || t - cur.time > 32767 || t - cur.time < -32768;
    if (startNew) clusters.push({ time: Math.max(0, t), blocks: [x], key: x.track === video && x.key }); else cur.blocks.push(x);
  }
  // duration (ticks): up to the requested end, the source duration, or the last kept frame plus one typical frame step
  const ref = keep.filter((x) => x.track === (video ?? keep[0].track)).map((x) => x.time).sort((p, q) => p - q);
  const step = ref.length > 1 ? (ref[ref.length - 1] - ref[0]) / (ref.length - 1) : 0;
  const endAbs = Math.min(otherEnd, f.duration ?? Infinity, Math.max(...keep.map((x) => x.time)) + step);
  const endT = Math.max(0, endAbs - keyTime);
  const infoKids: Bytes[] = [];
  if (f.info) for (const c of children(b, f.info)) if (c.id !== ID.Duration && c.id !== ID.Void && c.id !== ID.CRC32) infoKids.push(b.subarray(c.start, c.end));
  if (!f.info) infoKids.push(uEl(ID.TimestampScale, f.scale));
  infoKids.push(el(ID.Duration, f64(endT)));
  const info = el(ID.Info, ...infoKids);
  const tracks = b.subarray(f.tracks!.start, f.tracks!.end);
  const att = f.attachments ? b.subarray(f.attachments.start, f.attachments.end) : new Uint8Array(0);
  const fixed8 = (v: number) => { const o = new Uint8Array(8); let x = v; for (let i = 7; i >= 0; i--) { o[i] = x & 255; x = Math.floor(x / 256); } return o; };
  const seekEntry = (id: number, pos: number) => el(ID.Seek, el(ID.SeekID, idBytes(id)), el(ID.SeekPosition, fixed8(pos))); // 8-byte positions keep the SeekHead size stable
  const seekHeadLen = elW(ID.SeekHead, cat([seekEntry(ID.Info, 0), seekEntry(ID.Tracks, 0), seekEntry(ID.Cues, 0)])).length;
  const infoPos = seekHeadLen, tracksPos = infoPos + info.length, clustersPos = tracksPos + tracks.length + att.length;
  const clusterBytes: Bytes[] = []; const cuePoints: Bytes[] = []; let pos = clustersPos; let nBlocks = 0;
  for (const c of clusters) {
    const parts: Bytes[] = [uEl(ID.Timestamp, c.time)];
    for (const x of c.blocks) {
      const rawEl = b.slice(x.start, x.end); const rel = Math.round(x.time - keyTime) - c.time; const o = x.tsAt - x.start;
      rawEl[o] = (rel >> 8) & 255; rawEl[o + 1] = rel & 255; parts.push(rawEl); nBlocks++;
    }
    const ce = elW(ID.Cluster, cat(parts));
    if (c.key && video !== null) cuePoints.push(el(ID.CuePoint, uEl(ID.CueTime, c.time), el(ID.CueTrackPositions, uEl(ID.CueTrack, video), uEl(ID.CueClusterPosition, pos))));
    clusterBytes.push(ce); pos += ce.length;
  }
  if (!cuePoints.length) cuePoints.push(el(ID.CuePoint, uEl(ID.CueTime, clusters[0].time), el(ID.CueTrackPositions, uEl(ID.CueTrack, keep[0].track), uEl(ID.CueClusterPosition, clustersPos))));
  const cues = el(ID.Cues, ...cuePoints); const cuesPos = pos;
  const seekHead = elW(ID.SeekHead, cat([seekEntry(ID.Info, infoPos), seekEntry(ID.Tracks, tracksPos), seekEntry(ID.Cues, cuesPos)]));
  if (seekHead.length !== seekHeadLen) throw new MediaError("internal: seek head size changed");
  const body = cat([seekHead, info, tracks, att, ...clusterBytes, cues]);
  const out = cat([b.subarray(f.ebml.start, f.ebml.end), idBytes(ID.Segment), sizeBytes(body.length, 8), body]);
  return { bytes: out, start: keyTime * sc, end: (keyTime + endT) * sc, requestedStart: from, blocks: nBlocks, clusters: clusters.length, cues: cuePoints.length };
}
