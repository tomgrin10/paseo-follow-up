import { settled, type Pr } from "./model";
import { deployed } from "./follow-up";

export const graphitePrUrl = (pr: Pick<Pr, "repo" | "number">): string => `https://app.graphite.com/github/pr/${pr.repo}/${pr.number}`;

export function prPresentation(pr: Pr): { label: string; tone: "merged" | "approved" | "warning" | "neutral" } {
  const s = pr.snapshot;
  if (pr.error || !s?.complete) return { label: "Status unavailable", tone: "neutral" };
  if (s.state === "MERGED") return { label: "Merged", tone: "merged" };
  if (s.state === "CLOSED") return { label: "Closed", tone: "neutral" };
  if (s.conflict) return { label: "Conflicts", tone: "warning" };
  if (s.threads.length) return { label: `${s.threads.length} review threads`, tone: "warning" };
  if (s.failedChecks.length) return { label: "Checks failed", tone: "warning" };
  if (s.draft) return { label: "Draft", tone: "neutral" };
  if (s.checksPending) return { label: "Checks running", tone: "neutral" };
  return s.reviewDecision === "APPROVED" ? { label: "Approved", tone: "approved" } : { label: "In review", tone: "neutral" };
}
export function settledForDisplay(pr: Pr): boolean {
  return !pr.error && !!pr.snapshot?.complete && !!settled(pr) && (!pr.snapshot.deployment?.environment || deployed(pr));
}
export function compactPrStatus(pr: Pr): ReturnType<typeof prPresentation> {
  const status = prPresentation(pr);
  if (status.label !== "Merged" || !pr.snapshot?.deployment) return { ...status, label: status.label.replace("Status unavailable", "Unknown").replace("review threads", "threads").replace("Checks running", "Checking") };
  return { label: deployed(pr) ? "Deployed" : "Merged", tone: "merged" };
}
export function orderedStacks(prs: Pr[]): { name: string; prs: Pr[] }[] {
  const groups = new Map<string, Pr[]>();
  for (const pr of prs) { const rows = groups.get(pr.stack) ?? []; rows.push(pr); groups.set(pr.stack, rows); }
  const priority = (rows: Pr[]) => rows.every(settledForDisplay) ? 2 : rows.some(p => prPresentation(p).tone === "warning" || p.error || !p.snapshot?.complete || p.snapshot.state === "CLOSED" && !settled(p)) ? 0 : 1;
  return [...groups].map(([name, prs]) => ({ name, prs })).sort((a, b) => priority(a.prs) - priority(b.prs));
}
