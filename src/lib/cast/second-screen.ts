/**
 * TT140 (CA-08, LN-12) — Second-screen placement and presenter layout.
 *
 * Two capabilities that look similar and are not:
 *
 *   CA-08  Put the desktop on another physical display. The transport is
 *          `getScreenDetails()` + `window.open()` positioned on the target —
 *          zero latency, no encoding, and the receiver is our own page. It is
 *          the best cast target when one exists, and the one nobody lists.
 *
 *   LN-12  Put the presenter's camera over the slides, in one window. Both
 *          layers are already canvases, so this is a compositor geometry
 *          problem: where does the camera cutout go so it covers no content
 *          that matters?
 *
 * Both are pure geometry and policy here: no window, no screen, no canvas. The
 * caller owns the browser handles and this module owns the decisions, which is
 * the only way either can be tested without a second monitor.
 *
 * What this module deliberately does NOT claim:
 *   • It cannot see a screen it was not told about. `getScreenDetails()` needs
 *     a user permission and a user gesture; a denied permission is a first-class
 *     result here, not an error.
 *   • Window coordinates are requested, not enforced. A window manager may put
 *     the window anywhere; `verifyPlacement` reports the disagreement instead of
 *     pretending the request succeeded.
 *   • It does not composite pixels. It returns the rectangles to composite into.
 */

// ══ CA-08: second-screen placement ═══════════════════════════════════════

export interface ScreenInfo {
  /** Stable-ish identifier as reported by the browser; may be empty. */
  label: string;
  /** Usable area in CSS pixels, excluding reserved taskbars. */
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  /** True for the screen the current window is on, when the caller knows. */
  isCurrent?: boolean;
  /** Device pixel ratio, when reported. Used only to warn about scaling. */
  devicePixelRatio?: number;
  /** True when the screen has a touch digitiser. */
  touch?: boolean;
}

export type PlacementVerdict =
  | { ok: true; kind: "extended"; screen: ScreenInfo; window: PlacementWindow; reason: string }
  | { ok: false; kind: "mirrored" | "none" | "blocked"; reason: string; hint: string };

export interface PlacementWindow {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Feature string for window.open, built from the geometry above. */
  features: string;
}

/**
 * Choose the screen to extend onto.
 *
 * Order of preference, and why:
 *   1. A screen that is not the current one — that is what "second screen"
 *      means. Choosing screen[1] blindly fails when the browser orders the list
 *      differently from the desk.
 *   2. Among the others, the largest usable area, because the point of an
 *      extended display is more desk.
 *   3. If every reported screen is the current one (a mirrored setup, or a
 *      browser that reports only one), this is NOT an extended display. It says
 *      so instead of opening a window on the same screen and calling it a cast.
 */
export function chooseTargetScreen(screens: readonly ScreenInfo[]): PlacementVerdict {
  if (!screens.length) {
    return {
      ok: false, kind: "none",
      reason: "The browser reported no screens",
      hint: "getScreenDetails() needs a grant from the Window Management permission; grant it and try again.",
    };
  }
  const others = screens.filter((s) => !s.isCurrent);
  if (!others.length) {
    return {
      ok: false, kind: "mirrored",
      reason: screens.length === 1
        ? "Only one screen is reported"
        : "Every reported screen is the one this window is on (the displays are mirrored)",
      hint: "Extended mode needs the OS to present two separate displays, not a mirror.",
    };
  }
  const target = [...others].sort(
    (a, b) => b.availWidth * b.availHeight - a.availWidth * a.availHeight || a.label.localeCompare(b.label),
  )[0];
  return {
    ok: true, kind: "extended", screen: target,
    window: placementFor(target),
    reason: `Extending onto ${target.label || "the second screen"} (${target.availWidth}×${target.availHeight} at ${target.availLeft},${target.availTop})`,
  };
}

/** The window to request on a screen. Full usable area, positioned absolutely. */
export function placementFor(screen: ScreenInfo): PlacementWindow {
  const width = Math.max(320, Math.floor(screen.availWidth));
  const height = Math.max(240, Math.floor(screen.availHeight));
  // `popup=1` is what makes the coordinates and size requests rather than a tab.
  // `noopener` is deliberately NOT set: the opener must hold the handle to close
  // the display when the session ends, and the target is our own origin.
  const features = [
    "popup=1",
    `left=${Math.round(screen.availLeft)}`,
    `top=${Math.round(screen.availTop)}`,
    `width=${width}`,
    `height=${height}`,
  ].join(",");
  return { left: Math.round(screen.availLeft), top: Math.round(screen.availTop), width, height, features };
}

export interface ActualPlacement {
  screenX?: number;
  screenY?: number;
  outerWidth?: number;
  outerHeight?: number;
}

/**
 * Did the window go where it was asked to?
 *
 * Window placement is a request. On a multi-monitor desk with different scaling
 * it routinely lands elsewhere, and a UI that claims success without looking is
 * lying. Tolerance is 8 CSS px because window chrome and border width differ
 * per platform; anything larger is a real mismatch worth reporting.
 */
