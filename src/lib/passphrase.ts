/** SC-19: passphrase strength estimate + generator for the Vault.
 *  Strength is a Shannon-style estimate over the character pools actually
 *  present (a lower bound, stated as such in the UI). Generation takes an
 *  injected RNG returning [0,1) so tests are deterministic; the UI passes
 *  a CSPRNG-backed source. The word list is original to this codebase. */
const WORDS = ["amber", "basil", "cobalt", "dune", "ember", "flint", "garnet", "harbor", "iris", "jasper", "kestrel", "lumen", "mica", "north", "onyx", "prairie", "quartz", "rowan", "sable", "tundra", "umber", "velvet", "willow", "xenon", "yonder", "zephyr", "atlas", "birch", "cinder", "delta", "elm", "fjord"];
export function strengthBits(secret: string): number {
  if (!secret) return 0;
  let pool = 0;
  if (/[a-z]/.test(secret)) pool += 26;
  if (/[A-Z]/.test(secret)) pool += 26;
  if (/[0-9]/.test(secret)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(secret)) pool += 33;
  const raw = pool ? secret.length * Math.log2(pool) : 0;
  // Repeated-character runs contribute less than fresh entropy.
  let repeats = 0; for (let i = 1; i < secret.length; i++) if (secret[i] === secret[i - 1]) repeats++;
  return Math.max(0, Math.round(raw - repeats * 2));
}
export const strengthLabel = (bits: number): string => bits < 28 ? "weak" : bits < 45 ? "fair" : bits < 70 ? "strong" : "excellent";
export function generatePassphrase(rng: () => number, words = 4): string {
  const pick = () => WORDS[Math.min(WORDS.length - 1, Math.floor(rng() * WORDS.length))];
  const parts = Array.from({ length: Math.max(3, words) }, pick);
  return `${parts.join("-")}-${Math.floor(rng() * 90 + 10)}`;
}
