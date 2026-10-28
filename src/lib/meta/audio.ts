/**
 * TT54 (FF-13) — audio tag + stream-info reader, original code from the specifications:
 * ID3v2.2 / 2.3 / 2.4 (id3.org informal standards: unsynchronisation, extended header, frame flags, the four
 * text encodings, APIC / PIC, COMM, TXXX), ID3v1 / 1.1, MPEG audio frame headers (ISO 11172-3 / 13818-3) with
 * the Xing / Info + LAME gapless fields and the Fraunhofer VBRI header, FLAC (STREAMINFO, VORBIS_COMMENT,
 * PICTURE), Ogg (RFC 3533 pages; Vorbis I, Opus RFC 7845, Speex, Ogg FLAC; durations from the last granule
 * position), RIFF WAVE (fmt, data, LIST INFO, id3 chunk), AIFF / AIFC (COMM with its 80-bit rate, ID3 chunk).
 * Tags are normalised to: title artist album albumArtist date track disc genre composer comment.
 */

export interface Picture { mime: string; data: Uint8Array; type: number; description: string }
export interface AvInfo {
  format: string; mime: string; kind: "audio" | "video";
  duration?: number; sampleRate?: number; channels?: number; bitrate?: number; bitsPerSample?: number;
  width?: number; height?: number; codecs: string[];
  tags: Record<string, string>; pictures: Picture[];
  gps?: { lat: number; lon: number; alt?: number };
  warnings: string[];
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u24be = (b: Uint8Array, o: number) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + ((b[o + 3] << 24) >>> 0);
const ascii = (b: Uint8Array, o: number, n: number) => { let s = ""; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
const latin1 = (b: Uint8Array) => { let s = ""; for (const c of b) s += String.fromCharCode(c); return s; };
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
const syncsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

export const GENRES = ["Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "Alt. Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy", "Cult", "Gangsta Rap", "Top 40", "Christian Rap", "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock", "Folk", "Folk-Rock", "National Folk", "Swing", "Fast-Fusion", "Bebop", "Latin", "Revival", "Celtic", "Bluegrass", "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock", "Drum Solo", "A Cappella", "Euro-House", "Dance Hall", "Goa", "Drum & Bass", "Club-House", "Hardcore", "Terror", "Indie", "BritPop", "Afro-Punk", "Polsk Punk", "Beat", "Christian Gangsta Rap", "Heavy Metal", "Black Metal", "Crossover", "Contemporary Christian", "Christian Rock", "Merengue", "Salsa", "Thrash Metal", "Anime", "JPop", "Synthpop", "Abstract", "Art Rock", "Baroque", "Bhangra", "Big Beat", "Breakbeat", "Chillout", "Downtempo", "Dub", "EBM", "Eclectic", "Electro", "Electroclash", "Emo", "Experimental", "Garage", "Global", "IDM", "Illbient", "Industro-Goth", "Jam Band", "Krautrock", "Leftfield", "Lounge", "Math Rock", "New Romantic", "Nu-Breakz", "Post-Punk", "Post-Rock", "Psytrance", "Shoegaze", "Space Rock", "Trop Rock", "World Music", "Neoclassical", "Audiobook", "Audio Theatre", "Neue Deutsche Welle", "Podcast", "Indie Rock", "G-Funk", "Dubstep", "Garage Rock", "Psybient"];

/** ID3 TCON: "(17)", "(17)Rock", "17", "(RX)", "(CR)", v2.4 NUL-separated -> names */
export function resolveGenre(raw: string): string {
  const out: string[] = [];
  for (const part of raw.split("\0")) {
    let s = part; let m: RegExpMatchArray | null;
    while ((m = s.match(/^\((\d+|RX|CR)\)/))) {
      out.push(m[1] === "RX" ? "Remix" : m[1] === "CR" ? "Cover" : GENRES[+m[1]] ?? "Unknown");
      s = s.slice(m[0].length);
    }
    if (s.startsWith("((")) s = s.slice(1);
    if (/^\d+$/.test(s)) out.push(GENRES[+s] ?? "Unknown");
    else if (s.trim()) { if (out[out.length - 1] !== s.trim()) out.push(s.trim()); }
  }
  return [...new Set(out)].join("; ");
}

/* ------------------------------------------------------------- ID3v2 ------ */

export interface Id3 { version: number; size: number; tags: Record<string, string>; pictures: Picture[]; tlen?: number; warnings: string[] }

const MAP: Record<string, string> = {
  TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist", TALB: "album", TAL: "album", TPE2: "albumArtist", TP2: "albumArtist",
  TRCK: "track", TRK: "track", TPOS: "disc", TPA: "disc", TCON: "genre", TCO: "genre", TCOM: "composer", TCM: "composer",
  TDRC: "date", TYER: "date", TYE: "date", TCOP: "copyright", TCR: "copyright", TENC: "encodedBy", TEN: "encodedBy", TBPM: "bpm", TBP: "bpm",
};

function decodeText(enc: number, d: Uint8Array): string {
  if (enc === 0) return latin1(d);
  if (enc === 3) return utf8(d);
  if (enc === 2) return new TextDecoder("utf-16be").decode(d);
  // enc 1: UTF-16 with BOM per string (NUL-separated values each carry their own BOM)
  const parts: string[] = []; let i = 0;
  while (i + 1 < d.length || i === 0) {
    let le = true; if (d[i] === 0xfe && d[i + 1] === 0xff) { le = false; i += 2; } else if (d[i] === 0xff && d[i + 1] === 0xfe) i += 2;
    let j = i; while (j + 1 < d.length && !(d[j] === 0 && d[j + 1] === 0)) j += 2;
    parts.push(new TextDecoder(le ? "utf-16le" : "utf-16be").decode(d.subarray(i, Math.min(j, d.length))));
    i = j + 2; if (i >= d.length) break;
  }
  return parts.join("\0");
}
/** index after a NUL terminator in encoding `enc` (2-byte aligned NUL for UTF-16) */
function termEnd(enc: number, d: Uint8Array, from: number): [number, number] {
  if (enc === 1 || enc === 2) { for (let i = from; i + 1 < d.length; i += 2) if (d[i] === 0 && d[i + 1] === 0) return [i, i + 2]; return [d.length, d.length]; }
  const z = d.indexOf(0, from); return z < 0 ? [d.length, d.length] : [z, z + 1];
}
const deunsync = (d: Uint8Array) => { const o = new Uint8Array(d.length); let n = 0; for (let i = 0; i < d.length; i++) { o[n++] = d[i]; if (d[i] === 0xff && d[i + 1] === 0) i++; } return o.subarray(0, n); };

export async function readId3v2(b: Uint8Array, at = 0, inflate?: (d: Uint8Array) => Promise<Uint8Array>): Promise<Id3 | null> {
  if (ascii(b, at, 3) !== "ID3" || b.length < at + 10) return null;
  const ver = b[at + 3], flags = b[at + 5], size = syncsafe(b, at + 6);
  const out: Id3 = { version: ver, size: 10 + size + (flags & 0x10 ? 10 : 0), tags: {}, pictures: [], warnings: [] };
  if (ver < 2 || ver > 4) { out.warnings.push(`id3: unsupported version 2.${ver}`); return out; }
  if(at+10+size>b.length)out.warnings.push("id3: truncated tag");
  let body = b.subarray(at + 10, Math.min(b.length, at + 10 + size));
  if (flags & 0x80 && ver < 4) body = deunsync(body);
  let p = 0;
  if (flags & 0x40 && ver >= 3) {
    p = ver === 3 ? 4 + u32be(body, 0) : syncsafe(body, 0);
    // writers that set the flag without writing the header: a frame id where the size should be, or an impossible size
    if (p > body.length || p < 6 || /^[A-Z][A-Z0-9]{3}$/.test(ascii(body, 0, 4))) { p = 0; out.warnings.push("id3: extended-header flag set but no extended header (ignored)"); }
  }
  const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
  const frames: { id: string; data: Uint8Array }[] = [];
  // v2.4 frame sizes are syncsafe, but some writers (old iTunes) used plain integers: pick the reading that lands on a frame
  let plain24 = false;
  if (ver === 4) {
    let q = p, okSafe = true;
    while (q + hLen <= body.length && body[q]) { const n = syncsafe(body, q + 4); const nx = q + hLen + n; if (nx > body.length || (nx + 4 <= body.length && body[nx] && !/^[A-Z0-9]{4}$/.test(ascii(body, nx, 4)))) { okSafe = false; break; } q = nx; }
    if (!okSafe) { q = p; let okPlain = true; while (q + hLen <= body.length && body[q]) { const n = u32be(body, q + 4); const nx = q + hLen + n; if (nx > body.length || (nx + 4 <= body.length && body[nx] && !/^[A-Z0-9]{4}$/.test(ascii(body, nx, 4)))) { okPlain = false; break; } q = nx; } plain24 = okPlain; }
  }
  while (p + hLen <= body.length && frames.length < 4096) {
    const id = ascii(body, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const n = ver === 2 ? u24be(body, p + 3) : ver === 3 || plain24 ? u32be(body, p + 4) : syncsafe(body, p + 4);
    const ff = ver === 2 ? 0 : u16be(body, p + 8);
    if(p+hLen+n>body.length){out.warnings.push(`id3: truncated ${id} frame`);break;}
    let data = body.subarray(p + hLen, p + hLen + n);
    p += hLen + n;
    if (ver === 3) {
      if (ff & 0x0040) continue; // encrypted
      if (ff & 0x0020) data = data.subarray(1);
      if (ff & 0x0080) { if (!inflate) continue; try { data = await inflate(data.subarray(4)); } catch { out.warnings.push(`id3: ${id} decompression failed`); continue; } }
    } else if (ver === 4) {
      if (ff & 0x0004) continue;
      if (ff & 0x0040) data = data.subarray(1);
      if (ff & 0x0001) data = data.subarray(4);
      if (ff & 0x0002 || flags & 0x80) data = deunsync(data);
      if (ff & 0x0008) { if (!inflate) continue; try { data = await inflate(data); } catch { out.warnings.push(`id3: ${id} decompression failed`); continue; } }
    }
    frames.push({ id, data });
  }
  let tdat = "", tyer = "";
  for (const { id, data } of frames) {
    if (!data.length) continue;
    const enc = data[0];
    if(enc>3){out.warnings.push(`id3: unsupported text encoding in ${id}`);continue;}
    if (id[0] === "T" && id !== "TXXX" && id !== "TXX") {
      const v = decodeText(enc, data.subarray(1)).replace(/\0+$/, "");
      if (id === "TLEN") { const ms = parseInt(v, 10); if (ms > 0) out.tlen = ms / 1000; continue; }
      if (id === "TDAT") { tdat = v; continue; }
      const k = MAP[id] ?? `id3.${id}`;
      // a repeated text frame (illegal but common) adds values rather than being dropped
      if (out.tags[k]) { if (k !== "genre" && k !== "date" && k !== "track" && k !== "disc") { const add = v.split("\0").filter(Boolean).filter((x) => !out.tags[k].split("; ").includes(x)); if (add.length) out.tags[k] += "; " + add.join("; "); } continue; }
      if (id === "TYER" || id === "TYE") tyer = v;
      out.tags[k] = k === "genre" ? resolveGenre(v) : v.split("\0").filter(Boolean).join("; ");
    } else if (id === "TXXX" || id === "TXX") {
      const [end,start]=termEnd(enc,data,1),description=decodeText(enc,data.subarray(1,end));
      const value=decodeText(enc,data.subarray(start)).replace(/\0+$/, "");
      const key=`custom.${description}`;out.tags[key]=out.tags[key]?out.tags[key]+"; "+value:value;
    } else if (id === "USLT" || id === "ULT") {
      if(data.length<4){out.warnings.push("id3: truncated lyrics header");continue;}
      const [end,start]=termEnd(enc,data,4),description=decodeText(enc,data.subarray(4,end));
      const language=ascii(data,1,3),value=decodeText(enc,data.subarray(start)).replace(/\0+$/, "");
      const key=`lyrics.${language}.${description}`;out.tags[key]=out.tags[key]?out.tags[key]+"\n"+value:value;
    } else if (id === "SYLT" || id === "SLT") {
      if(data.length<7||![1,2].includes(data[4])){out.warnings.push('id3: invalid synchronized lyric header');continue;}
      const [end,start]=termEnd(enc,data,6);
      if(start===end){out.warnings.push('id3: unterminated synchronized lyric descriptor');continue;}
      const description=decodeText(enc,data.subarray(6,end)),parts:string[]=[],times:string[]=[];
      let q=start,last=-1,valid=true;
      // Ambiguous BOM inheritance is refused rather than silently decoding the wrong lyrics.
      while(q<data.length&&parts.length<4096){
        const [e,next]=termEnd(enc,data,q);
        if(next===e||next+4>data.length||(enc===1&&!((data[q]===255&&data[q+1]===254)||(data[q]===254&&data[q+1]===255)))){valid=false;break;}
        const stamp=u32be(data,next);if(stamp<last){valid=false;break;}last=stamp;
        parts.push(decodeText(enc,data.subarray(q,e)));times.push(`${stamp} ${data[4]===2?'ms':'MPEG frames'}`);q=next+4;
      }
      if(!valid||q<data.length){out.warnings.push('id3: malformed, ambiguous UTF-16 or over-budget synchronized lyrics refused');continue;}
      const key=`lyrics.synced.${ascii(data,1,3)}.${description}`;
      out.tags[key]=(out.tags[key]?out.tags[key]+'\n':'')+parts.join('\n');
      out.tags[key+'.contentType']=String(data[5]);out.tags[key+'.timestampFormat']=String(data[4]);
      out.tags[key+'.timestamps']=(out.tags[key+'.timestamps']?out.tags[key+'.timestamps']+'; ':'')+times.join('; ');
    } else if (id === "COMM" || id === "COM") {
      if (out.tags.comment) continue;
      const [, e1] = termEnd(enc, data, 4); const v = decodeText(enc, data.subarray(e1)).replace(/\0+$/, "");
      if (v) out.tags.comment = v;
    } else if (id === "APIC" || id === "PIC") {
      let mime: string, q: number;
      if (id === "PIC") { const f = ascii(data, 1, 3).toUpperCase(); mime = f === "PNG" ? "image/png" : f === "JPG" ? "image/jpeg" : `image/${f.toLowerCase()}`; q = 4; }
      else { const z = data.indexOf(0, 1); mime = latin1(data.subarray(1, z < 0 ? 1 : z)).toLowerCase() || "image/"; q = z + 1; if (!mime.includes("/")) mime = `image/${mime === "jpg" ? "jpeg" : mime}`; }
      const type = data[q]; const [de, e1] = termEnd(enc, data, q + 1);
      out.pictures.push({ mime, type, description: decodeText(enc, data.subarray(q + 1, de)), data: data.subarray(e1) });
    }
  }
  if (tyer && tdat && /^\d{4}$/.test(tdat) && out.tags.date === tyer) out.tags.date = `${tyer}-${tdat.slice(2)}-${tdat.slice(0, 2)}`;
  return out;
}

export function readId3v1(b: Uint8Array): Record<string, string> | null {
  if (b.length < 128) return null; const o = b.length - 128;
  if (ascii(b, o, 3) !== "TAG") return null;
  const f = (s: number, n: number) => latin1(b.subarray(o + s, o + s + n)).replace(/\0[\s\S]*$/, "").trim();
  const t: Record<string, string> = {};
  const put = (k: string, v: string) => { if (v) t[k] = v; };
  put("title", f(3, 30)); put("artist", f(33, 30)); put("album", f(63, 30)); put("date", f(93, 4));
  if (b[o + 125] === 0 && b[o + 126]) { t.track = String(b[o + 126]); put("comment", f(97, 28)); } else put("comment", f(97, 30));
  const g = b[o + 127]; if (g < GENRES.length) t.genre = GENRES[g];
  return t;
}

/* ----------------------------------------------------------- MPEG audio ------ */

const BR = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // v1 L1
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],    // v1 L2
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],     // v1 L3
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],    // v2 L1
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],         // v2 L2/L3
];
const SR = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];

