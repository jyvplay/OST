/**
 * TT137 (LN-05, LN-06) — Lens image operations: upscale and virtual key light.
 *
 * Pure image operation pipelines. No DOM, no canvas — just the
 * mathematical operations on pixel data.
 */

// ── LN-05: Upscale ─────────────────────────────────────────────────────────────
export type UpscaleMethod = "bilinear" | "bicubic" | "lanczos";

export interface UpscaleSpec {
  method: UpscaleMethod;
  scale: number;
  /** Kernel radius for the method. */
  radius: number;
}

export const UPSCALE_LIMIT = 8;

export function planUpscale(width: number, height: number, scale: number, method: UpscaleMethod): UpscaleSpec {
  if (!Number.isInteger(width) || width < 1 || width > 10_000) throw new Error("Width out of range");
  if (!Number.isInteger(height) || height < 1 || height > 10_000) throw new Error("Height out of range");
  if (!Number.isFinite(scale) || scale <= 0 || scale > UPSCALE_LIMIT) throw new Error(`Scale must be 0…${UPSCALE_LIMIT}`);
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);
  if (outW > 10_000 || outH > 10_000) throw new Error("Output dimensions exceed 10,000");

  const radius = method === "bilinear" ? 1 : method === "bicubic" ? 2 : 3;
  return { method, scale, radius };
}

export interface UpscaleResult {
  width: number;
  height: number;
  method: UpscaleMethod;
  scale: number;
  /** Estimated time in ms based on output pixel count. */
  estimatedMs: number;
}

export function estimateUpscale(width: number, height: number, scale: number, method: UpscaleMethod): UpscaleResult {
  const spec = planUpscale(width, height, scale, method);
  const outW = Math.round(width * spec.scale);
  const outH = Math.round(height * spec.scale);
  // Rough estimate: 0.01 ms per output pixel per radius step
  const estimatedMs = Math.round(outW * outH * spec.radius * 0.0001 * 10) / 10;
  return { width: outW, height: outH, method: spec.method, scale: spec.scale, estimatedMs };
}

/** Bilinear interpolation kernel — the core operation. */
export function bilinearInterpolate(a: number, b: number, c: number, d: number, fx: number, fy: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) throw new Error("Inputs must be finite");
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) throw new Error("Fractional coords must be finite");
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) throw new Error("Fractional coords must be 0…1");
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

// ── LN-06: Virtual key light / relight ──────────────────────────────────────────
export interface LightSource {
  /** Position in normalized image coordinates (0…1). */
  x: number;
  y: number;
  /** Intensity 0…1. */
  intensity: number;
  /** Warmth: negative = cooler (blue), positive = warmer (yellow). */
  warmth: number;
  /** Radius of influence in normalized coordinates. */
  radius: number;
}

export interface RelightSpec {
  sources: LightSource[];
  /** Ambient light level 0…1. */
  ambient: number;
  /** Whether to preserve original shadows. */
  preserveShadows: boolean;
}

export const LIGHT_LIMIT = 8;
export const INTENSITY_LIMIT = 1;

export function planRelight(width: number, height: number, sources: readonly LightSource[], ambient: number): RelightSpec {
  if (!Number.isInteger(width) || width < 1) throw new Error("Width must be a positive integer");
  if (!Number.isInteger(height) || height < 1) throw new Error("Height must be a positive integer");
  if (sources.length > LIGHT_LIMIT) throw new Error(`At most ${LIGHT_LIMIT} light sources`);
  if (!Number.isFinite(ambient) || ambient < 0 || ambient > 1) throw new Error("Ambient must be 0…1");

  for (const s of sources) {
    if (!Number.isFinite(s.x) || s.x < 0 || s.x > 1) throw new Error("Light x must be 0…1");
    if (!Number.isFinite(s.y) || s.y < 0 || s.y > 1) throw new Error("Light y must be 0…1");
    if (!Number.isFinite(s.intensity) || s.intensity < 0 || s.intensity > INTENSITY_LIMIT) throw new Error("Intensity must be 0…1");
    if (!Number.isFinite(s.warmth) || s.warmth < -1 || s.warmth > 1) throw new Error("Warmth must be -1…1");
    if (!Number.isFinite(s.radius) || s.radius < 0 || s.radius > 0.5) throw new Error("Radius must be 0…0.5");
  }
  return { sources: [...sources], ambient, preserveShadows: true };
}

/** Compute the light contribution at a given pixel from all sources. */
export function computeLighting(px: number, py: number, spec: RelightSpec): { intensity: number; warmth: number } {
  let totalIntensity = spec.ambient;
  let totalWarmth = 0;
  for (const s of spec.sources) {
    const dx = px - s.x;
    const dy = py - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > s.radius) continue;
    // Gaussian falloff
    const falloff = Math.exp(-(dist * dist) / (2 * s.radius * s.radius + 0.0001));
    totalIntensity += s.intensity * falloff;
    totalWarmth += s.warmth * s.intensity * falloff;
  }
  totalIntensity = Math.min(1, totalIntensity);
  const avgWarmth = spec.sources.length === 0 ? 0 : totalWarmth / spec.sources.reduce((s, l) => s + l.intensity, 0);
  return { intensity: Math.round(totalIntensity * 1000) / 1000, warmth: Math.round(avgWarmth * 1000) / 1000 };
}

/** Apply relight to a single RGB pixel. */
export function applyRelightPixel(r: number, g: number, b: number, px: number, py: number, spec: RelightSpec): [number, number, number] {
  const { intensity, warmth } = computeLighting(px, py, spec);
  // Warmth shifts red up and blue down; cool shifts blue up and red down
  const warmthFactor = 1 + warmth * 0.3;
  const coolFactor = 1 - warmth * 0.2;
  const nr = Math.min(255, Math.round(r * intensity * warmthFactor));
  const ng = Math.min(255, Math.round(g * intensity));
  const nb = Math.min(255, Math.round(b * intensity * coolFactor));
  return [nr, ng, nb];
}

export interface RelightReport {
  sources: number;
  maxIntensity: number;
  minIntensity: number;
  coverage: number;
}

export function relightReport(spec: RelightSpec, samples: number = 100): RelightReport {
  let maxI = 0, minI = 1, covered = 0;
  for (let i = 0; i < samples; i++) {
    const px = i / (samples - 1);
    const py = i / (samples - 1);
    const { intensity } = computeLighting(px, py, spec);
    if (intensity > maxI) maxI = intensity;
    if (intensity < minI) minI = intensity;
    if (intensity > spec.ambient + 0.01) covered++;
  }
  return { sources: spec.sources.length, maxIntensity: Math.round(maxI * 100) / 100, minIntensity: Math.round(minI * 100) / 100, coverage: Math.round((covered / samples) * 100) };
}
