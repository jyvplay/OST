/** Report every bound violation; a missing or non-finite reading must not pass. */
export function densityBoundFailures(
  targets: readonly (readonly [string, number])[],
  results: ReadonlyMap<string, { words: number }>,
): string[] {
  const failures: string[] = [];
  for (const [id, cap] of targets) {
    const words = results.get(id)?.words;
    if (words === undefined || !Number.isFinite(words)) failures.push(`${id}: missing or invalid word count`);
    else if (words > cap) failures.push(`${id}: ${words} words > bound ${cap}`);
  }
  return failures;
}
