import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Graphite } from "./graphite";
import type { Pr, Snapshot } from "../shared/model";
import type { Deployments } from "./deployments";
const exec = promisify(execFile);
type Node = Record<string, any>;
export type Observation = { snapshot: Snapshot | null; error: string | null };
export class ReviewRequestError extends Error { constructor(message: string, readonly uncertain: boolean) { super(message); } }
export function ghEnvironment(repo: string, environment = process.env): NodeJS.ProcessEnv {
  return { ...environment, GH_REPO: repo };
}

export function parsePr(pr: Node, trunk: string, observedAt: string, required: string[]): Snapshot {
  const threads = pr.reviewThreads;
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
  const failed = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
  const requiredSet = new Set(required);
  const checks = contexts?.nodes ?? [];
  const seen = new Set<string>();
  const failedChecks: string[] = [];
  let checksPending = false;
  for (const c of checks) {
    const name = c.name ?? c.context;
    if (!requiredSet.has(name)) continue;
    seen.add(name);
    const conclusion = c.conclusion ?? c.state;
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
    failedChecks, checksPending,
    complete: !threads.pageInfo.hasNextPage && !contexts?.pageInfo.hasNextPage && (pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN"), observedAt,
  };
}

const fields = `number title url state headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt mergeCommit{oid}
author{login}
reviewRequests(first:100){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ...on User{login} ...on Team{slug}}}}
latestReviews(first:100){pageInfo{hasNextPage} nodes{state author{__typename login}}}
baseRef{branchProtectionRule{requiredStatusCheckContexts}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved comments(last:1){nodes{updatedAt}}}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{
...on CheckRun{name status conclusion} ...on StatusContext{context state}
}}}}}}`;

export class Github {
  private ruleCache = new Map<string, { until: number; contexts: string[] }>();
  constructor(private run: (args: string[], repo: string) => Promise<string> = async (args, repo) => (await exec("gh", args, { env: ghEnvironment(repo), timeout: 25_000, maxBuffer: 4 * 1024 * 1024 })).stdout, private graphite?: Pick<Graphite, "observe" | "status">, private deployments?: Pick<Deployments, "observe">) {}
  async requestReviewers(pr: Pr, reviewers: string[]): Promise<void> {
    if (!reviewers.length || reviewers.some(login => !/^[\w-]+$/.test(login))) throw new Error("No eligible reviewers selected.");
    try {
      await this.run(["api", "--method", "POST", `repos/${pr.repo}/pulls/${pr.number}/requested_reviewers`, ...reviewers.flatMap(login => ["-f", `reviewers[]=${login}`])], pr.repo);
    } catch (error) {
      const denied = /HTTP (400|401|403|404|405|409|410|422|429)\b/.test(String((error as { stderr?: string }).stderr ?? ""));
      throw new ReviewRequestError(denied ? "GitHub refused the review request. Check repository write access and reviewer eligibility." : "GitHub did not confirm the review request. Check state before retrying.", !denied);
    }
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
    for (const repo of repositories) {
      const targets = [...new Map(prs.filter(p => p.repo === repo).map(p => [p.key, p])).values()];
      for (let offset = 0; offset < targets.length; offset += 15) {
        const group = targets.slice(offset, offset + 15);
        const [owner, name] = repo.split("/");
        const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name} ${group.map((p, i) => `p${i}:pullRequest(number:${p.number}){${fields}}`).join(" ")}}}`;
        try {
          const payload = JSON.parse(await this.run(["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `query=${query}`], repo));
          if (payload.errors?.length) throw new Error("Partial GitHub response");
          const repository = payload.data?.repository;
          if (!repository) throw new Error("Repository unavailable");
          const rules = new Map<string, string[]>();
          for (const branch of [...new Set(group.map((_, i) => repository[`p${i}`]?.state === "OPEN" ? repository[`p${i}`]?.baseRefName : null).filter(Boolean))] as string[]) {
            rules.set(branch, await this.ruleContexts(repo, branch));
          }
          group.forEach((p, i) => {
            const data = repository[`p${i}`];
            if (!data) { result.set(p.key, { snapshot: null, error: "PR unavailable; check access and its number" }); return; }
            const required = [...new Set([...(data.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? []), ...(rules.get(data.baseRefName) ?? [])])];
            result.set(p.key, { snapshot: parsePr(data, repository.defaultBranchRef.name, new Date().toISOString(), required), error: null });
          });
        } catch {
          for (const p of group) result.set(p.key, { snapshot: null, error: "GitHub status unavailable; check gh authentication and repository access" });
        }
      }
    }
    if (this.graphite) {
      const open = prs.filter(p => result.get(p.key)?.snapshot?.state === "OPEN");
      const scheduling = await this.graphite.observe(open);
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
