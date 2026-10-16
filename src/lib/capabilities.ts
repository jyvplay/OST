/**
 * Capability probe (DP-10 / RG-07).
 *
 * The Android spec probes the OS. On the web the *browser* is the OS, and the
 * variance is larger: the same device gives different capability sets in
 * Chrome, Firefox and Safari. Every blocked feature row in the Spec module is
 * justified by one of these entries, so the honesty claim is checkable at run
 * time instead of being a promise in a document.
 */

export interface Capability {
  id: string;
  label: string;
  group: string;
  available: boolean;
  detail: string;
  /** what the shell does when this is missing */
  degrade: string;
}

export interface CapabilityReport {
  generatedAt: number;
  ua: string;
  secureContext: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  languages: string[];
  pointerCoarse: boolean;
  prefersDark: boolean;
  prefersReducedMotion: boolean;
  screens: { count: number | "unknown"; width: number; height: number; dpr: number; colorDepth: number };
  capabilities: Capability[];
}

type Nav = Navigator & Record<string, unknown>;
type Win = Window & Record<string, unknown>;

const has = (obj: unknown, key: string) => Boolean(obj && key in (obj as object));

export function probeCapabilities(): CapabilityReport {
  const nav = (typeof navigator !== "undefined" ? navigator : {}) as Nav;
  const win = (typeof window !== "undefined" ? window : {}) as Win;
  const media = (q: string) => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false);

  const cap = (id: string, label: string, group: string, available: boolean, detail: string, degrade: string): Capability =>
    ({ id, label, group, available, detail, degrade });

  const videoEl = typeof document !== "undefined" ? document.createElement("video") : null;

  const capabilities: Capability[] = [
    // --- windowing / display
    cap("documentPiP", "Document Picture-in-Picture", "Windowing", has(win, "documentPictureInPicture"),
      "window.documentPictureInPicture", "Pop-out windows fall back to window.open popups (no always-on-top)."),
    cap("multiScreen", "Multi-screen window placement", "Windowing", has(win, "getScreenDetails"),
      "window.getScreenDetails()", "Second-screen desktop (BlackTop) degrades to a manually moved popup."),
    cap("fullscreen", "Fullscreen", "Windowing", typeof document !== "undefined" && Boolean(document.documentElement.requestFullscreen),
      "Element.requestFullscreen", "Immersive mode unavailable."),
    cap("keyboardLock", "Keyboard Lock (system chords)", "Windowing", has(nav, "keyboard") && has(nav.keyboard as object, "lock"),
      "navigator.keyboard.lock()", "Browser-reserved chords (Ctrl+T/W/N, Meta) cannot reach the shell; only non-reserved bindings work."),
    cap("keyboardMap", "Keyboard layout map", "Input", has(nav, "keyboard") && has(nav.keyboard as object, "getLayoutMap"),
      "navigator.keyboard.getLayoutMap()", "Shortcut labels show US-QWERTY key names."),
    cap("pointerLock", "Pointer lock", "Input", typeof document !== "undefined" && "requestPointerLock" in Element.prototype,
      "Element.requestPointerLock", "Cursor confinement during multi-screen drags is unavailable."),
    cap("wco", "Window Controls Overlay", "Windowing", has(nav, "windowControlsOverlay"),
      "navigator.windowControlsOverlay", "Top bar renders as an in-page bar instead of the title bar."),
    cap("wakeLock", "Screen wake lock", "Windowing", has(nav, "wakeLock"),
      "navigator.wakeLock", "The screen may sleep during presentations and recordings."),
    cap("vk", "VirtualKeyboard insets", "Input", has(nav, "virtualKeyboard"),
      "navigator.virtualKeyboard", "On-screen keyboard overlaps windows instead of re-tiling them."),

    // --- storage / files
    cap("fsAccess", "File System Access", "Storage", has(win, "showOpenFilePicker"),
      "showOpenFilePicker / showDirectoryPicker", "Local folders cannot be mounted; upload/download only."),
    cap("opfs", "Origin private file system", "Storage", has(nav, "storage") && has(nav.storage as object, "getDirectory"),
      "navigator.storage.getDirectory()", "Large local caches unavailable; server VFS only."),
    cap("storageEstimate", "Storage quota estimate", "Storage", has(nav, "storage") && has(nav.storage as object, "estimate"),
      "navigator.storage.estimate()", "Quota pressure cannot be reported."),
    cap("persist", "Persistent storage", "Storage", has(nav, "storage") && has(nav.storage as object, "persist"),
      "navigator.storage.persist()", "The browser may evict local data without warning."),
    cap("compression", "Compression streams", "Storage", has(win, "DecompressionStream"),
      "DecompressionStream('deflate-raw')", "Client-side archive browsing falls back to the server parser."),

    // --- media / cast
    cap("remotePlayback", "Remote Playback (AirPlay / Cast)", "Beam", videoEl ? "remote" in videoEl : false,
      "HTMLMediaElement.remote", "No first-party route to an AirPlay/Cast receiver; only second-window cast remains."),
    cap("airplaySafari", "Safari AirPlay target picker", "Beam", has(win, "WebKitPlaybackTargetAvailabilityEvent"),
      "webkitShowPlaybackTargetPicker", "Use the Remote Playback path if present."),
    cap("presentation", "Presentation API", "Beam", has(nav, "presentation"),
      "navigator.presentation / PresentationRequest", "Casting a URL to a second screen requires a manually opened window."),
    cap("pip", "Video picture-in-picture", "Beam", typeof document !== "undefined" && "pictureInPictureEnabled" in document && Boolean(document.pictureInPictureEnabled),
      "HTMLVideoElement.requestPictureInPicture", "Floating video unavailable."),
    cap("displayCapture", "Screen capture", "Media", has(nav, "mediaDevices") && has(nav.mediaDevices as object, "getDisplayMedia"),
      "getDisplayMedia()", "Capture Studio, presenter mode and screen share are disabled."),
    cap("userMedia", "Camera / microphone", "Media", has(nav, "mediaDevices") && has(nav.mediaDevices as object, "getUserMedia"),
      "getUserMedia()", "Lens and recording are disabled."),
    cap("setSinkId", "Per-element audio output routing", "Media", videoEl ? "setSinkId" in videoEl : false,
      "HTMLMediaElement.setSinkId", "Audio always follows the system default device."),
    cap("mediaRecorder", "MediaRecorder", "Media", has(win, "MediaRecorder"),
      "MediaRecorder", "Recording unavailable; live preview only."),
    cap("webCodecs", "WebCodecs (hardware encode/decode)", "Media", has(win, "VideoEncoder"),
      "VideoEncoder / VideoDecoder", "Encoding uses MediaRecorder defaults; no explicit hardware selection."),
    cap("mediaSession", "Media Session (OS media keys)", "Media", has(nav, "mediaSession"),
      "navigator.mediaSession", "OS media keys and lock-screen art unavailable."),
    cap("imageDecoderHeic", "HEIC decode", "Formats",
      typeof win.ImageDecoder === "function" ? false : false,
      "ImageDecoder.isTypeSupported('image/heic') — resolved asynchronously", "HEIC files are listed but not rendered."),
    cap("eyeDropper", "EyeDropper", "Media", has(win, "EyeDropper"),
      "new EyeDropper()", "Colour picking is limited to our own canvases."),
    cap("barcode", "BarcodeDetector", "Media", has(win, "BarcodeDetector"),
      "BarcodeDetector", "QR scanning falls back to manual entry."),
    cap("faceDetector", "FaceDetector", "Lens", has(win, "FaceDetector"),
      "FaceDetector", "Auto-framing and the subject matte use a manual/centred ellipse instead of a detected face."),

    // --- peripherals / platform
    cap("webhid", "WebHID", "Peripherals", has(nav, "hid"), "navigator.hid", "HID peripherals cannot be configured."),
    cap("webusb", "WebUSB", "Peripherals", has(nav, "usb"), "navigator.usb", "USB devices unavailable."),
    cap("webserial", "Web Serial", "Peripherals", has(nav, "serial"), "navigator.serial", "Serial console unavailable."),
    cap("bluetooth", "Web Bluetooth", "Peripherals", has(nav, "bluetooth"), "navigator.bluetooth", "Bluetooth peripherals unavailable."),
    cap("gamepad", "Gamepad", "Peripherals", has(nav, "getGamepads"), "navigator.getGamepads()", "Controller pointer mode unavailable."),

    // --- platform services
    cap("serviceWorker", "Service worker", "Platform", has(nav, "serviceWorker"), "navigator.serviceWorker", "No offline shell; the app requires the network."),
    cap("notifications", "Notifications", "Platform", has(win, "Notification"), "Notification API", "Alerts stay inside the app."),
    cap("badging", "App badging", "Platform", has(nav, "setAppBadge"), "navigator.setAppBadge", "Unread counts show only in the shelf."),
    cap("share", "Web Share", "Platform", has(nav, "share"), "navigator.share", "Sharing falls back to copy-link."),
    cap("clipboardRead", "Clipboard read", "Platform", has(nav, "clipboard") && has(nav.clipboard as object, "readText"),
      "navigator.clipboard.readText", "Clipboard history records only in-app copies."),
    cap("contacts", "Contact picker", "Platform", has(nav, "contacts"), "navigator.contacts.select", "Contacts must be typed manually."),
    cap("battery", "Battery status", "Performance", has(nav, "getBattery"), "navigator.getBattery()", "Governor ignores battery level."),
    cap("netinfo", "Network information", "Performance", has(nav, "connection"), "navigator.connection", "Quality ladder uses frame statistics only."),
    cap("memoryApi", "Memory measurement", "Performance", has(performance as unknown as object, "measureUserAgentSpecificMemory") || has(performance as unknown as object, "memory"),
      "performance.measureUserAgentSpecificMemory / performance.memory", "Memory figures unavailable in the monitor."),
    cap("scheduler", "scheduler.postTask", "Performance", has(win, "scheduler"), "scheduler.postTask", "Background work uses setTimeout priorities."),
    cap("webgpu", "WebGPU", "Hardware", has(nav, "gpu"), "navigator.gpu", "GPU effects use CSS/2D canvas paths."),
    cap("webnn", "WebNN (NPU)", "Hardware", has(nav, "ml"), "navigator.ml", "No accelerated inference; semantic features stay off."),
    cap("wasmSimd", "WebAssembly", "Hardware", typeof WebAssembly !== "undefined", "WebAssembly", "No WASM engines can be loaded."),
    cap("webauthn", "Passkeys / WebAuthn", "Security", has(nav, "credentials") && has(win, "PublicKeyCredential"),
      "navigator.credentials + PublicKeyCredential", "Vault uses passphrase only; no hardware-backed second factor."),
    cap("webcrypto", "WebCrypto", "Security", has(win, "crypto") && has((win.crypto ?? {}) as object, "subtle"),
      "crypto.subtle", "Vault and encrypted export are disabled (never a plaintext fallback)."),
    cap("permissionsApi", "Permissions API", "Security", has(nav, "permissions"), "navigator.permissions.query", "Permission audit cannot show live states."),
    cap("digitalGoods", "Digital Goods", "Commerce", has(win, "getDigitalGoodsService"), "getDigitalGoodsService()", "Purchases use licence keys instead of a store."),
    cap("launchQueue", "Launch handler / file handling", "Platform", has(win, "launchQueue"), "window.launchQueue", "Files cannot be opened from the OS into Fusion."),
    cap("protocolHandler", "Protocol handler", "Platform", has(nav, "registerProtocolHandler"), "registerProtocolHandler('web+fusion')", "Deep links must be pasted manually."),
    cap("speech", "Speech recognition", "Accessibility", has(win, "SpeechRecognition") || has(win, "webkitSpeechRecognition"),
      "SpeechRecognition", "Voice command entry unavailable."),
    cap("rtc", "WebRTC", "Beam", has(win, "RTCPeerConnection"), "RTCPeerConnection", "Peer screen share and device bridge unavailable."),
  ];

  return {
    generatedAt: Date.now(),
    ua: typeof navigator !== "undefined" ? navigator.userAgent : "server",
    secureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    crossOriginIsolated: typeof window !== "undefined" ? Boolean((win as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated) : false,
    hardwareConcurrency: Number(nav.hardwareConcurrency ?? 0),
    deviceMemoryGb: typeof nav.deviceMemory === "number" ? (nav.deviceMemory as number) : null,
    languages: Array.isArray(nav.languages) ? (nav.languages as string[]) : [],
    pointerCoarse: media("(pointer: coarse)"),
    prefersDark: media("(prefers-color-scheme: dark)"),
    prefersReducedMotion: media("(prefers-reduced-motion: reduce)"),
    screens: {
      count: typeof window !== "undefined" && has(win, "getScreenDetails") ? "unknown" : 1,
      width: typeof window !== "undefined" ? window.screen.width : 0,
      height: typeof window !== "undefined" ? window.screen.height : 0,
      dpr: typeof window !== "undefined" ? window.devicePixelRatio : 1,
      colorDepth: typeof window !== "undefined" ? window.screen.colorDepth : 0,
    },
    capabilities,
  };
}