export interface MpegFrame { offset: number; version: 1 | 2 | 25; layer: number; bitrate: number; sampleRate: number; channels: number; size: number; spf: number }
export function mpegHeader(b: Uint8Array, o: number): MpegFrame | null {
  if (o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const vb = (b[o + 1] >> 3) & 3, lb = (b[o + 1] >> 1) & 3, bi = b[o + 2] >> 4, si = (b[o + 2] >> 2) & 3, pad = (b[o + 2] >> 1) & 1, mode = b[o + 3] >> 6;
  if (vb === 1 || lb === 0 || bi === 0 || bi === 15 || si === 3) return null;
  const version = vb === 3 ? 1 : vb === 2 ? 2 : 25; const layer = 4 - lb;
  const kbps = version === 1 ? BR[layer - 1][bi] : BR[layer === 1 ? 3 : 4][bi];
  const sampleRate = SR[version === 1 ? 0 : version === 2 ? 1 : 2][si];
  const spf = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const size = layer === 1 ? (Math.floor(12 * kbps * 1000 / sampleRate) + pad) * 4 : Math.floor(spf / 8 * kbps * 1000 / sampleRate) + pad;
  return { offset: o, version, layer, bitrate: kbps * 1000, sampleRate, channels: mode === 3 ? 1 : 2, size, spf };
}
/** first frame at or after `from` that is followed by a second valid frame (avoids false syncs in junk) */
function syncFrame(b: Uint8Array, from: number): MpegFrame | null {
  const lim = Math.min(b.length - 4, from + (1 << 20));
  for (let o = from; o < lim; o++) {
    if (b[o] !== 0xff) continue;
    const h = mpegHeader(b, o); if (!h) continue;
    const n = mpegHeader(b, o + h.size);
    if (n && n.version === h.version && n.layer === h.layer && n.sampleRate === h.sampleRate) return h;
    if (o + h.size >= b.length - 4) return h;
  }
  return null;
}

async function mp3(b: Uint8Array, info: AvInfo, inflate?: (d: Uint8Array) => Promise<Uint8Array>) {
  let at = 0; const id3 = await readId3v2(b, 0, inflate);
  if (id3) { at = id3.size; Object.assign(info.tags, id3.tags); info.pictures.push(...id3.pictures); info.warnings.push(...id3.warnings); }
  while (ascii(b, at, 3) === "ID3") { const more = await readId3v2(b, at, inflate); if (!more || more.size <= 10) break; at += more.size; }
  const v1 = readId3v1(b); if (v1) for (const [k, v] of Object.entries(v1)) if (!info.tags[k]) info.tags[k] = v;
  const f = syncFrame(b, at); if (!f) { info.warnings.push("mp3: no MPEG audio frame found"); return; }
  info.format = `mp${f.layer}`; info.mime = f.layer === 3 ? "audio/mpeg" : "audio/mpeg";
  info.sampleRate = f.sampleRate; info.channels = f.channels; info.codecs = [`MPEG-${f.version === 25 ? "2.5" : f.version} Layer ${["", "I", "II", "III"][f.layer]}`];
  const side = f.version === 1 ? (f.channels === 1 ? 17 : 32) : (f.channels === 1 ? 9 : 17);
  const x = f.offset + 4 + side; const tag = ascii(b, x, 4);
  let end = b.length; if (v1) end -= 128; if (ascii(b, end - 32, 8) === "APETAGEX") end -= 32 + u32le(b, end - 20);
  if (tag === "Xing" || tag === "Info") {
    const fl = u32be(b, x + 4); let p = x + 8; let frames = -1, bytes = -1;
    if (fl & 1) { frames = u32be(b, p); p += 4; } if (fl & 2) { bytes = u32be(b, p); p += 4; } if (fl & 4) p += 100; if (fl & 8) p += 4;
    if (frames > 0) {
      let samples = frames * f.spf;
      // LAME extension: encoder delay / padding (12 + 12 bits at +21) — gapless length, as decoders that honour it play
      if (/^(LAME|Lavf|Lavc|GOGO|L3.99)/.test(ascii(b, p, 4)) && p + 24 <= b.length) { const d = u24be(b, p + 21); samples -= (d >> 12) + (d & 0xfff); }
      info.duration = Math.max(0, samples) / f.sampleRate;
      const audio = bytes > 0 ? bytes : end - f.offset; info.bitrate = Math.round(audio * 8 / info.duration);
      return;
    }
  } else if (ascii(b, f.offset + 36, 4) === "VBRI") {
    const v = f.offset + 36; const bytes = u32be(b, v + 10), frames = u32be(b, v + 14);
    if (frames > 0) { info.duration = frames * f.spf / f.sampleRate; info.bitrate = Math.round(bytes * 8 / info.duration); return; }
  }
  info.bitrate = f.bitrate; info.duration = Math.max(0, end - f.offset) * 8 / f.bitrate;
}

/* ------------------------------------------------------------- Vorbis comments / FLAC / Ogg ------ */

const VC: Record<string, string> = { TITLE: "title", ARTIST: "artist", ALBUM: "album", ALBUMARTIST: "albumArtist", "ALBUM ARTIST": "albumArtist", DATE: "date", TRACKNUMBER: "track", DISCNUMBER: "disc", GENRE: "genre", COMPOSER: "composer", COMMENT: "comment", DESCRIPTION: "comment", COPYRIGHT: "copyright" };

/** returns the bytes the comment really occupies (FLAC blocks with a too-short declared size rely on this) */
function vorbisComment(d: Uint8Array, info: AvInfo, o = 0): number {
  const start = o;
  if (o + 8 > d.length) return 0;
  const vlen = u32le(d, o); o += 4 + vlen; if (o + 4 > d.length) return 0;
  const n = u32le(d, o); o += 4;
  const seen: Record<string, string[]> = {};
  for (let i = 0; i < n && o + 4 <= d.length && i < 100000; i++) {
    const l = u32le(d, o); o += 4; if (o + l > d.length) break;
    const s = utf8(d.subarray(o, o + l)); o += l;
    const eq = s.indexOf("="); if (eq <= 0) continue;
    const key = s.slice(0, eq).toUpperCase(), val = s.slice(eq + 1);
    if (key === "METADATA_BLOCK_PICTURE") { try { const bin = Uint8Array.from(atob(val), (c) => c.charCodeAt(0)); const p = flacPicture(bin); if (p) info.pictures.push(p); } catch { info.warnings.push("vorbis: bad picture"); } continue; }
    const k = VC[key]; if (!k) continue;
    (seen[k] ??= []).push(val);
  }
  for (const [k, v] of Object.entries(seen)) if (!info.tags[k]) info.tags[k] = v.join("; ");
  return o - start;
}
function flacPicture(d: Uint8Array): Picture | null { return flacPictureAt(d)?.[0] ?? null; }
function flacPictureAt(d: Uint8Array): [Picture, number] | null {
  if (d.length < 32) return null;
  const type = u32be(d, 0); let o = 4; const ml = u32be(d, o); o += 4; const mime = latin1(d.subarray(o, o + ml)); o += ml;
  const dl = u32be(d, o); o += 4; const description = utf8(d.subarray(o, o + dl)); o += dl + 16;
  const n = u32be(d, o); o += 4; if (o + n > d.length || ml > 256 || dl > d.length) return null;
  return [{ type, mime, description, data: d.subarray(o, o + n) }, o + n];
}

function flacBlocks(b: Uint8Array, at: number, info: AvInfo) {
  let o = at + 4;
  for (let guard = 0; o + 4 <= b.length && guard < 1024; guard++) {
    const h = b[o], type = h & 0x7f, len = u24be(b, o + 1), s = o + 4;
    if (s + len > b.length) { info.warnings.push("flac: metadata block overruns"); break; }
    const d = b.subarray(s, s + len);
    let used = len;
    if (type === 0 && len >= 18) {
      const sr = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4); const ch = ((d[12] >> 1) & 7) + 1; const bps = (((d[12] & 1) << 4) | (d[13] >> 4)) + 1;
      const total = (d[13] & 15) * 2 ** 32 + u32be(d, 14);
      info.sampleRate = sr; info.channels = ch; info.bitsPerSample = bps; if (sr && total) info.duration = total / sr;
    } else if (type === 4) {
      // some writers store a too-short block length: the comment's own lengths are authoritative when they overrun it
      const n = vorbisComment(b.subarray(s, Math.min(b.length, s + Math.max(len, 1 << 24))), info);
      if (n > len) { used = n; info.warnings.push("flac: VORBIS_COMMENT longer than its block header says (repaired)"); }
    } else if (type === 6) {
      const r = flacPictureAt(b.subarray(s, b.length));
      if (r) { info.pictures.push(r[0]); if (r[1] > len) { used = r[1]; info.warnings.push("flac: PICTURE longer than its block header says (repaired)"); } }
    }
    o = s + used; if (h & 0x80) break;
  }
  if (info.duration) info.bitrate = Math.round((b.length - o) * 8 / info.duration);
}

