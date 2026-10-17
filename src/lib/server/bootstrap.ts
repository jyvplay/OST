import { and, eq, like } from "drizzle-orm";
import { db } from "@/db";
import { indexDocs } from "@/db/schema";
import { ensureSeeded } from "@/db/seed";

/** TT18: /Private is never indexed; purge rows a pre-TT18 server (or a raw move) may have left behind. */
async function purgePrivateIndex() {
  await db.delete(indexDocs).where(and(eq(indexDocs.source, "file"), like(indexDocs.ref, "/Private/%")));
}

/**
 * Seeding is expensive-ish (reconciles ~230 spec rows). It must run exactly once
 * per server process and must never block the health check, which the platform
 * uses as a liveness probe.
 */
const g = globalThis as typeof globalThis & { __fusionBootstrap?: Promise<{ seeded: boolean; features: number }> };

export function bootstrap() {
  if (!g.__fusionBootstrap) {
    g.__fusionBootstrap = purgePrivateIndex().then(() => ensureSeeded()).catch((err) => {
      g.__fusionBootstrap = undefined;
      throw err;
    });
  }
  return g.__fusionBootstrap;
}

export function bootstrapState() {
  return g.__fusionBootstrap ? "running-or-done" : "idle";
}
