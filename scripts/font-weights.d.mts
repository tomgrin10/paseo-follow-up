/** Types for scripts/font-weights.mjs, for tests that import it. */
export interface InkRow { stack: string; regular: number; semibold: number }
export const RENDER_STACKS: string[];
export function inkByWeight(stacks: string[]): InkRow[];
export function weightProblem(rows: InkRow[]): string | null;
export function fontWeightProblem(browser: unknown): Promise<string | null>;
