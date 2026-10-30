/** MN-01: Monitor job ordering. The journal arrives newest-first; sorts
 *  copy, never mutate, so the log below keeps its canonical order. */
export interface JobLike { at: string; op: string }
export type JobSort = "newest" | "oldest" | "op";
export function sortJobs<T extends JobLike>(jobs: T[], sort: JobSort): T[] {
  const out = [...jobs];
  if (sort === "oldest") out.sort((a, b) => a.at.localeCompare(b.at));
  else if (sort === "op") out.sort((a, b) => a.op.localeCompare(b.op) || b.at.localeCompare(a.at));
  else out.sort((a, b) => b.at.localeCompare(a.at));
  return out;
}