async function flac(b: Uint8Array, info: AvInfo, inflate?: (d: Uint8Array) => Promise<Uint8Array>) {
  let at = 0; const id3 = await readId3v2(b, 0, inflate); if (id3) { at = id3.size; Object.assign(info.tags, id3.tags); }
  if (ascii(b, at, 4) !== "fLaC") { info.warnings.push("flac: no fLaC marker"); return; }
  info.format = "flac"; info.mime = "audio/flac"; info.codecs = ["FLAC"];
  flacBlocks(b, at, info);
}

interface OggPage { serial: number; granule: number; flags: number; segs: number[]; data: number; end: number; truncated: boolean }
function oggPage(b: Uint8Array, o: number): OggPage | null {
  if (ascii(b, o, 4) !== "OggS" || o + 27 > b.length) return null;
  const n = b[o + 26]; if (o + 27 + n > b.length) return null;
  const segs = Array.from(b.subarray(o + 27, o + 27 + n)); const data = o + 27 + n;
  const end = data + segs.reduce((a, x) => a + x, 0);
  const lo = u32le(b, o + 6), hi = u32le(b, o + 10);
  const granule = hi === 0xffffffff && lo === 0xffffffff ? -1 : hi * 2 ** 32 + lo;
  return { serial: u32le(b, o + 14), granule, flags: b[o + 5], segs, data, end: Math.min(end, b.length), truncated: end > b.length };
}

