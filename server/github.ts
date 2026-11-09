import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Graphite } from "./graphite";
import type { PrWorkflow } from "../shared/pr-workflow";
import type { Pr, Snapshot } from "../shared/model";
import type { Deployments } from "./deployments";
import { splitReviewers, TEAM_SLUG, USER_LOGIN } from "../shared/reviewers";
const exec = promisify(execFile);
type Node = Record<string, any>;
export type Observation = { snapshot: Snapshot | null; error: string | null };
export class ReviewRequestError extends Error { constructor(message: string, readonly uncertain: boolean) { super(message); } }
export function ghEnvironment(repo: string, environment = process.env): NodeJS.ProcessEnv {
  return { ...environment, GH_REPO: repo };
}

const METHODS = { SQUASH: "squash", MERGE: "merge", REBASE: "rebase" } as const;
/** The repository's merge settings from the same query. Missing fields (older fixtures, GHES) read as unknown/none. */
export function repoMerge(repository: Node): NonNullable<Snapshot["repoMerge"]> {
  const methods = ([["squash", repository.squashMergeAllowed], ["merge", repository.mergeCommitAllowed], ["rebase", repository.rebaseMergeAllowed]] as const).filter(([, on]) => on === true).map(([m]) => m);
  const preferred = METHODS[repository.viewerDefaultMergeMethod as keyof typeof METHODS] ?? null;
  return { methods, preferred: preferred && methods.includes(preferred) ? preferred : methods[0] ?? null, autoMerge: repository.autoMergeAllowed === true, mergeQueue: !!repository.mergeQueue?.id };
}

