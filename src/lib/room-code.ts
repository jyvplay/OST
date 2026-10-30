/** TG-01: a fresh room code. Drawn from an unambiguous alphabet (no 0/O,
 *  1/I/L) so a code read aloud or copied by hand survives; callers pass
 *  their randomness in, so tests can fix it. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newRoomCode(rand: () => number, len = 6): string {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length) % ALPHABET.length];
  return `ROOM-${out}`;
}
