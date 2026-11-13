/** Types for scripts/scale-budget.mjs, for tests that import it. */
export function median(xs: readonly number[]): number;
export function idleVerdict(samplesMb: readonly number[], budgetMb: number): { medianMb: number; peakMb: number; over: boolean };
export const SEND_SETTLE_MS: number;
export const PR_READ_MS: number;
export const SEND_ROUNDS: number;
export const ACK_READ_MS: number;
export const SETTLE_MARGIN_MS: number;
export const QUIET_POLLS: number;
export function settleBoundMs(o?: { rounds?: number; readMs?: number; settleMs?: number; marginMs?: number }): number;
export function settleState(polls: readonly { atMs: number; open: number }[], boundMs: number): { settled: boolean; expired: boolean; atMs?: number };
