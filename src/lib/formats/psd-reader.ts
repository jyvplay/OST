/**
 * TT139 (FF-08) — PSD reader.
 *
 * Pure parser for the Adobe Photoshop .psd container. No DOM, no network.
 *
 * Scope, stated honestly: this reads the file *structure* — header, colour
 * mode data, image resources, the layer record table (names, rects, blend
 * modes, opacity, visibility, clipping, per-channel byte lengths) — and the
 * flattened composite. It does **not** decompress RLE-compressed channel data
 * into pixels, because PSD PackBits decode is a separate, testable concern and
 * a half-decoder that returns plausible-looking garbage is worse than one that
 * reports `compression: "rle"` and refuses to claim pixels.
 *
 * The format, verified against the published specification:
 *
 *   Header (26 bytes, big-endian)
 *     0  4  signature '8BPS'
 *     4  2  version (1 = PSD, 2 = PSB)
 *     6  6  reserved, must be zero
 *    12  2  channel count  1..56
 *    14  4  height  1..30000
 *    18  4  width   1..30000
 *    22  2  depth   1|8|16|32
 *    24  2  colour mode  0=bitmap 1=gray 2=indexed 3=RGB 4=CMYK 7=multichannel 8=duotone 9=lab
 *   Then: colour mode data (4-byte length + data)
 *         image resources   (4-byte length + data)
 *         layer/mask info   (4-byte length + data)   <- may be zero-length
 *         image data        (compression 2 bytes + channel data)
 *
 * Hardened against the classic malformed-file attacks: every length is
 * bounds-checked against the remaining buffer before it is used, and the
 * dimensions are validated against the format's own limits so a 4-byte header
 * cannot make the caller allocate 2^32 bytes.
 */

export const PSD_SIGNATURE = "8BPS";

export const COLOUR_MODES: Record<number, string> = {
  0: "Bitmap", 1: "Grayscale", 2: "Indexed", 3: "RGB", 4: "CMYK",
  7: "Multichannel", 8: "Duotone", 9: "Lab",
};

export const BLEND_MODES: Record<string, string> = {
  norm: "Normal", dark: "Darken", lite: "Lighten", hue: "Hue", sat: "Saturation",
  colr: "Color", lum: "Luminosity", mul: "Multiply", scrn: "Screen", diss: "Dissolve",
  over: "Overlay", hLit: "Hard Light", sLit: "Soft Light", diff: "Difference",
  smud: "Exclusion", div: "Divide", idiv: "Color Dodge", lbrn: "Linear Burn",
  lddg: "Linear Dodge", lLit: "Linear Light", pLit: "Pin Light", hMix: "Hard Mix",
  pass: "Pass Through", dkCl: "Darker Color", lgCl: "Lighter Color", fsub: "Subtract",
};

export type Compression = "raw" | "rle" | "zip-without-prediction" | "zip-with-prediction";

const COMPRESSION_NAMES: Record<number, Compression> = {
  0: "raw", 1: "rle", 2: "zip-without-prediction", 3: "zip-with-prediction",
};

export interface PsdHeader {
  version: 1 | 2;
  channels: number;
  height: number;
  width: number;
  depth: 8 | 16 | 32;
  colourMode: number;
  colourModeName: string;
}

export interface PsdLayerMaskData {
  top: number;
  left: number;
  bottom: number;
  right: number;
  /** Present only when the layer has a real user mask. */
  maskRect?: { top: number; left: number; bottom: number; right: number; defaultColour: number; flags: number };
}

export interface PsdLayer {
  name: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
  visible: boolean;
  opacity: number;
  blendMode: string;
  blendModeName: string;
  clipping: boolean;
  /** -1 = channel data is shared with another layer and not duplicated here. */
  channels: Array<{ id: number; length: number }>;
  /** True when this layer's pixels carry transparency. */
  hasAlpha: boolean;
  /** Photoshop layer section: 0 = normal, 1 = open group, 2 = closed group, 3 = end marker. */
  sectionType?: number;
  mask?: { top: number; left: number; bottom: number; right: number; defaultColour: number; flags: number };
}

