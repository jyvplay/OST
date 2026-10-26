import { F, type SpecRow } from "./row";

/**
 * TT79 register additions. "One other core feature into class A": ZIP archives (forge grade B → A). Class A is raised
 * only on oracles independent of the app: Python zipfile / bz2 / lzma, pyzipper (WinZip AES), Info-ZIP zip 3.0 and
 * unzip 6.0, node:crypto (OpenSSL) and published vectors (FIPS-197, FIPS 180, RFC 6070), and a Windows-made Deflate64
 * archive from dotnet/runtime-assets (docs/DESIGN-TT79.md). 7-Zip / WinZip / Windows Explorer are not available here.
 */
const A79 = "tt79-archive.mts", AE79 = "e2e-tt79-archive.mts";
export const tt79Features: SpecRow[] = [
  F("FF-69", "FF", "ZIP engine: ZIP64 (records, locator, extra field), data descriptors, Deflate64, bzip2 and LZMA decoding, CP437 / UTF-8 / Info-ZIP Unicode Path names, Unix modes and timestamps, archive and entry comments, self-extractor offsets; writer with ZIP64 and UTF-8 names",
    "A", "P2", "src/lib/archive/zip.ts (APPNOTE 6.3.x container) + inflate.ts (RFC 1951 + Deflate64) + bunzip.ts (bzip2) + unlzma.ts (LZMA, method 14) — isomorphic, first-party, synchronous decoders with output bounded by the declared size",
    "Not supported: Zstandard / XZ / PPMd methods (listed by name, refused on read), PKWARE strong encryption, split / spanned archives (refused). Unmarked names: CP437 unless the archive was made on Unix / macOS and the bytes are valid UTF-8 (what Info-ZIP unzip does); the user can force either. Files kept in Files are capped at 8 MB each; archives opened from the device are limited by memory.",
    "built", `${A79} C1 (Python zipfile, 4 methods × 8 payloads), C2 (own inflater == zlib, 80 streams), C3 (Deflate64 == unzip), C4 (Info-ZIP bzip2 / ZIP64 / streamed / symlink / UTF-8), C5 (CP437 == Python, 0x7075 == unzip), W1, W2 (ZIP64 forced + 70 000 entries == Python + unzip -t), P1`),
  F("FF-70", "FF", "ZIP encryption: WinZip AES-128/192/256 (AE-1 / AE-2) and traditional PKWARE ZipCrypto, read and write; editing an encrypted archive without the password",
    "A", "P2", "src/lib/archive/zipcrypt.ts (FIPS-197 AES forward cipher for WinZip's little-endian CTR, SHA-1, HMAC, PBKDF2, ZipCrypto keys) + zip.ts framing (0x9901 extra, verifier, 10-byte MAC, check byte)",
    "ZipCrypto is weak by design and labelled as such. File names stay visible in every ZIP encryption scheme (no central-directory encryption). Passwords are UTF-8 encoded (identical for ASCII; legacy tools that used OEM code pages may differ for non-ASCII passwords).",
    "built", `${A79} V1 (FIPS-197 / FIPS 180 / RFC 6070 + 210 OpenSSL cross-checks), E1 (pyzipper AES × 4 methods), E2 (ours → pyzipper), E3 (Info-ZIP -P incl. data descriptor), E4 (ours → unzip -P + Python), X1 (edit without password), N12, N13; ${AE79} 1, 4, 5`),
  F("FF-71", "FF", "Archive app: browse folders inside a ZIP without extracting, preview text / images / hex, open an entry in its app, extract a selection or everything (to Files or a device folder), add files / folders, delete, rename, undo, test, create new and encrypted copies; Files opens .zip here and asks for passwords",
    "A", "P2", "src/components/modules/Archive.tsx + src/lib/archive/tree.ts (derived folders) + FilesPane (Extract here with password retry, Compress with password, Open in Archive) + /api/fs extract / compress on the new engine",
    "Extract to a device folder needs the File System Access API (Chromium); elsewhere one file downloads at a time. 'Open in its app' writes a copy under /Temp/Archive.",
    "built", `${AE79} 1–6 (real browser: navigation, modal-shortcut isolation, password retry, previews, keyboard delete / rename / undo, save checked by pyzipper, extraction, zip-slip, encrypted copies checked by pyzipper and unzip, Files routing, Test); ${A79} T1`),
  F("FF-72", "FF", "Archive safety guards: zip-slip (absolute, drive, '..', backslash), symlinks never extracted, duplicate names, overlapping entries (non-recursive bomb), local / central name mismatch, ratio / size / count limits, decoder output capped at the declared size, CRC-32 and AES MAC on every read, multi-volume refused",
    "A", "P1", "src/lib/archive/zip.ts readArchive / readEntry guards (directory-time, before any allocation) + extractable()",
    "Ratio guard applies to entries over 1 MiB (default 1100:1, the deflate ceiling); highly compressible legitimate files above that are refused and the limit is shown.",
    "built", `${A79} N1–N24; ${AE79} 3 (unsafe badges, only safe entries written), 6 (damaged entry named)`),
];

const UP: Record<string, { note: string; test: string; tier?: SpecRow["tier"]; status?: SpecRow["status"] }> = {
  "FM-05": {
    tier: "A", status: "built",
    note: "TT79 class A: the Archive app (FF-71) on a new isomorphic engine (FF-69) — ZIP64, Deflate64 / bzip2 / LZMA, CP437 / Unicode names, WinZip AES + ZipCrypto (FF-70), guards (FF-72); Files' Extract here asks for passwords and Compress with password writes AES-256.",
    test: `${A79}; ${AE79}`,
  },
  "FF-12": { note: "TT79: archives gain overlap, name-mismatch, duplicate, symlink and output-cap guards (FF-72).", test: `${A79} N1–N24` },
};

export function patchTT79(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