function ogg(b: Uint8Array, info: AvInfo) {
  // packets of the first logical stream (its first two-three packets carry the identification + comments)
  const first = oggPage(b, 0); if (!first) { info.warnings.push("ogg: no page"); return; }
  // the media stream is the first beginning-of-stream page that is not an Ogg Skeleton (fishead / fisbone)
  let serial = first.serial;
  for (let o2 = 0, n = 0; o2 < b.length && n < 64; n++) {
    const p = oggPage(b, o2); if (!p || !(p.flags & 2)) break;
    if (ascii(b, p.data, 8) !== "fishead\0") { serial = p.serial; break; }
    o2 = p.end;
  } const packets: Uint8Array[] = []; let cur: number[] = []; let o = 0;
  const pieces: Uint8Array[] = [];
  while (packets.length < 3 && o < b.length) {
    const p = oggPage(b, o); if (!p) break; o = p.end;
    if (p.serial !== serial) continue;
    let q = p.data;
    for (const s of p.segs) {
      pieces.push(b.subarray(q, q + s)); q += s; cur.push(s);
      if (s < 255) { const len = pieces.reduce((a, x) => a + x.length, 0); const pk = new Uint8Array(len); let k = 0; for (const x of pieces) { pk.set(x, k); k += x.length; } packets.push(pk); pieces.length = 0; cur = []; if (packets.length >= 3) break; }
    }
  }
  const id = packets[0]; if (!id) return;
  let rate = 0, preskip = 0; let theora: { fps: number; shift: number } | null = null;
  if (ascii(id, 0, 7) === "\x01vorbis") { info.format = "ogg"; info.mime = "audio/ogg"; info.codecs = ["Vorbis"]; info.channels = id[11]; rate = info.sampleRate = u32le(id, 12); const nom = u32le(id, 20) | 0; if (nom > 0) info.bitrate = nom; if (packets[1] && ascii(packets[1], 0, 7) === "\x03vorbis") vorbisComment(packets[1], info, 7); }
  else if (ascii(id, 0, 8) === "OpusHead") { info.format = "opus"; info.mime = "audio/ogg"; info.codecs = ["Opus"]; info.channels = id[9]; preskip = u16le(id, 10); info.sampleRate = 48000; rate = 48000; if (packets[1] && ascii(packets[1], 0, 8) === "OpusTags") vorbisComment(packets[1], info, 8); }
  else if (ascii(id, 0, 8) === "Speex   ") { info.format = "spx"; info.mime = "audio/ogg"; info.codecs = ["Speex"]; rate = info.sampleRate = u32le(id, 36); info.channels = u32le(id, 48); if (packets[1]) vorbisComment(packets[1], info, 0); }
  else if (ascii(id, 0, 5) === "\x7fFLAC") {
    // Ogg FLAC mapping: 0x7F "FLAC" major minor u16 header-count, then "fLaC" + the STREAMINFO block
    info.format = "oga"; info.mime = "audio/ogg"; info.codecs = ["FLAC"];
    flacBlocks(id.subarray(9, 9 + 4 + 4 + 34), 0, info); rate = info.sampleRate ?? 0; info.duration = undefined; info.bitrate = undefined;
    if (packets[1] && (packets[1][0] & 0x7f) === 4) vorbisComment(packets[1].subarray(4), info, 0);
  }
  else if (ascii(id, 0, 7) === "\x80theora") {
    info.format = "ogv"; info.mime = "video/ogg"; info.kind = "video"; info.codecs = ["Theora"]; info.width = u24be(id, 14); info.height = u24be(id, 17);
    if (packets[1] && ascii(packets[1], 0, 7) === "\x81theora") vorbisComment(packets[1], info, 7);
    // granule = keyframe-number << KFGSHIFT | frames-since-keyframe; fps = FRN / FRD
    const frn = u32be(id, 22), frd = u32be(id, 26), shift = ((id[40] & 3) << 3) | (id[41] >> 5);
    theora = frn && frd ? { fps: frn / frd, shift } : null;
  }
  else { info.warnings.push(`ogg: unknown codec ${JSON.stringify(ascii(id, 0, 8))}`); return; }
  // duration: granule of the last page of this stream
  for (let s = b.length - 27; s >= 0 && s > b.length - (1 << 20); s--) {
    if (b[s] !== 0x4f || ascii(b, s, 4) !== "OggS") continue;
    // a page cut off by the end of the file describes samples that are not there (truncated download)
    const p = oggPage(b, s); if (!p || p.serial !== serial || p.granule < 0 || p.truncated) continue;
    if (theora) { const k = Math.floor(p.granule / 2 ** theora.shift), f = p.granule - k * 2 ** theora.shift; info.duration = (k + f) / theora.fps; }
    else if (rate) info.duration = Math.max(0, p.granule - preskip) / rate;
    break;
  }
  if (info.duration && !info.bitrate) info.bitrate = Math.round(b.length * 8 / info.duration);
}

