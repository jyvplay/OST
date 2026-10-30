/** MN-02: which journal jobs "clear finished" removes. Finished means a
 *  terminal journal state (COMPLETE or FAILED); running and queued jobs
 *  are never touched, so clearing cannot hide work in flight. */
export interface JobLike { id: number; state: string }
export const TERMINAL_JOB_STATES = ["COMPLETE", "FAILED"]; // the journal's own terminal states; anything else is in flight
export const isFinishedJob = (j: JobLike): boolean => TERMINAL_JOB_STATES.includes(j.state);
export function pruneFinished<T extends JobLike>(jobs: readonly T[]): T[] {
  return jobs.filter(isFinishedJob);
}
/** MN-02: the in-flight view. A toggle, not a delete — the journal is the
 *  server's record (fileOps); hiding finished rows here never touches it. */
export function inFlightJobs<T extends JobLike>(jobs: readonly T[]): T[] {
  return jobs.filter((j) => !isFinishedJob(j));
}
