import type { ListPr as Pr } from "./list";

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
