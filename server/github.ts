import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Graphite } from "./graphite";
import type { PrWorkflow } from "../shared/pr-workflow";
import type { Pr, Snapshot } from "../shared/model";
import type { Deployments } from "./deployments";
import { notSetUpEvidence } from "../shared/task-trigger";
import { budgetTier, cadence, dueForRead, probeVerdict, SAFETY_READ_MS, type Budget, type Fingerprint } from "../shared/poll";
import { cliApi, githubApi, type GithubApi } from "./github-api";
import { githubSetup, type GithubSetup } from "./github-setup";
import { githubOffText, type GithubOff } from "../shared/github-setup";
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
  // The head comes from headRefOid, the checks from the PR's last listed commit: two fields GitHub updates apart. After
  // a push the commit list can still end at the old head, whose results then read as the new head's
  // (checks-belong-to-the-current-head). Results for any other commit count as nothing reported on the head yet.
  const checksHead: string | null = pr.commits.nodes[0]?.commit.oid ?? null;
  const foreign = !!checksHead && checksHead !== pr.headRefOid;
  const contexts = foreign ? undefined : pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
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
  if (foreign) { checksPending = true; checksRunning = true; }
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
    failedChecks, otherFailedChecks, checksPending, checksRunning, ...(checksHead ? { checksHead } : {}),
    complete: !threads.pageInfo.hasNextPage && !contexts?.pageInfo.hasNextPage && (pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN"), observedAt,
    ...(typeof pr.mergeStateStatus === "string" ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(typeof pr.isInMergeQueue === "boolean" ? { inMergeQueue: pr.isInMergeQueue } : {}),
  };
}

/** Check counts by state: the whole connection's, whatever page of nodes comes back. */
const COUNTS = "checkRunCountsByState{state count} statusContextCountsByState{state count}";
/**
 * A probe's fields (shared/poll.ts, change-first reads): everything the full read decides on that GitHub can report
 * without per-check or per-comment nodes. ~3 requests per PR, so ~1 point per 33 PRs; the full read is ~107 per PR.
 */
const PROBE = `updatedAt state headRefOid baseRefName isDraft mergeable mergeStateStatus reviewDecision isInMergeQueue autoMergeRequest{enabledAt}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved}}
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:1){${COUNTS}}}}}}`;
/** PRs per probe query (one account, any number of its repositories): ~300 requests, about 3 points. */
const PROBE_CHUNK = 100;
const RUNNING_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
/**
 * The fingerprint of a PR as a probe or a full read returned it, or null when it can't be compared (threads past one
 * page, no updatedAt or no check counts: an older GitHub), which leaves that PR on full reads.
 */
export function fingerprint(pr: Node): Fingerprint | null {
  const threads = pr.reviewThreads;
  if (typeof pr.updatedAt !== "string" || !threads || !Array.isArray(threads.nodes) || threads.pageInfo?.hasNextPage !== false) return null;
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  if (contexts && (!Array.isArray(contexts.checkRunCountsByState) || !Array.isArray(contexts.statusContextCountsByState))) return null;
  const counts: [string, number][] = [
    ...(contexts?.checkRunCountsByState ?? []).map((c: Node): [string, number] => [`run:${c.state}`, Number(c.count) || 0]),
    ...(contexts?.statusContextCountsByState ?? []).map((c: Node): [string, number] => [`status:${c.state}`, Number(c.count) || 0]),
  ].filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
  const sum = (states: Set<string>) => counts.reduce((total, [key, n]) => total + (states.has(key.slice(key.indexOf(":") + 1)) ? n : 0), 0);
  const unresolved = threads.nodes.filter((t: Node) => !t.isResolved).map((t: Node) => String(t.id)).sort();
  // The rollup's commit (checks-belong-to-the-current-head): a lagged commit list catching up to the head is a change
  // even when its counts read the same.
  const checksHead = pr.commits?.nodes?.[0]?.commit?.oid ?? null;
  return {
    core: JSON.stringify([pr.updatedAt, pr.state, pr.headRefOid, ...(checksHead ? [checksHead] : []), pr.baseRefName, !!pr.isDraft, pr.mergeable ?? null, pr.mergeStateStatus ?? null, pr.reviewDecision ?? null, pr.isInMergeQueue ?? null, !!pr.autoMergeRequest, unresolved]),
    checks: JSON.stringify(counts), running: sum(RUNNING_STATES), failed: sum(FAILED_STATES),
  };
}

