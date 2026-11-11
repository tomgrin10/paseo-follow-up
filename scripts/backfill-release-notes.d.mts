import type { Source } from "./release-body.mjs";
export type Step = { tag: string; action: "write" | "keep" | "skip"; reason: string; body?: string };
export function plan(releases: { tagName: string; body: string | null }[], src: Source, only?: string[] | null): Step[];
