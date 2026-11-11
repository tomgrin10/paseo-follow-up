export type Source = {
  tags(): string[];
  file(ref: string, path: string): string | null;
  added(from: string, to: string): string[];
};
export const VERIFIED: string;
export const MAINTENANCE: string;
export const UNWRITTEN: string;
export const BETA_SECTIONS_REF: string;
export function compare(a: string, b: string): number;
export function section(changelog: string | null, version: string, options?: { full?: boolean }): string | null;
export function gitSource(git: (args: string[]) => string): Source;
export function previousTag(src: Source, version: string): string | null;
export function releaseNotes(tag: string, src: Source): { notes: string; source: string };
export function install(tag: string, src: Source): { cmd: string; line: string; needs: string };
export function releaseBody(tag: string, src: Source): string;
export function hasNotes(body: string | null | undefined): boolean;
