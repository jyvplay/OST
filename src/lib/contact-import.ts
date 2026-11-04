import { MAX_CONTACTS, MAX_INPUT, serializeVcf, type Contact, type ParseResult } from "./contacts-core";

/** Refuse opening a book that cannot be safely represented by UID-keyed edits.
 * The original file is left untouched for repair in Files or another app. */
export function bookProblem(text: string, result: ParseResult): string | null {
  if (result.truncated) return "This book exceeds the Contacts import limits. Open it in Files or split it before editing; the original was not changed.";
  if (text.trim() && !result.contacts.length) return "No vCards were found. Open the original in Files; it was not changed.";
  const ids = new Set<string>();
  for (const contact of result.contacts) {
    if (ids.has(contact.uid)) return "This book contains repeated UIDs. Repair it in Files or another contacts app before editing; the original was not changed.";
    ids.add(contact.uid);
  }
  return null;
}

/** Existing contacts win; for repeated new UIDs the first card wins. Never
 * silently replace or merge distinct cards. Caller reports skipped cards. */
export function planContactImport(existing: readonly Contact[], incoming: readonly Contact[]) {
  const existingIds = new Set(existing.map(contact => contact.uid));
  const seen = new Set(existingIds);
  const fresh: Contact[] = [];
  let alreadyPresent = 0, repeated = 0;
  for (const contact of incoming) {
    if (existingIds.has(contact.uid)) { alreadyPresent++; continue; }
    if (seen.has(contact.uid)) { repeated++; continue; }
    seen.add(contact.uid); fresh.push(contact);
  }
  return { fresh, alreadyPresent, repeated };
}

/** Do not create a book that the bounded parser would refuse on the next open. */
export function contactImportProblem(existing: readonly Contact[], fresh: readonly Contact[]): string | null {
  if (existing.length + fresh.length > MAX_CONTACTS) return `Import would exceed ${MAX_CONTACTS} contacts; no contacts imported.`;
  if (serializeVcf([...existing, ...fresh]).length > MAX_INPUT) return "Import would exceed the address book size limit; no contacts imported.";
  return null;
}
