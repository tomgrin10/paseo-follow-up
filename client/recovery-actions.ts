import type { Batch } from "../shared/model";

/**
 * The Recovery block says it once (`recovery-offers-one-primary-action`): one primary action per state, plus "Open
 * recovery agent" when an agent exists. After a failure (blocked or uncertain) that action is Retry recovery: Run and
 * Retry do the same thing from the user's view, and the block used to offer both, next to each other.
 */
export type RecoveryPrimary =
  | { kind: "run"; title: "Run recovery" | "Starting recovery…"; disabled: boolean }
  | { kind: "run-queued"; title: "Run queued recovery"; disabled: false }
  | { kind: "retry"; title: "Retry recovery"; disabled: false };

export type RecoveryActions = { primary: RecoveryPrimary; openAgent: boolean };

export function recoveryActions(last: Pick<Batch, "state" | "recipientAgentId"> | undefined, { archived, starting }: { archived: boolean; starting: boolean }): RecoveryActions {
  const openAgent = !!last?.recipientAgentId;
  if (last?.state === "pending") return { primary: { kind: "run-queued", title: "Run queued recovery", disabled: false }, openAgent };
  if (last && (last.state === "blocked" || last.state === "uncertain")) return { primary: { kind: "retry", title: "Retry recovery", disabled: false }, openAgent };
  const busy = starting || last?.state === "sending";
  return { primary: { kind: "run", title: busy ? "Starting recovery…" : "Run recovery", disabled: busy || archived || last?.state === "sent" }, openAgent };
}
