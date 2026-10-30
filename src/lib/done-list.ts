/** TT125 PL-10: the finished tasks as plain text, in list order. */
export interface DoneLike { title: string; done: boolean; }
export function doneTasksText(rows: ReadonlyArray<DoneLike>): string {
  const done = rows.filter((r) => r.done);
  if (!done.length) return "nothing done yet";
  return done.map((r) => `- ${r.title}`).join("\n");
}
