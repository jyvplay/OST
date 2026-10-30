/** WR-01: a session word goal. The count is the difference between the
 *  document's word count when the session started and now — deletions
 *  shrink it (clamped at zero), so the goal measures net writing. */
export interface GoalStatus { written: number; remaining: number; done: boolean }
export function goalStatus(startWords: number, nowWords: number, target: number): GoalStatus {
  const written = Math.max(0, nowWords - startWords);
  const remaining = Math.max(0, target - written);
  return { written, remaining, done: target > 0 && remaining === 0 };
}