/* ------------------------------------------------------------- WAV / AIFF ------ */

const INFO: Record<string, string> = { INAM: "title", IART: "artist", IPRD: "album", ICRD: "date", IGNR: "genre", ICMT: "comment", ITRK: "track", IPRT: "track", ICOP: "copyright" };

async function wav(b: Uint8Array, info: AvInfo, inflate?: (d: Uint8Array) => Promise<Uint8Array>) {
  info.format = "wav"; info.mime = "audio/wav";
  let o = 12, byteRate = 0, blockAlign = 0, dataSize = -1; const end = Math.min(b.length, 8 + u32le(b, 4));
  while (o + 8 <= end) {
    const id = ascii(b, o, 4), len = u32le(b, o + 4), s = o + 8;
    if (id === "fmt ") { const tag = u16le(b, s); info.codecs = [tag === 1 ? "PCM" : tag === 3 ? "IEEE float" : tag === 0xfffe ? "PCM (extensible)" : `0x${tag.toString(16)}`]; info.channels = u16le(b, s + 2); info.sampleRate = u32le(b, s + 4); byteRate = u32le(b, s + 8); blockAlign = u16le(b, s + 12); info.bitsPerSample = u16le(b, s + 14); }
    else if (id === "data") dataSize = Math.min(len, b.length - s);
    else if (id === "LIST" && ascii(b, s, 4) === "INFO") {
      let q = s + 4; while (q + 8 <= s + len) { const k = ascii(b, q, 4), n = u32le(b, q + 4); const v = latin1(b.subarray(q + 8, q + 8 + n)).replace(/\0+$/, ""); const t = INFO[k]; if (t && v && !info.tags[t]) info.tags[t] = v; q += 8 + n + (n & 1); }
    } else if (id === "id3 " || id === "ID3 ") { const t = await readId3v2(b, s, inflate); if (t) { Object.assign(info.tags, t.tags); info.pictures.push(...t.pictures); } }
    o = s + len + (len & 1);
  }
  if (dataSize >= 0 && byteRate) { const frames = blockAlign ? Math.floor(dataSize / blockAlign) : 0; info.duration = frames && info.sampleRate ? frames / info.sampleRate : dataSize / byteRate; info.bitrate = byteRate * 8; }
}

