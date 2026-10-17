import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/nunito";
import "./globals.css";
import { styleCss, DEFAULT_STYLE } from "@/lib/style-core";

export const metadata: Metadata = {
  title: "Fusion Shell Web",
  description:
    "A desktop environment as an installable PWA: window compositor, journaled file system, search index, Beam casting, Lens camera pipeline — with capability honesty.",
  manifest: "/manifest.webmanifest",
  applicationName: "Fusion Shell",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Fusion Shell" },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }], apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#062a33", // TT22: poolside lagoon
  width: "device-width",
  initialScale: 1,
  // TT21: no maximumScale — blocking pinch-zoom fails WCAG 1.4.4 (axe rule meta-viewport)
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-density="balanced" data-style={DEFAULT_STYLE} suppressHydrationWarning>
      {/* TT22: per-style surface tokens, generated from style-core.ts (one source of truth, checked by a11y-unit) */}
      <head><style id="fs-style-tokens" dangerouslySetInnerHTML={{ __html: styleCss() }} /></head>
      <body>{children}</body>
    </html>
  );
}
