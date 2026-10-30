/** TT125 PK-04: the printable ASCII runs inside a binary — what `strings`
 *  would show, computed in original code with an explicit minimum length. */
export const STRINGS_MIN = 4;
export function asciiRuns(bytes: ReadonlyArray<number> | Uint8Array, min: number = STRINGS_MIN): string[] {
  const out: string[] = [];
  let run = "";
  const push = () => { if (run.length >= min) out.push(run); run = ""; };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x20 && b <= 0x7e) run += String.fromCharCode(b);
    else push();
  }
  push();
  return out;
}
export function asciiRunsText(bytes: ReadonlyArray<number> | Uint8Array, min: number = STRINGS_MIN): string {
  const runs = asciiRuns(bytes, min);
  return runs.length ? runs.join("\n") : `no ASCII run of ${min}+ bytes`;
}
