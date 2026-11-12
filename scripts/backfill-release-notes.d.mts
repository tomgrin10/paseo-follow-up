import type { Source } from "./release-body.mjs";
export type Step = { tag: string; action: "write" | "keep"; reason: string; body?: string; replaced?: string[] };
export function plan(releases: { tagName: string; body: string | null }[], src: Source, options?: { only?: string[] | null; except?: string[] }): Step[];
