import { createHash } from "node:crypto";

/** A stable tag for an RPC answer: the same answer always gets the same tag. */
export const etagOf = (answer: unknown): string => createHash("sha1").update(JSON.stringify(answer)).digest("base64url");

/**
 * The inbox list for a client that already holds `etag` (1.4.0): when the answer is the same, a few bytes saying so
 * instead of every row again (65 KB at 120 agents, polled by every surface).
 */
export function inboxAnswer<T extends { enabled: boolean; firstRun: boolean; signOffs: number; error: string | null }>(answer: T, etag: string | undefined) {
  const tag = etagOf(answer);
  if (etag === tag) return { etag: tag, unchanged: true as const, enabled: answer.enabled, rows: [], unsorted: null, firstRun: answer.firstRun, batchUndo: null, signOffs: answer.signOffs, error: answer.error, overseer: null };
  return { ...answer, etag: tag, unchanged: undefined as true | undefined };
}