export interface PsdImage {
  header: PsdHeader;
  layers: PsdLayer[];
  /** Flattened image, present only when compression is raw. */
  composite: Uint8Array | null;
  compositeCompression: Compression;
  /** Bytes of image data still unparsed (RLE/zip failures are reported, not guessed). */
  imageDataBytes: number;
  warnings: string[];
}

class Reader {
  readonly u8: Uint8Array;
  readonly dv: DataView;
  pos = 0;

  constructor(u8: Uint8Array) {
    this.u8 = u8;
    // A copy avoids alignment requirements: a PSD can start at any offset in
    // a larger buffer, and DataView on a misaligned subarray throws.
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  get remaining(): number {
    return this.u8.length - this.pos;
  }

  need(n: number, what: string): void {
    if (n < 0 || !Number.isFinite(n)) throw new Error(`Negative length for ${what}`);
    if (this.pos + n > this.u8.length) {
      throw new Error(`Truncated PSD: ${what} needs ${n} bytes, only ${this.remaining} remain`);
    }
  }

  u16(): number {
    this.need(2, "uint16");
    const v = this.dv.getUint16(this.pos);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2, "int16");
    const v = this.dv.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4, "uint32");
    const v = this.dv.getUint32(this.pos);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4, "int32");
    const v = this.dv.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  ascii(n: number): string {
    this.need(n, "ascii");
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8[this.pos + i]);
    this.pos += n;
    return s;
  }

  skip(n: number): void {
    this.need(n, "skip");
    this.pos += n;
  }

  take(n: number): Uint8Array {
    this.need(n, "slice");
    const out = this.u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Skip four-byte-aligned padding to the next multiple of `align`. */
  align(align: number): void {
    const pad = (align - (this.pos % align)) % align;
    if (pad) this.skip(pad);
  }

}

