/** CV-02: calculator memory register. Pure state transitions; the UI keeps
 *  the register in window state only (never persisted), matching the
 *  privacy posture of the in-window history. */
export interface MemState { value: number; has: boolean }
export const MEM_EMPTY: MemState = { value: 0, has: false };
export const memAdd = (m: MemState, n: number): MemState => Number.isFinite(n) ? { value: m.value + n, has: true } : m;
export const memSub = (m: MemState, n: number): MemState => Number.isFinite(n) ? { value: m.value - n, has: true } : m;
export const memStore = (n: number): MemState => Number.isFinite(n) ? { value: n, has: true } : MEM_EMPTY;
export const memClear = (): MemState => MEM_EMPTY;
export const memRecall = (m: MemState): number | null => (m.has ? m.value : null);