function ext80(b: Uint8Array, o: number): number {
  const e = ((b[o] & 0x7f) << 8) | b[o + 1]; const hi = u32be(b, o + 2), lo = u32be(b, o + 6);
  if (!e && !hi && !lo) return 0; const s = b[o] & 0x80 ? -1 : 1;
  return s * (hi * 2 ** 32 + lo) * 2 ** (e - 16383 - 63);
}
async function aiff(b: Uint8Array, info: AvInfo, inflate?: (d: Uint8Array) => Promise<Uint8Array>) {
  info.format = "aiff"; info.mime = "audio/aiff"; info.codecs = [ascii(b, 8, 4) === "AIFC" ? "AIFF-C" : "PCM"];
  let o = 12; const end = Math.min(b.length, 8 + u32be(b, 4));
  while (o + 8 <= end) {
    const id = ascii(b, o, 4), len = u32be(b, o + 4), s = o + 8;
    if (id === "COMM") { info.channels = u16be(b, s); const frames = u32be(b, s + 2); info.bitsPerSample = u16be(b, s + 6); info.sampleRate = ext80(b, s + 8); if (info.sampleRate) { info.duration = frames / info.sampleRate; info.bitrate = Math.round(info.sampleRate * info.channels * info.bitsPerSample); } if (len >= 22) { const c = ascii(b, s + 18, 4); if (c.trim()) info.codecs = [c]; } }
    else if (id === "NAME" || id === "AUTH" || id === "ANNO" || id === "(c) ") { const k = { NAME: "title", AUTH: "artist", ANNO: "comment", "(c) ": "copyright" }[id]!; if (!info.tags[k]) info.tags[k] = latin1(b.subarray(s, s + len)).replace(/\0+$/, ""); }
    else if (id === "ID3 " || id === "id3 ") { const t = await readId3v2(b, s, inflate); if (t) { Object.assign(info.tags, t.tags); info.pictures.push(...t.pictures); } }
    o = s + len + (len & 1);
  }
}

