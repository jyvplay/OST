/** RT-03: duplicate a routine. The copy's name never collides with an
 *  existing one ("copy", "copy 2", …); identity comes from the caller's
 *  id source so the storage layer stays the single id authority. */
export function duplicateName(base: string, taken: readonly string[]): string {
  let name = `${base} copy`;
  for (let i = 2; taken.includes(name); i++) name = `${base} copy ${i}`;
  return name;
}