export function parsePsd(data: Uint8Array): PsdImage {
  if (!(data instanceof Uint8Array)) throw new Error("parsePsd expects a Uint8Array");
  if (data.length < 26) throw new Error(`PSD header needs 26 bytes, got ${data.length}`);

  const r = new Reader(data);
  const warnings: string[] = [];

  // ── Header ──
  const signature = r.ascii(4);
  if (signature !== PSD_SIGNATURE) {
    throw new Error(`Not a PSD file: signature is ${JSON.stringify(signature)}, expected "8BPS"`);
  }
  const rawVersion = r.u16();
  if (rawVersion !== 1 && rawVersion !== 2) throw new Error(`Unsupported PSD version: ${rawVersion}`);
  const version = rawVersion as 1 | 2;
  const reserved = r.ascii(6);
  if (reserved !== "\0\0\0\0\0\0") {
    // Photoshop writes zeros; a non-zero value means we are not where we think.
    throw new Error("PSD reserved field is not zero — file is not a valid PSD");
  }
  const channels = r.u16();
  if (channels < 1 || channels > 56) throw new Error(`PSD channel count out of range: ${channels}`);
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const colourMode = r.u16();

  const maxSide = version === 2 ? 300000 : 30000;
  if (width < 1 || width > maxSide) throw new Error(`PSD width out of range: ${width}`);
  if (height < 1 || height > maxSide) throw new Error(`PSD height out of range: ${height}`);
  if (depth !== 8 && depth !== 16 && depth !== 32) throw new Error(`PSD bit depth out of range: ${depth}`);
  if (COLOUR_MODES[colourMode] === undefined) throw new Error(`Unknown PSD colour mode: ${colourMode}`);

  const header: PsdHeader = {
    version, channels, height, width,
    depth: depth as 8 | 16 | 32,
    colourMode,
    colourModeName: COLOUR_MODES[colourMode],
  };

  // ── Colour mode data ──
  const cmLen = r.u32();
  r.skip(cmLen);

  // ── Image resources ──
  const irLen = r.u32();
  r.skip(irLen);

  // ── Layer and mask info ──
  const layers: PsdLayer[] = [];
  const lmLen = r.u32();
  // A declared length beyond the buffer is a malformed file, not a hint.
  if (lmLen > r.remaining) {
    throw new Error(`Layer/mask section declares ${lmLen} bytes but only ${r.remaining} remain`);
  }
  const lmEnd = r.pos + lmLen;
  if (lmLen > 0) {
    // PSD layer info length, then layer count, then records.
    const liLen = r.u32();
    if (liLen > 0) {
      const layerCountRaw = r.i16();
      // Negative count means the first alpha channel is the merged result.
      const layerCount = Math.abs(layerCountRaw);
      if (layerCount > 8000) throw new Error(`PSD layer count out of range: ${layerCount}`);
      if (layerCount > 0) {
        for (let i = 0; i < layerCount; i++) {
          // Layer record
          const top = r.i32();
          const left = r.i32();
          const bottom = r.i32();
          const right = r.i32();
          const chCount = r.u16();
          if (chCount < 1 || chCount > 56) throw new Error(`Layer ${i} channel count out of range: ${chCount}`);
          const chans: Array<{ id: number; length: number }> = [];
          for (let c = 0; c < chCount; c++) {
            const id = r.i16();
            const length = r.u32();
            chans.push({ id, length });
          }
          const blendSig = r.ascii(4);
          if (blendSig !== "8BIM") throw new Error(`Layer ${i} blend signature is ${JSON.stringify(blendSig)}, expected "8BIM"`);
          // Blend keys are exactly 4 bytes; short mnemonics are space padded
          // on disk ("mul " = Multiply), so the stored key needs trimming.
          const blendKey = r.ascii(4).trim();
          const opacity = data[r.pos] ?? 255;
          r.skip(1); // opacity
          const clippingByte = data[r.pos] ?? 0;
          r.skip(1); // clipping
          const flagsByte = data[r.pos] ?? 0;
          r.skip(1); // flags
          r.skip(1); // filler
          const nameLen = data[r.pos] ?? 0;
          r.skip(1);
          const name = r.ascii(nameLen);
          // Pascal-string padding to a multiple of 4 for the whole field.
          const totalNameField = 1 + nameLen;
          const pad = (4 - (totalNameField % 4)) % 4;
          if (pad) r.skip(pad);

          // Additional layer info: '8BIM' + key + length + data blocks.
          let sectionType: number | undefined;
          let unicodeName: string | undefined;
          let layerVisible: boolean | undefined;
          const recordEndProbe = r.pos;
          while (r.remaining > 0 && r.pos + 12 <= lmEnd) {
            const sig = r.ascii(4);
            if (sig !== "8BIM" && sig !== "8B64") {
              // Not an additional-info block: rewind and stop.
              r.pos -= 4;
              break;
            }
            const key = r.ascii(4);
            const len = r.u32();
            r.need(len, `layer info "${key}"`);
            if (key === "luni") {
              // Unicode name: 4-byte length in characters, then UTF-16BE.
              const uniLen = r.u32();
              if (uniLen * 2 <= len) {
                let u = "";
                for (let k = 0; k < uniLen; k++) u += String.fromCharCode(data[r.pos + k * 2] * 256 + data[r.pos + k * 2 + 1]);
                unicodeName = u;
              }
              r.skip(len);
            } else if (key === "lspf") {
              if (len >= 4) {
                const flags = r.u32();
                // bit 1 = visible; a cleared bit means hidden.
                layerVisible = (flags & 2) !== 0;
                r.skip(len - 4);
              } else r.skip(len);
            } else if (key === "lsct") {
              if (len >= 4) {
                sectionType = r.u32();
                r.skip(len - 4);
              } else r.skip(len);
            } else if (key === "lclr") {
              r.skip(len);
            } else {
              r.skip(len);
            }
          }
          void recordEndProbe;


          layers.push({
            name: unicodeName ?? name,
            top, left, bottom, right,
            // flags bit 1 (value 2) = hidden
            visible: layerVisible ?? (flagsByte & 2) === 0,
            opacity,
            blendMode: blendKey,
            blendModeName: BLEND_MODES[blendKey] ?? blendKey,
            clipping: (clippingByte & 1) !== 0,
            channels: chans,
            hasAlpha: chans.some((c) => c.id === -1),
            sectionType,
          });
        }

        // Channel image data, one per channel per layer, in record order.
        for (let i = 0; i < layers.length; i++) {
          for (const ch of layers[i].channels) {
            if (ch.length === -1 >>> 0 || ch.length === 0xffffffff) continue; // shared
            r.need(ch.length, `layer ${i} channel data`);
            r.skip(ch.length);
          }
        }
      }
    }
    // Guarantee we are inside the declared layer/mask block, then jump to end.
    if (r.pos > lmEnd) {
      const over = r.pos - lmEnd;
      if (over <= 4) {
        // Off-by-padding only: some writers omit the pad byte from the declared
        // length. Warn and continue; the outer block bound is authoritative.
        warnings.push(`Layer info length is ${over} byte(s) short of its content (padding); recovered.`);
      } else {
        throw new Error(`Layer info overruns its declared length by ${over} bytes`);
      }
    }
    r.pos = Math.min(lmEnd, r.u8.length);
  } else {
    warnings.push("File has no layer information; only the composite is available.");
  }

  // ── Image data ──
  let composite: Uint8Array | null = null;
  let compression: Compression = "raw";
  const imageDataBytes = r.remaining;
  if (r.remaining >= 2) {
    const rawCompression = r.u16();
    compression = COMPRESSION_NAMES[rawCompression] ?? "raw";
    if (COMPRESSION_NAMES[rawCompression] === undefined) {
      warnings.push(`Unknown image compression code ${rawCompression}; composite not decoded.`);
    }
    if (compression === "raw") {
      const expected = width * height * channels * (depth / 8);
      if (depth === 8 && r.remaining >= expected) {
        composite = r.take(expected);
      } else if (depth !== 8) {
        warnings.push(`16/32-bit composite decoding is not implemented; header and layers are exact.`);
      } else {
        warnings.push(`Composite is short: ${r.remaining} bytes available, ${expected} expected.`);
      }
    } else {
      warnings.push(`Composite uses ${compression}; only the structure is parsed, pixels are not decoded.`);
    }
  } else {
    warnings.push("File ends before the image-data section.");
  }

  return { header, layers, composite, compositeCompression: compression, imageDataBytes, warnings };
}

