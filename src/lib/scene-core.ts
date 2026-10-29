/**
 * LN-09 — Scenes: the geometry and motion of the animated desktop backgrounds, with no DOM in it.
 *
 * Everything here is a pure function of (scene id, seed, size, time, pointer). That is deliberate:
 * a background that only exists as pixels can only be checked by looking at it, whereas this one
 * can be asserted on numerically — layer count, parallax ratios, determinism across reloads, the
 * clamping that keeps a scene inside its box — and then drawn by a thin renderer.
 *
 * The scenes are built from a seeded generator rather than from image assets, so a desktop costs a
 * few hundred numbers instead of a download, nothing is fetched, and the same seed gives the same
 * scene on every machine. The one scene that does use a picture reads it from the local VFS.
 *
 * Privacy: no network, no device sensors, no pointer history kept. Parallax reads the current
 * pointer position only, as a fraction of the viewport, and the renderer discards it each frame.
 */

export const SCENES = [
  { id: "off", label: "None", motion: false },
  { id: "drift", label: "Drift — slow bokeh in depth", motion: true },
  { id: "ridge", label: "Ridges — layered parallax hills", motion: true },
  { id: "aurora", label: "Aurora — soft bands", motion: true },
  { id: "image", label: "Your picture, with parallax", motion: true },
] as const;
export type SceneId = (typeof SCENES)[number]["id"];
export const SCENE_IDS = SCENES.map((s) => s.id) as readonly string[];
export const isScene = (v: string): v is SceneId => SCENE_IDS.includes(v);
export const DEFAULT_SCENE: SceneId = "off";

/**
 * A small deterministic generator, written for this file.
 *
 * Requirements are narrow: identical output for an identical seed, a usable spread over [0,1), and
 * no dependency. This is a 32-bit xorshift whose state is advanced before use and folded down with
 * a multiply, so the low bits move as well as the high ones. It is not a cryptographic generator
 * and nothing here asks it to be one - it decides where to put a blob of light.
 */
export function seededRandom(seed: number): () => number {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    // Multiply-fold: the raw xorshift word has weak low bits for small seeds.
    const x = Math.imul(s ^ (s >>> 15), 0x2545f491) >>> 0;
    return x / 4294967296;
  };
}

/** A stable 32-bit seed from a string, so "the same wallpaper choice" means "the same scene". */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export interface Blob { x: number; y: number; r: number; hue: number; alpha: number; phase: number; speed: number }
export interface Ridge { y: number; amplitude: number; wavelength: number; phase: number; hue: number }
export interface SceneLayer {
  /** 0 = far away (barely moves), 1 = nearest (moves most). Parallax scales with this. */
  depth: number;
  blobs: Blob[];
  ridges: Ridge[];
}
export interface SceneModel { id: SceneId; layers: SceneLayer[]; seed: number }

/** Per-scene layer counts. Three is enough to read as depth and cheap enough to animate. */
const LAYERS: Record<Exclude<SceneId, "off">, number> = { drift: 3, ridge: 4, aurora: 3, image: 2 };

/**
 * Build the scene. Pure: same arguments, same model, every time — which is what lets a test assert
 * that reloading the desktop does not reshuffle the background.
 */
export function buildScene(id: SceneId, seed: number): SceneModel {
  if (id === "off") return { id, layers: [], seed };
  const count = LAYERS[id];
  const rnd = seededRandom(seed);
  const layers: SceneLayer[] = [];
  for (let i = 0; i < count; i++) {
    const depth = count === 1 ? 1 : i / (count - 1);
    const blobs: Blob[] = [];
    const ridges: Ridge[] = [];
    if (id === "drift" || id === "aurora" || id === "image") {
      // Nearer layers carry fewer, larger shapes: the same trick a lens does, and it keeps the
      // total number of drawn shapes roughly constant as depth increases.
      const n = id === "image" ? 3 + i * 2 : Math.max(3, Math.round(10 - depth * 5));
      for (let k = 0; k < n; k++) {
        blobs.push({
          x: rnd(), y: rnd(),
          r: (id === "aurora" ? 0.30 : 0.06) + rnd() * (0.08 + depth * 0.16),
          hue: Math.round(rnd() * 360),
          alpha: (id === "image" ? 0.05 : 0.10) + rnd() * (0.16 - depth * 0.05),
          phase: rnd() * Math.PI * 2,
          speed: 0.02 + rnd() * 0.05 + depth * 0.05,
        });
      }
    }
    if (id === "ridge") {
      ridges.push({
        y: 0.45 + depth * 0.4,
        amplitude: 0.03 + (1 - depth) * 0.08,
        wavelength: 0.4 + rnd() * 0.9,
        phase: rnd() * Math.PI * 2,
        hue: Math.round(rnd() * 70) + 190,
      });
    }
    layers.push({ depth, blobs, ridges });
  }
  return { id, layers, seed };
}

