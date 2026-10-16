import { ensureSeeded } from "@/db/seed";

/**
 * Seeding is expensive-ish (reconciles ~230 spec rows). It must run exactly once
 * per server process and must never block the health check, which the platform
 * uses as a liveness probe.
 */
const g = globalThis as typeof globalThis & { __fusionBootstrap?: Promise<{ seeded: boolean; features: number }> };

export function bootstrap() {
  if (!g.__fusionBootstrap) {
    g.__fusionBootstrap = ensureSeeded().catch((err) => {
      g.__fusionBootstrap = undefined;
      throw err;
    });
  }
  return g.__fusionBootstrap;
}

export function bootstrapState() {
  return g.__fusionBootstrap ? "running-or-done" : "idle";
}