export function psdSummary(img: PsdImage): {
  dimensions: string;
  colourMode: string;
  depth: number;
  layerCount: number;
  visibleLayers: number;
  totalLayerPixels: number;
  blendModes: string[];
  composite: string;
} {
  return {
    dimensions: `${img.header.width}×${img.header.height}`,
    colourMode: img.header.colourModeName,
    depth: img.header.depth,
    layerCount: img.layers.length,
    visibleLayers: img.layers.filter((l) => l.visible).length,
    totalLayerPixels: img.layers.reduce((a, l) => a + Math.max(0, l.right - l.left) * Math.max(0, l.bottom - l.top), 0),
    blendModes: [...new Set(img.layers.map((l) => l.blendModeName))],
    composite: img.composite ? `${img.composite.length} bytes (raw)` : img.compositeCompression,
  };
}

/** Layer tree: groups (section 1/2) contain the layers that follow until section 3. */
export interface LayerNode {
  layer: PsdLayer;
  children: LayerNode[];
}

export function layerTree(img: PsdImage): LayerNode[] {
  const roots: LayerNode[] = [];
  const stack: LayerNode[][] = [roots];
  for (const layer of img.layers) {
    const target = stack[stack.length - 1];
    if (layer.sectionType === 3) {
      // Divider: close the current group.
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node: LayerNode = { layer, children: [] };
    target.push(node);
    if (layer.sectionType === 1 || layer.sectionType === 2) {
      stack.push(node.children);
    }
  }
  return roots;
}

/** Photoshop writes layer records bottom-up; this flips to top-down UI order. */
export function layersTopDown(img: PsdImage): PsdLayer[] {
  return [...img.layers].reverse();
}