/* ------------------------------------------------------------- entry ------ */

export function sniffAudio(b: Uint8Array, name = ""): string | null {
  const a4 = ascii(b, 0, 4);
  if (a4 === "fLaC") return "flac";
  if (a4 === "OggS") return "ogg";
  if (a4 === "RIFF" && ascii(b, 8, 4) === "WAVE") return "wav";
  if (a4 === "FORM" && (ascii(b, 8, 4) === "AIFF" || ascii(b, 8, 4) === "AIFC")) return "aiff";
  if (ascii(b, 0, 3) === "ID3") {
    // ID3 in front of FLAC is legal; otherwise MPEG audio
    const n = 10 + syncsafe(b, 6) + (b[5] & 0x10 ? 10 : 0);
    return ascii(b, n, 4) === "fLaC" ? "flac" : "mp3";
  }
  if (mpegHeader(b, 0) && (/\.(mp[123]|mpga)$/i.test(name) || mpegHeader(b, mpegHeader(b, 0)!.size))) return "mp3";
  if (/\.(mp3|mp2)$/i.test(name)) return "mp3";
  return null;
}

export async function readAudio(b: Uint8Array, name = "", inflate?: (d: Uint8Array) => Promise<Uint8Array>): Promise<AvInfo | null> {
  const kind = sniffAudio(b, name); if (!kind) return null;
  const info: AvInfo = { format: kind, mime: "audio/" + kind, kind: "audio", codecs: [], tags: {}, pictures: [], warnings: [] };
  try {
    if (kind === "mp3") await mp3(b, info, inflate);
    else if (kind === "flac") await flac(b, info, inflate);
    else if (kind === "ogg") ogg(b, info);
    else if (kind === "wav") await wav(b, info, inflate);
    else if (kind === "aiff") await aiff(b, info, inflate);
  } catch (e) { info.warnings.push(`${kind}: ${(e as Error).message}`); }
  return info;
}
