/**
 * TT139 (HW-07) — WebHID / WebUSB / Web Serial / Web Bluetooth: a broker that
 * tells the truth about which of them exists here.
 *
 * These four APIs are not interchangeable and each is gated differently:
 *
 *   - **WebHID** needs a user gesture per device; a report descriptor decides the
 *     packet layout, and reading it wrong produces silent garbage.
 *   - **WebUSB** cannot claim a device whose driver the OS holds; it throws
 *     `SecurityError` for protected classes (HID keyboards, mass storage) — which
 *     is correct and must be reported, not retried.
 *   - **Web Serial** exposes a byte stream, and a wrong baud rate is not an error,
 *     it is noise.
 *   - **Web Bluetooth** offers GATT services only, with no pairing code handling.
 *
 * This module validates filters *before* the picker opens (an over-broad filter is
 * a privacy problem: it lists every device the user owns) and classifies failures
 * so the UI can show a reason. Nothing here opens a device; it decides whether
 * asking is legal and what to ask for.
 */

export type Transport = "hid" | "usb" | "serial" | "bluetooth";

export interface TransportSupport { transport: Transport; available: boolean; reason: string }

export function transportSupport(env: { hasHid: boolean; hasUsb: boolean; hasSerial: boolean; hasBluetooth: boolean; secureContext: boolean }): TransportSupport[] {
  const secure = env.secureContext;
  return [
    { transport: "hid", available: env.hasHid && secure, reason: env.hasHid ? (secure ? "ok" : "WebHID needs a secure context") : "this browser has no WebHID" },
    { transport: "usb", available: env.hasUsb && secure, reason: env.hasUsb ? (secure ? "ok" : "WebUSB needs a secure context") : "this browser has no WebUSB" },
    { transport: "serial", available: env.hasSerial && secure, reason: env.hasSerial ? (secure ? "ok" : "Web Serial needs a secure context") : "this browser has no Web Serial" },
    { transport: "bluetooth", available: env.hasBluetooth && secure, reason: env.hasBluetooth ? (secure ? "ok" : "Web Bluetooth needs a secure context") : "this browser has no Web Bluetooth" },
  ];
}

export interface FilterSet { vendorId?: number; productIds?: number[]; usagePage?: number; usage?: number; services?: string[] }

export const PRIVILEGED_USB_CLASSES: Record<number, string> = {
  0x03: "human-interface devices (keyboards, mice) are protected", 
  0x08: "mass storage is protected",
  0x09: "hubs are protected",
  0xe0: "wireless controllers are protected",
};

export function validateFilters(transport: Transport, filters: readonly FilterSet[] | undefined): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const list = filters ?? [];
  if (!list.length) {
    // No filter is legal for HID and Bluetooth (the picker asks), but for USB and
    // Serial it means "every device" — which is both a privacy problem and, for
    // USB, refused by the API in many embeddings.
    if (transport === "usb") errors.push("WebUSB requires at least one filter; an empty filter lists every attached device");
    if (transport === "serial") warnings.push("with no filters the chooser shows every serial port, including debug consoles");
    return { ok: errors.length === 0, errors, warnings };
  }
  for (const f of list) {
    if (f.vendorId !== undefined && !(Number.isInteger(f.vendorId) && f.vendorId > 0 && f.vendorId <= 0xffff)) errors.push("vendorId must be 1..65535");
    for (const p of f.productIds ?? []) if (!(Number.isInteger(p) && p > 0 && p <= 0xffff)) errors.push(`productId ${p} is out of range`);
    if (f.usagePage !== undefined && !(f.usagePage > 0)) errors.push("usagePage must be positive");
    if (f.usage !== undefined && !(f.usage > 0)) errors.push("usage must be positive");
    for (const s of f.services ?? []) if (!/^[0-9a-f]{4,8}$/i.test(s)) errors.push(`“${s}” is not a 16- or 32-bit service UUID`);
    if (transport === "bluetooth" && f.vendorId !== undefined) warnings.push("vendorId is ignored by Web Bluetooth; use services");
    if (transport === "serial" && (f.vendorId !== undefined || f.usagePage !== undefined)) warnings.push("serial filters use usbVendorId/usbProductId, not vendorId/usagePage");
  }
  return { ok: errors.length === 0, errors, warnings };
}

export type DeviceFailure = "denied" | "cancelled" | "busy" | "protected" | "unsupported" | "disconnected" | "unknown";

export function classifyFailure(err: unknown): { kind: DeviceFailure; sentence: string } {
  const name = (err as { name?: string } | null)?.name ?? "";
  const message = (err as { message?: string } | null)?.message ?? "";
  switch (name) {
    case "NotFoundError": return { kind: "cancelled", sentence: "No device was chosen." };
    case "NotAllowedError": return { kind: "denied", sentence: "Permission for that device was refused." };
    case "SecurityError": return { kind: "protected", sentence: "The browser protects this class of device from web pages." };
    case "NetworkError": return { kind: "busy", sentence: "The device is claimed by another program (a driver or another tab)." };
    case "NotSupportedError": return { kind: "unsupported", sentence: "This browser cannot talk to that device." };
    case "InvalidStateError": return { kind: "disconnected", sentence: "The device was disconnected." };
    case "AbortError": return { kind: "cancelled", sentence: "The chooser was closed." };
    default:
      if (/access denied/i.test(message)) return { kind: "denied", sentence: "The operating system refused access to the device." };
      if (/no such device|disconnected/i.test(message)) return { kind: "disconnected", sentence: "The device is no longer attached." };
      return { kind: "unknown", sentence: message ? `Device error: ${message}` : "The device failed for an unknown reason." };
  }
}

/** A serial frame reader that keeps partial frames, so chunk boundaries never split data. */
export function serialFramer(delimiter: string): { push: (chunk: Uint8Array) => string[] } {
  const decoder = new TextDecoder();
  let carry = "";
  const maxCarry = 1 << 20;
  return {
    push(chunk: Uint8Array): string[] {
      carry += decoder.decode(chunk, { stream: true });
      const parts = carry.split(delimiter);
      carry = parts.pop() ?? "";
      if (carry.length > maxCarry) carry = ""; // a stream with no delimiter must not grow without bound
      return parts;
    },
  };
}

/** What a peripheral page must say before opening a picker. */
export const PERIPHERAL_DISCLOSURE = "A device is shared only after you choose it in the browser's own picker. The page sees only the device you pick, and only until you unplug it or reload.";
