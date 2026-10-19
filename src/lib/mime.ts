/** Isomorphic MIME guess by extension (shared by the server VFS and the browser privacy layer). */
export function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    yml: "text/yaml", yaml: "text/yaml", log: "text/plain", ini: "text/plain",
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", avif: "image/avif", heic: "image/heic", bmp: "image/bmp",
    pdf: "application/pdf", zip: "application/zip", ai: "application/illustrator", vcf: "text/vcard", vcard: "text/vcard", eps: "application/postscript", ps: "application/postscript",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    psd: "image/vnd.adobe.photoshop", psb: "image/vnd.adobe.photoshop", epub: "application/epub+zip",
    ics: "text/calendar", fsheet: "application/json", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg",
  };
  return map[ext] ?? "application/octet-stream";
}

export const isTextual = (mime: string) =>
  mime.startsWith("text/") || ["application/json", "image/svg+xml", "text/typescript"].includes(mime);

/** MIME the browser privacy layer stores for encrypted Persistent Storage blobs (see privacy/pcrypt.ts). */
export const ENCRYPTED_MIME = "application/x-fusion-encrypted";
export const isPrivateVfsPath = (p: string) => p === "/Private" || p.startsWith("/Private/");
/** Server-side readers call this so a ciphertext blob is refused clearly instead of parsed as garbage. */
export function refuseEncrypted(node: { mime: string; path: string }) {
  if (node.mime === ENCRYPTED_MIME) throw new Error(`${node.path} is encrypted Persistent Storage — the server holds ciphertext only; open it from the browser while unlocked`);
}

/** TT47: base64 prefix of the MS-CFB signature D0CF11E0A1B11AE1 (password-protected OOXML lives in a CFB container). */
const CFB_B64 = "0M8R4KGxGu"; // first 10 chars = 60 bits of the signature, independent of the byte that follows
/**
 * Server-side guard: refuse to replace a password-protected .docx/.xlsx/.pptx with a non-encrypted body unless the
 * client confirmed it explicitly (replaceEncrypted). Fusion decrypts but cannot re-encrypt, so this is what stops a
 * decrypted document being written back over its protected original as plaintext.
 */
export function refuseEncryptedOverwrite(existing: { content?: string | null; encoding?: string | null; path: string } | null | undefined, newBase64: string, confirmed: unknown) {
  if (!existing || confirmed === true || !/\.(docx|xlsx|pptx|docm|xlsm|pptm)$/i.test(existing.path)) return;
  const wasCfb = existing.encoding === "base64" && typeof existing.content === "string" && existing.content.startsWith(CFB_B64);
  if (wasCfb && !newBase64.startsWith(CFB_B64)) throw new Error(`${existing.path} is a password-protected file; refusing to replace it with an unencrypted copy (save under a different name)`);
}
