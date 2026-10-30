/** CN-07: contact facets. A contact "has e-mail/phone" when at least one
 *  non-blank value exists — vCard imports often carry empty typed fields,
 *  and counting those would make the facet lie. */
export interface ContactLike { emails?: string[]; phones?: string[] }
export type ContactFacet = "all" | "email" | "phone" | "noEmail";
const nonBlank = (xs?: string[]) => (xs ?? []).some((x) => x.trim().length > 0);
export function filterContacts<T extends ContactLike>(contacts: T[], facet: ContactFacet): T[] {
  if (facet === "email") return contacts.filter((c) => nonBlank(c.emails));
  if (facet === "phone") return contacts.filter((c) => nonBlank(c.phones));
  if (facet === "noEmail") return contacts.filter((c) => !nonBlank(c.emails));
  return contacts;
}