export function parsePr(pr: Node, trunk: string, observedAt: string, required: string[]): Snapshot {
  const threads = pr.reviewThreads;
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  const failed = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  const requiredSet = new Set(required);
  const checks = contexts?.nodes ?? [];
  const seen = new Set<string>();
  const failedChecks: string[] = [];
  const otherFailedChecks: string[] = [];
  let checksPending = false;
  for (const c of checks) {
    const name = c.name ?? c.context;
    const conclusion = c.conclusion ?? c.state;
    if (!requiredSet.has(name)) {
      if ((!c.status || c.status === "COMPLETED") && failed.has(conclusion)) otherFailedChecks.push(name);
      continue;
    }
    seen.add(name);
    if ((c.status && c.status !== "COMPLETED") || !conclusion || conclusion === "PENDING") checksPending = true;
    else if (failed.has(conclusion)) failedChecks.push(name);
  }
  if ([...requiredSet].some(name => !seen.has(name))) checksPending = true;
  return {
    title: pr.title, url: pr.url, state: pr.state, head: pr.headRefOid, mergeCommit: pr.mergeCommit?.oid ?? null, mergedAt: pr.mergedAt ?? null, headBranch: pr.headRefName ?? "", base: pr.baseRefName, graphiteMergeStatus: null,
    trunk, draft: pr.isDraft, conflict: pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY",
    reviewDecision: pr.reviewDecision ?? "",
    reviewers: {
      author: pr.author?.login ?? null,
      requested: (pr.reviewRequests?.nodes ?? []).flatMap((r: Node) => r.requestedReviewer?.__typename === "User" && r.requestedReviewer.login !== pr.author?.login && !r.requestedReviewer.login.endsWith("[bot]") ? [r.requestedReviewer.login] : []),
      teams: (pr.reviewRequests?.nodes ?? []).flatMap((r: Node) => r.requestedReviewer?.__typename === "Team" ? [r.requestedReviewer.slug] : []),
      reviewed: [...new Set<string>((pr.latestReviews?.nodes ?? []).flatMap((r: Node) => r.author?.__typename === "User" && r.author.login !== pr.author?.login && !r.author.login.endsWith("[bot]") && ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(r.state) ? [r.author.login] : []))],
      complete: !!pr.author?.login && pr.reviewRequests?.pageInfo?.hasNextPage === false && pr.latestReviews?.pageInfo?.hasNextPage === false && pr.reviewRequests.nodes.every((r: Node) => ["User", "Team"].includes(r.requestedReviewer?.__typename)),
    },
    mergeWhenReady: "unknown",
    threads: threads.nodes.filter((t: Node) => !t.isResolved).map((t: Node) => ({ id: t.id, updatedAt: t.comments.nodes[0]?.updatedAt ?? observedAt })),
    failedChecks, otherFailedChecks, checksPending,
    complete: !threads.pageInfo.hasNextPage && !contexts?.pageInfo.hasNextPage && (pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN"), observedAt,
    ...(typeof pr.mergeStateStatus === "string" ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(typeof pr.isInMergeQueue === "boolean" ? { inMergeQueue: pr.isInMergeQueue } : {}),
  };
}

const fields = `number title url state headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt mergeCommit{oid} isInMergeQueue autoMergeRequest{enabledAt}
author{login}
reviewRequests(first:100){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ...on User{login} ...on Team{slug}}}}
latestReviews(first:100){pageInfo{hasNextPage} nodes{state author{__typename login}}}
baseRef{branchProtectionRule{requiredStatusCheckContexts} associatedPullRequests(first:100,states:[OPEN]){nodes{number headRefName state headRepository{nameWithOwner}}}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved comments(last:1){nodes{updatedAt}}}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{
...on CheckRun{name status conclusion} ...on StatusContext{context state}
}}}}}}`;

/** A GitHub write that failed outright (refused) or whose outcome is unknown (timed out, no reply). */
export class GithubWriteError extends Error { constructor(message: string, readonly uncertain: boolean) { super(message); } }
type Method = "squash" | "merge" | "rebase";
/** `gh pr merge` for one PR, pinned to the reviewed head. A merge queue picks its own method, so none is passed. */
export function mergeArgs(number: number, o: { method: Method; head: string; mergeQueue?: boolean }): string[] {
  return ["pr", "merge", String(number), ...(o.mergeQueue ? [] : [`--${o.method}`]), "--match-head-commit", o.head];
}
/** GitHub auto-merge on (with the method it will use) or off. */
export function autoMergeArgs(number: number, o: { enable: true; method: Method; head: string; mergeQueue?: boolean } | { enable: false }): string[] {
  return o.enable ? ["pr", "merge", String(number), "--auto", ...(o.mergeQueue ? [] : [`--${o.method}`]), "--match-head-commit", o.head] : ["pr", "merge", String(number), "--disable-auto"];
}
export const retargetArgs = (number: number, base: string) => ["pr", "edit", String(number), "--base", base];
/** The method to merge with: the repository's saved choice when GitHub still allows it, else GitHub's preferred, else squash. */
export function chooseMethod(repoMerge: { methods: Method[]; preferred: Method | null } | undefined, saved: Method | null | undefined): Method {
  if (saved && (!repoMerge?.methods.length || repoMerge.methods.includes(saved))) return saved;
  return repoMerge?.preferred ?? repoMerge?.methods[0] ?? "squash";
}
function writeError(error: unknown, fallback: string): GithubWriteError {
  const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
  const timedOut = (error as { killed?: boolean; signal?: string }).killed || /timed? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|connection/i.test(stderr);
  const line = stderr.split("\n").find(l => l.trim())?.replace(/^(?:GraphQL|X|!)\s*:?\s*/i, "").slice(0, 300);
  if (!timedOut && line) return new GithubWriteError(`GitHub refused it: ${line}`, false);
  return new GithubWriteError(fallback, true);
}

export class Github {
  private ruleCache = new Map<string, { until: number; contexts: string[] }>();
  /** Each repository's PR workflow; Graphite is asked only about PRs in Graphite repositories. Absent: all Graphite, as before. */
  workflow: ((repo: string) => Promise<PrWorkflow>) | null = null;
  constructor(private run: (args: string[], repo: string) => Promise<string> = async (args, repo) => (await exec("gh", args, { env: ghEnvironment(repo), timeout: 25_000, maxBuffer: 4 * 1024 * 1024 })).stdout, private graphite?: Pick<Graphite, "observe" | "status">, private deployments?: Pick<Deployments, "observe">) {}
  async requestReviewers(pr: Pr, reviewers: string[]): Promise<void> {
    if (!reviewers.length || reviewers.some(login => !USER_LOGIN.test(login) && !TEAM_SLUG.test(login))) throw new Error("No eligible reviewers selected.");
    // People go in reviewers[], teams (org/slug) in team_reviewers[] by slug; GitHub resolves the slug in the repository's org.
    const { users, teams } = splitReviewers(reviewers);
    try {
      await this.run(["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/requested_reviewers`, ...users.flatMap(login => ["-f", `reviewers[]=${login}`]), ...teams.flatMap(slug => ["-f", `team_reviewers[]=${slug}`])], pr.repo);
    } catch (error) {
      const denied = /HTTP (400|401|403|404|405|409|410|422|429)\b/.test(String((error as { stderr?: string }).stderr ?? ""));
      throw new ReviewRequestError(denied ? "GitHub refused the review request. Check repository write access and reviewer eligibility." : "GitHub did not confirm the review request. Check state before retrying.", !denied);
    }
  }
  private async write(args: string[], repo: string, uncertain: string): Promise<void> {
    try { await this.run(args, repo); } catch (error) { throw writeError(error, uncertain); }
  }
  /** Merge one PR in a plain-GitHub repository. */
  merge(pr: Pick<Pr, "repo" | "number">, o: Parameters<typeof mergeArgs>[1]): Promise<void> {
    return this.write(mergeArgs(pr.number, o), pr.repo, "GitHub did not confirm the merge. Check state before trying again.");
  }
  autoMerge(pr: Pick<Pr, "repo" | "number">, o: Parameters<typeof autoMergeArgs>[1]): Promise<void> {
    return this.write(autoMergeArgs(pr.number, o), pr.repo, "GitHub did not confirm the auto-merge change. Check state before trying again.");
  }
  /** Point a stacked PR at a new base after its parent merged, when GitHub didn't already. */
  retarget(pr: Pick<Pr, "repo" | "number">, base: string): Promise<void> {
    return this.write(retargetArgs(pr.number, base), pr.repo, "GitHub did not confirm the new base branch. Check state before trying again.");
  }
  private async ruleContexts(repo: string, branch: string): Promise<string[]> {
    const key = `${repo}:${branch}`;
    const cache = this.ruleCache.get(key);
    if (cache && cache.until > Date.now()) return cache.contexts;
    const rules = JSON.parse(await this.run(["api", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`], repo));
    if (!Array.isArray(rules)) throw new Error("Branch rules were unavailable");
    const contexts = rules.filter((r: Node) => r.type === "required_status_checks").flatMap((r: Node) => r.parameters.required_status_checks.map((c: Node) => c.context));
    this.ruleCache.set(key, { until: Date.now() + 60_000, contexts });
    return contexts;
  }
  async observe(prs: Pr[]): Promise<Map<string, Observation>> {
    const result = new Map<string, Observation>();
    const repositories = [...new Set(prs.map(p => p.repo))];
    const modes = new Map<string, PrWorkflow>();
    for (const repo of repositories) modes.set(repo, this.workflow ? await this.workflow(repo).catch((): PrWorkflow => "github") : "graphite");
    for (const repo of repositories) {
      const targets = [...new Map(prs.filter(p => p.repo === repo).map(p => [p.key, p])).values()];
      for (let offset = 0; offset < targets.length; offset += 15) {
        const group = targets.slice(offset, offset + 15);
        const [owner, name] = repo.split("/");
        const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name branchProtectionRule{requiredStatusCheckContexts}} squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed viewerDefaultMergeMethod mergeQueue{id} ${group.map((p, i) => `p${i}:pullRequest(number:${p.number}){${fields}}`).join(" ")}}}`;
        try {
          const payload = JSON.parse(await this.run(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`], repo));
          if (payload.errors?.length) throw new Error("Partial GitHub response");
          const repository = payload.data?.repository;
          if (!repository) throw new Error("Repository unavailable");
          const stacked = (data: Node) => data.baseRefName !== repository.defaultBranchRef.name &&
            data.baseRef?.associatedPullRequests?.nodes.some((parent: Node) => parent.state === "OPEN" && parent.number !== data.number && parent.headRefName === data.baseRefName && parent.headRepository?.nameWithOwner?.toLowerCase() === repo.toLowerCase());
          const branches = group.flatMap((_, i) => {
            const data = repository[`p${i}`];
            return data?.state === "OPEN" ? [data.baseRefName, ...(stacked(data) ? [repository.defaultBranchRef.name] : [])] : [];
          });
          const rules = new Map<string, string[]>();
          for (const branch of [...new Set(branches)] as string[]) {
            rules.set(branch, await this.ruleContexts(repo, branch));
          }
          group.forEach((p, i) => {
            const data = repository[`p${i}`];
            if (!data) { result.set(p.key, { snapshot: null, error: "PR unavailable; check access and its number" }); return; }
            // A stacked PR is eventually checked against trunk. An unprotected parent
            // branch must not erase the required checks that apply to the stack.
            const trunkChecks = stacked(data) ? [
              ...(repository.defaultBranchRef.branchProtectionRule?.requiredStatusCheckContexts ?? []),
              ...(rules.get(repository.defaultBranchRef.name) ?? []),
            ] : [];
            const required = [...new Set([...(data.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? []), ...(rules.get(data.baseRefName) ?? []), ...trunkChecks])];
            const snapshot = parsePr(data, repository.defaultBranchRef.name, new Date().toISOString(), required);
            if (modes.get(repo) === "github") {
              // GitHub mode: merge-when-ready is GitHub's auto-merge, and the repository's merge settings travel with the PR.
              snapshot.prWorkflow = "github"; snapshot.repoMerge = repoMerge(repository);
              if (data.state === "OPEN") snapshot.mergeWhenReady = data.autoMergeRequest ? "on" : "off";
            } else if (this.workflow) snapshot.prWorkflow = "graphite";
            result.set(p.key, { snapshot, error: null });
          });
        } catch {
          for (const p of group) result.set(p.key, { snapshot: null, error: "GitHub status unavailable; check gh authentication and repository access" });
        }
      }
    }
    if (this.graphite) {
      // Never call Graphite for a repository that ships through plain GitHub.
      const open = prs.filter(p => result.get(p.key)?.snapshot?.state === "OPEN" && modes.get(p.repo) === "graphite");
      const scheduling = open.length ? await this.graphite.observe(open) : new Map<string, Snapshot["mergeWhenReady"]>();
      for (const p of open) {
        result.get(p.key)!.snapshot!.mergeWhenReady = scheduling.get(p.key) ?? "unknown";
        result.get(p.key)!.snapshot!.graphiteMergeStatus = this.graphite.status(p.key);
      }
    }
    if (this.deployments) {
      const targets = prs.flatMap(p => { const observed = result.get(p.key); return observed?.snapshot && !observed.error ? [{ ...p, snapshot: observed.snapshot }] : []; });
      const deployment = await this.deployments.observe(targets);
      for (const [key, value] of deployment) result.get(key)!.snapshot!.deployment = value;
    }
    return result;
  }
}
