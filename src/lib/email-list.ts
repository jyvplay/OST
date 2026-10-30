/** CN-10: the mail addresses of the contacts on screen, de-duplicated
 *  and locale-sorted — a paste-ready recipient list. Only addresses the
 *  cards actually carry; cards without mail contribute nothing. */
export interface MailCard { emails: { value: string }[] }
export function emailList(contacts: readonly MailCard[]): string[] {
  return [...new Set(contacts.flatMap((c) => c.emails.map((e) => e.value.trim()).filter(Boolean)))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
