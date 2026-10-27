"use client";
import { useEffect, useState } from "react";
import { Badge, Btn, Section } from "./ui";

const PLATFORMS = {
  android: {
    label: "Android",
    steps: [
      "Open Android Settings → Apps → Default apps, then choose a role such as Browser, Phone or SMS and select an available app.",
      "For a specific app's links, open Settings → Apps → that app → Open by default. Supported-link and clear-default controls vary by Android version and device.",
      "For a file, use the system's Open with chooser and choose Always if your device offers it. A web app may not be offered as a handler.",
    ],
  },
  windows: {
    label: "Windows",
    steps: [
      "Open Windows Settings → Apps → Default apps.",
      "Search for a file extension or link type, choose it, then select an available app; alternatively choose an app to see the types it can handle.",
      "Install the PWA in a supporting browser first if you want to look for Fusion. Windows and the browser decide whether it is offered.",
    ],
  },
  mac: {
    label: "macOS",
    steps: [
      "In Finder, select a file of the desired type and choose File → Get Info.",
      "Under Open with, choose an available app, then use Change All if you want all files of that type to use it.",
      "Link handling is controlled separately by macOS and the relevant apps; a browser-installed PWA may not appear in every chooser.",
    ],
  },
  linux: {
    label: "Linux",
    steps: [
      "In your desktop's Settings, look for Default Applications to choose common roles such as web browser or mail.",
      "For a file type, use your file manager's Open With or Properties dialog and select an available default application.",
      "Names and available controls vary by desktop environment, browser and installation; Fusion may not be offered.",
    ],
  },
} as const;
type Platform = keyof typeof PLATFORMS;

type ProtocolNav = Navigator & { registerProtocolHandler?: (scheme: string, url: string) => void; unregisterProtocolHandler?: (scheme: string, url: string) => void };

/** A guide and optional browser request, not a privileged OS-defaults manager. */
export default function DefaultAppsGuide() {
  const [platform, setPlatform] = useState<Platform>("android");
  const [cap, setCap] = useState({ checked: false, register: false, unregister: false, launch: false });
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const nav = navigator as ProtocolNav;
    const launch = (window as unknown as { launchQueue?: { setConsumer?: unknown } }).launchQueue;
    // Defer the feature probe until the browser has hydrated the component.
    void Promise.resolve().then(() => setCap({ checked: true, register: window.isSecureContext && typeof nav.registerProtocolHandler === "function", unregister: window.isSecureContext && typeof nav.unregisterProtocolHandler === "function", launch: window.isSecureContext && typeof launch?.setConsumer === "function" }));
  }, []);
  const request = (remove: boolean) => {
    try {
      const nav = navigator as ProtocolNav;
      const handler = `${window.location.origin}/?cmd=%s`;
      if (remove) {
        if (typeof nav.unregisterProtocolHandler !== "function") throw new Error("This browser does not expose removal");
        nav.unregisterProtocolHandler("web+fusion", handler);
        setNotice("Removal requested from this browser. Fusion cannot verify the browser or OS default.");
      } else {
        if (typeof nav.registerProtocolHandler !== "function") throw new Error("This browser does not expose registration");
        nav.registerProtocolHandler("web+fusion", handler);
        setNotice("Request sent to this browser. It may ask for approval or ignore it; Fusion cannot verify the browser or OS default.");
      }
    } catch (e) { setNotice(`Browser request failed: ${String((e as Error).message ?? e).slice(0, 160)}`); }
  };
  return <div style={{ display: "grid", gap: 12 }} data-testid="default-apps-guide">
    <Section title="Change default apps">
      <p style={{ margin: 0 }}>Fusion cannot inspect or change system-wide default apps. Use your device settings; names and choices differ by OS and version.</p>
      <label htmlFor="default-platform">Device platform</label>
      <select id="default-platform" className="fs-input" value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
        {(Object.keys(PLATFORMS) as Platform[]).map((key) => <option key={key} value={key}>{PLATFORMS[key].label}</option>)}
      </select>
      <ol style={{ margin: 0, paddingInlineStart: 22, lineHeight: 1.6 }}>{PLATFORMS[platform].steps.map((step) => <li key={step}>{step}</li>)}</ol>
    </Section>
    <Section title="Fusion handlers">
      <p style={{ margin: 0 }}>Fusion declares text file and <code>web+fusion:</code> handlers in its PWA manifest. A declaration does not mean this browser installed them or the OS chose Fusion as a default.</p>
      <p style={{ margin: 0 }}>On browsers that deliver files to an installed PWA, Fusion asks before copying up to eight UTF-8 text files (1 MiB each) in plaintext to the Fusion server. Edits are to the copies in /Documents, not the originals; file import is unavailable in amnesic sessions.</p>
      <p style={{ margin: 0 }}>An example link is <code>web+fusion://open?app=files</code>. Only recognized Fusion app IDs can be opened; links cannot run arbitrary commands.</p>
      <div><Badge tone={cap.launch ? "info" : "warn"}>{!cap.checked ? "checking browser" : cap.launch ? "launch queue API exposed" : "launch queue API not exposed"}</Badge> <span>API presence is not proof of an installed or registered handler.</span></div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Btn disabled={!cap.register} onClick={() => request(false)}>Ask browser to handle web+fusion links</Btn>
        <Btn disabled={!cap.unregister} onClick={() => request(true)}>Request removal of browser handler</Btn>
      </div>
      {!cap.register && cap.checked ? <p style={{ margin: 0 }}>Browser protocol registration is not available here. PWA manifest handling may also be unsupported.</p> : null}
      <p role="status" aria-live="polite" style={{ margin: 0 }}>{notice}</p>
    </Section>
  </div>;
}
