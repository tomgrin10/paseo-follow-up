import { settled, statusKnown, type Pr } from "./model";
import { deployed } from "./follow-up";

export const graphitePrUrl = (pr: Pick<Pr, "repo" | "number">): string => `https://app.graphite.com/github/pr/${pr.repo}/${pr.number}`;

/** A PR as a row links it: where one click opens it, and what a screen reader says. */
export type PrLink = { key: string; number: number; url: string; label: string };
/**
 * Where a row's "Open #N" goes (a-row-that-names-a-pr-opens-it-in-one-click): Graphite for a PR its repository ships
 * through Graphite, else the PR on GitHub (the PR sheet's primary link). Every surface that names a PR links it through this, so they agree.
 */
export function prLink(pr: Pick<Pr, "key" | "repo" | "number" | "snapshot">): PrLink {
  const s = pr.snapshot;
  // The PR sheet's rule: a read PR not in GitHub mode ships through Graphite (isGithubFlow); unread, GitHub.
  const url = s && s.prWorkflow !== "github" ? graphitePrUrl(pr) : s?.url || `https://github.com/${pr.repo}/pull/${pr.number}`;
  return { key: pr.key, number: pr.number, url, label: `Open pull request #${pr.number}` };
}
/**
 * A workspace's PRs by number, for linking a bare "#1630" in a row's text. A number two tracked repositories share is
 * left out: "#12" alone can't say which one it means.
 */
export function prLinksByNumber(prs: readonly Pick<Pr, "key" | "repo" | "number" | "snapshot">[]): ReadonlyMap<number, PrLink> {
  const out = new Map<number, PrLink>(); const twice = new Set<number>();
  for (const pr of prs) { if (out.has(pr.number) && out.get(pr.number)!.key !== pr.key) twice.add(pr.number); else out.set(pr.number, prLink(pr)); }
  for (const n of twice) out.delete(n);
  return out;
}

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
  if (s.threads.length) return { label: `${s.threads.length} review thread${s.threads.length === 1 ? "" : "s"}`, tone: "warning" };
  if (s.failedChecks.length) return { label: "Checks failed", tone: "warning" };
  if (s.otherFailedChecks?.length) return { label: s.otherFailedChecks.length === 1 ? "Optional check failed" : "Optional checks failed", tone: "warning" };
  if (s.draft) return { label: "Draft", tone: "neutral" };
  if (s.checksPending) return { label: "Checks running", tone: "neutral" };
  return s.reviewDecision === "APPROVED" ? { label: "Approved", tone: "approved" } : { label: "In review", tone: "neutral" };
}
export function settledForDisplay(pr: Pr): boolean {
  return statusKnown(pr) && !!settled(pr) && (!pr.snapshot.deployment?.environment || deployed(pr));
}
/** The quiet line a known PR gets when its latest read failed: when its status was last read. Null otherwise. */
export function staleHint(pr: Pr, ago: (iso: string) => string): string | null {
  return pr.error && statusKnown(pr) ? `Last checked ${ago(pr.snapshot!.observedAt)}` : null;
}
export function compactPrStatus(pr: Pr): ReturnType<typeof prPresentation> {
  const status = prPresentation(pr);
  if (status.label !== "Merged" || !pr.snapshot?.deployment) return { ...status, label: status.label.replace("Status unavailable", "Unknown").replace(/review thread/, "thread").replace("Checks running", "Checking") };
  return { label: deployed(pr) ? "Deployed" : "Merged", tone: "merged" };
}
export function orderedStacks(prs: Pr[]): { name: string; prs: Pr[] }[] {
  const groups = new Map<string, Pr[]>();
  for (const pr of prs) { const rows = groups.get(pr.stack) ?? []; rows.push(pr); groups.set(pr.stack, rows); }
  const priority = (rows: Pr[]) => rows.every(settledForDisplay) ? 2 : rows.some(p => prPresentation(p).tone === "warning" || !statusKnown(p) || p.snapshot.state === "CLOSED" && !settled(p)) ? 0 : 1;
  return [...groups].map(([name, prs]) => ({ name, prs })).sort((a, b) => priority(a.prs) - priority(b.prs));
}
