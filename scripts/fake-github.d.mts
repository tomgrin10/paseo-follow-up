/** Types for scripts/fake-github.mjs, for tests that import it. */
export type FakeGithubRequest = { method: string; path: string; body?: any; authorization: string | null };
export function fakeGithub(o: { dir: string; gh: string; owners?: string[]; handle?: (r: FakeGithubRequest) => { status: number; body?: unknown } | undefined | Promise<{ status: number; body?: unknown } | undefined> }): Promise<{
  url: string;
  requests: { method: string; path: string; repo: string | null }[];
  env: Record<string, string>;
  strip: string[];
  close(): Promise<void>;
}>;
