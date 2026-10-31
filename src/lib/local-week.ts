/** Monday-through-Sunday dates in the current local time zone. Calendar-day
 * arithmetic, unlike adding 24-hour durations, survives ordinary DST shifts. */
export function localWeekDays(now: Date): Date[] {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    day.setHours(0, 0, 0, 0);
    return day;
  });
}