/** The strongest a scene may shift, as a fraction of the viewport. Small on purpose: a background
 *  that lurches is a distraction, and a large shift would expose the un-drawn edge of a layer. */
export const PARALLAX_MAX = 0.04;

/**
 * Pointer position → layer offset, in viewport fractions.
 *
 * `pointer` is the pointer's position as a fraction of the viewport, so (0.5, 0.5) is the centre
 * and the offset there is exactly zero in both axes for every layer. The near layers move most.
 * Inputs outside [0,1] are clamped rather than rejected: a pointer leaving the window should stop
 * the scene at its limit, not throw or snap back to centre.
 */
export function parallaxOffset(depth: number, pointer: { x: number; y: number }): { dx: number; dy: number } {
  const cx = Math.min(1, Math.max(0, pointer.x)) - 0.5;
  const cy = Math.min(1, Math.max(0, pointer.y)) - 0.5;
  const d = Math.min(1, Math.max(0, depth));
  return { dx: -cx * 2 * PARALLAX_MAX * d + 0, dy: -cy * 2 * PARALLAX_MAX * d + 0 };
}

/**
 * Where a blob is at time t, including its own drift and the parallax of its layer.
 * The drift is a closed loop (sine in both axes), so a scene never wanders off and never needs
 * resetting - it can run for a day and stay inside its box.
 */
export function blobAt(b: Blob, depth: number, tSeconds: number, pointer: { x: number; y: number }): { x: number; y: number; r: number } {
  const { dx, dy } = parallaxOffset(depth, pointer);
  const a = b.phase + tSeconds * b.speed;
  return {
    x: b.x + Math.sin(a) * 0.03 + dx,
    y: b.y + Math.cos(a * 0.8) * 0.02 + dy,
    r: b.r,
  };
}

/** Height of a ridge at horizontal fraction u, in viewport fractions. */
export function ridgeAt(r: Ridge, u: number, tSeconds: number, depth: number, pointer: { x: number; y: number }): number {
  const { dy } = parallaxOffset(depth, pointer);
  return r.y + dy + Math.sin((u / r.wavelength) * Math.PI * 2 + r.phase + tSeconds * 0.05) * r.amplitude;
}

/**
 * The frame budget a scene may use.
 *
 * A desktop background is the least important thing on screen, so it yields first: the shell's
 * governor reports pressure, the document can be hidden, and the human can ask for less motion.
 * Any of those drops the scene to a single static frame rather than a slower animation — a
 * half-speed background still costs a composite every frame, and a still one costs nothing.
 */
export function sceneFps(opts: { reducedMotion: boolean; hidden: boolean; throttled: boolean; motionSetting: "system" | "on" | "off" }): number {
  if (opts.hidden) return 0;
  if (opts.motionSetting === "off") return 0;
  if (opts.motionSetting !== "on" && opts.reducedMotion) return 0;
  if (opts.throttled) return 0;
  return 30;
}

/** cover-fit: the scale and offsets that fill `box` with `img` without distorting it. */
export function coverFit(img: { w: number; h: number }, box: { w: number; h: number }): { w: number; h: number; x: number; y: number } {
  if (img.w <= 0 || img.h <= 0 || box.w <= 0 || box.h <= 0) return { w: box.w, h: box.h, x: 0, y: 0 };
  const scale = Math.max(box.w / img.w, box.h / img.h);
  const w = img.w * scale, h = img.h * scale;
  return { w, h, x: (box.w - w) / 2, y: (box.h - h) / 2 };
}

/** A scene image must be a picture already in the VFS; no URLs, no remote fetches. */
export function validSceneImage(path: string): boolean {
  return /^\/[^\u0000-\u001f\u007f]{1,480}\.(png|jpe?g|webp|gif|avif)$/i.test(path) && path === path.replace(/\/{2,}/g, "/") && !path.includes("/../");
}