/** Ruleset rules for a ref (GraphQL `Ref.rules`), the same set REST `rules/branches/<branch>` returns. */
const RULES = "rules(first:100){pageInfo{hasNextPage} nodes{type repositoryRuleset{enforcement} parameters{...on RequiredStatusChecksParameters{requiredStatusChecks{context}}}}}";
const fields = `number title url state updatedAt headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt mergeCommit{oid} isInMergeQueue autoMergeRequest{enabledAt}
author{login}
reviewRequests(first:100){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ...on User{login} ...on Team{slug}}}}
latestReviews(first:100){pageInfo{hasNextPage} nodes{state author{__typename login}}}
baseRef{branchProtectionRule{requiredStatusCheckContexts} ${RULES} associatedPullRequests(first:100,states:[OPEN]){nodes{number headRefName state headRepository{nameWithOwner}}}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved comments(last:1){nodes{updatedAt}}}}
commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){${COUNTS} pageInfo{hasNextPage} nodes{
...on CheckRun{name status conclusion} ...on StatusContext{context state}
}}}}}}`;

/**
 * Merged or closed with a complete snapshot: final. Never read again except on its workspace's Refresh, and never in
 * error. Closed joined merged on 2026-11-19: closed PRs were re-read every minute forever. A reopened PR shows on
 * the workspace's Refresh, or when its agent registers it again.
 */
