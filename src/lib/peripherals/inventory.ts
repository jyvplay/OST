/**
 * TT147 (HW-07) — peripherals: what is already granted, what needs a gesture.
 *
 * The web's device APIs split every question in two, and most apps answer the
 * wrong half:
 *
 *   • `getDevices()` / `getPorts()` list what the user has *already* granted to
 *     this origin. It is silent, needs no gesture, and returns an empty list on
 *     a first visit — which is not the same as "no devices exist".
 *   • `requestDevice()` / `requestPort()` open a chooser. They need a user
 *     gesture and cannot be called from a timer, a load handler, or a Worker.
 *
 * So the inventory here always reports three separate numbers — granted, and
 * whether a chooser can be opened at all — and never folds them into "devices:
 * 0". A blocked permission is reported as blocked, with the reason the browser
 * gave, rather than as an absence of hardware.
 */

export type Bus = "hid" | "usb" | "serial" | "bluetooth";

/** The subset of each API this module uses. Injected so the logic is testable. */
export interface BusApi {
  getDevices?: () => Promise<unknown[]>;
  getPorts?: () => Promise<unknown[]>;
  requestDevice?: (options?: unknown) => Promise<unknown>;
  requestPort?: (options?: unknown) => Promise<unknown>;
}

export interface BusReport {
  bus: Bus;
  /** The API object exists in this engine. */
  present: boolean;
  /** A chooser can be opened (the method exists), not that it will succeed. */
  canRequest: boolean;
  /** Devices already granted to this origin. */
  granted: number;
  reason: string;
}

export interface PeripheralInventory {
  buses: BusReport[];
  /** Granted devices across every bus. */
  granted: number;
  /** The one-line read-out. */
  summary: string;
  /** Honest list of what an inventory cannot tell you. */
  limits: string[];
}

const SPEC: { bus: Bus; list: "getDevices" | "getPorts"; request: "requestDevice" | "requestPort"; what: string }[] = [
  { bus: "hid", list: "getDevices", request: "requestDevice", what: "game controllers, keyboards, vendor tools" },
  { bus: "usb", list: "getDevices", request: "requestDevice", what: "USB serial adapters, instruments, drives that expose a device class" },
  { bus: "serial", list: "getPorts", request: "requestPort", what: "Arduino-class boards and serial consoles" },
  { bus: "bluetooth", list: "getDevices", request: "requestDevice", what: "BLE sensors and heart-rate straps" },
];

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "the browser refused without a message";
}

/**
 * Read the inventory without asking for anything.
 *
 * A bus whose `getDevices` throws (a permissions policy, a locked-down profile)
 * is reported as refused with the browser's own words; that is different from a
 * bus that returns an empty array, and the two are never merged.
 */
export async function readInventory(apis: Partial<Record<Bus, BusApi | null>>): Promise<PeripheralInventory> {
  const buses: BusReport[] = [];
  for (const s of SPEC) {
    const api = apis[s.bus] ?? null;
    if (!api) {
      buses.push({ bus: s.bus, present: false, canRequest: false, granted: 0, reason: `this engine has no Web${s.bus === "bluetooth" ? "Bluetooth" : s.bus} object` });
      continue;
    }
    const list = api[s.list];
    const request = api[s.request];
    let granted = 0;
    let reason = `granted to this origin: ${s.what}`;
    if (typeof list === "function") {
      try {
        const items = await list.call(api);
        granted = Array.isArray(items) ? items.length : 0;
        if (granted === 0) reason = "nothing granted to this origin yet — the chooser is the only way to add one";
      } catch (e) {
        reason = `the browser refused the list: ${errorText(e)}`;
      }
    } else {
      reason = "this engine exposes the bus without a granted-device list";
    }
    buses.push({ bus: s.bus, present: true, canRequest: typeof request === "function", granted, reason });
  }
  const granted = buses.reduce((n, b) => n + b.granted, 0);
  const requestable = buses.filter((b) => b.canRequest).length;
  const summary = `${granted} granted device(s) across ${buses.filter((b) => b.present).length} bus(es); ${requestable} chooser(s) available`;
  return {
    buses,
    granted,
    summary,
    limits: [
      "this list is what the browser has already granted; it is not the machine's device list",
      "a chooser needs a click — no timer, page load or Worker can open one",
      "nothing here says a device works; it says the origin may talk to it",
    ],
  };
}

/** The browser-bound wrapper. */
export async function browserInventory(): Promise<PeripheralInventory> {
  const nav = navigator as Navigator & {
    hid?: BusApi; usb?: BusApi; serial?: BusApi;
    bluetooth?: { getDevices?: () => Promise<unknown[]>; requestDevice?: (o?: unknown) => Promise<unknown> };
  };
  return readInventory({
    hid: nav.hid ?? null,
    usb: nav.usb ?? null,
    serial: nav.serial ?? null,
    bluetooth: nav.bluetooth ? { getDevices: nav.bluetooth.getDevices, requestDevice: nav.bluetooth.requestDevice } : null,
  });
}

/**
 * What a chooser may be asked for.
 *
 * Filters are deliberately narrow: a HID filter that accepts everything is how
 * an app ends up asking for a keyboard it has no business reading. Empty means
 * "refuse to open a chooser", which the caller must surface as a refusal rather
 * than a silent no-op.
 */
export interface RequestPlan {
  bus: Bus;
  options: Record<string, unknown> | null;
  reason: string;
}

export function requestPlan(bus: Bus, opts: { vendorId?: number; productId?: number; usagePage?: number; usage?: number } = {}): RequestPlan {
  if (bus === "hid") {
    if (opts.usagePage === undefined) return { bus, options: null, reason: "a HID request needs a usage page; asking for every HID device would include keyboards" };
    const filter = opts.usage === undefined ? { usagePage: opts.usagePage } : { usagePage: opts.usagePage, usage: opts.usage };
    return { bus, options: { filters: [filter] }, reason: "the chooser shows only devices of that usage page" };
  }
  if (bus === "usb") {
    if (opts.vendorId === undefined || opts.productId === undefined) return { bus, options: null, reason: "a USB request needs a vendor and product id; an unfiltered request is refused by the spec" };
    return { bus, options: { filters: [{ vendorId: opts.vendorId, productId: opts.productId }] }, reason: "the chooser shows only that vendor/product pair" };
  }
  if (bus === "serial") return { bus, options: {}, reason: "the serial chooser lists every port the OS exposes; there is no filter" };
  return { bus, options: { acceptAllDevices: false, filters: [] }, reason: "Bluetooth needs an explicit service filter; nothing is requested without one" };
}
