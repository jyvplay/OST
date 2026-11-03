/** Canonical UTC/content-resource filters shared by UI, host and privacy gate. */
import { searchScope } from "./search-path";
export interface SearchResources { modifiedAfter: string; modifiedBefore: string; minBytes: string; maxBytes: string; excludeFolder: string }
export const EMPTY_RESOURCES: SearchResources = { modifiedAfter: "", modifiedBefore: "", minBytes: "", maxBytes: "", excludeFolder: "" };
function day(value: string): string {
  if (!value) return "";
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Modified dates require a real YYYY-MM-DD date in years 0001–9999");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("Modified date is not a real UTC calendar day");
  return value;
}
function bytes(value: string): string {
  if (value && (!/^(0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error("Content sizes require canonical nonnegative safe integers in bytes");
  return value;
}
export function searchResources(value: Partial<SearchResources>): SearchResources {
  const result = { ...EMPTY_RESOURCES };
  for (const key of Object.keys(result) as (keyof SearchResources)[]) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`${key} must be text`);
    result[key] = value[key] ?? "";
  }
  result.modifiedAfter = day(result.modifiedAfter); result.modifiedBefore = day(result.modifiedBefore);
  result.minBytes = bytes(result.minBytes); result.maxBytes = bytes(result.maxBytes); result.excludeFolder = searchScope(result.excludeFolder);
  if (result.modifiedAfter && result.modifiedBefore && result.modifiedAfter >= result.modifiedBefore) throw new Error("Modified on/after must precede modified before (UTC)");
  if (result.minBytes && result.maxBytes && Number(result.minBytes) > Number(result.maxBytes)) throw new Error("Minimum bytes must not exceed maximum bytes");
  return result;
}
export function resourceOptions(params: URLSearchParams): SearchResources { return searchResources(Object.fromEntries(Object.keys(EMPTY_RESOURCES).map(key => [key, params.get(key) ?? ""]))); }
export function resourceFiltersUsed(value: SearchResources): boolean { return Object.values(searchResources(value)).some(Boolean); }
export function contentFiltersUsed(value: SearchResources): boolean { return !!(value.modifiedAfter || value.modifiedBefore || value.minBytes || value.maxBytes); }
export function literalPage(params: URLSearchParams): { offset: number; publicPages: boolean } {
  const offset = params.get("offset") ?? "0", publicPages = params.get("publicPages") ?? "0";
  if (!["0", "50", "100", "150"].includes(offset) || !["0", "1"].includes(publicPages)) throw new Error("Literal pages allow offsets 0, 50, 100, 150 and publicPages=0|1");
  if ((offset !== "0" || publicPages === "1") && (params.get("mode") === "metadata" || params.get("match") !== "literal")) throw new Error("Public result paging requires literal text mode");
  return { offset: Number(offset), publicPages: publicPages === "1" };
}
