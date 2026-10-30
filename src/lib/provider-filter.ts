/**
 * MU-03 — Streams library provider facet. The text filter (SM) matches
 * titles; this answers the different question "show only my YouTube
 * saves". "all" is explicit, an unknown provider matches nothing (a
 * typo'd facet must show an empty list, not everything).
 */
export interface ProviderItem { id: string; provider: string }

export function providersOf<T extends ProviderItem>(items: T[]): { provider: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.provider, (counts.get(i.provider) ?? 0) + 1);
  return [...counts.entries()].map(([provider, count]) => ({ provider, count })).sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
}

export function filterByProvider<T extends ProviderItem>(items: T[], provider: string): T[] {
  if (provider === "all") return items;
  return items.filter((i) => i.provider === provider);
}
