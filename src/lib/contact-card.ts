/** CN-08: one contact as a shareable .vcf. Uses the book's own serializer
 *  (contacts-core) so a single-card export is byte-compatible with the
 *  whole-book download; the filename slug cannot escape a folder. */
import { serializeContact, type Contact } from "./contacts-core";
export function contactCardFile(c: Contact): { filename: string; text: string } {
  const slug = (c.fn || "contact").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "contact";
  return { filename: `${slug}.vcf`, text: serializeContact(c) };
}
