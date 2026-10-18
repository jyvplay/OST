/**
 * TT34 MP-07: Plus Codes (Open Location Code) — original code written from the published specification
 * (github.com/google/open-location-code, Documentation/Specification/specification.md, Apache-2.0); checked by
 * scripts/tt34-unit.mts against the project's official test vectors (encoding / decoding / short codes / validity).
 *
 * Arithmetic is done on integers in the code's finest units (lat 1/2.5e7°, lng 1/8.192e6°) so digits never depend
 * on floating-point division: lat 0…180·2.5e7−1, lng 0…360·8.192e6−1.
 */

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEP = "+", PAD = "0", SEP_POS = 8, MAX_LEN = 15, PAIR_LEN = 10;
const LAT_UNITS = 2.5e7, LNG_UNITS = 8.192e6; // per degree at full (15-digit) precision
const LAT_MAX = 180 * LAT_UNITS, LNG_MAX = 360 * LNG_UNITS;
const GRID_LAT = 5, GRID_LNG = 4, GRID_ROWS = 5; // 5 grid digits after the 10 pair digits
const PAIR_UNIT_LAT = LAT_UNITS / GRID_LAT ** GRID_ROWS; // 8000 per degree
const PAIR_UNIT_LNG = LNG_UNITS / GRID_LNG ** GRID_ROWS; // 8000 per degree

/** degrees → integer units; floor, but a product within 1e-5 units of an integer counts as that integer (float noise) */
function toUnits(deg: number, offset: number, units: number): number {
  const x = (deg + offset) * units;
  const r = Math.round(x);
  return Math.abs(x - r) < 1e-5 ? r : Math.floor(x);
}

/** integer units of a location (clipped latitude, wrapped longitude), as the test vectors define them */
export function locationToIntegers(lat: number, lng: number): [number, number] {
  let la = toUnits(lat, 90, LAT_UNITS);
  la = Math.max(0, Math.min(LAT_MAX - 1, la));
  let ln = toUnits(lng, 180, LNG_UNITS);
  ln = ((ln % LNG_MAX) + LNG_MAX) % LNG_MAX;
  return [la, ln];
}

/** Encode to a Plus Code of `length` digits (2, 4, 6, 8, 10…15; default 10; longer requests are capped at 15). */
export function encode(lat: number, lng: number, length = 10): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new RangeError("latitude and longitude must be numbers");
  const len = Math.min(MAX_LEN, Math.floor(length));
  if (len < 2 || (len < PAIR_LEN && len % 2 === 1)) throw new RangeError(`invalid Plus Code length ${length}`);
  let [la, ln] = locationToIntegers(lat, lng);
  const out: string[] = new Array(MAX_LEN);
  // grid digits (positions 11–15): lat base 5, lng base 4, least significant first
  for (let i = MAX_LEN - 1; i >= PAIR_LEN; i--) {
    out[i] = ALPHABET[(la % GRID_LAT) * GRID_LNG + (ln % GRID_LNG)];
    la = Math.floor(la / GRID_LAT); ln = Math.floor(ln / GRID_LNG);
  }
  // pair digits (positions 1–10): base 20, interleaved lat, lng, least significant pair first
  for (let i = PAIR_LEN - 2; i >= 0; i -= 2) {
    out[i + 1] = ALPHABET[ln % 20]; out[i] = ALPHABET[la % 20];
    la = Math.floor(la / 20); ln = Math.floor(ln / 20);
  }
  const digits = out.slice(0, len).join("");
  if (len < SEP_POS) return digits + PAD.repeat(SEP_POS - len) + SEP;
  return `${digits.slice(0, SEP_POS)}${SEP}${digits.slice(SEP_POS)}`;
}

/* ----------------------------------------------------------------- validity */

/** Valid Plus Code (full or short) per the specification's character, separator and padding rules. */
export function isValid(raw: string): boolean {
  if (typeof raw !== "string" || !raw) return false;
  const code = raw.toUpperCase();
  const sep = code.indexOf(SEP);
  if (sep < 0 || sep !== code.lastIndexOf(SEP) || sep > SEP_POS || sep % 2 === 1) return false;
  const pad = code.indexOf(PAD);
  if (pad >= 0) {
    if (sep < SEP_POS) return false; // short codes cannot be padded
    if (pad === 0 || pad % 2 === 1) return false;
    const m = /^([^0]*)(0+)\+$/.exec(code);
    if (!m) return false; // padding must run up to the separator and nothing may follow it
    if (m[2].length % 2 === 1) return false;
  }
  if (code.length - sep - 1 === 1) return false; // a single digit after the separator
  if (code.replace(/[+0]/g, "").length < 2) return false; // "+" alone: no digits (official validity vectors)
  for (const ch of code) if (ch !== SEP && ch !== PAD && !ALPHABET.includes(ch)) return false;
  return true;
}

export const isShort = (code: string) => isValid(code) && code.indexOf(SEP) >= 0 && code.indexOf(SEP) < SEP_POS;

/** Full code: valid, not short, and its first digits decode to a legal latitude / longitude. */
export function isFull(raw: string): boolean {
  if (!isValid(raw) || isShort(raw)) return false;
  const code = raw.toUpperCase();
  if (ALPHABET.indexOf(code[0]) * 20 >= 180) return false; // first lat digit ≥ 9 → ≥ 180°
  if (code.length > 1 && ALPHABET.indexOf(code[1]) * 20 >= 360) return false; // first lng digit ≥ 18 → ≥ 360°
  return true;
}