/** Async refinements that cannot be answered synchronously. */
export async function refineCapabilities(report: CapabilityReport): Promise<CapabilityReport> {
  const win = window as unknown as { ImageDecoder?: { isTypeSupported?: (t: string) => Promise<boolean> }; VideoEncoder?: { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> } };
  const caps = [...report.capabilities];
  const set = (id: string, available: boolean, detail?: string) => {
    const i = caps.findIndex((c) => c.id === id);
    if (i >= 0) caps[i] = { ...caps[i], available, detail: detail ?? caps[i].detail };
  };
  try {
    if (win.ImageDecoder?.isTypeSupported) {
      const heic = await win.ImageDecoder.isTypeSupported("image/heic").catch(() => false);
      set("imageDecoderHeic", Boolean(heic), `ImageDecoder.isTypeSupported('image/heic') = ${heic}`);
    }
  } catch { /* probe failures are themselves information; keep the false value */ }
  try {
    if (win.VideoEncoder?.isConfigSupported) {
      const cfg = await win.VideoEncoder.isConfigSupported({
        codec: "avc1.42001F", width: 1280, height: 720, bitrate: 2_500_000, framerate: 30,
        hardwareAcceleration: "prefer-hardware",
      }).catch(() => ({ supported: false }));
      set("webCodecs", Boolean(cfg?.supported), `VideoEncoder hardware H.264 720p30 supported = ${Boolean(cfg?.supported)}`);
    }
  } catch { /* ignore */ }
  return { ...report, capabilities: caps };
}

export const capAvailable = (report: CapabilityReport | null, id: string) =>
  Boolean(report?.capabilities.find((c) => c.id === id)?.available);

export const capOf = (report: CapabilityReport | null, id: string) =>
  report?.capabilities.find((c) => c.id === id) ?? null;
