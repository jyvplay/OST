export type Tier = "A" | "A/B" | "B" | "C" | "X";
export type Phase = "P1" | "P2" | "P3" | "P4" | "S";
/**
 * built   = runs in this build, end to end, against real browser/DB APIs
 * partial = runs, but a named sub-capability is degraded
 * probe   = ships only as a runtime capability probe + honest degrade UI
 * skeleton= typed interface + route + UI surface, no engine behind it yet
 * blocked = provably not deliverable on this platform; UI must say so
 */
export type Status = "built" | "partial" | "probe" | "skeleton" | "blocked";

export interface SpecRow {
  code: string;
  family: string;
  name: string;
  tier: Tier;
  phase: Phase;
  route: string;
  nuance: string;
  status: Status;
  test: string;
}

export const F = (
  code: string,
  family: string,
  name: string,
  tier: Tier,
  phase: Phase,
  route: string,
  nuance: string,
  status: Status,
  test = "",
): SpecRow => ({ code, family, name, tier, phase, route, nuance, status, test });