export interface CodeArea { latLo: number; lngLo: number; latHi: number; lngHi: number; lat: number; lng: number; length: number }

/** Decode a full code to its area (SW corner, NE corner, centre) and digit count. */
export function decode(raw: string): CodeArea {
  if (!isFull(raw)) throw new RangeError(`not a full Plus Code: ${raw}`);
  const digits = raw.toUpperCase().replace(SEP, "").replace(/0+$/, "").slice(0, MAX_LEN);
  let la = 0, ln = 0;
  // pair digits
  let latPlace = LAT_UNITS * 400, lngPlace = LNG_UNITS * 400; // ÷20 before use: the first pair digit is worth 20°
  const pairs = Math.min(digits.length, PAIR_LEN);
  for (let i = 0; i < pairs; i += 2) {
    latPlace /= 20; lngPlace /= 20;
    la += ALPHABET.indexOf(digits[i]) * latPlace * 1;
    ln += ALPHABET.indexOf(digits[i + 1]) * lngPlace * 1;
  }
  let latRes = latPlace, lngRes = lngPlace;
  for (let i = PAIR_LEN; i < digits.length; i++) {
    const v = ALPHABET.indexOf(digits[i]);
    latRes /= GRID_LAT; lngRes /= GRID_LNG;
    la += Math.floor(v / GRID_LNG) * latRes;
    ln += (v % GRID_LNG) * lngRes;
  }
  const latLo = la / LAT_UNITS - 90, lngLo = ln / LNG_UNITS - 180;
  const latHi = (la + latRes) / LAT_UNITS - 90, lngHi = (ln + lngRes) / LNG_UNITS - 180;
  return { latLo, lngLo, latHi, lngHi, lat: Math.min(90, (latLo + latHi) / 2), lng: Math.min(180, (lngLo + lngHi) / 2), length: digits.length };
}

/* ----------------------------------------------------------------- short codes */

/** degrees spanned by one digit pair after removing `removed` leading digits (2 → 20°, 4 → 1°, 6 → 0.05°) */
const pairResolution = (removed: number) => 20 / 20 ** (removed / 2 - 1);
const SAFETY = 0.3; // offset must be < 0.3 × the resolution (the specification's worked example and test vectors)

/** Remove 6, 4 or 2 leading digits when the reference location is close enough; otherwise the full code. */
export function shorten(raw: string, refLat: number, refLng: number): string {
  if (!isFull(raw)) throw new RangeError(`not a full Plus Code: ${raw}`);
  const code = raw.toUpperCase();
  if (code.includes(PAD)) throw new RangeError("padded codes cannot be shortened");
  const area = decode(code);
  const ref = clipRef(refLat, refLng);
  const off = Math.max(Math.abs(area.lat - ref[0]), Math.abs(wrapLng(area.lng - ref[1])));
  // The specification's prose says "a maximum of six" digits; its official test vectors also remove EIGHT when the
  // reference is within the code's own cell neighbourhood (9C3W9QCJ+2VX → +2VX). The vectors are the arbiter;
  // eight is only removed when digits follow the separator (so the result is never the invalid bare "+").
  for (const removed of [8, 6, 4, 2]) {
    if (removed === 8 && code.length - SEP_POS - 1 < 2) continue;
    if (off < pairResolution(removed) * SAFETY) return code.slice(removed);
  }
  return code;
}

const wrapLng = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const clipRef = (lat: number, lng: number): [number, number] => [Math.max(-90, Math.min(90, lat)), wrapLng(lng)];

/** The nearest full code matching a short code, relative to a reference location (a full code is returned as is). */
export function recoverNearest(raw: string, refLat: number, refLng: number): string {
  if (!isShort(raw)) {
    if (isFull(raw)) return raw.toUpperCase();
    throw new RangeError(`not a valid short Plus Code: ${raw}`);
  }
  const code = raw.toUpperCase();
  const [rLat, rLng] = clipRef(refLat, refLng);
  const removed = SEP_POS - code.indexOf(SEP);
  const res = pairResolution(removed);
  const half = res / 2;
  const prefix = encode(rLat, rLng).slice(0, removed);
  const area = decode(prefix + code);
  let lat = area.lat, lng = area.lng;
  // move by one resolution step when the candidate's centre is more than half a step from the reference
  if (rLat + half < lat && lat - res >= -90) lat -= res;
  else if (rLat - half > lat && lat + res <= 90) lat += res;
  if (rLng + half < lng) lng -= res;
  else if (rLng - half > lng) lng += res;
  return encode(lat, lng, area.length);
}

/** Find a Plus Code inside free text ("8FVC9G8F+6W", "9G8F+6W Zürich"); returns the code and the rest. */
export function findCode(text: string): { code: string; rest: string } | null {
  const m = /(^|\s)([23456789CFGHJMPQRVWX0]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})(?=\s|,|$)/i.exec(text.trim());
  if (!m || !isValid(m[2])) return null;
  return { code: m[2].toUpperCase(), rest: (text.trim().slice(0, m.index) + text.trim().slice(m.index + m[0].length)).replace(/^[\s,]+|[\s,]+$/g, "") };
}
