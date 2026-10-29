/**
 * TT111 (RC-37) — is the loaded-media tap switched on?
 *
 * The proxy asks this on every media response, so the answer is cached for a second; the SAVE path
 * re-reads it without the cache, because that is the moment a refusal has to be exact. Default off:
 * an installation that never touches the switch never retains a byte.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { settings } from '@/db/schema';
import { TAP_POLICY_KEY } from './wp-tap';

let cached: { at: number; on: boolean } | null = null;
const TTL = 1000;

export async function tapEnabled(fresh = false): Promise<boolean> {
  if (!fresh && cached && Date.now() - cached.at < TTL) return cached.on;
  try {
    const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, TAP_POLICY_KEY)).limit(1);
    const on = row[0]?.value === 'on';
    cached = { at: Date.now(), on };
    return on;
  } catch {
    return false; // a database the proxy cannot read is not permission to keep someone's media
  }
}

/** The switch moved: the next request must not be answered from a stale yes. */
export function forgetTapPolicyCache(): void { cached = null; }
