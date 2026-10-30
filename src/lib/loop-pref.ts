/** MD-11: Media loop toggle state. Loop is a player preference kept in
 *  window state; the label always states the current behaviour so the
 *  control never shows the action it will take instead of the state. */
export const loopLabel = (on: boolean): string => (on ? "loop on" : "loop off");
export const nextLoop = (on: boolean): boolean => !on;