export function verifyPlacement(want: PlacementWindow, actual: ActualPlacement): { ok: boolean; detail: string } {
  const tolerance = 8;
  const problems: string[] = [];
  const near = (a: number, b: number | undefined) =>
    typeof b === "number" && Math.abs(a - b) <= tolerance;

  if (typeof actual.screenX === "number" && !near(want.left, actual.screenX)) {
    problems.push(`left: asked ${want.left}, got ${actual.screenX}`);
  }
  if (typeof actual.screenY === "number" && !near(want.top, actual.screenY)) {
    problems.push(`top: asked ${want.top}, got ${actual.screenY}`);
  }
  // Size is allowed to be larger than requested (chrome), never much smaller.
  if (typeof actual.outerWidth === "number" && actual.outerWidth < want.width - tolerance) {
    problems.push(`width: asked ${want.width}, got ${actual.outerWidth}`);
  }
  if (typeof actual.outerHeight === "number" && actual.outerHeight < want.height - tolerance) {
    problems.push(`height: asked ${want.height}, got ${actual.outerHeight}`);
  }
  return {
    ok: problems.length === 0,
    detail: problems.length === 0
      ? "placed as requested"
      : `placement differs (${problems.join("; ")}) — the window manager is not obliged to honour coordinates`,
  };
}

/** Warnings a person should see before trusting an extended display. */
export function placementCaveats(screens: readonly ScreenInfo[], target: ScreenInfo): string[] {
  const out: string[] = [];
  const ratios = new Set(screens.map((s) => s.devicePixelRatio ?? 1));
  if (ratios.size > 1) {
    out.push(`Displays run at different scales (${[...ratios].join(", ")}×), so text will look a different size on each.`);
  }
  if (screens.length > 2) {
    out.push(`${screens.length} displays are attached; only one is used for this session.`);
  }
  if (target.touch) out.push("The target display is a touch screen; window chrome will not scale with it.");
  if (target.availWidth < 800) out.push(`The target is only ${target.availWidth} px wide, which is narrow for a full desktop.`);
  return out;
}

// ══ LN-12: presenter layout ══════════════════════════════════════════════

export type CameraCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type PresenterMode = "off" | "camera-only" | "picture-in-picture" | "side-by-side" | "green-screen";

export interface PresenterConfig {
  mode: PresenterMode;
  corner: CameraCorner;
  /** Camera box width as a fraction of the output width, 0.1..0.5. */
  scale: number;
  /** Rounded-corner radius in output pixels. */
  radius: number;
  /** Margin from the edges, as a fraction of the output width. */
  margin: number;
  /** Mirror the camera horizontally (the convention for self-view). */
  mirror: boolean;
}

export const PRESENTER_DEFAULTS: PresenterConfig = {
  mode: "picture-in-picture",
  corner: "bottom-right",
  scale: 0.22,
  radius: 18,
  margin: 0.02,
  mirror: true,
};

export interface Rect2 { x: number; y: number; width: number; height: number }

/**
 * Where to draw each layer.
 *
 * The camera box is 4:3 in a 16:9 output by default, so its height is derived
 * from the aspect ratio rather than set equal to its width — a square cutout in
 * a widescreen show wastes a band of slide.
 *
 * `side-by-side` splits at 70/30 because a presenter column narrower than 30%
 * cannot show a head and shoulders at a readable size on a projector.
 * `green-screen` omits the camera rect entirely: the camera is a source for
 * chroma keying, not a picture, and returning a rect for it would be a lie.
 */
