import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fusion Shell Web",
  description:
    "A desktop environment as an installable PWA: window compositor, journaled file system, search index, Beam casting, Lens camera pipeline — with capability honesty.",
  manifest: "/manifest.webmanifest",
  applicationName: "Fusion Shell",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Fusion Shell" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = {
  themeColor: "#070b16",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-density="balanced" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
