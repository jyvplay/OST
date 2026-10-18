import type { NextConfig } from "next";

/**
 * TT18 privacy headers. Deliberately NOT set: X-Frame-Options / frame-ancestors (the shell must stay
 * embeddable in its preview host) and COOP (cast/share popups rely on the opener). A full script-src CSP
 * would need nonces threaded through Next's inline bootstrap — declared, not faked.
 */
const privacyHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" }, // deep links (?open=…&path=…) never leak to other sites
  { key: "X-DNS-Prefetch-Control", value: "off" }, // no speculative DNS lookups for links shown in files/notes
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "object-src 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Permissions-Policy", value: "browsing-topics=(), attribution-reporting=(), join-ad-interest-group=(), run-ad-auction=()" },
];

const nextConfig: NextConfig = {
  // TT35: the proxy keeps target paths exactly — "/search/" and "/search" are different pages on many sites
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      // TT35: the web proxy (/api/wp/s/…) sets its own complete header set (CSP sandbox etc.), so it is excluded here
      { source: "/:path((?!api/wp/s/).*)", headers: privacyHeaders },
      // API bodies (file contents, notes, state) must not be kept in the browser's HTTP disk cache —
      // in an amnesic session that cache would be a trace on the device.
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] },
    ];
  },
};

export default nextConfig;
