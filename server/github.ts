import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Graphite } from "./graphite";
import type { PrWorkflow } from "../shared/pr-workflow";
import type { Pr, Snapshot } from "../shared/model";
import type { Deployments } from "./deployments";
import { budgetTier, cadence, dueForRead, type Budget } from "../shared/poll";
import { cliApi, githubApi, type GithubApi } from "./github-api";
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
  let checksRunning = false;
  for (const c of checks) {
    const name = c.name ?? c.context;
    const conclusion = c.conclusion ?? c.state;
    if ((c.status && c.status !== "COMPLETED") || (!c.status && ["PENDING", "EXPECTED"].includes(conclusion))) checksRunning = true;
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
    failedChecks, otherFailedChecks, checksPending, checksRunning,
    complete: !threads.pageInfo.hasNextPage && !contexts?.pageInfo.hasNextPage && (pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN"), observedAt,
    ...(typeof pr.mergeStateStatus === "string" ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(typeof pr.isInMergeQueue === "boolean" ? { inMergeQueue: pr.isInMergeQueue } : {}),
  };
}

/** Ruleset rules for a ref (GraphQL `Ref.rules`), the same set REST `rules/branches/<branch>` returns. */
const RULES = "rules(first:100){pageInfo{hasNextPage} nodes{type repositoryRuleset{enforcement} parameters{...on RequiredStatusChecksParameters{requiredStatusChecks{context}}}}}";
const fields = `number title url state headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt mergeCommit{oid} isInMergeQueue autoMergeRequest{enabledAt}
author{login}
reviewRequests(first:100){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ...on User{login} ...on Team{slug}}}}
latestReviews(first:100){pageInfo{hasNextPage} nodes{state author{__typename login}}}
baseRef{branchProtectionRule{requiredStatusCheckContexts} ${RULES} associatedPullRequests(first:100,states:[OPEN]){nodes{number headRefName state headRepository{nameWithOwner}}}}
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

/** PRs per aliased GraphQL query: well inside GitHub's node (500k) and cost limits with every connection at 100. */
const CHUNK = 15;
/** Ruleset checks for a branch ride the batched query; REST is a per-branch fallback cached this long. */
export const RULES_TTL_MS = 10 * 60_000;
/** Active ruleset required checks from a ref's `rules`, or null when they didn't come back whole (fall back to REST). */
export function ruleChecks(ref: Node | null | undefined): string[] | null {
  const rules = ref?.rules;
  if (!rules || !Array.isArray(rules.nodes) || rules.pageInfo?.hasNextPage) return null;
  return rules.nodes.filter((r: Node) => r?.type === "REQUIRED_STATUS_CHECKS" && !["EVALUATE", "DISABLED"].includes(r.repositoryRuleset?.enforcement))
    .flatMap((r: Node) => (r.parameters?.requiredStatusChecks ?? []).map((c: Node) => c.context as string));
}

function rateLimited(error: unknown): boolean {
  const e = error as { rateLimited?: boolean; stderr?: string; message?: string };
  return !!e?.rateLimited || /rate limit|RATE_LIMITED/i.test(`${e?.stderr ?? ""} ${e?.message ?? ""}`);
}

export class Github {
  private ruleCache = new Map<string, { until: number; contexts: Promise<string[]> }>();
  private readAt = new Map<string, number>();
  private budgets = new Map<string, Budget>();
  private last = new Map<string, Observation>();
  private prints = new Map<string, string>();
  private changedAt = new Map<string, number>();
  private api: GithubApi;
  /** Each repository's PR workflow; Graphite is asked only about PRs in Graphite repositories. Absent: all Graphite, as before. */
  workflow: ((repo: string) => Promise<PrWorkflow>) | null = null;
  private run: (args: string[], repo: string) => Promise<string>;
  /**
   * `run` is the gh CLI, kept for writes. Reads go through `api`: in-process HTTPS by default, or `run` itself when
   * a test injects one.
   */
  constructor(run?: (args: string[], repo: string) => Promise<string>, private graphite?: Pick<Graphite, "observe" | "status">, private deployments?: Pick<Deployments, "observe">, api?: GithubApi, private now = Date.now) {
    this.run = run ?? (async (args, repo) => (await exec("gh", args, { env: ghEnvironment(repo), timeout: 25_000, maxBuffer: 4 * 1024 * 1024 })).stdout);
    this.api = api ?? (run ? cliApi(run) : githubApi());
  }
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
  /** REST fallback for one branch's ruleset checks (GraphQL `Ref.rules` missing, truncated or refused). */
  private ruleContexts(repo: string, branch: string): Promise<string[]> {
    const key = `${repo}:${branch}`;
    const cache = this.ruleCache.get(key);
    if (cache && cache.until > this.now()) return cache.contexts;
    const contexts = this.api.rest(repo, `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`).then(rules => {
      if (!Array.isArray(rules)) throw new Error("Branch rules were unavailable");
      return rules.filter((r: Node) => r.type === "required_status_checks").flatMap((r: Node) => r.parameters.required_status_checks.map((c: Node) => c.context as string));
    });
    // One lookup per branch per RULES_TTL_MS, shared by every PR (and concurrent tick) that targets it.
    this.ruleCache.set(key, { until: this.now() + RULES_TTL_MS, contexts });
    void contexts.catch(() => this.ruleCache.delete(key));
    return contexts;
  }
  /**
   * Whether a PR must be read on this tick rather than reuse its last observation (see POLL_IDLE_MS). Anything
   * still moving is hot: no observation yet, an error, incomplete data, checks pending (finishing checks do NOT bump
   * a PR's updatedAt), a merge queue or merge-when-ready in flight, unknown mergeability, or a change seen recently.
   */
  hot(p: Pr): boolean {
    const last = this.last.get(p.key);
    return cadence(last?.snapshot, p.error || last?.error, this.changedAt.get(p.key) ?? null, this.now()) !== "idle";
  }
  /** Requests GitHub reads made, for tests and the poll-cost harness. */
  readonly stats = { graphql: 0, rest: 0, skipped: 0, points: 0 };
  /**
   * Reads every PR fresh, unless `background` (the engine's timer tick) allows backoff. Then only `fresh` keys,
   * `hot` keys (busy workspaces) and hot PRs force their repository to be read this tick.
   */
  async observe(prs: Pr[], o: { background?: boolean; fresh?: Set<string>; hot?: Set<string> } = {}): Promise<Map<string, Observation>> {
    const result = new Map<string, Observation>();
    const repositories = [...new Set(prs.map(p => p.repo))];
    const modes = new Map<string, PrWorkflow>();
    for (const repo of repositories) modes.set(repo, this.workflow ? await this.workflow(repo).catch((): PrWorkflow => "github") : "graphite");
    for (const repo of repositories) {
      const targets = [...new Map(prs.filter(p => p.repo === repo).map(p => [p.key, p])).values()];
      const owner = repo.split("/")[0];
      const tier = budgetTier(this.budgets.get(owner), this.now());
      const pinned = (p: Pr) => o.hot?.has(p.key) || o.fresh?.has(p.key);
      const repoUrgent = targets.some(p => pinned(p) || this.hot(p));
      // Per-PR backoff (shared/poll.ts): only due PRs go into this tick's queries; the rest reuse their last
      // observation. A read costs ~1 GraphQL point per PR, so reading fewer PRs is what saves the budget.
      const due = targets.filter(p => {
        // Merged is final: a merged PR whose status is known isn't read again, not even on a cold start. Only the
        // developer's Refresh of its workspace (fresh) reads it.
        if (p.snapshot?.state === "MERGED" && p.snapshot.complete && !p.error && !o.fresh?.has(p.key)) return false;
        if (tier === "critical") return false;
        if (!o.background || !this.last.has(p.key) || o.fresh?.has(p.key) || o.hot?.has(p.key)) return true;
        const last = this.last.get(p.key)!;
        return dueForRead({ snapshot: last.snapshot, error: p.error || last.error, changedAt: this.changedAt.get(p.key) ?? null, readAt: this.readAt.get(p.key) ?? 0, now: this.now(), tier, repoUrgent });
      });
      const dueKeys = new Set(due.map(p => p.key));
      for (const p of targets) if (!dueKeys.has(p.key)) { this.stats.skipped++; result.set(p.key, this.standIn(p, owner)); }
      if (!due.length) continue;
      for (let offset = 0; offset < due.length; offset += CHUNK) {
        const group = due.slice(offset, offset + CHUNK);
        const [owner, name] = repo.split("/");
        const query = `query($owner:String!,$name:String!){rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){defaultBranchRef{name branchProtectionRule{requiredStatusCheckContexts} ${RULES}} squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed viewerDefaultMergeMethod mergeQueue{id} ${group.map((p, i) => `p${i}:pullRequest(number:${p.number}){${fields}}`).join(" ")}}}`;
        try {
          this.stats.graphql++;
          const payload = await this.api.graphql(repo, query, { owner, name });
          const rate = payload.data?.rateLimit;
          if (rate && typeof rate.remaining === "number") { this.budgets.set(owner, { remaining: rate.remaining, resetAt: Date.parse(rate.resetAt) || this.now() + 3_600_000 }); this.stats.points += Number(rate.cost) || 0; }
          for (const p of group) this.readAt.set(p.key, this.now());
          // A partial response fails only the PRs its errors point at. An error outside any PR fails the group.
          const broken = new Set<string>(); const rulesBroken = new Set<string>();
          for (const e of (payload.errors ?? []) as Node[]) {
            const path: unknown[] = Array.isArray(e.path) ? e.path : [];
            const at = typeof path[1] === "string" ? path[1] : null;
            if (e.type === "RATE_LIMITED" || e.type === "RATE_LIMIT") throw Object.assign(new Error("rate limited"), { rateLimited: true });
            if (path[0] !== "repository" || !at) throw new Error("GitHub response error");
            (path.includes("rules") ? rulesBroken : broken).add(at);
          }
          const repository = payload.data?.repository;
          if (!repository) throw new Error("Repository unavailable");
          if (broken.has("defaultBranchRef")) throw new Error("Default branch unavailable");
          const trunk: string = repository.defaultBranchRef.name;
          const stacked = (data: Node) => data.baseRefName !== trunk &&
            data.baseRef?.associatedPullRequests?.nodes.some((parent: Node) => parent.state === "OPEN" && parent.number !== data.number && parent.headRefName === data.baseRefName && parent.headRepository?.nameWithOwner?.toLowerCase() === repo.toLowerCase());
          // Ruleset checks: inline from GraphQL's Ref.rules; REST only for a branch whose rules didn't come back whole.
          const trunkRules = rulesBroken.has("defaultBranchRef") ? null : ruleChecks(repository.defaultBranchRef);
          const rules = new Map<string, Promise<string[]>>();
          const rulesFor = (branch: string, inline: string[] | null) => {
            if (inline) return Promise.resolve(inline);
            if (!rules.has(branch)) { this.stats.rest++; rules.set(branch, this.ruleContexts(repo, branch)); }
            return rules.get(branch)!;
          };
          const observed = await Promise.all(group.map(async (p, i) => {
            const alias = `p${i}`; const data = repository[alias];
            if (!data) return [p, { snapshot: null, error: "PR unavailable; check access and its number" }] as const;
            if (broken.has(alias)) return [p, { snapshot: null, error: "GitHub status unavailable; check gh authentication and repository access" }] as const;
            const open = data.state === "OPEN";
            const base = open ? await rulesFor(data.baseRefName, rulesBroken.has(alias) ? null : ruleChecks(data.baseRef)) : [];
            // A stacked PR is eventually checked against trunk. An unprotected parent
            // branch must not erase the required checks that apply to the stack.
            const trunkChecks = open && stacked(data) ? [...(repository.defaultBranchRef.branchProtectionRule?.requiredStatusCheckContexts ?? []), ...await rulesFor(trunk, trunkRules)] : [];
            const required = [...new Set([...(data.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? []), ...base, ...trunkChecks])];
            const snapshot = parsePr(data, trunk, new Date(this.now()).toISOString(), required);
            if (modes.get(repo) === "github") {
              // GitHub mode: merge-when-ready is GitHub's auto-merge, and the repository's merge settings travel with the PR.
              snapshot.prWorkflow = "github"; snapshot.repoMerge = repoMerge(repository);
              if (open) snapshot.mergeWhenReady = data.autoMergeRequest ? "on" : "off";
            } else if (this.workflow) snapshot.prWorkflow = "graphite";
            return [p, { snapshot, error: null }] as const;
          }));
          for (const [p, value] of observed) result.set(p.key, value);
        } catch (error) {
          // Out of GraphQL budget: don't fail. Keep the last observations and wait for the reset.
          if (rateLimited(error)) {
            this.budgets.set(owner, { remaining: 0, resetAt: (error as { resetAt?: number }).resetAt ?? this.now() + 10 * 60_000 });
            for (const p of group) result.set(p.key, this.standIn(p, owner));
            continue;
          }
          // Any other failure (a timeout, a 5xx, a refused token) keeps what is known too: a PR with a status keeps it
          // until a read succeeds (a-github-limit-never-blanks-a-known-pr); only a never-read PR says it has none.
          for (const p of group) result.set(p.key, this.standIn(p, owner, "GitHub status unavailable; check gh authentication and repository access"));
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
    for (const [key, value] of result) this.remember(key, value);
    return result;
  }
  /**
   * What is known without a read: the last observation, else the stored snapshot (after a restart nothing is in
   * memory), else an error: `why`, or (out of budget) when reads resume.
   */
  private standIn(p: Pr, owner: string, why?: string): Observation {
    const last = this.last.get(p.key);
    if (last?.snapshot) return { snapshot: { ...last.snapshot }, error: last.error };
    if (p.snapshot?.complete) return { snapshot: { ...p.snapshot }, error: null };
    if (last) return { snapshot: null, error: last.error };
    if (why) return { snapshot: null, error: why };
    const reset = this.budgets.get(owner)?.resetAt;
    return { snapshot: null, error: `GitHub's API limit for this account is used up${reset ? `; Follow-up reads again after ${new Date(reset).toISOString().slice(11, 16)} UTC` : ""}` };
  }
  /** Each owner's GraphQL budget from the last query's rateLimit (owners on one account report the same). */
  budget(owner: string): Budget | undefined { return this.budgets.get(owner); }
  /** Keeps each PR's last observation for backoff, and when its content last changed (observedAt aside). */
  private remember(key: string, value: Observation): void {
    const { observedAt: _, deployment: __, ...content } = value.snapshot ?? ({} as Partial<Snapshot>);
    const print = JSON.stringify([value.error, value.snapshot ? content : null]);
    // A first read is not a change: otherwise every PR stays hot for RECENT_CHANGE_MS after each worker start.
    const previous = this.prints.get(key);
    if (previous !== print) { if (previous !== undefined) this.changedAt.set(key, this.now()); this.prints.set(key, print); }
    this.last.set(key, value);
  }
}
