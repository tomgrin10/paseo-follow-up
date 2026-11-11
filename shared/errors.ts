/** RPC errors arrive as "Request failed: <reason> requestType=… code=…"; people only need the reason. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.replace(/^Request failed:\s*/i, "").replace(/\s*requestType=\S+.*$/s, "").trim() || "Something went wrong. Try again.";
}

/** A reason as one sentence with exactly one stop, so more text can follow it: "x." and "x" both become "x.". */
export function sentence(reason: string): string {
  const t = reason.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/** The server's refusals for an action on a brief card that isn't the live, open brief (server/inbox.ts briefAction). */
export const STALE_BRIEF = {
  replaced: "This brief was replaced by a newer one. Read the newest card.",
  answered: "This brief was already answered or signed off.",
} as const;
// Q35 answered or withdrawn elsewhere (server/questions.ts developerAnswer, recordAnswer).
const MOOT = [/^This brief was (replaced by a newer one|already answered or signed off)\./, /^Q\d+ (is already (answered|withdrawn)|was withdrawn)\b/];

/**
 * A refusal that means the action is moot, not failed: what it acts on was already answered, replaced or withdrawn
 * somewhere else. The surface reconciles to the resolved state (runAction's `reconcile`); it never offers Retry.
 */
export function isMoot(error: unknown): boolean {
  const t = errorText(error);
  return MOOT.some(r => r.test(t));
}
