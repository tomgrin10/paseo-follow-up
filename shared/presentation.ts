import { settled, statusKnown } from "./model";
import type { ListPr as Pr } from "./list";
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

export { prPresentation } from "./pr-status";
import { prPresentation } from "./pr-status";
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
export function orderedStacks<P extends Pr>(prs: P[]): { name: string; prs: P[] }[] {
  const groups = new Map<string, P[]>();
  for (const pr of prs) { const rows = groups.get(pr.stack) ?? []; rows.push(pr); groups.set(pr.stack, rows); }
  const priority = (rows: Pr[]) => rows.every(settledForDisplay) ? 2 : rows.some(p => prPresentation(p).tone === "warning" || !statusKnown(p) || p.snapshot.state === "CLOSED" && !settled(p)) ? 0 : 1;
  return [...groups].map(([name, prs]) => ({ name, prs })).sort((a, b) => priority(a.prs) - priority(b.prs));
}

/**
 * The Pull requests card's line while Follow-up holds back its GitHub reads for the budget (Workspace.githubWait):
 * what is happening, when checks resume (local time), and why the statuses below may be behind. Null when reads run.
 */
export function githubWaitLine(w: { githubWait?: { until: string } | null }, now: number): { title: string; detail: string; label: string } | null {
  const until = Date.parse(w.githubWait?.until ?? "");
  if (!Number.isFinite(until) || until <= now) return null;
  const at = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // "updates", not "checks": this card also shows CI checks. "Limit", not "budget": GitHub's own word.
  const title = `GitHub limit low · updates again at ${at}`;
  const detail = "Follow-up paused to leave the rest to your agents. PR statuses here may be behind.";
  return { title, detail, label: `${title}. ${detail}` };
}
