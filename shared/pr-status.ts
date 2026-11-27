import type { ListPr as Pr } from "./list";
import { deployed } from "./follow-up";

/**
 * A complete snapshot always shows its own status; a failed read after it (`pr.error`) adds at most a quiet "last
 * checked" hint (staleHint). "Status unavailable" means no complete read ever (a-github-limit-never-blanks-a-known-pr).
 */
export function prPresentation(pr: Pr): { label: string; tone: "merged" | "approved" | "warning" | "neutral" } {
  const s = pr.snapshot;
  if (!s?.complete) return { label: "Status unavailable", tone: "neutral" };
  if (s.state === "MERGED") return { label: "Merged", tone: "merged" };
  if (s.state === "CLOSED") return { label: "Closed", tone: "neutral" };
  if (s.conflict) return { label: "Conflicts", tone: "warning" };
  if (s.threads?.length) return { label: `${s.threads?.length} review thread${s.threads?.length === 1 ? "" : "s"}`, tone: "warning" };
  if (s.failedChecks?.length) return { label: "Checks failed", tone: "warning" };
  if (s.otherFailedChecks?.length) return { label: s.otherFailedChecks.length === 1 ? "Optional check failed" : "Optional checks failed", tone: "warning" };
  if (s.draft) return { label: "Draft", tone: "neutral" };
  if (s.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "warning" };
  if (s.checksPending) return { label: "Checks running", tone: "neutral" };
  return s.reviewDecision === "APPROVED" ? { label: "Approved", tone: "approved" } : { label: "In review", tone: "neutral" };
}

/** One reference on the agent line and the PR row; an unknown project repository stays qualified. */
export function prReference(pr: Pick<Pr, "repo" | "number">, workspaceRepo: string | null | undefined): string {
  return `${workspaceRepo?.toLowerCase() === pr.repo.toLowerCase() ? "" : pr.repo}#${pr.number}`;
}

export const MERGE_QUEUED_STATUSES = ["QUEUED_TO_MERGE", "WAITING_TO_MERGE", "REBASING", "HANDED_OFF_TO_EXTERNAL_MERGE_QUEUE"];
export const mergeQueued = (pr: Pr): boolean => pr.snapshot?.prWorkflow === "github" ? !!pr.snapshot.inMergeQueue : MERGE_QUEUED_STATUSES.includes(pr.snapshot?.graphiteMergeStatus ?? "");

export const PR_CHECKING_WORD = "Checking";

export function compactPrStatus(pr: Pr): ReturnType<typeof prPresentation> {
  const status = prPresentation(pr);
  if (status.label !== "Merged" || !pr.snapshot?.deployment) return { ...status, label: status.label.replace("Status unavailable", "Unknown").replace(/review thread/, "thread").replace("Checks running", PR_CHECKING_WORD) };
  return { label: deployed(pr) ? "Deployed" : "Merged", tone: "merged" };
}

/** The exact status the PR list row draws, including its queue override. */
export function prRowStatus(pr: Pr): ReturnType<typeof prPresentation> {
  const status = compactPrStatus(pr);
  return mergeQueued(pr) ? { ...status, label: "Queued to merge" } : status;
}