export function presenterLayout(
  output: { width: number; height: number },
  camera: { width: number; height: number },
  cfg: Partial<PresenterConfig> = {},
): {
  slides: Rect2 | null;
  camera: Rect2 | null;
  /** True when the whole output is the camera and slides are hidden. */
  cameraOnly: boolean;
  warnings: string[];
} {
  const c: PresenterConfig = { ...PRESENTER_DEFAULTS, ...cfg };
  if (!(output.width > 0) || !(output.height > 0)) throw new Error("Output size must be positive");
  if (!(camera.width > 0) || !(camera.height > 0)) throw new Error("Camera size must be positive");
  if (!(c.scale >= 0.1 && c.scale <= 0.5)) throw new Error("Camera scale must be 0.1..0.5 of the output width");
  if (!(c.margin >= 0 && c.margin <= 0.1)) throw new Error("Margin must be 0..0.1 of the output width");

  const warnings: string[] = [];
  const full: Rect2 = { x: 0, y: 0, width: output.width, height: output.height };
  const cameraAspect = camera.height / camera.width;

  if (c.mode === "off") {
    return { slides: full, camera: null, cameraOnly: false, warnings };
  }
  if (c.mode === "camera-only") {
    return { slides: null, camera: full, cameraOnly: true, warnings };
  }
  if (c.mode === "green-screen") {
    // The camera is keyed into the slides downstream; no rectangle is produced.
    return { slides: full, camera: null, cameraOnly: false, warnings: ["Camera is a chroma-key source; composite it above the slides with a key filter."] };
  }

  if (c.mode === "side-by-side") {
    const cameraW = Math.round(output.width * 0.3);
    const slideW = output.width - cameraW;
    if (cameraW < 240) warnings.push(`The presenter column is only ${cameraW} px wide; it will read as a thumbnail, not a person.`);
    // Fit the camera inside its column without distortion.
    const boxH = Math.min(output.height, cameraW / (camera.width / camera.height));
    return {
      slides: { x: 0, y: 0, width: slideW, height: output.height },
      camera: { x: slideW, y: Math.round((output.height - boxH) / 2), width: cameraW, height: Math.round(boxH) },
      cameraOnly: false,
      warnings,
    };
  }

  // picture-in-picture
  const w = Math.max(48, Math.round(output.width * c.scale));
  const h = Math.max(36, Math.round(w * cameraAspect));
  const m = Math.round(output.width * c.margin);
  const x = c.corner.endsWith("left") ? m : output.width - w - m;
  const y = c.corner.startsWith("top") ? m : output.height - h - m;

  if (c.scale > 0.35) warnings.push("A camera box this large covers slide content; 0.22 is the usual size.");
  // A PiP in the bottom-right of a 16:9 slide usually sits over the footer.
  if (c.corner === "bottom-right" && c.scale > 0.28) {
    warnings.push("The bottom-right corner is where slide footers and logos live; consider top-right.");
  }
  if (h > output.height * 0.5) warnings.push("The camera box is more than half the output height.");

  return {
    slides: full,
    camera: { x, y, width: w, height: h },
    cameraOnly: false,
    warnings,
  };
}

/** Move the cutout around the frame without resizing it. */
export function moveCamera(rect: Rect2, output: { width: number; height: number }, corner: CameraCorner, margin: number): Rect2 {
  const m = Math.round(output.width * margin);
  const x = corner.endsWith("left") ? m : output.width - rect.width - m;
  const y = corner.startsWith("top") ? m : output.height - rect.height - m;
  return { ...rect, x: Math.max(0, x), y: Math.max(0, y) };
}

/**
 * Does the camera box cover anything the presenter needs to see?
 * `keepClear` is the region of the slide that must stay visible (a code block,
 * a chart axis, a subtitle band). Overlap is reported, not resolved: only the
 * presenter knows whether to move the cutout or the content.
 */
export function overlapWith(rect: Rect2, keepClear: Rect2): { overlaps: boolean; area: number; fraction: number } {
  const x = Math.max(0, Math.min(rect.x + rect.width, keepClear.x + keepClear.width) - Math.max(rect.x, keepClear.x));
  const y = Math.max(0, Math.min(rect.y + rect.height, keepClear.y + keepClear.height) - Math.max(rect.y, keepClear.y));
  const area = x * y;
  const keep = keepClear.width * keepClear.height;
  return { overlaps: area > 0, area, fraction: keep > 0 ? area / keep : 0 };
}

/** A one-line description for the presenter HUD. */
export function describePresenter(cfg: PresenterConfig, layout: ReturnType<typeof presenterLayout>): string {
  if (cfg.mode === "off") return "Presenter camera off";
  if (cfg.mode === "camera-only") return "Camera full frame, slides hidden";
  if (cfg.mode === "green-screen") return "Camera keyed (green screen), slides behind";
  const cam = layout.camera;
  if (!cam) return `Presenter: ${cfg.mode}`;
  return `Presenter ${cfg.mode === "side-by-side" ? "strip" : "PiP"} · ${cam.width}×${cam.height} · ${cfg.corner} · ${cfg.mirror ? "mirrored" : "as shot"}`;
}

/**
 * Which frames the presenter should see: a 2×2 monitor wall of the output plus
 * the next slide, or just the output on a small screen. Returned as rectangles
 * so the caller can render them; the point is that the presenter's own view
 * never occupies the same surface as the audience output.
 */
export function presenterMonitorRects(output: { width: number; height: number }): {
  current: Rect2;
  next: Rect2;
  notes: Rect2;
  clock: Rect2;
} {
  const pad = Math.round(output.width * 0.02);
  const halfW = Math.floor((output.width - pad * 3) / 2);
  const halfH = Math.floor((output.height - pad * 3) / 2);
  return {
    current: { x: pad, y: pad, width: halfW, height: halfH },
    next: { x: pad * 2 + halfW, y: pad, width: halfW, height: halfH },
    notes: { x: pad, y: pad * 2 + halfH, width: halfW, height: halfH },
    clock: { x: pad * 2 + halfW, y: pad * 2 + halfH, width: halfW, height: halfH },
  };
}