const finalMerged = (p: Pr): boolean => (p.snapshot?.state === "MERGED" || p.snapshot?.state === "CLOSED") && !!p.snapshot.complete;

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
  /** When each PR was first observed in this process: how long its checks have been running, at least. */
  private seenAt = new Map<string, number>();
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
    this.setup = api || run ? null : githubSetup();
  }
  /** Whether GitHub is on for the host (works-without-github); null in tests that inject their own GitHub. */
  setup: (Pick<GithubSetup, "current" | "writeOff"> & Partial<Pick<GithubSetup, "off" | "binary">>) | null;
  /** Why GitHub is off right now, or null: what every PR surface and agent tool says instead of reading. */
  async off(): Promise<GithubOff | null> { if (!this.setup) return null; const state = await this.setup.current(); return state.on ? null : state.off; }
  /**
   * Why GitHub is off as last known, without waiting: what a GitHub action's gate answers from, so an RPC never waits
   * on a gh check before it replies (an-ack-never-waits-on-the-disk). Unknown is not off (invariant 7): it starts the
   * check and goes on, and the read or write itself answers if GitHub turns out to be off.
   */
  offNow(): GithubOff | null {
    const off = this.setup?.off?.() ?? null;
    if (this.setup && off === null) void this.setup.current().catch(() => undefined);
    return off;
  }
  /** offNow for a write, which also needs a gh binary to run (a stat, no spawn). */
  writeOffNow(): GithubOff | null { return this.offNow() ?? (this.setup?.binary && !this.setup.binary() ? "missing" : null); }
  /** Why a write can't run (no GitHub, or no gh to run it), or null. */
  async writeOff(): Promise<GithubOff | null> { return this.setup ? this.setup.writeOff() : null; }
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
  /** Requests GitHub reads made, for tests and the poll-cost harness. `probes`: probe queries; `unchanged`: PRs a probe settled. */
  readonly stats = { graphql: 0, rest: 0, skipped: 0, points: 0, probes: 0, unchanged: 0 };
  /** Each PR's fingerprint from its last full read, and when that read was (change-first reads, shared/poll.ts). */
  private fingerprints = new Map<string, Fingerprint>();
  private fullAt = new Map<string, number>();
  private noteBudget(owner: string, rate: Node | undefined): void {
    if (!rate || typeof rate.remaining !== "number") return;
    this.budgets.set(owner, { remaining: rate.remaining, resetAt: Date.parse(rate.resetAt) || this.now() + 3_600_000, ...(typeof rate.limit === "number" ? { limit: rate.limit } : {}) });
    this.stats.points += Number(rate.cost) || 0;
  }
  /**
   * A rateLimit another reader saw for this owner's account (PR statistics, server/pr-stats-gate.ts): it moves the same
   * budget this poller reads, so a burst either one sees throttles both (`stats-feed-the-shared-budget`). Its cost is
   * not counted in `stats.points`, which measures the poller's own reads.
   */
  noteRateLimit(owner: string, rate: { remaining?: number; resetAt?: string; limit?: number }): void {
    if (typeof rate.remaining !== "number") return;
    this.budgets.set(owner, { remaining: rate.remaining, resetAt: Date.parse(rate.resetAt ?? "") || this.now() + 3_600_000, ...(typeof rate.limit === "number" ? { limit: rate.limit } : {}) });
  }
  /** GitHub refused another reader for the limit: nothing on this account is read until `resetAt`. */
  noteLimited(owner: string, resetAt: number): void { this.outOfBudget(owner, { resetAt }); }
  private outOfBudget(owner: string, error: unknown): void {
    this.budgets.set(owner, { remaining: 0, resetAt: (error as { resetAt?: number }).resetAt ?? this.now() + 10 * 60_000 });
  }
  /** A due PR that a probe may settle: read in full before, nothing wrong with that read, not asked for fresh. */
  private probeable(p: Pr, o: { background?: boolean; fresh?: Set<string> }): boolean {
    const last = this.last.get(p.key);
    return !!o.background && !o.fresh?.has(p.key) && !!last?.snapshot?.complete && !last.error && !p.error && this.fingerprints.has(p.key) && this.now() - (this.fullAt.get(p.key) ?? 0) < SAFETY_READ_MS;
  }
  /**
   * Reads every PR fresh, unless `background` (the engine's timer tick) allows backoff. Then only `fresh` keys,
   * `hot` keys (busy workspaces) and hot PRs force their repository to be read this tick.
   *
   * Change-first (invariant `github-reads-scale-with-change`): a due PR read in full before is probed first, one query
   * per account for every such PR, and read in full only when the probe saw a change that matters (`probeVerdict`).
   * A fresh request (Refresh, opening the panel) and a foreground read (agent tools, actions) read in full.
   */
  async observe(prs: Pr[], o: { background?: boolean; fresh?: Set<string>; hot?: Set<string>; watched?: ReadonlyMap<string, number> } = {}): Promise<Map<string, Observation>> {
    const result = new Map<string, Observation>();
    // GitHub off (works-without-github): nothing is read. A PR keeps what is known; the workspace says why in one line.
    const off = await this.off();
    if (off) {
      const why = githubOffText(off, "PR status");
      for (const p of prs) { const known = this.standIn(p, p.repo.split("/")[0], why); result.set(p.key, known.snapshot ? { ...known, error: why } : known); }
      return result;
    }
    const repositories = [...new Set(prs.map(p => p.repo))];
    const modes = new Map<string, PrWorkflow>();
    for (const repo of repositories) modes.set(repo, this.workflow ? await this.workflow(repo).catch((): PrWorkflow => "github") : "graphite");
    const full = new Map<string, Pr[]>();
    const probes = new Map<string, Pr[]>();
    for (const repo of repositories) {
      const targets = [...new Map(prs.filter(p => p.repo === repo).map(p => [p.key, p])).values()];
      const owner = repo.split("/")[0];
      const tier = budgetTier(this.budgets.get(owner), this.now());
      const pinned = (p: Pr) => o.hot?.has(p.key) || o.fresh?.has(p.key);
      const repoUrgent = targets.some(p => pinned(p) || this.hot(p));
      // Per-PR backoff (shared/poll.ts): only due PRs go into this tick's queries; the rest reuse their last
      // observation.
      const due = targets.filter(p => {
        // Merged or closed is final: one whose status is known isn't read again, not even on a cold start. Only the
        // developer's Refresh of its workspace (fresh) reads it.
        // A stored error doesn't undo that (2.0.1-beta.0 left some behind): the skip below reports no error, clearing it.
        if (finalMerged(p) && !o.fresh?.has(p.key)) return false;
        if (tier === "critical") return false;
        // Under the reserve, background reads stop; the developer's Refresh and foreground reads (agent tools) still go.
        if (tier === "reserve" && o.background && !o.fresh?.has(p.key)) return false;
        if (!o.background || !this.last.has(p.key) || o.fresh?.has(p.key) || o.hot?.has(p.key)) return true;
        const last = this.last.get(p.key)!;
        return dueForRead({ snapshot: last.snapshot, error: p.error || last.error, changedAt: this.changedAt.get(p.key) ?? null, readAt: this.readAt.get(p.key) ?? 0, now: this.now(), tier, repoUrgent, since: this.changedAt.get(p.key) ?? this.seenAt.get(p.key) ?? null, watchedSince: o.watched?.get(p.key) ?? null });
      });
      const dueKeys = new Set(due.map(p => p.key));
      for (const p of targets) if (!dueKeys.has(p.key)) { this.stats.skipped++; result.set(p.key, finalMerged(p) ? { snapshot: { ...p.snapshot! }, error: null } : this.standIn(p, owner)); }
      for (const p of due) { const into = this.probeable(p, o) ? probes : full; into.set(into === probes ? owner : repo, [...(into.get(into === probes ? owner : repo) ?? []), p]); }
    }
    // Probes: one query per account (owner) for up to PROBE_CHUNK PRs across its repositories.
    for (const [owner, group] of probes) {
      for (let offset = 0; offset < group.length; offset += PROBE_CHUNK) {
        const chunk = group.slice(offset, offset + PROBE_CHUNK);
        const byRepo = [...new Set(chunk.map(p => p.repo))];
        const query = `query{rateLimit{cost remaining resetAt limit} ${byRepo.map((repo, r) => {
          const [o, n] = repo.split("/");
          return `r${r}:repository(owner:${JSON.stringify(o)},name:${JSON.stringify(n)}){${chunk.filter(p => p.repo === repo).map(p => `p${p.number}:pullRequest(number:${p.number}){${PROBE}}`).join(" ")}}`;
        }).join(" ")}}`;
        const reread = (p: Pr) => full.set(p.repo, [...(full.get(p.repo) ?? []), p]);
        try {
          this.stats.graphql++; this.stats.probes++;
          // A read counts from when it was asked, never answered: an answer that lands after an agent's push and wait
          // may describe the PR before the push (checks-belong-to-the-current-head).
          const askedAt = new Date(this.now()).toISOString();
          const payload = await this.api.graphql(byRepo[0], query, {});
          if (((payload.errors ?? []) as Node[]).some(e => e.type === "RATE_LIMITED" || e.type === "RATE_LIMIT")) throw Object.assign(new Error("rate limited"), { rateLimited: true });
          this.noteBudget(owner, payload.data?.rateLimit);
          for (const p of chunk) {
            const data = payload.data?.[`r${byRepo.indexOf(p.repo)}`]?.[`p${p.number}`];
            const seen = data ? fingerprint(data) : null;
            const before = this.fingerprints.get(p.key)!;
            if (!seen || probeVerdict(before, seen, this.now() - (this.fullAt.get(p.key) ?? 0)) === "read") { reread(p); continue; }
            // Nothing the full read decides on moved: the last observation is current as of now.
            this.stats.unchanged++; this.readAt.set(p.key, this.now());
            result.set(p.key, { snapshot: { ...this.last.get(p.key)!.snapshot!, observedAt: askedAt }, error: null });
          }
        } catch (error) {
          if (rateLimited(error)) { this.outOfBudget(owner, error); for (const p of chunk) result.set(p.key, this.standIn(p, owner)); continue; }
          // Any other probe failure: the full read decides (and reports) for these PRs.
          for (const p of chunk) reread(p);
        }
      }
    }
    for (const [repo, due] of full) {
      const owner = repo.split("/")[0];
      for (let offset = 0; offset < due.length; offset += CHUNK) {
        const group = due.slice(offset, offset + CHUNK);
        // A probe (or an earlier chunk) that hit the limit stops the rest of this tick's reads on that account.
        if (budgetTier(this.budgets.get(owner), this.now()) === "critical") { for (const p of group) result.set(p.key, this.standIn(p, owner)); continue; }
        const [, name] = repo.split("/");
        const query = `query($owner:String!,$name:String!){rateLimit{cost remaining resetAt limit} repository(owner:$owner,name:$name){defaultBranchRef{name branchProtectionRule{requiredStatusCheckContexts} ${RULES}} squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed viewerDefaultMergeMethod mergeQueue{id} ${group.map((p, i) => `p${i}:pullRequest(number:${p.number}){${fields}}`).join(" ")}}}`;
        try {
          this.stats.graphql++;
          const askedAt = new Date(this.now()).toISOString(); // asked, not answered (checks-belong-to-the-current-head)
          const payload = await this.api.graphql(repo, query, { owner, name });
          this.noteBudget(owner, payload.data?.rateLimit);
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
            const snapshot = parsePr(data, trunk, askedAt, required);
            const print = fingerprint(data);
            if (print) this.fingerprints.set(p.key, print); else this.fingerprints.delete(p.key);
            this.fullAt.set(p.key, this.now());
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
            this.outOfBudget(owner, error);
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
      const stored = new Map(prs.map(p => [p.key, p]));
      const targets = prs.flatMap(p => { const observed = result.get(p.key); return observed?.snapshot && !observed.error ? [{ ...p, snapshot: observed.snapshot }] : []; });
      const deployment = await this.deployments.observe(targets);
      for (const [key, value] of deployment) result.get(key)!.snapshot!.deployment = value;
      // No deploy check for the repository: keep the last observation (it returns when the check does), marked.
      for (const p of targets) if (p.snapshot.state === "MERGED" && !deployment.has(p.key)) {
        const before = p.snapshot.deployment ?? this.last.get(p.key)?.snapshot?.deployment ?? stored.get(p.key)?.snapshot?.deployment;
        result.get(p.key)!.snapshot!.deployment = before
          ? { ...before, notSetUp: true }
          : { state: "unknown", environment: "", commits: [], evidence: notSetUpEvidence(p.repo), observedAt: new Date(this.now()).toISOString(), notSetUp: true };
      }
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
  /**
   * While Follow-up holds back reads on this repository's account for the budget (the reserve or less), when they
   * resume (GitHub's reset); null when reads run. Feeds the workspace's "GitHub budget low" line (Workspace.githubWait).
   */
  /** When this PR's content last changed, else when this worker first read it; null before any read (wait for checks' settle rule). */
  quietSince(key: string): number | null { return this.changedAt.get(key) ?? this.seenAt.get(key) ?? null; }
  waitUntil(repo: string): number | null {
    const budget = this.budgets.get(repo.split("/")[0]);
    const tier = budgetTier(budget, this.now());
    return tier === "reserve" || tier === "critical" ? budget!.resetAt : null;
  }
  /** Keeps each PR's last observation for backoff, and when its content last changed (observedAt aside). */
  private remember(key: string, value: Observation): void {
    const { observedAt: _, deployment: __, ...content } = value.snapshot ?? ({} as Partial<Snapshot>);
    const print = JSON.stringify([value.error, value.snapshot ? content : null]);
    // A first read is not a change: otherwise every PR stays hot for RECENT_CHANGE_MS after each worker start.
    const previous = this.prints.get(key);
    if (previous !== print) { if (previous !== undefined) this.changedAt.set(key, this.now()); this.prints.set(key, print); }
    this.last.set(key, value);
    if (!this.seenAt.has(key)) this.seenAt.set(key, this.now());
  }
}
