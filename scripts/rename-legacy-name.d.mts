export const EXEMPT: string[];
export const RULES: [RegExp, string][];
export const LEGACY: RegExp;
export function rewrite(text: string): string;
export function trackedFiles(cwd?: string): string[];
